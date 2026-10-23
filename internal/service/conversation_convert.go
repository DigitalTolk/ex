package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
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
	// MoveMembersToChannel finishes a conversion that stopped partway.
	MoveMembersToChannel(ctx context.Context, channelID string, members []store.ConvertedMember) error
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
	if s.users != nil {
		if u, err := s.users.GetUser(ctx, actorID); err == nil && u.SystemRole == model.SystemRoleGuest {
			return nil, apperr.Forbidden("channel: guests cannot create channels")
		}
	}
	if conv.ConvertedToChannelID != "" {
		return s.resumeConversion(ctx, conv)
	}
	if err := ValidateChannelName(name); err != nil {
		return nil, err
	}
	slug := Slugify(name)
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
	members := s.convertedMembers(ctx, ch, conv.ParticipantIDs, rows, now)
	// The store moves a larger group in several transactions; a message
	// landing between them may cache the half-moved member list, so the
	// channel's audience moves on once the move is over (or failed partway).
	if err := s.audienceWritten(ctx, ch.ID, s.conversions.ConvertGroupToChannel(ctx, ch, members, now)); err != nil {
		switch {
		case errors.Is(err, store.ErrConversationConverted):
			return nil, fmt.Errorf("channel: this conversation is a channel already: %w", ErrAlreadyExists)
		case errors.Is(err, store.ErrAlreadyExists):
			return nil, fmt.Errorf("channel: a channel with this name already exists: %w", ErrAlreadyExists)
		}
		return nil, fmt.Errorf("channel: convert conversation: %w", err)
	}

	s.finishConversion(ctx, actorID, conv, ch)
	return ch, nil
}

// convertedMembers builds the channel rows for these participants, carrying
// over each one's read position, badge, favourite and category from their
// group row. Whoever converted the group owns the channel.
func (s *ChannelService) convertedMembers(ctx context.Context, ch *model.Channel, userIDs []string, rows map[string]*model.UserConversation, now time.Time) []store.ConvertedMember {
	members := make([]store.ConvertedMember, 0, len(userIDs))
	for _, uid := range userIDs {
		role := model.ChannelRoleMember
		if uid == ch.CreatedBy {
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
	return members
}

// finishConversion is everything after the rows moved: everyone's sockets
// follow the channel and are told, drafts move, the system message and the
// search index.
func (s *ChannelService) finishConversion(ctx context.Context, converterID string, conv *model.Conversation, ch *model.Channel) {
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
		"convertedBy":    converterID,
	})
	if s.convertedDrafts != nil {
		s.convertedDrafts.MoveConversationDrafts(ctx, conv.ParticipantIDs, conv.ID)
	}
	s.postSystemMessage(ctx, ch.ID, s.resolveDisplayName(ctx, converterID)+" made this a private channel")
	s.indexChannel(ctx, ch)
}

// resumeConversion finishes a conversion whose member moves stopped partway:
// the store moves a large group in several transactions, and once the first
// landed the group reads as a channel, so whoever wasn't moved yet had no way
// in. Anyone who still has a row for the group is moved now, and then what
// the first attempt never got to runs. A finished conversion has nobody left
// to move.
func (s *ChannelService) resumeConversion(ctx context.Context, conv *model.Conversation) (*model.Channel, error) {
	rows, err := s.conversions.GetUserConversations(ctx, conv.ID, conv.ParticipantIDs)
	if err != nil {
		return nil, fmt.Errorf("channel: read conversation members: %w", err)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("channel: this conversation is a channel already: %w", ErrAlreadyExists)
	}
	ch, err := s.channels.GetChannel(ctx, conv.ConvertedToChannelID)
	if err != nil {
		return nil, fmt.Errorf("channel: get the channel the group became: %w", err)
	}
	pending := make([]string, 0, len(rows))
	for _, uid := range conv.ParticipantIDs {
		if rows[uid] != nil {
			pending = append(pending, uid)
		}
	}
	members := s.convertedMembers(ctx, ch, pending, rows, time.Now())
	if err := s.audienceWritten(ctx, ch.ID, s.conversions.MoveMembersToChannel(ctx, ch.ID, members)); err != nil {
		return nil, fmt.Errorf("channel: finish converting: %w", err)
	}
	s.finishConversion(ctx, ch.CreatedBy, conv, ch)
	return ch, nil
}
