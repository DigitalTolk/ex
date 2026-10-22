package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// ConversationConverter is the conversation store's side of turning a group
// message into a private channel.
type ConversationConverter interface {
	GetConversation(ctx context.Context, id string) (*model.Conversation, error)
	GetUserConversations(ctx context.Context, convID string, userIDs []string) (map[string]*model.UserConversation, error)
	ConvertGroupToChannel(ctx context.Context, ch *model.Channel, members []store.ConvertedMember, at time.Time) error
}

// ConversationDraftMover moves what people were writing in a group message
// to the channel it became. Implemented by DraftService.
type ConversationDraftMover interface {
	MoveConversationDrafts(ctx context.Context, userIDs []string, conversationID string)
}

// SetConversationConverter wires converting group messages into channels,
// and moving their drafts along (drafts may be nil).
func (s *ChannelService) SetConversationConverter(c ConversationConverter, drafts ConversationDraftMover) {
	s.conversions = c
	s.convertedDrafts = drafts
}

// ConvertGroupConversation turns a group message into a private channel
// named name, as Slack does: everyone in it becomes a member (whoever
// converts it its owner), the whole history comes along, and the group is
// gone from everyone's list, the channel in its place. Each keeps where they
// had read up to, their unread badge and where the group sat in their
// sidebar. Any of its people may do it, except guests (who can't create
// channels).
func (s *ChannelService) ConvertGroupConversation(ctx context.Context, actorID, convID, name string) (*model.Channel, error) {
	if s.conversions == nil {
		return nil, fmt.Errorf("channel: converting conversations is unavailable: %w", ErrValidation)
	}
	conv, err := s.conversions.GetConversation(ctx, convID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("channel: conversation not found: %w", store.ErrNotFound)
		}
		return nil, fmt.Errorf("channel: get conversation: %w", err)
	}
	if !slices.Contains(conv.ParticipantIDs, actorID) {
		return nil, fmt.Errorf("channel: not in this conversation: %w", ErrForbidden)
	}
	if conv.Type != model.ConversationTypeGroup {
		return nil, fmt.Errorf("channel: only a group message can become a channel: %w", ErrValidation)
	}
	if conv.ConvertedToChannelID != "" {
		return nil, fmt.Errorf("channel: this conversation is a channel already: %w", ErrAlreadyExists)
	}
	if s.users != nil {
		if u, err := s.users.GetUser(ctx, actorID); err == nil && u.SystemRole == model.SystemRoleGuest {
			return nil, fmt.Errorf("channel: guests cannot create channels: %w", ErrForbidden)
		}
	}
	if err := ValidateChannelName(name); err != nil {
		return nil, err
	}
	slug := slugify(name)
	if existing, err := s.channels.GetChannelBySlug(ctx, slug); err == nil && existing != nil {
		return nil, fmt.Errorf("channel: a channel with this name already exists: %w", ErrAlreadyExists)
	}
	rows, err := s.conversions.GetUserConversations(ctx, conv.ID, conv.ParticipantIDs)
	if err != nil {
		return nil, fmt.Errorf("channel: read conversation members: %w", err)
	}

	now := time.Now()
	ch := &model.Channel{
		ID:        conv.ID,
		Name:      name,
		Slug:      slug,
		Type:      model.ChannelTypePrivate,
		CreatedBy: actorID,
		CreatedAt: now,
		UpdatedAt: now,
		// Unread counts carry on from the group's own counter.
		MessageSeq: conv.MessageSeq,
	}
	members := make([]store.ConvertedMember, 0, len(conv.ParticipantIDs))
	for _, uid := range conv.ParticipantIDs {
		role := model.ChannelRoleMember
		if uid == actorID {
			role = model.ChannelRoleOwner
		}
		uc := &model.UserChannel{
			UserID:      uid,
			ChannelID:   ch.ID,
			ChannelName: ch.Name,
			ChannelType: ch.Type,
			Role:        role,
			JoinedAt:    now,
		}
		if row := rows[uid]; row != nil {
			uc.LastReadMsgID = row.LastReadMsgID
			uc.LastReadSeq = row.LastReadSeq
			uc.UnreadNotifyCount = row.UnreadNotifyCount
			uc.Favorite = row.Favorite
			// A place among the direct messages means nothing among the
			// channels; one in a category of their own does.
			uc.CategoryID = row.CategoryID
			if row.CategoryID != "" {
				uc.SidebarPosition = row.SidebarPosition
			}
		}
		members = append(members, store.ConvertedMember{
			Member: &model.ChannelMembership{
				ChannelID:   ch.ID,
				UserID:      uid,
				Role:        role,
				DisplayName: s.resolveDisplayName(ctx, uid),
				JoinedAt:    now,
			},
			UserChannel: uc,
		})
	}
	if err := s.conversions.ConvertGroupToChannel(ctx, ch, members, now); err != nil {
		switch {
		case errors.Is(err, store.ErrConversationConverted):
			return nil, fmt.Errorf("channel: this conversation is a channel already: %w", ErrAlreadyExists)
		case errors.Is(err, store.ErrAlreadyExists):
			return nil, fmt.Errorf("channel: a channel with this name already exists: %w", ErrAlreadyExists)
		}
		return nil, fmt.Errorf("channel: convert conversation: %w", err)
	}

	recipients := make([]string, 0, len(conv.ParticipantIDs))
	for _, uid := range conv.ParticipantIDs {
		if s.broker != nil {
			s.broker.Subscribe(uid, pubsub.ChannelName(ch.ID))
			s.broker.Unsubscribe(uid, pubsub.ConversationName(conv.ID))
		}
		recipients = append(recipients, pubsub.UserChannel(uid))
	}
	events.PublishMany(ctx, s.publisher, recipients, events.EventConversationConverted, map[string]any{
		"conversationID": conv.ID,
		"channelID":      ch.ID,
		"name":           ch.Name,
		"slug":           ch.Slug,
		"convertedBy":    actorID,
	})
	if s.convertedDrafts != nil {
		s.convertedDrafts.MoveConversationDrafts(ctx, conv.ParticipantIDs, conv.ID)
	}
	s.postSystemMessage(ctx, ch.ID, s.resolveDisplayName(ctx, actorID)+" made this a private channel")
	s.indexChannel(ctx, ch)
	return ch, nil
}
