package service

import (
	"context"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// UserStore defines persistence operations for users.
type UserStore interface {
	CreateUser(ctx context.Context, user *model.User) error
	GetUser(ctx context.Context, id string) (*model.User, error)
	GetUserByEmail(ctx context.Context, email string) (*model.User, error)
	UpdateUser(ctx context.Context, user *model.User) error
	ListUsers(ctx context.Context, limit int, cursor string) ([]*model.User, string, error)
	HasUsers(ctx context.Context) (bool, error)
	// NotificationSettingsFor batch-loads account-level notification settings
	// for a set of users so the notifier can decide per-recipient without an
	// N+1 fan-out. Missing users default to DefaultNotificationSettings.
	NotificationSettingsFor(ctx context.Context, userIDs []string) (map[string]model.NotificationSettings, error)
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
	// UserChannelNotifPrefs returns each user's per-channel notification
	// override (muted + the five inherit-or-override fields), batched into a
	// single fan-out instead of one query per user.
	UserChannelNotifPrefs(ctx context.Context, channelID string, userIDs []string) (map[string]*model.UserChannel, error)
	SetMute(ctx context.Context, channelID, userID string, muted bool) error
	SetFavorite(ctx context.Context, channelID, userID string, favorite bool) error
	SetCategory(ctx context.Context, channelID, userID, categoryID string, sidebarPosition *int) error
	// SetNotifPrefs persists a user's per-channel notification overrides;
	// nil fields clear the override back to "inherit account default".
	SetNotifPrefs(ctx context.Context, channelID, userID string, override model.ChannelNotificationOverride) error
}

// ConversationStore defines persistence operations for conversations.
type ConversationStore interface {
	CreateConversation(ctx context.Context, conv *model.Conversation, userConvs []*model.UserConversation) error
	GetConversation(ctx context.Context, id string) (*model.Conversation, error)
	ListUserConversations(ctx context.Context, userID string) ([]*model.UserConversation, error)
	ActivateConversation(ctx context.Context, convID string, participantIDs []string) error
	TouchConversation(ctx context.Context, convID string, participantIDs []string, at time.Time) error
	SetFavorite(ctx context.Context, convID, userID string, favorite bool) error
	SetCategory(ctx context.Context, convID, userID, categoryID string, sidebarPosition *int) error
}

// MessageStore defines persistence operations for messages.
type MessageStore interface {
	CreateMessage(ctx context.Context, msg *model.Message) error
	GetMessage(ctx context.Context, parentID, msgID string) (*model.Message, error)
	UpdateMessage(ctx context.Context, msg *model.Message) error
	DeleteMessage(ctx context.Context, parentID, msgID string) error
	ListMessages(ctx context.Context, parentID string, before string, limit int) ([]*model.Message, bool, error)
	// ListThreadReplies returns every reply to a thread root via the GSI1
	// thread index (one Query, oldest-first) instead of a parent scan.
	ListThreadReplies(ctx context.Context, threadRootID string) ([]*model.Message, error)
	// ListMessagesAfter returns messages strictly newer than the given
	// cursor, oldest-first within the page but with the same
	// newest-first ordering as ListMessages overall.
	ListMessagesAfter(ctx context.Context, parentID, after string, limit int) ([]*model.Message, bool, error)
	// ListMessagesAround returns a window centered on msgID: up to
	// `before` older + the target + up to `after` newer, newest-first.
	ListMessagesAround(ctx context.Context, parentID, msgID string, before, after int) ([]*model.Message, bool, bool, error)
	// IncrementReplyMetadata atomically bumps replyCount, sets
	// lastReplyAt, and merges replyAuthorID into recentReplyAuthorIDs.
	// Returns the updated message so callers can republish authoritative
	// state. ErrNotFound if the parent doesn't exist.
	IncrementReplyMetadata(ctx context.Context, parentID, msgID string, replyTime time.Time, replyAuthorID string) (*model.Message, error)
}

// ParentPinFileIndexStore is the per-parent index used by ListPinned
// and ListFiles. Without it, both code paths fall back to scanning
// recent messages — accurate up to 1000 items but unbounded in
// latency. With it, both queries become O(pinned) / O(files-shared)
// instead of O(messages).
type ParentPinFileIndexStore interface {
	SetPinIndex(ctx context.Context, parentID, msgID, pinnedBy string, pinnedAt time.Time) error
	DeletePinIndex(ctx context.Context, parentID, msgID string) error
	ListPinIndex(ctx context.Context, parentID string) ([]PinIndexEntry, error)

	SetFileIndex(ctx context.Context, parentID, attachmentID, msgID, authorID string, createdAt time.Time) error
	DeleteFileIndex(ctx context.Context, parentID, attachmentID string) error
	ListFileIndex(ctx context.Context, parentID string) ([]FileIndexEntry, error)
}

// PinIndexEntry mirrors store.PinIndexRow at the service-interface
// boundary so the service layer doesn't depend on the store package.
type PinIndexEntry struct {
	MessageID string
	PinnedBy  string
	PinnedAt  time.Time
}

// FileIndexEntry mirrors store.FileIndexRow at the service-interface
// boundary.
type FileIndexEntry struct {
	AttachmentID string
	MessageID    string
	AuthorID     string
	CreatedAt    time.Time
}

// ThreadFollowStore defines per-user follow/unfollow overrides for threads.
type ThreadFollowStore interface {
	SetThreadFollow(ctx context.Context, follow *model.ThreadFollow) error
	// SetThreadFollowMany writes a batch of follows in a single
	// underlying call. Used by the auto-follow-on-mention path so a
	// reply that mentions N people costs one round-trip instead of N.
	SetThreadFollowMany(ctx context.Context, follows []*model.ThreadFollow) error
	GetThreadFollow(ctx context.Context, userID, parentID, threadRootID string) (*model.ThreadFollow, error)
	ListUserThreadFollows(ctx context.Context, userID string) ([]*model.ThreadFollow, error)
	ListThreadFollows(ctx context.Context, parentID, threadRootID string) ([]*model.ThreadFollow, error)
}

type UserStateStore interface {
	SetUserState(ctx context.Context, item *model.UserStateItem) error
	DeleteUserState(ctx context.Context, userID string, kind model.UserStateKind, targetID string) error
	ListUserState(ctx context.Context, userID string) ([]*model.UserStateItem, error)
}

// DraftStore defines persistence operations for server-side message drafts.
type DraftStore interface {
	// Upsert applies the draft using last-write-wins on draft.Ts (client edit
	// time, epoch ms): stale writes are silently dropped by the store.
	Upsert(ctx context.Context, draft *model.MessageDraft) error
	Get(ctx context.Context, userID, id string) (*model.MessageDraft, error)
	List(ctx context.Context, userID string) ([]*model.MessageDraft, error)
	// Delete tombstones the draft at client ts (epoch ms). A delete older than
	// the stored write is a no-op, so it can't remove a newer draft.
	Delete(ctx context.Context, userID, id string, ts int64) error
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
	Get(ctx context.Context, key string, dest interface{}) error
	Set(ctx context.Context, key string, val interface{}, ttl time.Duration) error
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
	AuthURL(state, nonce string) string
	Exchange(ctx context.Context, code, nonce string) (*OIDCUserInfo, error)
}

// OIDCUserInfo holds user profile data returned by the identity provider.
type OIDCUserInfo struct {
	Email   string
	Name    string
	Picture string
}
