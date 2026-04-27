package service

import (
	"context"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/events"
)

// UserStore defines persistence operations for users.
type UserStore interface {
	CreateUser(ctx context.Context, user *model.User) error
	GetUser(ctx context.Context, id string) (*model.User, error)
	GetUserByEmail(ctx context.Context, email string) (*model.User, error)
	UpdateUser(ctx context.Context, user *model.User) error
	ListUsers(ctx context.Context, limit int, cursor string) ([]*model.User, string, error)
	HasUsers(ctx context.Context) (bool, error)
}

// ChannelStore defines persistence operations for channels.
type ChannelStore interface {
	CreateChannel(ctx context.Context, ch *model.Channel) error
	GetChannel(ctx context.Context, id string) (*model.Channel, error)
	GetChannelBySlug(ctx context.Context, slug string) (*model.Channel, error)
	UpdateChannel(ctx context.Context, ch *model.Channel) error
	ListPublicChannels(ctx context.Context, limit int, cursor string) ([]*model.Channel, string, error)
}

// MembershipStore defines persistence operations for channel memberships.
type MembershipStore interface {
	AddMember(ctx context.Context, membership *model.ChannelMembership, userChannel *model.UserChannel) error
	RemoveMember(ctx context.Context, channelID, userID string) error
	GetMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error)
	UpdateMemberRole(ctx context.Context, channelID, userID string, role model.ChannelRole) error
	ListMembers(ctx context.Context, channelID string) ([]*model.ChannelMembership, error)
	ListUserChannels(ctx context.Context, userID string) ([]*model.UserChannel, error)
	SetMute(ctx context.Context, channelID, userID string, muted bool) error
	SetFavorite(ctx context.Context, channelID, userID string, favorite bool) error
	SetCategory(ctx context.Context, channelID, userID, categoryID string) error
}

// ConversationStore defines persistence operations for conversations.
type ConversationStore interface {
	CreateConversation(ctx context.Context, conv *model.Conversation, userConvs []*model.UserConversation) error
	GetConversation(ctx context.Context, id string) (*model.Conversation, error)
	ListUserConversations(ctx context.Context, userID string) ([]*model.UserConversation, error)
	ActivateConversation(ctx context.Context, convID string, participantIDs []string) error
	SetFavorite(ctx context.Context, convID, userID string, favorite bool) error
	SetCategory(ctx context.Context, convID, userID, categoryID string) error
}

// MessageStore defines persistence operations for messages.
type MessageStore interface {
	CreateMessage(ctx context.Context, msg *model.Message) error
	GetMessage(ctx context.Context, parentID, msgID string) (*model.Message, error)
	UpdateMessage(ctx context.Context, msg *model.Message) error
	DeleteMessage(ctx context.Context, parentID, msgID string) error
	ListMessages(ctx context.Context, parentID string, before string, limit int) ([]*model.Message, bool, error)
}

// InviteStore defines persistence operations for invitations.
type InviteStore interface {
	CreateInvite(ctx context.Context, inv *model.Invite) error
	GetInvite(ctx context.Context, token string) (*model.Invite, error)
	DeleteInvite(ctx context.Context, token string) error
}

// TokenStore defines persistence operations for refresh tokens.
type TokenStore interface {
	StoreRefreshToken(ctx context.Context, rt *model.RefreshToken) error
	GetRefreshToken(ctx context.Context, tokenHash string) (*model.RefreshToken, error)
	DeleteRefreshToken(ctx context.Context, tokenHash string) error
	DeleteAllRefreshTokensForUser(ctx context.Context, userID string) error
}

// Cache defines cache operations used by the service layer.
type Cache interface {
	GetUser(ctx context.Context, id string) (*model.User, error)
	SetUser(ctx context.Context, user *model.User) error
	Delete(ctx context.Context, key string) error
}

// Publisher is an alias for events.Publisher; defined in the events package
// so that publish helpers can take a single canonical interface.
type Publisher = events.Publisher

// Broker manages real-time client subscriptions.
type Broker interface {
	Subscribe(clientID, channel string)
	Unsubscribe(clientID, channel string)
}

// JWTProvider generates and validates JWT tokens.
type JWTProvider interface {
	GenerateAccessToken(user *model.User) (string, error)
	GenerateRefreshToken() (raw string, hash string, err error)
	RefreshTTL() time.Duration
}

// OIDCProvider handles OpenID Connect authentication flows.
type OIDCProvider interface {
	AuthURL(state string) string
	Exchange(ctx context.Context, code string) (*OIDCUserInfo, error)
}

// OIDCUserInfo holds user profile data returned by the identity provider.
type OIDCUserInfo struct {
	Email   string
	Name    string
	Picture string
}
