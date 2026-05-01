package handler

import (
	"context"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// UserStoreAdapter wraps store.UserStoreImpl to satisfy service.UserStore.
type UserStoreAdapter struct {
	s *store.UserStoreImpl
}

func NewUserStoreAdapter(s *store.UserStoreImpl) *UserStoreAdapter {
	return &UserStoreAdapter{s: s}
}

func (a *UserStoreAdapter) CreateUser(ctx context.Context, user *model.User) error {
	return a.s.Create(ctx, user)
}
func (a *UserStoreAdapter) GetUser(ctx context.Context, id string) (*model.User, error) {
	return a.s.GetByID(ctx, id)
}
func (a *UserStoreAdapter) GetUserByEmail(ctx context.Context, email string) (*model.User, error) {
	return a.s.GetByEmail(ctx, email)
}
func (a *UserStoreAdapter) UpdateUser(ctx context.Context, user *model.User) error {
	return a.s.Update(ctx, user)
}
func (a *UserStoreAdapter) ListUsers(ctx context.Context, limit int, cursor string) ([]*model.User, string, error) {
	return a.s.List(ctx, limit, cursor)
}
func (a *UserStoreAdapter) HasUsers(ctx context.Context) (bool, error) {
	return a.s.HasUsers(ctx)
}

// ChannelStoreAdapter wraps store.ChannelStoreImpl to satisfy service.ChannelStore.
type ChannelStoreAdapter struct {
	s *store.ChannelStoreImpl
}

func NewChannelStoreAdapter(s *store.ChannelStoreImpl) *ChannelStoreAdapter {
	return &ChannelStoreAdapter{s: s}
}

func (a *ChannelStoreAdapter) CreateChannel(ctx context.Context, ch *model.Channel) error {
	return a.s.Create(ctx, ch)
}
func (a *ChannelStoreAdapter) GetChannel(ctx context.Context, id string) (*model.Channel, error) {
	return a.s.GetByID(ctx, id)
}
func (a *ChannelStoreAdapter) GetChannelBySlug(ctx context.Context, slug string) (*model.Channel, error) {
	return a.s.GetBySlug(ctx, slug)
}
func (a *ChannelStoreAdapter) UpdateChannel(ctx context.Context, ch *model.Channel) error {
	return a.s.Update(ctx, ch)
}
func (a *ChannelStoreAdapter) ListPublicChannels(ctx context.Context, limit int, cursor string) ([]*model.Channel, string, error) {
	return a.s.ListPublic(ctx, limit, cursor)
}

// ListAllChannels exposes the underlying store's full Scan for use by
// admin maintenance flows (search reindex). Not part of the service-
// layer ChannelStore interface — only the search reindex pipeline
// reaches for it via the search-source adapter in main.
func (a *ChannelStoreAdapter) ListAllChannels(ctx context.Context) ([]*model.Channel, error) {
	return a.s.ListAll(ctx)
}

// MembershipStoreAdapter wraps store.MembershipStoreImpl to satisfy service.MembershipStore.
type MembershipStoreAdapter struct {
	s *store.MembershipStoreImpl
}

func NewMembershipStoreAdapter(s *store.MembershipStoreImpl) *MembershipStoreAdapter {
	return &MembershipStoreAdapter{s: s}
}

func (a *MembershipStoreAdapter) AddMember(ctx context.Context, membership *model.ChannelMembership, userChannel *model.UserChannel) error {
	// The store's AddChannelMember requires a *model.Channel, but the service
	// interface does not pass one. We construct a minimal Channel with just the
	// ID so the store can build DynamoDB keys.
	ch := &model.Channel{ID: membership.ChannelID}
	return a.s.AddChannelMember(ctx, ch, membership, userChannel)
}
func (a *MembershipStoreAdapter) RemoveMember(ctx context.Context, channelID, userID string) error {
	return a.s.RemoveChannelMember(ctx, channelID, userID)
}
func (a *MembershipStoreAdapter) GetMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	return a.s.GetChannelMembership(ctx, channelID, userID)
}
func (a *MembershipStoreAdapter) UpdateMemberRole(ctx context.Context, channelID, userID string, role model.ChannelRole) error {
	return a.s.UpdateChannelRole(ctx, channelID, userID, role)
}
func (a *MembershipStoreAdapter) ListMembers(ctx context.Context, channelID string) ([]*model.ChannelMembership, error) {
	return a.s.ListChannelMembers(ctx, channelID)
}
func (a *MembershipStoreAdapter) ListUserChannels(ctx context.Context, userID string) ([]*model.UserChannel, error) {
	return a.s.ListUserChannels(ctx, userID)
}
func (a *MembershipStoreAdapter) SetMute(ctx context.Context, channelID, userID string, muted bool) error {
	return a.s.SetUserChannelMute(ctx, channelID, userID, muted)
}
func (a *MembershipStoreAdapter) SetFavorite(ctx context.Context, channelID, userID string, favorite bool) error {
	return a.s.SetUserChannelFavorite(ctx, channelID, userID, favorite)
}
func (a *MembershipStoreAdapter) SetCategory(ctx context.Context, channelID, userID, categoryID string) error {
	return a.s.SetUserChannelCategory(ctx, channelID, userID, categoryID)
}

// ConversationStoreAdapter wraps store.ConversationStoreImpl to satisfy service.ConversationStore.
type ConversationStoreAdapter struct {
	s *store.ConversationStoreImpl
}

