package service

import (
	"context"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// --- Mock UserStore ---

type mockUserStore struct {
	users        map[string]*model.User
	emailIndex   map[string]*model.User
	createErr    error
	hasUsersVal  bool
	hasUsersErr  error
	getUserErr   error
	getEmailErr  error
	updateErr    error
	listErr      error
}

func newMockUserStore() *mockUserStore {
	return &mockUserStore{
		users:      make(map[string]*model.User),
		emailIndex: make(map[string]*model.User),
	}
}

func (m *mockUserStore) CreateUser(_ context.Context, u *model.User) error {
	if m.createErr != nil {
		return m.createErr
	}
	m.users[u.ID] = u
	m.emailIndex[u.Email] = u
	return nil
}

func (m *mockUserStore) GetUser(_ context.Context, id string) (*model.User, error) {
	if m.getUserErr != nil {
		return nil, m.getUserErr
	}
	u, ok := m.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return u, nil
}

func (m *mockUserStore) GetUserByEmail(_ context.Context, email string) (*model.User, error) {
	if m.getEmailErr != nil {
		return nil, m.getEmailErr
	}
	u, ok := m.emailIndex[email]
	if !ok {
		return nil, store.ErrNotFound
	}
	return u, nil
}

func (m *mockUserStore) UpdateUser(_ context.Context, u *model.User) error {
	if m.updateErr != nil {
		return m.updateErr
	}
	m.users[u.ID] = u
	m.emailIndex[u.Email] = u
	return nil
}

func (m *mockUserStore) ListUsers(_ context.Context, _ int, _ string) ([]*model.User, string, error) {
	if m.listErr != nil {
		return nil, "", m.listErr
	}
	var result []*model.User
	for _, u := range m.users {
		result = append(result, u)
	}
	return result, "", nil
}

func (m *mockUserStore) HasUsers(_ context.Context) (bool, error) {
	if m.hasUsersErr != nil {
		return false, m.hasUsersErr
	}
	return m.hasUsersVal, nil
}

// --- Mock TokenStore ---

type mockTokenStore struct {
	tokens    map[string]*model.RefreshToken
	storeErr  error
	getErr    error
	deleteErr error
}

func newMockTokenStore() *mockTokenStore {
	return &mockTokenStore{tokens: make(map[string]*model.RefreshToken)}
}

func (m *mockTokenStore) StoreRefreshToken(_ context.Context, rt *model.RefreshToken) error {
	if m.storeErr != nil {
		return m.storeErr
	}
	m.tokens[rt.TokenHash] = rt
	return nil
}

func (m *mockTokenStore) GetRefreshToken(_ context.Context, hash string) (*model.RefreshToken, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	rt, ok := m.tokens[hash]
	if !ok {
		return nil, store.ErrNotFound
	}
	return rt, nil
}

func (m *mockTokenStore) DeleteRefreshToken(_ context.Context, hash string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.tokens, hash)
	return nil
}

func (m *mockTokenStore) DeleteAllRefreshTokensForUser(_ context.Context, userID string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	for hash, rt := range m.tokens {
		if rt.UserID == userID {
			delete(m.tokens, hash)
		}
	}
	return nil
}

// --- Mock InviteStore ---

type mockInviteStore struct {
	invites   map[string]*model.Invite
	createErr error
	getErr    error
	deleteErr error
}

func newMockInviteStore() *mockInviteStore {
	return &mockInviteStore{invites: make(map[string]*model.Invite)}
}

func (m *mockInviteStore) CreateInvite(_ context.Context, inv *model.Invite) error {
	if m.createErr != nil {
		return m.createErr
	}
	m.invites[inv.Token] = inv
	return nil
}

func (m *mockInviteStore) GetInvite(_ context.Context, token string) (*model.Invite, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	inv, ok := m.invites[token]
	if !ok {
		return nil, store.ErrNotFound
	}
	return inv, nil
}

func (m *mockInviteStore) DeleteInvite(_ context.Context, token string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.invites, token)
	return nil
}

// --- Mock MembershipStore ---

