package service

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// --- Mock UserStore ---

type mockUserStore struct {
	users       map[string]*model.User
	emailIndex  map[string]*model.User
	createErr   error
	hasUsersVal bool
	hasUsersErr error
	getUserErr  error
	getEmailErr error
	updateErr   error
	listErr     error
	notifErr    error
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

func (m *mockUserStore) NotificationSettingsFor(_ context.Context, userIDs []string) (map[string]model.NotificationSettings, error) {
	if m.notifErr != nil {
		return nil, m.notifErr
	}
	out := make(map[string]model.NotificationSettings)
	for _, uid := range userIDs {
		u, ok := m.users[uid]
		if !ok {
			continue
		}
		if u.NotificationSettings != nil {
			out[uid] = *u.NotificationSettings
		} else {
			out[uid] = model.DefaultNotificationSettings()
		}
	}
	return out, nil
}

// --- Mock TokenStore ---

type mockTokenStore struct {
	tokens     map[string]*model.RefreshToken
	storeErr   error
	getErr     error
	getErrHash map[string]error // per-hash Get failures
	deleteErr  error
	rotateErr  error
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
	if err, ok := m.getErrHash[hash]; ok {
		return nil, err
	}
	rt, ok := m.tokens[hash]
	if !ok {
		return nil, store.ErrNotFound
	}
	return rt, nil
}

func (m *mockTokenStore) MarkRefreshTokenRotated(_ context.Context, hash string, rotatedAt time.Time, supersededBy string) error {
	if m.rotateErr != nil {
		return m.rotateErr
	}
	rt, ok := m.tokens[hash]
	if !ok {
		return store.ErrNotFound
	}
	t := rotatedAt
	rt.RotatedAt = &t
	rt.SupersededBy = supersededBy
	return nil
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
	memberships       map[string]*model.ChannelMembership // key: channelID + "#" + userID
	mutes             map[string]bool                     // key: channelID + "#" + userID
	userChannels      []*model.UserChannel                // override for ListUserChannels
	addErr            error
	removeErr         error
	getErr            error
	getErrForUser     string // per-user GetMembership failure
	getErrForUserSkip int    // matching calls to let through before failing
	updateRoleErr     error
	listMembersErr    error
	listChannelsErr   error
	setMuteErr        error
	setNotifErr       error
	lastReadSeqs      map[string]int64 // key: channelID + "#" + userID
	setLastReadErr    error
	addedUserChannels map[string]*model.UserChannel // key: channelID + "#" + userID
}

func newMockMembershipStore() *mockMembershipStore {
	return &mockMembershipStore{
		memberships: make(map[string]*model.ChannelMembership),
		mutes:       make(map[string]bool),
	}
}

func (m *mockMembershipStore) AddMember(_ context.Context, mem *model.ChannelMembership, uc *model.UserChannel) error {
	if m.addErr != nil {
		return m.addErr
	}
	key := mem.ChannelID + "#" + mem.UserID
	m.memberships[key] = mem
	if m.addedUserChannels == nil {
		m.addedUserChannels = make(map[string]*model.UserChannel)
	}
	m.addedUserChannels[key] = uc
	return nil
}

// mockUnreadSeqStore is the shared UnreadSeqStore fake for both channels and
// conversations: a monotonically increasing per-parent counter plus a recorded
// per-(parent,user) last-read. Mutex-guarded because bumpUnreadSeq writes it
// from a detached goroutine while the test reads it back.
type mockUnreadSeqStore struct {
	mu        sync.Mutex
	seq       map[string]int64
	lastReads map[string]int64 // key: parentID + "#" + userID
	err       error
	lastErr   error
}

func (m *mockUnreadSeqStore) IncrementMessageSeq(_ context.Context, parentID string) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return 0, m.err
	}
	if m.seq == nil {
		m.seq = make(map[string]int64)
	}
	m.seq[parentID]++
	return m.seq[parentID], nil
}

