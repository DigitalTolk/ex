package service

import (
	"context"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// PresenceService tracks online users and broadcasts presence changes to all
// connected clients via the global presence pub/sub channel. Connection counts
// allow a single user to have multiple sessions without flapping the online
// flag on each tab close.
type PresenceService struct {
	publisher Publisher
	store     PresenceStore
	// audience resolves the pub/sub topics that should receive a user's presence
	// change — the channels and DM conversations they belong to. When set, a
	// presence change fans out only to people who actually share a context with
	// the subject instead of to every connected client on a single global topic.
	audience func(ctx context.Context, userID string) []string

	mu     sync.RWMutex
	online map[string]int // userID -> connection count
}

// SetPresenceAudienceResolver wires the function that maps a user to the pub/sub
// topics their presence change should reach (shared channels + DM conversations).
// Without it, presence falls back to the single global broadcast topic.
func (s *PresenceService) SetPresenceAudienceResolver(fn func(ctx context.Context, userID string) []string) {
	s.audience = fn
}

// PresenceStore is the distributed (Redis-backed) presence view. Connections
// are tracked INDIVIDUALLY by connID (a per-socket ULID): each one carries
// its own expiry, so a crashed instance's connections age out on their own,
// a disconnect of an unknown/lapsed connID is a no-op, and the keep-alive
// refresh recreates a blip-lost entry — the failure modes of the old
// per-instance counter (leaked increments, negative-count offline flaps,
// unhealable lost markers) are structurally gone.
type PresenceStore interface {
	IncrementPresence(ctx context.Context, userID, connID string) (bool, error)
	DecrementPresence(ctx context.Context, userID, connID string) (bool, error)
	RefreshPresence(ctx context.Context, userID, connID string) error
	IsPresenceOnline(ctx context.Context, userID string) (bool, error)
	OnlinePresenceUserIDs(ctx context.Context) ([]string, error)
}

// NewPresenceService creates a presence service. The optional store shares
// presence counts across backend processes; the in-memory map remains the
// local fallback and prevents duplicate transitions within one process.
func NewPresenceService(store PresenceStore, publisher Publisher) *PresenceService {
	return &PresenceService{
		publisher: publisher,
		store:     store,
		online:    make(map[string]int),
	}
}

// OnConnect records a new connection (identified by its per-socket connID)
// for a user. Returns true if this made the user online (no other live
// connection anywhere in the fleet), so callers can publish a presence event
// exactly once per state transition. Every connection registers its own
// distributed entry — the store's live-member count is the transition
// authority; the local map only dedupes same-instance lookups. When the
// caller already knows the user's audience topics (the WS handler just built
// them for its broker subscription) it passes them in so the transition does
// not re-read the user's memberships through the audience resolver.
func (s *PresenceService) OnConnect(ctx context.Context, userID, connID string, topics ...string) bool {
	s.mu.Lock()
	prev := s.online[userID]
	s.online[userID] = prev + 1
	s.mu.Unlock()
	if s.store != nil {
		first, err := s.store.IncrementPresence(ctx, userID, connID)
		if err == nil {
			if !first {
				return false
			}
			s.publish(ctx, userID, true, topics)
			return true
		}
		// Store unavailable: fall back to the local transition so a user's
		// own instance still announces them (fail toward visible).
	}
	if prev == 0 {
		s.publish(ctx, userID, true, topics)
		return true
	}
	return false
}

// OnDisconnect removes a connection. Returns true if this transitioned the
// user from online to offline (no live connections remain fleet-wide), so we
// publish exactly once. Topics work as in OnConnect; disconnect callers
// usually omit them so the audience resolves fresh (memberships may have
// changed over the connection's lifetime).
func (s *PresenceService) OnDisconnect(ctx context.Context, userID, connID string, topics ...string) bool {
	s.mu.Lock()
	count := s.online[userID]
	if count <= 1 {
		delete(s.online, userID)
	} else {
		s.online[userID] = count - 1
	}
	remaining := s.online[userID]
	s.mu.Unlock()
	if s.store != nil {
		last, err := s.store.DecrementPresence(ctx, userID, connID)
		if err == nil {
			if !last {
				return false
			}
			s.publish(ctx, userID, false, topics)
			return true
		}
		// Store unavailable: fall back to the local view. The distributed
		// entry it failed to remove lapses by score within presenceTTL.
	}
	if count > 0 && remaining == 0 {
		s.publish(ctx, userID, false, topics)
		return true
	}
	return false
}

// Refresh re-scores the distributed presence entry for a locally connected
// user's connection. The plain ZADD underneath doubles as the self-heal: an
// entry lost to a Redis blip is recreated within one keep-alive interval.
func (s *PresenceService) Refresh(ctx context.Context, userID, connID string) {
	if s.store == nil {
		return
	}
	s.mu.RLock()
	local := s.online[userID] > 0
	s.mu.RUnlock()
	if !local {
		return
	}
	_ = s.store.RefreshPresence(ctx, userID, connID)
}

// presenceLookupTimeout caps how long a presence lookup can block on
// Redis. Both IsOnline and OnlineUserIDs are called from request-
// handling render paths (sidebar, member list); without a deadline,
// a slow/partitioned Redis would freeze the request hot path until
// the OS dial timeout (which is much longer than is acceptable for
// a chat sidebar). On timeout we fall back to the in-process map,
// which is a stale-but-safe view.
const presenceLookupTimeout = 500 * time.Millisecond

// IsOnline reports whether a user has any active connection.
func (s *PresenceService) IsOnline(userID string) bool {
	s.mu.RLock()
	local := s.online[userID] > 0
	s.mu.RUnlock()
	if local {
		return true
	}
	if s.store == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), presenceLookupTimeout)
	defer cancel()
	online, err := s.store.IsPresenceOnline(ctx, userID)
	return err == nil && online
}