func NewConversationStoreAdapter(s *store.ConversationStoreImpl) *ConversationStoreAdapter {
	return &ConversationStoreAdapter{s: s}
}

func (a *ConversationStoreAdapter) CreateConversation(ctx context.Context, conv *model.Conversation, userConvs []*model.UserConversation) error {
	return a.s.Create(ctx, conv, userConvs)
}
func (a *ConversationStoreAdapter) GetConversation(ctx context.Context, id string) (*model.Conversation, error) {
	return a.s.GetByID(ctx, id)
}
func (a *ConversationStoreAdapter) ListUserConversations(ctx context.Context, userID string) ([]*model.UserConversation, error) {
	return a.s.ListUserConversations(ctx, userID)
}
func (a *ConversationStoreAdapter) ActivateConversation(ctx context.Context, convID string, participantIDs []string) error {
	return a.s.Activate(ctx, convID, participantIDs)
}
func (a *ConversationStoreAdapter) SetFavorite(ctx context.Context, convID, userID string, favorite bool) error {
	return a.s.SetUserConversationFavorite(ctx, convID, userID, favorite)
}
func (a *ConversationStoreAdapter) SetCategory(ctx context.Context, convID, userID, categoryID string) error {
	return a.s.SetUserConversationCategory(ctx, convID, userID, categoryID)
}

// ListAllConversations exposes the full conversation Scan to admin
// maintenance flows (search reindex). Same rationale as
// ListAllChannels above — not service-layer surface.
func (a *ConversationStoreAdapter) ListAllConversations(ctx context.Context) ([]*model.Conversation, error) {
	return a.s.ListAll(ctx)
}

// MessageStoreAdapter wraps store.MessageStoreImpl to satisfy service.MessageStore.
type MessageStoreAdapter struct {
	s *store.MessageStoreImpl
}

func NewMessageStoreAdapter(s *store.MessageStoreImpl) *MessageStoreAdapter {
	return &MessageStoreAdapter{s: s}
}

func (a *MessageStoreAdapter) CreateMessage(ctx context.Context, msg *model.Message) error {
	return a.s.Create(ctx, msg)
}
func (a *MessageStoreAdapter) GetMessage(ctx context.Context, parentID, msgID string) (*model.Message, error) {
	return a.s.GetByID(ctx, parentID, msgID)
}
func (a *MessageStoreAdapter) UpdateMessage(ctx context.Context, msg *model.Message) error {
	return a.s.Update(ctx, msg.ParentID, msg)
}
func (a *MessageStoreAdapter) DeleteMessage(ctx context.Context, parentID, msgID string) error {
	return a.s.Delete(ctx, parentID, msgID)
}
func (a *MessageStoreAdapter) ListMessagesAfter(ctx context.Context, parentID, after string, limit int) ([]*model.Message, bool, error) {
	return a.s.ListAfter(ctx, parentID, after, limit)
}
func (a *MessageStoreAdapter) ListMessagesAround(ctx context.Context, parentID, msgID string, before, after int) ([]*model.Message, bool, bool, error) {
	return a.s.ListAround(ctx, parentID, msgID, before, after)
}
func (a *MessageStoreAdapter) ListMessages(ctx context.Context, parentID string, before string, limit int) ([]*model.Message, bool, error) {
	return a.s.List(ctx, parentID, before, limit)
}
func (a *MessageStoreAdapter) IncrementReplyMetadata(ctx context.Context, parentID, msgID string, replyTime time.Time, replyAuthorID string) (*model.Message, error) {
	return a.s.IncrementReplyMetadata(ctx, parentID, msgID, replyTime, replyAuthorID)
}

// InviteStoreAdapter wraps store.InviteStoreImpl to satisfy service.InviteStore.
type InviteStoreAdapter struct {
	s *store.InviteStoreImpl
}

func NewInviteStoreAdapter(s *store.InviteStoreImpl) *InviteStoreAdapter {
	return &InviteStoreAdapter{s: s}
}

func (a *InviteStoreAdapter) CreateInvite(ctx context.Context, inv *model.Invite) error {
	return a.s.Create(ctx, inv)
}
func (a *InviteStoreAdapter) GetInvite(ctx context.Context, token string) (*model.Invite, error) {
	return a.s.GetByToken(ctx, token)
}
func (a *InviteStoreAdapter) DeleteInvite(ctx context.Context, token string) error {
	return a.s.Delete(ctx, token)
}

// TokenStoreAdapter wraps store.TokenStoreImpl to satisfy service.TokenStore.
type TokenStoreAdapter struct {
	s *store.TokenStoreImpl
}

func NewTokenStoreAdapter(s *store.TokenStoreImpl) *TokenStoreAdapter {
	return &TokenStoreAdapter{s: s}
}

func (a *TokenStoreAdapter) StoreRefreshToken(ctx context.Context, rt *model.RefreshToken) error {
	return a.s.Create(ctx, rt)
}
func (a *TokenStoreAdapter) GetRefreshToken(ctx context.Context, tokenHash string) (*model.RefreshToken, error) {
	return a.s.GetByHash(ctx, tokenHash)
}
func (a *TokenStoreAdapter) DeleteRefreshToken(ctx context.Context, tokenHash string) error {
	return a.s.Delete(ctx, tokenHash)
}
func (a *TokenStoreAdapter) DeleteAllRefreshTokensForUser(ctx context.Context, userID string) error {
	return a.s.DeleteAllForUser(ctx, userID)
}