type mockMembershipStore struct {
	memberships     map[string]*model.ChannelMembership // key: channelID + "#" + userID
	mutes           map[string]bool                     // key: channelID + "#" + userID
	userChannels    []*model.UserChannel                // override for ListUserChannels
	addErr          error
	removeErr       error
	getErr          error
	updateRoleErr   error
	listMembersErr  error
	listChannelsErr error
	setMuteErr      error
}

func newMockMembershipStore() *mockMembershipStore {
	return &mockMembershipStore{
		memberships: make(map[string]*model.ChannelMembership),
		mutes:       make(map[string]bool),
	}
}

func (m *mockMembershipStore) AddMember(_ context.Context, mem *model.ChannelMembership, _ *model.UserChannel) error {
	if m.addErr != nil {
		return m.addErr
	}
	key := mem.ChannelID + "#" + mem.UserID
	m.memberships[key] = mem
	return nil
}

func (m *mockMembershipStore) RemoveMember(_ context.Context, channelID, userID string) error {
	if m.removeErr != nil {
		return m.removeErr
	}
	delete(m.memberships, channelID+"#"+userID)
	// Keep the userChannels override in sync so ListUserChannels reflects
	// the removal — otherwise tests that pre-seed both maps see stale rows.
	if m.userChannels != nil {
		filtered := m.userChannels[:0]
		for _, uc := range m.userChannels {
			if uc.UserID == userID && uc.ChannelID == channelID {
				continue
			}
			filtered = append(filtered, uc)
		}
		m.userChannels = filtered
	}
	return nil
}