func (m *mockUnreadSeqStore) SetLastRead(_ context.Context, parentID, userID string, seq int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.lastErr != nil {
		return m.lastErr
	}
	if m.lastReads == nil {
		m.lastReads = make(map[string]int64)
	}
	m.lastReads[parentID+"#"+userID] = seq
	return nil
}

func (m *mockUnreadSeqStore) count(parentID string) int64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.seq[parentID]
}

func (m *mockUnreadSeqStore) lastRead(parentID, userID string) (int64, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.lastReads[parentID+"#"+userID]
	return v, ok
}

// convSeqStore adapts a mockConversationStore to UnreadSeqStore so an
// end-to-end test's seq bump lands on the same store ListUserConversations
// reads (mirrors handler.UnreadSeqAdapter). The conversation store owns both
// the counter and the per-user last-read.
type convSeqStore struct{ s *mockConversationStore }

func (a convSeqStore) IncrementMessageSeq(ctx context.Context, parentID string) (int64, error) {
	return a.s.IncrementMessageSeq(ctx, parentID)
}
func (a convSeqStore) SetLastRead(ctx context.Context, parentID, userID string, seq int64) error {
	return a.s.SetConversationLastRead(ctx, parentID, userID, seq)
}

// waitForCond polls cond until it holds (or fails the test), for asserting the
// effects of detached goroutines without a sleep-and-hope.
func waitForCond(t *testing.T, cond func() bool, desc string) {
	t.Helper()
	for range 200 {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", desc)
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
	if m.getErrForUser != "" && m.getErrForUser == userID {
		if m.getErrForUserSkip > 0 {
			m.getErrForUserSkip--
		} else {
			return nil, errors.New("injected membership get failure")
		}
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

func (m *mockMembershipStore) UserChannelNotifPrefs(_ context.Context, channelID string, userIDs []string) (map[string]*model.UserChannel, error) {
	if m.listChannelsErr != nil {
		return nil, m.listChannelsErr
	}
	want := make(map[string]bool, len(userIDs))
	for _, uid := range userIDs {
		want[uid] = true
	}
	out := make(map[string]*model.UserChannel)
	for _, uc := range m.userChannels {
		if uc.ChannelID == channelID && want[uc.UserID] {
			cp := *uc
			out[uc.UserID] = &cp
		}
	}
	for _, uid := range userIDs {
		if !m.mutes[channelID+"#"+uid] {
			continue
		}
		if existing, ok := out[uid]; ok {
			existing.Muted = true
		} else {
			out[uid] = &model.UserChannel{UserID: uid, ChannelID: channelID, Muted: true}
		}
	}
	return out, nil
}

func (m *mockMembershipStore) SetMute(_ context.Context, channelID, userID string, muted bool) error {
	if m.setMuteErr != nil {
		return m.setMuteErr
	}
	m.mutes[channelID+"#"+userID] = muted
	return nil
}

func (m *mockMembershipStore) SetChannelLastRead(_ context.Context, channelID, userID string, seq int64) error {
	if m.setLastReadErr != nil {
		return m.setLastReadErr
	}
	if m.lastReadSeqs == nil {
		m.lastReadSeqs = make(map[string]int64)
	}
	m.lastReadSeqs[channelID+"#"+userID] = seq
	return nil
}

func (m *mockMembershipStore) SetNotifPrefs(_ context.Context, channelID, userID string, o model.ChannelNotificationOverride) error {
	if m.setNotifErr != nil {
		return m.setNotifErr
	}
	for _, uc := range m.userChannels {
		if uc.UserID == userID && uc.ChannelID == channelID {
			uc.DesktopLevel = o.DesktopLevel
			uc.MobileLevel = o.MobileLevel
			uc.ThreadReplies = o.ThreadReplies
			uc.IgnoreGroupMentions = o.IgnoreGroupMentions
			uc.FollowAllThreads = o.FollowAllThreads
			return nil
		}
	}
	return store.ErrNotFound
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

func (m *mockMembershipStore) SetCategory(_ context.Context, channelID, userID, categoryID string, sidebarPosition *int) error {
	for _, uc := range m.userChannels {
		if uc.UserID == userID && uc.ChannelID == channelID {
			uc.CategoryID = categoryID
			if sidebarPosition != nil {
				uc.SidebarPosition = *sidebarPosition
			}
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
	values    map[string]interface{}
	getErr    error
	setErr    error
	deleteErr error
}

func newMockCache() *mockCache {
	return &mockCache{users: make(map[string]*model.User), values: make(map[string]interface{})}
}

func (m *mockCache) Get(_ context.Context, key string, dest interface{}) error {
	if m.getErr != nil {
		return m.getErr
	}
	value, ok := m.values[key]
	if !ok {
		return store.ErrNotFound
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, dest)
}

func (m *mockCache) Set(_ context.Context, key string, val interface{}, _ time.Duration) error {
	if m.setErr != nil {
		return m.setErr
	}
	m.values[key] = val
	return nil
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
	delete(m.values, key)
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

func (m *mockOIDCProvider) AuthURL(state, nonce string) string {
	return m.authURL + "?state=" + state + "&nonce=" + nonce
}

func (m *mockOIDCProvider) Exchange(_ context.Context, _, _ string) (*OIDCUserInfo, error) {
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
	touchErr      error
	activateErr   error
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
	if m.activateErr != nil {
		return m.activateErr
	}
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

func (m *mockConversationStore) TouchConversation(_ context.Context, convID string, participantIDs []string, at time.Time) error {
	if m.touchErr != nil {
		return m.touchErr
	}
	if conv, ok := m.conversations[convID]; ok {
		conv.UpdatedAt = at
	}
	for _, uid := range participantIDs {
		for _, uc := range m.userConvs[uid] {
			if uc.ConversationID == convID {
				uc.UpdatedAt = at
			}
		}
	}
	return nil
}

func (m *mockConversationStore) IncrementMessageSeq(_ context.Context, convID string) (int64, error) {
	conv, ok := m.conversations[convID]
	if !ok {
		return 0, store.ErrNotFound
	}
	conv.MessageSeq++
	return conv.MessageSeq, nil
}

func (m *mockConversationStore) SetConversationLastRead(_ context.Context, convID, userID string, seq int64) error {
	for _, uc := range m.userConvs[userID] {
		if uc.ConversationID == convID {
			uc.LastReadSeq = seq
			return nil
		}
	}
	return store.ErrNotFound
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

func (m *mockConversationStore) SetCategory(_ context.Context, convID, userID, categoryID string, sidebarPosition *int) error {
	for _, uc := range m.userConvs[userID] {
		if uc.ConversationID == convID {
			uc.CategoryID = categoryID
			if sidebarPosition != nil {
				uc.SidebarPosition = *sidebarPosition
			}
			return nil
		}
	}
	return store.ErrNotFound
}

// --- Mock MessageStore ---

type mockMessageStore struct {
	messages       map[string]*model.Message // key: parentID + "#" + msgID
	createErr      error
	getErr         error
	updateErr      error
	updateErrID    string // when set, UpdateMessage fails only for this msg ID
	updateErrForID error  // error returned for updateErrID (defaults to a generic error)
	deleteErr      error
	listErr        error
	listAfterErr   error
	listHasMore    bool  // when true, ListMessages always reports more pages
	threadReplyErr error // when set, ListThreadReplies returns this error
	noThreadIndex  bool  // when true, ListThreadReplies returns nothing (simulates an un-backfilled thread → scan fallback)
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
	if m.updateErrID != "" && msg.ID == m.updateErrID {
		if m.updateErrForID != nil {
			return m.updateErrForID
		}
		return errors.New("mock: update failed")
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
	return result, m.listHasMore, nil
}

func (m *mockMessageStore) ListThreadReplies(_ context.Context, threadRootID string) ([]*model.Message, error) {
	if m.threadReplyErr != nil {
		return nil, m.threadReplyErr
	}
	if m.noThreadIndex {
		return nil, nil
	}
	var result []*model.Message
	for _, msg := range m.messages {
		if msg.ParentMessageID == threadRootID {
			result = append(result, msg)
		}
	}
	return result, nil
}

func (m *mockMessageStore) ListMessagesAfter(ctx context.Context, parentID, _ string, limit int) ([]*model.Message, bool, error) {
	if m.listAfterErr != nil {
		return nil, false, m.listAfterErr
	}
	return m.ListMessages(ctx, parentID, "", limit)
}

func (m *mockMessageStore) ListMessagesAround(ctx context.Context, parentID, _ string, _ int, _ int) ([]*model.Message, bool, bool, error) {
	msgs, _, err := m.ListMessages(ctx, parentID, "", 0)
	return msgs, false, false, err
}

func (m *mockMessageStore) IncrementReplyMetadata(_ context.Context, parentID, msgID string, replyTime time.Time, replyAuthorID string) (*model.Message, error) {
	if m.updateErr != nil {
		return nil, m.updateErr
	}
	key := parentID + "#" + msgID
	msg, ok := m.messages[key]
	if !ok {
		return nil, store.ErrNotFound
	}
	msg.ReplyCount++
	t := replyTime
	msg.LastReplyAt = &t
	authors := []string{replyAuthorID}
	for _, id := range msg.RecentReplyAuthorIDs {
		if id == replyAuthorID {
			continue
		}
		authors = append(authors, id)
		if len(authors) >= 3 {
			break
		}
	}
	msg.RecentReplyAuthorIDs = authors
	return msg, nil
}

// --- Mock ThreadFollowStore ---

type mockThreadFollowStore struct {
	follows         map[string]*model.ThreadFollow
	setCalls        int
	setManyCalls    int
	setManyMaxBatch int
	setManyErr      error
}

func newMockThreadFollowStore() *mockThreadFollowStore {
	return &mockThreadFollowStore{follows: make(map[string]*model.ThreadFollow)}
}

func threadFollowMockKey(userID, parentID, threadRootID string) string {
	return userID + "#" + parentID + "#" + threadRootID
}

func (m *mockThreadFollowStore) SetThreadFollow(_ context.Context, follow *model.ThreadFollow) error {
	m.setCalls++
	cp := *follow
	m.follows[threadFollowMockKey(follow.UserID, follow.ParentID, follow.ThreadRootID)] = &cp
	return nil
}

func (m *mockThreadFollowStore) SetThreadFollowMany(_ context.Context, follows []*model.ThreadFollow) error {
	m.setManyCalls++
	if m.setManyErr != nil {
		return m.setManyErr
	}
	if len(follows) > m.setManyMaxBatch {
		m.setManyMaxBatch = len(follows)
	}
	for _, f := range follows {
		cp := *f
		m.follows[threadFollowMockKey(f.UserID, f.ParentID, f.ThreadRootID)] = &cp
	}
	return nil
}

func (m *mockThreadFollowStore) GetThreadFollow(_ context.Context, userID, parentID, threadRootID string) (*model.ThreadFollow, error) {
	f, ok := m.follows[threadFollowMockKey(userID, parentID, threadRootID)]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *f
	return &cp, nil
}

func (m *mockThreadFollowStore) ListUserThreadFollows(_ context.Context, userID string) ([]*model.ThreadFollow, error) {
	out := make([]*model.ThreadFollow, 0)
	for _, f := range m.follows {
		if f.UserID != userID {
			continue
		}
		cp := *f
		out = append(out, &cp)
	}
	return out, nil
}

func (m *mockThreadFollowStore) ListThreadFollows(_ context.Context, parentID, threadRootID string) ([]*model.ThreadFollow, error) {
	out := make([]*model.ThreadFollow, 0)
	for _, f := range m.follows {
		if f.ParentID != parentID || f.ThreadRootID != threadRootID {
			continue
		}
		cp := *f
		out = append(out, &cp)
	}
	return out, nil
}

// --- Mock ParentPinFileIndexStore ---

type mockParentIndex struct {
	pins          map[string]map[string]PinIndexEntry  // parentID -> msgID -> entry
	files         map[string]map[string]FileIndexEntry // parentID -> attachmentID -> entry
	deleteFileErr error
}

func newMockParentIndex() *mockParentIndex {
	return &mockParentIndex{
		pins:  make(map[string]map[string]PinIndexEntry),
		files: make(map[string]map[string]FileIndexEntry),
	}
}

func (m *mockParentIndex) SetPinIndex(_ context.Context, parentID, msgID, pinnedBy string, pinnedAt time.Time) error {
	if m.pins[parentID] == nil {
		m.pins[parentID] = make(map[string]PinIndexEntry)
	}
	m.pins[parentID][msgID] = PinIndexEntry{MessageID: msgID, PinnedBy: pinnedBy, PinnedAt: pinnedAt}
	return nil
}

func (m *mockParentIndex) DeletePinIndex(_ context.Context, parentID, msgID string) error {
	if m.pins[parentID] != nil {
		delete(m.pins[parentID], msgID)
	}
	return nil
}

func (m *mockParentIndex) ListPinIndex(_ context.Context, parentID string) ([]PinIndexEntry, error) {
	rows := m.pins[parentID]
	out := make([]PinIndexEntry, 0, len(rows))
	for _, r := range rows {
		out = append(out, r)
	}
	return out, nil
}

func (m *mockParentIndex) SetFileIndex(_ context.Context, parentID, attachmentID, msgID, authorID string, createdAt time.Time) error {
	if m.files[parentID] == nil {
		m.files[parentID] = make(map[string]FileIndexEntry)
	}
	m.files[parentID][attachmentID] = FileIndexEntry{
		AttachmentID: attachmentID, MessageID: msgID, AuthorID: authorID, CreatedAt: createdAt,
	}
	return nil
}

func (m *mockParentIndex) DeleteFileIndex(_ context.Context, parentID, attachmentID string) error {
	if m.deleteFileErr != nil {
		return m.deleteFileErr
	}
	if m.files[parentID] != nil {
		delete(m.files[parentID], attachmentID)
	}
	return nil
}

func (m *mockParentIndex) ListFileIndex(_ context.Context, parentID string) ([]FileIndexEntry, error) {
	rows := m.files[parentID]
	out := make([]FileIndexEntry, 0, len(rows))
	for _, r := range rows {
		out = append(out, r)
	}
	return out, nil
}

// erroringParentIndex returns errors from every write and list,
// while still letting the test reach through to the underlying
// inner mock for read-side assertions. Used to exercise the slog
// Warn fallback branches in SetPinned/Send/Edit/Delete that fire
// when the index store is unhealthy.
type erroringParentIndex struct{}

func (erroringParentIndex) SetPinIndex(_ context.Context, _, _, _ string, _ time.Time) error {
	return errors.New("pin index unavailable")
}
func (erroringParentIndex) DeletePinIndex(_ context.Context, _, _ string) error {
	return errors.New("pin index unavailable")
}
func (erroringParentIndex) ListPinIndex(_ context.Context, _ string) ([]PinIndexEntry, error) {
	return nil, errors.New("pin index unavailable")
}
func (erroringParentIndex) SetFileIndex(_ context.Context, _, _, _, _ string, _ time.Time) error {
	return errors.New("file index unavailable")
}
func (erroringParentIndex) DeleteFileIndex(_ context.Context, _, _ string) error {
	return errors.New("file index unavailable")
}
func (erroringParentIndex) ListFileIndex(_ context.Context, _ string) ([]FileIndexEntry, error) {
	return nil, errors.New("file index unavailable")
}
