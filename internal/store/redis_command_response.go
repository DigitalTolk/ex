package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

// CommandResponseStore backs the delayed slash-command response (Mattermost's
// `response_url`). When ex invokes a command it hands the integration a one-shot
// URL it can POST to later — the escape hatch for work that takes longer than the
// synchronous request allows.
//
// The URL's token IS the credential, so what it authorizes has to be pinned at
// mint time: the chat to post into, the invoking user whose access is re-checked
// before posting, and the identity to post as. Redis holds that pinning with a
// TTL, which also bounds how long a leaked URL is useful.
type CommandResponseStore struct {
	client *redis.Client
}

func NewCommandResponseStore(client *redis.Client) *CommandResponseStore {
	return &CommandResponseStore{client: client}
}

// CommandResponseTTL is how long a response_url stays valid. Mattermost allows 30
// minutes; ex matches that so an integration written against MM's documented
// window behaves the same here.
const CommandResponseTTL = 30 * time.Minute

// PendingCommandResponse is the invocation a response_url may post back into.
// Every field is server-authored — nothing here comes from the integration, so a
// stolen token cannot retarget the post.
type PendingCommandResponse struct {
	CommandID  string `json:"commandID"`
	Trigger    string `json:"trigger"`
	UserID     string `json:"userID"`
	ParentID   string `json:"parentID"`
	ParentType string `json:"parentType"`
	BotUserID  string `json:"botUserID,omitempty"`
	Username   string `json:"username,omitempty"`
	IconURL    string `json:"iconURL,omitempty"`
	// RootMessageID threads a delayed response under the message the command
	// posted, when there was one.
	RootMessageID string `json:"rootMessageID,omitempty"`
}

func commandResponseKey(token string) string { return "command:response:" + token }

// Put stores the pending invocation under a freshly minted token.
func (s *CommandResponseStore) Put(ctx context.Context, token string, p *PendingCommandResponse) error {
	// Every field is a string, so this marshal cannot fail — no error guard, which
	// would be unreachable (and uncoverable) code.
	b, _ := json.Marshal(p)
	return s.client.Set(ctx, commandResponseKey(token), b, CommandResponseTTL).Err()
}

// Get resolves a token without consuming it. MM's response_url accepts multiple
// posts within its window (an integration may report progress then a result), so
// this deliberately does not GETDEL — the TTL is what bounds reuse.
func (s *CommandResponseStore) Get(ctx context.Context, token string) (*PendingCommandResponse, error) {
	b, err := s.client.Get(ctx, commandResponseKey(token)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var p PendingCommandResponse
	if err := json.Unmarshal(b, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// Delete revokes a token early.
func (s *CommandResponseStore) Delete(ctx context.Context, token string) {
	s.client.Del(ctx, commandResponseKey(token))
}