// batchPresenceStore is the optional one-MGET capability of the presence
// store (RedisCache has it). Asserted with a per-user fallback so plain test
// stores keep working.
type batchPresenceStore interface {
	ArePresenceOnline(ctx context.Context, userIDs []string) (map[string]bool, error)
}

// OnlineMany reports online status for many users at once: the local
// connection map answers for sessions on THIS instance, everyone else
// resolves through one batched Redis read instead of a GET per user — the
// notification fan-out calls this once per message rather than once per
// recipient. A store failure leaves the unresolved users offline, which is
// the fail-safe direction for the mobile-push fallback: an offline verdict
// pushes immediately, and a duplicate alert beats a silently lost one.
func (s *PresenceService) OnlineMany(userIDs []string) map[string]bool {
	out := make(map[string]bool, len(userIDs))
	remote := make([]string, 0, len(userIDs))
	s.mu.RLock()
	for _, id := range userIDs {
		if s.online[id] > 0 {
			out[id] = true
		} else {
			remote = append(remote, id)
		}
	}
	s.mu.RUnlock()
	if len(remote) == 0 || s.store == nil {
		return out
	}
	ctx, cancel := context.WithTimeout(context.Background(), presenceLookupTimeout)
	defer cancel()
	if bs, ok := s.store.(batchPresenceStore); ok {
		if m, err := bs.ArePresenceOnline(ctx, remote); err == nil {
			for id, on := range m {
				out[id] = on
			}
		}
		return out
	}
	for _, id := range remote {
		on, err := s.store.IsPresenceOnline(ctx, id)
		out[id] = err == nil && on
	}
	return out
}

// OnlineUserIDs returns all currently online user IDs (sorted not guaranteed).
func (s *PresenceService) OnlineUserIDs() []string {
	if s.store != nil {
		ctx, cancel := context.WithTimeout(context.Background(), presenceLookupTimeout)
		defer cancel()
		ids, err := s.store.OnlinePresenceUserIDs(ctx)
		if err == nil {
			return ids
		}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.online))
	for id := range s.online {
		out = append(out, id)
	}
	return out
}

func (s *PresenceService) publish(ctx context.Context, userID string, online bool, topics []string) {
	data := map[string]any{"userID": userID, "online": online}
	// Scoped fan-out: only people who share a channel or DM with the subject need
	// to know. A subject in no shared context reaches no one. Caller-supplied
	// topics win (no membership re-read); otherwise resolve the audience here.
	if len(topics) == 0 {
		topics = []string{pubsub.PresenceEvents()}
		if s.audience != nil {
			topics = s.audience(ctx, userID)
		}
	}
	if len(topics) == 0 {
		return
	}
	// Pipeline the fan-out into one round-trip when the publisher supports it
	// (a presence transition for a user in N channels otherwise did N serial
	// PUBLISHes on every connect/disconnect). Fall back to a per-topic loop.
	if bp, ok := s.publisher.(events.ManyPublisher); ok {
		if evt, err := events.NewEvent(events.EventPresenceChanged, data); err == nil {
			_ = bp.PublishMany(ctx, topics, evt)
			return
		}
	}
	for _, topic := range topics {
		events.Publish(ctx, s.publisher, topic, events.EventPresenceChanged, data)
	}
}
