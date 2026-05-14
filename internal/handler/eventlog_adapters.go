package handler

import (
	"context"

	"github.com/DigitalTolk/ex/internal/model"
)

// ListMembersFunc abstracts the membership store's channel-member
// listing so the eventlog adapter doesn't depend on a concrete store
// type. main.go passes the bound method; tests pass a closure.
type ListMembersFunc func(ctx context.Context, channelID string) ([]*model.ChannelMembership, error)

// GetConversationFunc abstracts the conversation store's get-by-ID
// for the same reason.
type GetConversationFunc func(ctx context.Context, id string) (*model.Conversation, error)

// MembershipMemberLister adapts a channel-membership lister to the
// eventlog.MemberLister interface (just userIDs, not full membership
// rows) so the publisher can fan-out to per-user inboxes without
// pulling the full membership model through the eventlog package.
type MembershipMemberLister struct {
	list ListMembersFunc
}

// NewMembershipMemberLister wraps a channel-membership listing
// function so it resolves recipients for the durable event log.
func NewMembershipMemberLister(list ListMembersFunc) *MembershipMemberLister {
	return &MembershipMemberLister{list: list}
}

// MemberIDs returns the user IDs of all members of the channel.
// Empty/nil rows are filtered so an empty userID can't propagate to
// XADD (where it would fail anyway).
func (m *MembershipMemberLister) MemberIDs(ctx context.Context, channelID string) ([]string, error) {
	if m == nil || m.list == nil {
		return nil, nil
	}
	rows, err := m.list(ctx, channelID)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	for _, r := range rows {
		if r == nil || r.UserID == "" {
			continue
		}
		ids = append(ids, r.UserID)
	}
	return ids, nil
}

// ConversationParticipantLister adapts a conversation getter to the
// eventlog.ParticipantLister interface.
type ConversationParticipantLister struct {
	get GetConversationFunc
}

// NewConversationParticipantLister wraps a conversation getter
// function so it resolves recipients for conversation topics.
func NewConversationParticipantLister(get GetConversationFunc) *ConversationParticipantLister {
	return &ConversationParticipantLister{get: get}
}

// ParticipantIDs returns the participant userIDs for the
// conversation. Returns an empty slice (not an error) for a missing
// conversation — publish-time fan-out should never fail an action
// because a stale topic resolved nothing.
func (c *ConversationParticipantLister) ParticipantIDs(ctx context.Context, conversationID string) ([]string, error) {
	if c == nil || c.get == nil {
		return nil, nil
	}
	conv, err := c.get(ctx, conversationID)
	if err != nil {
		return nil, err
	}
	if conv == nil {
		return nil, nil
	}
	out := make([]string, 0, len(conv.ParticipantIDs))
	for _, id := range conv.ParticipantIDs {
		if id == "" {
			continue
		}
		out = append(out, id)
	}
	return out, nil
}
