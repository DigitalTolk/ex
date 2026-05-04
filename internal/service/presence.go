package service

import (
	"context"
	"sync"

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

	mu     sync.RWMutex
	online map[string]int // userID -> connection count
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
	online, err := s.store.IsPresenceOnline(context.Background(), userID)
	return err == nil && online
}

// OnlineUserIDs returns all currently online user IDs (sorted not guaranteed).
func (s *PresenceService) OnlineUserIDs() []string {
	if s.store != nil {
		ids, err := s.store.OnlinePresenceUserIDs(context.Background())
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
	events.Publish(ctx, s.publisher, pubsub.PresenceEvents(), events.EventPresenceChanged, map[string]any{
		"userID": userID,
		"online": online,
	})
}
