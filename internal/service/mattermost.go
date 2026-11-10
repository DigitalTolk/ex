package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// MattermostService backs the Mattermost-compatible API (/api/v4): what an
// integration written against Mattermost asks for, done the ex way, as the bot
// whose token it holds. The handler speaks Mattermost's wire format; this
// decides, through the same services the app uses, so a bot can do exactly
// what a member could: create a channel (and own it), add people to a channel
// it is in, post where it is a member, and message someone directly.

// MattermostChannels is the channel side (ChannelService).
type MattermostChannels interface {
	Create(ctx context.Context, userID, name string, chanType model.ChannelType, description string) (*model.Channel, error)
	GetByID(ctx context.Context, id string) (*model.Channel, error)
	AddMember(ctx context.Context, actorID, channelID, userID string, role model.ChannelRole) error
}

// MattermostMessages posts (MessageService).
type MattermostMessages interface {
	Send(ctx context.Context, userID, parentID, parentType, body, parentMessageID string, attachmentIDs ...string) (*model.Message, error)
}

// MattermostDMs opens direct conversations (ConversationService).
type MattermostDMs interface {
	GetOrCreateDM(ctx context.Context, userA, userB string) (*model.Conversation, error)
}

// MarkupTranslator turns Mattermost message markup into ex's
// (IncomingWebhookService).
type MarkupTranslator interface {
	TranslateMarkup(ctx context.Context, text string) string
}

// MembershipGetter reads one channel membership (the membership store).
type MembershipGetter interface {
	GetMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error)
}

// MattermostService carries out the Mattermost API's calls.
type MattermostService struct {
	channels      MattermostChannels
	memberships   MembershipGetter
	users         UserStore
	messages      MattermostMessages
	conversations MattermostDMs
	markup        MarkupTranslator
}

// NewMattermostService wires the Mattermost API's service.
func NewMattermostService(channels MattermostChannels, memberships MembershipGetter, users UserStore, messages MattermostMessages, conversations MattermostDMs, markup MarkupTranslator) *MattermostService {
	return &MattermostService{
		channels:      channels,
		memberships:   memberships,
		users:         users,
		messages:      messages,
		conversations: conversations,
		markup:        markup,
	}
}

// CreateChannel creates a channel owned by the bot creating it. Its name is
// the Mattermost name (ex channels have no separate display name), its
// purpose the description.
func (s *MattermostService) CreateChannel(ctx context.Context, actorID, name string, private bool, purpose string) (*model.Channel, error) {
	chanType := model.ChannelTypePublic
	if private {
		chanType = model.ChannelTypePrivate
	}
	return s.channels.Create(ctx, actorID, name, chanType, purpose)
}

// AddChannelMember adds userID to a channel the actor is in, and returns the
// membership. Adding someone already there changes nothing and answers the
// same, as Mattermost does: an integration re-inviting whoever is relevant
// must not demote an admin or repeat the "was added" line.
func (s *MattermostService) AddChannelMember(ctx context.Context, actorID, channelID, userID string) (*model.ChannelMembership, error) {
	// The channel would otherwise take any ID as a member.
	if _, err := s.users.GetUser(ctx, userID); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, apperr.NotFound("user not found")
		}
		return nil, fmt.Errorf("mattermost: get user: %w", err)
	}
	if err := s.channels.AddMember(ctx, actorID, channelID, userID, model.ChannelRoleMember); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
		return nil, err
	}
	m, err := s.memberships.GetMembership(ctx, channelID, userID)
	if err != nil {
		return nil, fmt.Errorf("mattermost: get membership: %w", err)
	}
	return m, nil
}

// CreatePost posts message to a channel or a direct conversation (Mattermost
// calls both channels), as a reply when rootID names a thread. Mattermost
// markup in the text becomes ex's.
func (s *MattermostService) CreatePost(ctx context.Context, actorID, channelID, message, rootID string) (*model.Message, error) {
	parentType := ParentChannel
	if _, err := s.channels.GetByID(ctx, channelID); err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
		parentType = ParentConversation
	}
	return s.messages.Send(ctx, actorID, channelID, parentType, s.markup.TranslateMarkup(ctx, message), rootID)
}

// DirectChannel opens (or finds) the direct conversation between the actor
// and one other user. Mattermost takes the pair as two user IDs, the caller's
// among them.
func (s *MattermostService) DirectChannel(ctx context.Context, actorID string, userIDs []string) (*model.Conversation, error) {
	if len(userIDs) != 2 {
		return nil, apperr.Invalid("a direct channel takes two user IDs")
	}
	other := userIDs[0]
	switch actorID {
	case userIDs[0]:
		other = userIDs[1]
	case userIDs[1]:
	default:
		return nil, apperr.Forbidden("a direct channel must include you")
	}
	return s.conversations.GetOrCreateDM(ctx, actorID, other)
}