func (m *mockMembershipStore) GetMembership(_ context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	mem, ok := m.memberships[channelID+"#"+userID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return mem, nil
}

func (m *mockMembershipStore) UpdateMemberRole(_ context.Context, channelID, userID string, role model.ChannelRole) error {
	if m.updateRoleErr != nil {
		return m.updateRoleErr
	}
	key := channelID + "#" + userID
	if mem, ok := m.memberships[key]; ok {
		mem.Role = role
	}
	return nil
}

func (m *mockMembershipStore) ListMembers(_ context.Context, channelID string) ([]*model.ChannelMembership, error) {
	if m.listMembersErr != nil {
		return nil, m.listMembersErr
	}
	var result []*model.ChannelMembership
	for _, mem := range m.memberships {
		if mem.ChannelID == channelID {
			result = append(result, mem)
		}
	}
	return result, nil
}

func (m *mockMembershipStore) ListUserChannels(_ context.Context, userID string) ([]*model.UserChannel, error) {
	if m.listChannelsErr != nil {
		return nil, m.listChannelsErr
	}
	if m.userChannels != nil {
		var result []*model.UserChannel
		for _, uc := range m.userChannels {
			if uc.UserID == userID {
				result = append(result, uc)
			}
		}
		return result, nil
	}
	return nil, nil
}

func (m *mockMembershipStore) SetMute(_ context.Context, channelID, userID string, muted bool) error {
	if m.setMuteErr != nil {
		return m.setMuteErr
	}
	m.mutes[channelID+"#"+userID] = muted
	return nil
}

func (m *mockMembershipStore) SetFavorite(_ context.Context, channelID, userID string, favorite bool) error {
	for _, uc := range m.userChannels {
		if uc.UserID == userID && uc.ChannelID == channelID {
			uc.Favorite = favorite
			return nil
		}
	}
	return store.ErrNotFound
}

func (m *mockMembershipStore) SetCategory(_ context.Context, channelID, userID, categoryID string) error {
	for _, uc := range m.userChannels {
		if uc.UserID == userID && uc.ChannelID == channelID {
			uc.CategoryID = categoryID
			return nil
		}
	}
	return store.ErrNotFound
}

// --- Mock ChannelStore ---

type mockChannelStore struct {
	channels  map[string]*model.Channel
	createErr error
	getErr    error
	slugErr   error
	updateErr error
	listErr   error
}

func newMockChannelStore() *mockChannelStore {
	return &mockChannelStore{channels: make(map[string]*model.Channel)}
}

func (m *mockChannelStore) CreateChannel(_ context.Context, ch *model.Channel) error {
	if m.createErr != nil {
		return m.createErr
	}
	if _, exists := m.channels[ch.ID]; exists {
		return store.ErrAlreadyExists
	}
	m.channels[ch.ID] = ch
	return nil
}

func (m *mockChannelStore) GetChannel(_ context.Context, id string) (*model.Channel, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	ch, ok := m.channels[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return ch, nil
}

func (m *mockChannelStore) GetChannelBySlug(_ context.Context, slug string) (*model.Channel, error) {
	if m.slugErr != nil {
		return nil, m.slugErr
	}
	for _, ch := range m.channels {
		if ch.Slug == slug {
			return ch, nil
		}
	}
	return nil, store.ErrNotFound
}

func (m *mockChannelStore) UpdateChannel(_ context.Context, ch *model.Channel) error {
	if m.updateErr != nil {
		return m.updateErr
	}
	m.channels[ch.ID] = ch
	return nil
}

func (m *mockChannelStore) ListPublicChannels(_ context.Context, _ int, _ string) ([]*model.Channel, string, error) {
	if m.listErr != nil {
		return nil, "", m.listErr
	}
	out := make([]*model.Channel, 0, len(m.channels))
	for _, c := range m.channels {
		if c.Type == model.ChannelTypePublic {
			out = append(out, c)
		}
	}
	return out, "", nil
}

// --- Mock Cache ---

type mockCache struct {
	users     map[string]*model.User
	getErr    error
	setErr    error
	deleteErr error
}

func newMockCache() *mockCache {
	return &mockCache{users: make(map[string]*model.User)}
}

func (m *mockCache) GetUser(_ context.Context, id string) (*model.User, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	u, ok := m.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return u, nil
}

func (m *mockCache) SetUser(_ context.Context, u *model.User) error {
	if m.setErr != nil {
		return m.setErr
	}
	m.users[u.ID] = u
	return nil
}

func (m *mockCache) Delete(_ context.Context, key string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	delete(m.users, key)
	return nil
}

// --- Mock JWTProvider ---

type mockJWTProvider struct {
	accessToken     string
	accessTokenErr  error
	refreshRaw      string
	refreshHash     string
	refreshTokenErr error
	refreshTTL      time.Duration
}

func newMockJWTProvider() *mockJWTProvider {
	return &mockJWTProvider{
		accessToken: "mock-access-token",
		refreshRaw:  "mock-refresh-raw",
		refreshHash: "mock-refresh-hash",
		refreshTTL:  720 * time.Hour,
	}
}

func (m *mockJWTProvider) GenerateAccessToken(_ *model.User) (string, error) {
	return m.accessToken, m.accessTokenErr
}

func (m *mockJWTProvider) GenerateRefreshToken() (string, string, error) {
	return m.refreshRaw, m.refreshHash, m.refreshTokenErr
}

func (m *mockJWTProvider) RefreshTTL() time.Duration {
	return m.refreshTTL
}

// --- Mock OIDCProvider ---

type mockOIDCProvider struct {
	authURL     string
	userInfo    *OIDCUserInfo
	exchangeErr error
}

func (m *mockOIDCProvider) AuthURL(state string) string {
	return m.authURL + "?state=" + state
}

func (m *mockOIDCProvider) Exchange(_ context.Context, _ string) (*OIDCUserInfo, error) {
	if m.exchangeErr != nil {
		return nil, m.exchangeErr
	}
	return m.userInfo, nil
}

// --- Mock Broker ---

type mockBroker struct {
	mu              sync.Mutex
	subscriptions   map[string][]string // userID -> channels
	unsubscriptions map[string][]string
}

func newMockBroker() *mockBroker {
	return &mockBroker{
		subscriptions:   make(map[string][]string),
		unsubscriptions: make(map[string][]string),
	}
}

func (m *mockBroker) Subscribe(clientID, channel string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.subscriptions[clientID] = append(m.subscriptions[clientID], channel)
}

func (m *mockBroker) Unsubscribe(clientID, channel string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.unsubscriptions[clientID] = append(m.unsubscriptions[clientID], channel)
}

// --- Mock Publisher ---

type mockPublisher struct {
	mu         sync.Mutex
	published  []publishedEvent
	publishErr error
}

type publishedEvent struct {
	channel string
	event   *events.Event
}

func newMockPublisher() *mockPublisher {
	return &mockPublisher{}
}

func (m *mockPublisher) Publish(_ context.Context, channel string, event *events.Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.published = append(m.published, publishedEvent{channel: channel, event: event})
	return m.publishErr
}

// --- Mock ConversationStore ---

type mockConversationStore struct {
	conversations map[string]*model.Conversation
	userConvs     map[string][]*model.UserConversation // userID -> conversations
	createErr     error
	getErr        error
	listErr       error
}

func newMockConversationStore() *mockConversationStore {
	return &mockConversationStore{
		conversations: make(map[string]*model.Conversation),
		userConvs:     make(map[string][]*model.UserConversation),
	}
}

func (m *mockConversationStore) CreateConversation(_ context.Context, conv *model.Conversation, userConvs []*model.UserConversation) error {
	if m.createErr != nil {
		return m.createErr
	}
	if _, exists := m.conversations[conv.ID]; exists {
		return store.ErrAlreadyExists
	}
	m.conversations[conv.ID] = conv
	for _, uc := range userConvs {
		m.userConvs[uc.UserID] = append(m.userConvs[uc.UserID], uc)
	}
	return nil
}

func (m *mockConversationStore) GetConversation(_ context.Context, id string) (*model.Conversation, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	conv, ok := m.conversations[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return conv, nil
}

func (m *mockConversationStore) ListUserConversations(_ context.Context, userID string) ([]*model.UserConversation, error) {
	if m.listErr != nil {
		return nil, m.listErr
	}
	return m.userConvs[userID], nil
}

func (m *mockConversationStore) ActivateConversation(_ context.Context, convID string, participantIDs []string) error {
	if conv, ok := m.conversations[convID]; ok {
		conv.Activated = true
	}
	for _, uid := range participantIDs {
		for _, uc := range m.userConvs[uid] {
			if uc.ConversationID == convID {
				uc.Activated = true
			}
		}
	}
	return nil
}

func (m *mockConversationStore) SetFavorite(_ context.Context, convID, userID string, favorite bool) error {
	for _, uc := range m.userConvs[userID] {
		if uc.ConversationID == convID {
			uc.Favorite = favorite
			return nil
		}
	}
	return store.ErrNotFound
}

func (m *mockConversationStore) SetCategory(_ context.Context, convID, userID, categoryID string) error {
	for _, uc := range m.userConvs[userID] {
		if uc.ConversationID == convID {
			uc.CategoryID = categoryID
			return nil
		}
	}
	return store.ErrNotFound
}

// --- Mock MessageStore ---

type mockMessageStore struct {
	messages  map[string]*model.Message // key: parentID + "#" + msgID
	createErr error
	getErr    error
	updateErr error
	deleteErr error
	listErr   error
}

func newMockMessageStore() *mockMessageStore {
	return &mockMessageStore{messages: make(map[string]*model.Message)}
}

func (m *mockMessageStore) CreateMessage(_ context.Context, msg *model.Message) error {
	if m.createErr != nil {
		return m.createErr
	}
	key := msg.ParentID + "#" + msg.ID
	m.messages[key] = msg
	return nil
}

func (m *mockMessageStore) GetMessage(_ context.Context, parentID, msgID string) (*model.Message, error) {
	if m.getErr != nil {
		return nil, m.getErr
	}
	key := parentID + "#" + msgID
	msg, ok := m.messages[key]
	if !ok {
		return nil, store.ErrNotFound
	}
	return msg, nil
}

func (m *mockMessageStore) UpdateMessage(_ context.Context, msg *model.Message) error {
	if m.updateErr != nil {
		return m.updateErr
	}
	key := msg.ParentID + "#" + msg.ID
	m.messages[key] = msg
	return nil
}

func (m *mockMessageStore) DeleteMessage(_ context.Context, parentID, msgID string) error {
	if m.deleteErr != nil {
		return m.deleteErr
	}
	key := parentID + "#" + msgID
	delete(m.messages, key)
	return nil
}

func (m *mockMessageStore) ListMessages(_ context.Context, parentID string, _ string, _ int) ([]*model.Message, bool, error) {
	if m.listErr != nil {
		return nil, false, m.listErr
	}
	var result []*model.Message
	for _, msg := range m.messages {
		if msg.ParentID == parentID {
			result = append(result, msg)
		}
	}
	return result, false, nil
}
