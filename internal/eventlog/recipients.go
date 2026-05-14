package eventlog

import (
	"context"
	"strings"
)

// MemberLister is the subset of MembershipStore needed to resolve
// channel-topic recipients without importing the store interface.
type MemberLister interface {
	MemberIDs(ctx context.Context, channelID string) ([]string, error)
}

// ParticipantLister is the subset of ConversationStore needed to
// resolve conversation-topic recipients.
type ParticipantLister interface {
	ParticipantIDs(ctx context.Context, conversationID string) ([]string, error)
}

// Resolver maps a pub/sub topic to the set of userIDs that should
// receive the event in their durable inbox. Topics whose recipient
// set is "everyone connected" (global:*) are intentionally not
// resolved — those events are sent live-only because fanning them out
// to every user's inbox is expensive and the recovery cost on the
// client (a single list refetch) is cheap.
type Resolver struct {
	members      MemberLister
	participants ParticipantLister
}

// NewResolver builds a Resolver. Either dependency may be nil — the
// corresponding topic prefix then simply yields an empty recipient
// list (the event still publishes live, just nothing goes into any
// inbox).
func NewResolver(m MemberLister, p ParticipantLister) *Resolver {
	return &Resolver{members: m, participants: p}
}

// Resolve returns the recipient userIDs for the given pubsub topic.
// Topics not understood by the resolver (e.g. `global:*`) return an
// empty slice and a nil error so the caller can safely skip durable
// fan-out without special-casing topic strings.
func (r *Resolver) Resolve(ctx context.Context, topic string) ([]string, error) {
	if r == nil {
		return nil, nil
	}
	switch {
	case strings.HasPrefix(topic, "chan:"):
		if r.members == nil {
			return nil, nil
		}
		return r.members.MemberIDs(ctx, strings.TrimPrefix(topic, "chan:"))
	case strings.HasPrefix(topic, "conv:"):
		if r.participants == nil {
			return nil, nil
		}
		return r.participants.ParticipantIDs(ctx, strings.TrimPrefix(topic, "conv:"))
	case strings.HasPrefix(topic, "user:"):
		// Direct delivery — the topic encodes the recipient.
		return []string{strings.TrimPrefix(topic, "user:")}, nil
	default:
		// global:* and anything else — live-only.
		return nil, nil
	}
}
