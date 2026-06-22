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

type PresenceStore interface {
	IncrementPresence(ctx context.Context, userID string) (bool, error)
	DecrementPresence(ctx context.Context, userID string) (bool, error)
	RefreshPresence(ctx context.Context, userID string) error
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

// OnConnect records a new connection for a user. Returns true if this is the
// user's first connection (transition from offline to online), so callers can
// publish a presence event exactly once per state transition.
func (s *PresenceService) OnConnect(ctx context.Context, userID string) bool {
	s.mu.Lock()
	prev := s.online[userID]
	s.online[userID] = prev + 1
	s.mu.Unlock()
	if prev == 0 {
		if s.store != nil {
			first, err := s.store.IncrementPresence(ctx, userID)
			if err == nil && !first {
				return false
			}
		}
		s.publish(ctx, userID, true)
		return true
	}
	return false
}

// OnDisconnect decrements a connection. Returns true if this transitioned the
// user from online to offline, so we publish exactly once.
func (s *PresenceService) OnDisconnect(ctx context.Context, userID string) bool {
	s.mu.Lock()
	count := s.online[userID]
	if count <= 1 {
		delete(s.online, userID)
	} else {
		s.online[userID] = count - 1
	}
	remaining := s.online[userID]
	s.mu.Unlock()
	if count > 0 && remaining == 0 {
		if s.store != nil {
			last, err := s.store.DecrementPresence(ctx, userID)
			if err == nil && !last {
				return false
			}
		}
		s.publish(ctx, userID, false)
		return true
	}
	return false
}

// Refresh extends the distributed presence marker for a locally connected user.
func (s *PresenceService) Refresh(ctx context.Context, userID string) {
	if s.store == nil {
		return
	}
	s.mu.RLock()
	local := s.online[userID] > 0
	s.mu.RUnlock()
	if !local {
		return
	}
	_ = s.store.RefreshPresence(ctx, userID)
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

func (s *PresenceService) publish(ctx context.Context, userID string, online bool) {
	data := map[string]any{"userID": userID, "online": online}
	if s.audience != nil {
		// Scoped fan-out: only people who share a channel or DM with the subject
		// need to know. A subject in no shared context reaches no one.
		for _, topic := range s.audience(ctx, userID) {
			events.Publish(ctx, s.publisher, topic, events.EventPresenceChanged, data)
		}
		return
	}
	events.Publish(ctx, s.publisher, pubsub.PresenceEvents(), events.EventPresenceChanged, data)
}
