package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

// CliffyInChatStore holds short-lived state for in-chat @cliffy: a per-(chat,user)
// write proposal awaiting the user's confirmation, and markers for threads Cliffy
// is part of (so replies there reach it without an @mention).
type CliffyInChatStore struct {
	client *redis.Client
}

func NewCliffyInChatStore(client *redis.Client) *CliffyInChatStore {
	return &CliffyInChatStore{client: client}
}

const (
	cliffyPendingTTL = 15 * time.Minute
	cliffyThreadTTL  = 24 * time.Hour
)

// CliffyPendingWrite is a proposed CliffHub write awaiting the user's "yes".
type CliffyPendingWrite struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   map[string]string `json:"query,omitempty"`
	Body    json.RawMessage   `json:"body,omitempty"`
	Summary string            `json:"summary"`
}

func cliffyPendingKey(chatID, userID string) string {
	return "cliffy:inchat:pending:" + chatID + ":" + userID
}
func cliffyThreadKey(rootID string) string { return "cliffy:inchat:thread:" + rootID }

// SetPending stores the write the given user must confirm in the given chat.
func (s *CliffyInChatStore) SetPending(ctx context.Context, chatID, userID string, p *CliffyPendingWrite) error {
	b, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return s.client.Set(ctx, cliffyPendingKey(chatID, userID), b, cliffyPendingTTL).Err()
}

// GetPending returns the pending write for (chat,user), or (nil, nil) if none.
func (s *CliffyInChatStore) GetPending(ctx context.Context, chatID, userID string) (*CliffyPendingWrite, error) {
	b, err := s.client.Get(ctx, cliffyPendingKey(chatID, userID)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p CliffyPendingWrite
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// TakePending atomically returns AND removes the pending write for (chat,user)
// via GETDEL. This makes confirmation a single point of mutual exclusion: if two
// "yes" messages race (double-tap / client retry), only the caller that observes
// the value executes; the loser gets (nil, nil) and must not act. Returns
// (nil, nil) when nothing is parked.
func (s *CliffyInChatStore) TakePending(ctx context.Context, chatID, userID string) (*CliffyPendingWrite, error) {
	b, err := s.client.GetDel(ctx, cliffyPendingKey(chatID, userID)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p CliffyPendingWrite
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *CliffyInChatStore) ClearPending(ctx context.Context, chatID, userID string) {
	s.client.Del(ctx, cliffyPendingKey(chatID, userID))
}

// MarkThread records that Cliffy has spoken in the thread rooted at rootID, so
// later replies there reach Cliffy without an @mention.
func (s *CliffyInChatStore) MarkThread(ctx context.Context, rootID string) {
	if rootID == "" {
		return
	}
	s.client.Set(ctx, cliffyThreadKey(rootID), "1", cliffyThreadTTL)
}

func (s *CliffyInChatStore) IsCliffyThread(ctx context.Context, rootID string) bool {
	if rootID == "" {
		return false
	}
	n, _ := s.client.Exists(ctx, cliffyThreadKey(rootID)).Result()
	return n > 0
}
