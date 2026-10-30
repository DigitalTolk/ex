package service

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// ---------------------------------------------------------------------------
// Batch-capability mocks. Each embeds the plain mock and adds the optional
// interface the service type-asserts, so the same tests pin BOTH arms:
// existing suites (plain mocks) exercise the fallbacks, these the batches.
// ---------------------------------------------------------------------------

type batchMockCache struct {
	*mockCache
	getUsersErr error
	setUsersLen int
}

func (m *batchMockCache) GetUsers(_ context.Context, ids []string) (map[string]*model.User, error) {
	if m.getUsersErr != nil {
		return nil, m.getUsersErr
	}
	out := make(map[string]*model.User, len(ids))
	for _, id := range ids {
		if u, ok := m.users[id]; ok {
			cp := *u
			out[id] = &cp
		}
	}
	return out, nil
}

func (m *batchMockCache) SetUsers(_ context.Context, users []*model.User) error {
	m.setUsersLen += len(users)
	for _, u := range users {
		cp := *u
		m.users[u.ID] = &cp
	}
	return nil
}

// batchMediaCache implements MediaURLCache + the batch capability over the
// plain in-memory value map.
type batchMediaCache struct {
	*mockCache
	getManyErr error
	setManyErr error
	setCalls   int
}

func (m *batchMediaCache) GetManyJSON(_ context.Context, keys []string) ([][]byte, error) {
	if m.getManyErr != nil {
		return nil, m.getManyErr
	}
	out := make([][]byte, len(keys))
	for i, k := range keys {
		if v, ok := m.values[k].([]byte); ok {
			out[i] = v
		}
	}
	return out, nil
}

func (m *batchMediaCache) SetManyJSON(_ context.Context, keys []string, values []any, _ time.Duration) error {
	m.setCalls++
	if m.setManyErr != nil {
		return m.setManyErr
	}
	for i, k := range keys {
		data := mustJSONBytes(values[i])
		m.values[k] = data
	}
	return nil
}

type batchMockConversationStore struct {
	*mockConversationStore
	batchErr   error
	batchCalls int
}

func (m *batchMockConversationStore) GetConversationsByIDs(_ context.Context, ids []string) ([]*model.Conversation, error) {
	m.batchCalls++
	if m.batchErr != nil {
		return nil, m.batchErr
	}
	out := make([]*model.Conversation, 0, len(ids))
	for _, id := range ids {
		if c, ok := m.conversations[id]; ok {
			cp := *c
			out = append(out, &cp)
		}
	}
	return out, nil
}

type batchMockChannelStore struct {
	*mockChannelStore
	batchErr   error
	batchCalls int
}

func (m *batchMockChannelStore) GetChannelsByIDs(_ context.Context, ids []string) ([]*model.Channel, error) {
	m.batchCalls++
	if m.batchErr != nil {
		return nil, m.batchErr
	}
	out := make([]*model.Channel, 0, len(ids))
	for _, id := range ids {
		if c, ok := m.channels[id]; ok {
			cp := *c
			out = append(out, &cp)
		}
	}
	return out, nil
}

type batchMockMessageStore struct {
	*mockMessageStore
	batchErr   error
	batchMu    sync.Mutex
	batchCalls int
	batchSizes []int
}

func (m *batchMockMessageStore) GetMessagesByIDs(_ context.Context, parentID string, ids []string) ([]*model.Message, error) {
	m.batchMu.Lock()
	m.batchCalls++
	m.batchSizes = append(m.batchSizes, len(ids))
	m.batchMu.Unlock()
	if m.batchErr != nil {
		return nil, m.batchErr
	}
	out := make([]*model.Message, 0, len(ids))
	for _, id := range ids {
		if msg, ok := m.messages[parentID+"#"+id]; ok {
			cp := *msg
			out = append(out, &cp)
		}
	}
	return out, nil
}

// indexedThreadFollowStore adds the write-time /threads index capability.
type indexedThreadFollowStore struct {
	*mockThreadFollowStore
	seeded       bool
	seededErr    error
	markErr      error
	ifAbsentErr  error
	ifAbsentKeys []string
}

func (m *indexedThreadFollowStore) SetThreadFollowIfAbsent(_ context.Context, f *model.ThreadFollow) error {
	if m.ifAbsentErr != nil {
		return m.ifAbsentErr
	}
	key := threadFollowMockKey(f.UserID, f.ParentID, f.ThreadRootID)
	m.ifAbsentKeys = append(m.ifAbsentKeys, key)
	if _, exists := m.follows[key]; exists {
		return nil
	}
	cp := *f
	m.follows[key] = &cp
	return nil
}

func (m *indexedThreadFollowStore) IsThreadIndexSeeded(_ context.Context, _ string) (bool, error) {
	if m.seededErr != nil {
		return false, m.seededErr
	}
	return m.seeded, nil
}

func (m *indexedThreadFollowStore) MarkThreadIndexSeeded(_ context.Context, _ string) error {
	if m.markErr != nil {
		return m.markErr
	}
	m.seeded = true
	return nil
}

func mustJSONBytes(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}

// ---------------------------------------------------------------------------
// StableMediaURLs
// ---------------------------------------------------------------------------

func TestStableMediaURLs_BatchHitsMissesAndFailures(t *testing.T) {
	ctx := context.Background()

	// nil cache / empty input → empty result.
	if got := StableMediaURLs(ctx, nil, "avatar", []MediaURLRequest{{ID: "a"}}); len(got) != 0 {
		t.Fatalf("nil cache = %v", got)
	}
	c := &batchMediaCache{mockCache: newMockCache()}
	if got := StableMediaURLs(ctx, c, "avatar", nil); len(got) != 0 {
		t.Fatalf("empty reqs = %v", got)
	}

	// Misses mint tokens and persist them in ONE pipelined write.
	got := StableMediaURLs(ctx, c, "avatar", []MediaURLRequest{
		{ID: "u1:k1", S3Key: "k1", Filename: "avatar"},
		{ID: "u2:k2", S3Key: "k2", Filename: "avatar"},
	})
	if len(got) != 2 || got["u1:k1"] == "" || got["u2:k2"] == "" {
		t.Fatalf("minted URLs = %v", got)
	}
	if c.setCalls != 1 {
		t.Fatalf("SetManyJSON calls = %d, want 1 (pipelined)", c.setCalls)
	}

	// Second resolve: pure MGET hits, same URLs, no writes.
	again := StableMediaURLs(ctx, c, "avatar", []MediaURLRequest{
		{ID: "u1:k1", S3Key: "k1", Filename: "avatar"},
		{ID: "u2:k2", S3Key: "k2", Filename: "avatar"},
	})
	if again["u1:k1"] != got["u1:k1"] || again["u2:k2"] != got["u2:k2"] {
		t.Fatalf("stable URLs changed: %v vs %v", again, got)
	}
	if c.setCalls != 1 {
		t.Fatalf("hits must not rewrite, setCalls = %d", c.setCalls)
	}

	// A corrupt cached record is a miss: re-minted, not an error.
	c.values["media:avatar:u3:k3"] = []byte("not json")
	corrupt := StableMediaURLs(ctx, c, "avatar", []MediaURLRequest{{ID: "u3:k3", S3Key: "k3", Filename: "avatar"}})
	if corrupt["u3:k3"] == "" {
		t.Fatalf("corrupt record must re-mint, got %v", corrupt)
	}

	// MGET failure → empty (URLs are cosmetic, never fail the caller).
	c.getManyErr = errors.New("redis down")
	if got := StableMediaURLs(ctx, c, "avatar", []MediaURLRequest{{ID: "u1:k1", S3Key: "k1"}}); len(got) != 0 {
		t.Fatalf("mget failure = %v, want empty", got)
	}
	c.getManyErr = nil

	// Pipelined write failure → the minted URLs would 404; they're dropped
	// while already-cached hits survive.
	c.setManyErr = errors.New("redis down")
	mixed := StableMediaURLs(ctx, c, "avatar", []MediaURLRequest{
		{ID: "u1:k1", S3Key: "k1", Filename: "avatar"}, // cached hit
		{ID: "u9:k9", S3Key: "k9", Filename: "avatar"}, // fresh mint
	})
	if mixed["u1:k1"] == "" || mixed["u9:k9"] != "" {
		t.Fatalf("write-failure result = %v, want hit kept + mint dropped", mixed)
	}
}

func TestStableMediaURLs_FallsBackWithoutBatchCapability(t *testing.T) {
	// A plain Get/Set cache resolves per item through StableMediaURL.
	c := newMockCache()
	got := StableMediaURLs(context.Background(), c, "avatar", []MediaURLRequest{
		{ID: "u1:k1", S3Key: "k1", Filename: "avatar"},
	})
	if got["u1:k1"] == "" {
		t.Fatalf("fallback result = %v", got)
	}
}

// ---------------------------------------------------------------------------
// UserService batches
// ---------------------------------------------------------------------------

func TestUserGetBatch_UsesCacheMGETAndPipelinedFill(t *testing.T) {
	users := &batchMockUserStore{mockUserStore: newMockUserStore()}
	users.users["u-1"] = &model.User{ID: "u-1", DisplayName: "Cached"}
	users.users["u-2"] = &model.User{ID: "u-2", DisplayName: "Stored"}
	cache := &batchMockCache{mockCache: newMockCache()}
	cache.users["u-1"] = &model.User{ID: "u-1", DisplayName: "Cached"}
	svc := NewUserService(users, cache, nil, nil)

	got, err := svc.GetBatch(context.Background(), []string{"u-1", "u-2", "u-missing"})
	if err != nil || len(got) != 2 {
		t.Fatalf("GetBatch = %v, err=%v", got, err)
	}
	if got[0].ID != "u-1" || got[1].ID != "u-2" {
		t.Fatalf("order = %s,%s", got[0].ID, got[1].ID)
	}
	// The store miss (u-2) was cached via ONE pipelined SetUsers.
	if cache.setUsersLen != 1 {
		t.Fatalf("SetUsers cached %d users, want 1", cache.setUsersLen)
	}
	if _, ok := cache.users["u-2"]; !ok {
		t.Fatal("store hit must be cached for next time")
	}
}

func TestUserGetBatch_CacheMGETFailureFallsBackToStore(t *testing.T) {
	users := &batchMockUserStore{mockUserStore: newMockUserStore()}
	users.users["u-1"] = &model.User{ID: "u-1", DisplayName: "Stored"}
	cache := &batchMockCache{mockCache: newMockCache(), getUsersErr: errors.New("redis down")}
	svc := NewUserService(users, cache, nil, nil)

	got, err := svc.GetBatch(context.Background(), []string{"u-1"})
	if err != nil || len(got) != 1 || got[0].DisplayName != "Stored" {
		t.Fatalf("GetBatch = %v, err=%v", got, err)
	}
}

func TestUserResolveAvatars_BatchedMediaURLs(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, newMockCache(), fakeAvatarSigner{}, nil)
	media := &batchMediaCache{mockCache: newMockCache()}
	svc.SetMediaURLCache(media)

	list := []*model.User{
		{ID: "u-1", AvatarKey: "k1"},
		{ID: "u-2"}, // no avatar — skipped
		nil,         // tolerated
		{ID: "u-3", AvatarKey: "k3"},
	}
	svc.resolveAvatars(context.Background(), list)
	if list[0].AvatarURL == "" || list[3].AvatarURL == "" {
		t.Fatalf("avatars unresolved: %+v %+v", list[0], list[3])
	}
	if list[1].AvatarURL != "" {
		t.Fatal("keyless user must stay URL-less")
	}
	// Both records went through ONE pipelined write.
	if media.setCalls != 1 {
		t.Fatalf("SetManyJSON calls = %d, want 1", media.setCalls)
	}

	// Without a media cache the per-user presign fallback still works.
	svc2 := NewUserService(users, newMockCache(), fakeAvatarSigner{}, nil)
	plain := []*model.User{{ID: "u-9", AvatarKey: "k9"}}
	svc2.resolveAvatars(context.Background(), plain)
	if plain[0].AvatarURL == "" {
		t.Fatal("presign fallback must resolve")
	}

	// A user the batch could not serve (cache down) falls back per-user.
	media.getManyErr = errors.New("redis down")
	drop := []*model.User{{ID: "u-4", AvatarKey: "k4"}}
	svc.resolveAvatars(context.Background(), drop)
	if drop[0].AvatarURL == "" {
		t.Fatal("per-user fallback must resolve when the batch fails")
	}
}

func TestUserCacheUsers_FallsBackToPerUserSet(t *testing.T) {
	users := newMockUserStore()
	cache := newMockCache() // no batch capability
	svc := NewUserService(users, cache, nil, nil)
	svc.cacheUsers(context.Background(), []*model.User{{ID: "u-1"}, {ID: "u-2"}})
	if len(cache.users) != 2 {
		t.Fatalf("cached %d users, want 2", len(cache.users))
	}
	// nil cache and empty input are no-ops.
	svc2 := NewUserService(users, nil, nil, nil)
	svc2.cacheUsers(context.Background(), []*model.User{{ID: "u-1"}})
	svc.cacheUsers(context.Background(), nil)
}

// ---------------------------------------------------------------------------
// ConversationService batches
// ---------------------------------------------------------------------------

func TestConversationEnrichUnread_BatchedMetaRead(t *testing.T) {
	convs := &batchMockConversationStore{mockConversationStore: newMockConversationStore()}
	convs.conversations["c-1"] = &model.Conversation{ID: "c-1", MessageSeq: 10}
	convs.conversations["c-2"] = &model.Conversation{ID: "c-2", MessageSeq: 3}
	svc := NewConversationService(convs, newMockUserStore(), nil, nil, nil)

	rows := []*model.UserConversation{
		{ConversationID: "c-1", LastReadSeq: 7},
		{ConversationID: "c-2", LastReadSeq: 3},
		{ConversationID: "c-gone", LastReadSeq: 0}, // META missing → left alone
	}
	svc.enrichUnread(context.Background(), rows)
	if convs.batchCalls != 1 {
		t.Fatalf("batch calls = %d, want 1", convs.batchCalls)
	}
	if !rows[0].Unread || rows[0].UnreadCount != 3 {
		t.Fatalf("row0 = %+v, want unread 3", rows[0])
	}
	if rows[1].Unread || rows[2].Unread {
		t.Fatalf("caught-up/missing rows must stay read: %+v %+v", rows[1], rows[2])
	}

	// Batch failure → per-row fallback still enriches.
	convs.batchErr = errors.New("dynamo down")
	rows2 := []*model.UserConversation{{ConversationID: "c-1", LastReadSeq: 0}}
	svc.enrichUnread(context.Background(), rows2)
	if !rows2[0].Unread || rows2[0].UnreadCount != 10 {
		t.Fatalf("fallback row = %+v", rows2[0])
	}

	// Empty input is a no-op.
	svc.enrichUnread(context.Background(), nil)
}

// batchProfileUserService stands in for UserService as the profile resolver.
type batchProfileUserService struct {
	users map[string]*model.User
	calls int
}

func (m *batchProfileUserService) GetByID(_ context.Context, id string) (*model.User, error) {
	if u, ok := m.users[id]; ok {
		return u, nil
	}
	return nil, errNotFoundForTest
}

func (m *batchProfileUserService) GetBatch(_ context.Context, ids []string) ([]*model.User, error) {
	m.calls++
	out := make([]*model.User, 0, len(ids))
	for _, id := range ids {
		if u, ok := m.users[id]; ok {
			out = append(out, u)
		}
	}
	return out, nil
}

var errNotFoundForTest = errors.New("not found")

func TestConversationEnrichDMProfiles_BatchedResolver(t *testing.T) {
	convs := newMockConversationStore()
	svc := NewConversationService(convs, newMockUserStore(), nil, nil, nil)
	status := &model.UserStatus{Emoji: "🌴", Text: "away"}
	resolver := &batchProfileUserService{users: map[string]*model.User{
		"u-bob": {ID: "u-bob", AvatarURL: "/api/v1/media/tok/avatar", UserStatus: status},
	}}
	svc.SetUserProfileResolver(resolver)

	rows := []*model.UserConversation{
		{ConversationID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-me", "u-bob"}},
		{ConversationID: "dm-2", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-me", "u-ghost"}},
		{ConversationID: "grp", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-me", "u-bob"}},
		nil,
	}
	svc.enrichDMProfiles(context.Background(), "u-me", rows)
	// ONE batch call resolved every DM counterpart.
	if resolver.calls != 1 {
		t.Fatalf("resolver batch calls = %d, want 1", resolver.calls)
	}
	if !rows[0].ProfileResolved || rows[0].AvatarURL == "" || rows[0].UserStatus != status {
		t.Fatalf("dm row unenriched: %+v", rows[0])
	}
	if rows[1].ProfileResolved {
		t.Fatal("unresolvable counterpart must stay unenriched")
	}
	if rows[2].ProfileResolved {
		t.Fatal("groups are not DM-enriched")
	}

	// Self-DM resolves to the caller.
	resolver.users["u-me"] = &model.User{ID: "u-me"}
	self := []*model.UserConversation{{ConversationID: "self", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-me"}}}
	svc.enrichDMProfiles(context.Background(), "u-me", self)
	if !self[0].ProfileResolved {
		t.Fatalf("self-DM unenriched: %+v", self[0])
	}

	// No DM rows → no batch call.
	before := resolver.calls
	svc.enrichDMProfiles(context.Background(), "u-me", []*model.UserConversation{{Type: model.ConversationTypeGroup}})
	if resolver.calls != before {
		t.Fatal("no-DM input must not call the resolver")
	}
}

// ---------------------------------------------------------------------------
// ChannelService batch
// ---------------------------------------------------------------------------

func TestChannelListUserChannels_BatchedMetaRead(t *testing.T) {
	channels := &batchMockChannelStore{mockChannelStore: newMockChannelStore()}
	memberships := newMockMembershipStore()
	svc := NewChannelService(channels, memberships, nil, nil, nil, nil, nil)

	channels.channels["ch-live"] = &model.Channel{ID: "ch-live", MessageSeq: 9}
	channels.channels["ch-arch"] = &model.Channel{ID: "ch-arch", Archived: true}
	channels.channels["ch-own"] = &model.Channel{ID: "ch-own", Archived: true}
	memberships.userChannels = []*model.UserChannel{
		{UserID: "u-1", ChannelID: "ch-live", LastReadSeq: 4},
		{UserID: "u-1", ChannelID: "ch-arch", Role: model.ChannelRoleMember},
		{UserID: "u-1", ChannelID: "ch-own", Role: model.ChannelRoleOwner},
		{UserID: "u-1", ChannelID: "ch-meta-gone"},
	}

	got, err := svc.ListUserChannels(context.Background(), "u-1")
	if err != nil {
		t.Fatalf("ListUserChannels: %v", err)
	}
	if channels.batchCalls != 1 {
		t.Fatalf("batch calls = %d, want 1", channels.batchCalls)
	}
	ids := make([]string, 0, len(got))
	for _, uc := range got {
		ids = append(ids, uc.ChannelID)
	}
	// Missing-META rows drop; archived channels stay for every member,
	// flagged so the sidebar can group them.
	if len(ids) != 3 || ids[0] != "ch-live" || ids[1] != "ch-arch" || ids[2] != "ch-own" {
		t.Fatalf("kept = %v, want [ch-live ch-arch ch-own]", ids)
	}
	if got[0].Archived || !got[1].Archived || !got[2].Archived {
		t.Fatalf("archived flags = %v/%v/%v, want false/true/true", got[0].Archived, got[1].Archived, got[2].Archived)
	}
	if !got[0].Unread || got[0].UnreadCount != 5 {
		t.Fatalf("unread = %+v, want 5", got[0])
	}

	// Batch failure → the per-channel fallback still serves the list.
	channels.batchErr = errors.New("dynamo down")
	got, err = svc.ListUserChannels(context.Background(), "u-1")
	if err != nil || len(got) != 3 || !got[1].Archived {
		t.Fatalf("fallback = %v (err=%v), want 3 rows with ch-arch flagged", got, err)
	}
}

// Each row carries its channel's last top-level message time — the sidebar's
// "Recent activity" sort — on the batched read and the per-channel fallback.
func TestChannelListUserChannels_StampsLastMessageAt(t *testing.T) {
	channels := &batchMockChannelStore{mockChannelStore: newMockChannelStore()}
	memberships := newMockMembershipStore()
	svc := NewChannelService(channels, memberships, nil, nil, nil, nil, nil)

	at := time.Date(2026, 10, 29, 9, 30, 0, 0, time.UTC)
	channels.channels["ch-busy"] = &model.Channel{ID: "ch-busy", LastMessageAt: &at}
	channels.channels["ch-quiet"] = &model.Channel{ID: "ch-quiet"}
	memberships.userChannels = []*model.UserChannel{
		{UserID: "u-1", ChannelID: "ch-busy"},
		{UserID: "u-1", ChannelID: "ch-quiet"},
	}

	for _, path := range []struct {
		name string
		err  error
	}{{"batched", nil}, {"fallback", errors.New("dynamo down")}} {
		channels.batchErr = path.err
		got, err := svc.ListUserChannels(context.Background(), "u-1")
		if err != nil || len(got) != 2 {
			t.Fatalf("%s: rows = %v, err = %v", path.name, got, err)
		}
		if got[0].LastMessageAt == nil || !got[0].LastMessageAt.Equal(at) {
			t.Errorf("%s: ch-busy lastMessageAt = %v, want %v", path.name, got[0].LastMessageAt, at)
		}
		if got[1].LastMessageAt != nil {
			t.Errorf("%s: ch-quiet lastMessageAt = %v, want unset", path.name, got[1].LastMessageAt)
		}
	}
}

// ---------------------------------------------------------------------------
// Thread-participation index
// ---------------------------------------------------------------------------

func threadIndexService() (*MessageService, *batchMockMessageStore, *mockMembershipStore, *mockConversationStore, *indexedThreadFollowStore) {
	messages := &batchMockMessageStore{mockMessageStore: newMockMessageStore()}
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	svc := NewMessageService(messages, memberships, conversations, newMockPublisher(), newMockBroker())
	svc.SetParentIndex(newMockParentIndex())
	follows := &indexedThreadFollowStore{mockThreadFollowStore: newMockThreadFollowStore()}
	svc.SetThreadFollowStore(follows)
	return svc, messages, memberships, conversations, follows
}

func TestRecordThreadParticipation(t *testing.T) {
	svc, _, _, _, follows := threadIndexService()
	ctx := context.Background()

	reply := &model.Message{ID: "r-1", ParentID: "ch-1", ParentMessageID: "root-1", AuthorID: "u-replier"}
	root := &model.Message{ID: "root-1", ParentID: "ch-1", AuthorID: "u-root"}
	svc.recordThreadParticipation(ctx, reply, ParentChannel, root)

	// Both the reply author and the root author become participants: the
	// author by replying, the root author only if they have no row yet.
	if f := follows.follows[threadFollowMockKey("u-replier", "ch-1", "root-1")]; f == nil || !f.Following {
		t.Fatal("reply author not recorded")
	}
	if len(follows.ifAbsentKeys) != 1 || follows.ifAbsentKeys[0] != threadFollowMockKey("u-root", "ch-1", "root-1") {
		t.Fatalf("conditional writes = %v, want only the root author", follows.ifAbsentKeys)
	}
	if _, ok := follows.follows[threadFollowMockKey("u-root", "ch-1", "root-1")]; !ok {
		t.Fatal("root author not recorded")
	}

	// Self-reply: one write, not two.
	follows.ifAbsentKeys = nil
	calls := follows.setCalls
	selfRoot := &model.Message{ID: "root-2", ParentID: "ch-1", AuthorID: "u-replier"}
	selfReply := &model.Message{ID: "r-2", ParentID: "ch-1", ParentMessageID: "root-2", AuthorID: "u-replier"}
	svc.recordThreadParticipation(ctx, selfReply, ParentChannel, selfRoot)
	if len(follows.ifAbsentKeys) != 0 || follows.setCalls != calls+1 {
		t.Fatalf("self-reply writes = %d + %v, want 1", follows.setCalls-calls, follows.ifAbsentKeys)
	}

	// Replying follows the thread again, past an earlier unfollow…
	follows.follows[threadFollowMockKey("u-out", "ch-1", "root-1")] = &model.ThreadFollow{
		UserID: "u-out", ParentID: "ch-1", ThreadRootID: "root-1", Following: false,
	}
	outReply := &model.Message{ID: "r-3", ParentID: "ch-1", ParentMessageID: "root-1", AuthorID: "u-out"}
	svc.recordThreadParticipation(ctx, outReply, ParentChannel, nil)
	if !follows.follows[threadFollowMockKey("u-out", "ch-1", "root-1")].Following {
		t.Fatal("replying did not follow the thread again")
	}
	// …but someone else's reply never clobbers the root author's unfollow.
	follows.follows[threadFollowMockKey("u-root", "ch-1", "root-1")].Following = false
	svc.recordThreadParticipation(ctx, reply, ParentChannel, root)
	if follows.follows[threadFollowMockKey("u-root", "ch-1", "root-1")].Following {
		t.Fatal("a reply clobbered the root author's unfollow")
	}

	// Top-level messages and unavailable roots are tolerated.
	svc.recordThreadParticipation(ctx, &model.Message{ID: "m", ParentID: "ch-1", AuthorID: "u-x"}, ParentChannel, nil)
	svc.recordThreadParticipation(ctx, nil, ParentChannel, nil)
	// An authorless reply (defensive: webhook/system shapes) writes only the
	// root author's row.
	follows.ifAbsentKeys = nil
	calls = follows.setCalls
	svc.recordThreadParticipation(ctx, &model.Message{ID: "r-anon", ParentID: "ch-1", ParentMessageID: "root-1", AuthorID: ""}, ParentChannel, root)
	if len(follows.ifAbsentKeys) != 1 || follows.ifAbsentKeys[0] != threadFollowMockKey("u-root", "ch-1", "root-1") || follows.setCalls != calls {
		t.Fatalf("authorless writes = %v, want only the root author", follows.ifAbsentKeys)
	}
	// Write failures are retried, then logged, never surfaced.
	orig := audienceRetryInterval
	audienceRetryInterval = time.Millisecond
	t.Cleanup(func() { audienceRetryInterval = orig })
	follows.ifAbsentErr = errors.New("dynamo down")
	svc.recordThreadParticipation(ctx, reply, ParentChannel, root)
}

// flakyParticipationStore fails the first `failures` SetThreadFollow calls —
// a DynamoDB blip on the send path.
type flakyParticipationStore struct {
	*indexedThreadFollowStore
	failures int
	attempts int
}

func (f *flakyParticipationStore) SetThreadFollow(ctx context.Context, follow *model.ThreadFollow) error {
	f.attempts++
	if f.attempts <= f.failures {
		return errors.New("throttled")
	}
	return f.indexedThreadFollowStore.SetThreadFollow(ctx, follow)
}

// The follow rows are what an indexed thread's later replies are routed by
// (threadFullyIndexed), so a transient write failure is retried rather than
// leaving the replier silently out of the thread's future alerts.
func TestRecordThreadParticipation_RetriesTransientFailure(t *testing.T) {
	orig := audienceRetryInterval
	audienceRetryInterval = time.Millisecond
	t.Cleanup(func() { audienceRetryInterval = orig })

	svc, _, _, _, follows := threadIndexService()
	flaky := &flakyParticipationStore{indexedThreadFollowStore: follows, failures: 1}
	svc.SetThreadFollowStore(flaky)
	reply := &model.Message{ID: "r-1", ParentID: "ch-1", ParentMessageID: "root-1", AuthorID: "u-replier"}
	svc.recordThreadParticipation(context.Background(), reply, ParentChannel, nil)

	if flaky.attempts != 2 {
		t.Fatalf("SetThreadFollow attempts = %d, want 2 (one retry)", flaky.attempts)
	}
	if f := follows.follows[threadFollowMockKey("u-replier", "ch-1", "root-1")]; f == nil || !f.Following {
		t.Fatalf("replier's follow row = %+v, want written after the retry", f)
	}
}

func TestListThreadsPage_FollowedThreads(t *testing.T) {
	svc, messages, memberships, _, follows := threadIndexService()
	ctx := context.Background()
	follows.seeded = true

	seedMembership(memberships, "ch-1", "u-1")
	lastReply := time.Now().Truncate(time.Second)
	rootAt := lastReply.Add(-time.Hour)
	messages.messages["ch-1#root-a"] = &model.Message{ID: "root-a", ParentID: "ch-1", AuthorID: "u-2", Body: "root a", CreatedAt: rootAt, ReplyCount: 3, LastReplyAt: &lastReply}
	messages.messages["ch-1#root-b"] = &model.Message{ID: "root-b", ParentID: "ch-1", AuthorID: "u-1", Body: "root b", CreatedAt: rootAt.Add(time.Minute), ReplyCount: 1}
	messages.messages["ch-left#root-x"] = &model.Message{ID: "root-x", ParentID: "ch-left", AuthorID: "u-2", CreatedAt: rootAt, ReplyCount: 1}

	// One followed, one unfollowed, one in a channel the user LEFT (not a
	// member → left out).
	follows.follows[threadFollowMockKey("u-1", "ch-1", "root-a")] = &model.ThreadFollow{UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: "root-a", Following: true, LastActivityAt: &lastReply}
	follows.follows[threadFollowMockKey("u-1", "ch-1", "root-b")] = &model.ThreadFollow{UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: "root-b", Following: false}
	follows.follows[threadFollowMockKey("u-1", "ch-left", "root-x")] = &model.ThreadFollow{UserID: "u-1", ParentID: "ch-left", ParentType: ParentChannel, ThreadRootID: "root-x", Following: true, LastActivityAt: &rootAt}

	page, err := svc.ListThreadsPage(ctx, "u-1", threadCursorFollowed, 0)
	if err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	got := page.Threads
	if len(got) != 1 || got[0].ThreadRootID != "root-a" || page.NextCursor != "" {
		t.Fatalf("page = %+v, want only root-a and no more", page)
	}
	if got[0].ReplyCount != 3 || !got[0].LatestActivityAt.Equal(lastReply) || got[0].RootBody != "root a" || !got[0].Following || got[0].Unread {
		t.Fatalf("summary = %+v", got[0])
	}
	// The roots are read in one batch per parent; nothing scans history.
	if messages.batchCalls != 1 {
		t.Fatalf("batch root reads = %d, want 1", messages.batchCalls)
	}
	if messages.listCalls.Load() != 0 {
		t.Fatalf("legacy scans = %d, want 0", messages.listCalls.Load())
	}

	// A root the batch can't find (deleted thread) is skipped.
	follows.follows[threadFollowMockKey("u-1", "ch-1", "root-gone")] = &model.ThreadFollow{UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: "root-gone", Following: true, LastActivityAt: &rootAt}
	if page, err := svc.ListThreadsPage(ctx, "u-1", threadCursorFollowed, 0); err != nil || len(page.Threads) != 1 {
		t.Fatalf("missing root = %+v (err=%v)", page, err)
	}

	// A batch root read failure surfaces (the caller retries).
	messages.batchErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", threadCursorFollowed, 0); err == nil {
		t.Fatal("expected batch error")
	}
	messages.batchErr = nil
	// So does a failed read of the follow order, and a membership check
	// that could not run.
	follows.activityErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", threadCursorFollowed, 0); err == nil {
		t.Fatal("expected follow order error")
	}
	follows.activityErr = nil
	memberships.getErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", threadCursorFollowed, 0); err == nil {
		t.Fatal("expected membership error")
	}
}

func TestListUserThreads_SeedsIndexFromLegacyScan(t *testing.T) {
	svc, messages, memberships, _, follows := threadIndexService()
	seeds := seedFinished(svc)
	ctx := context.Background()
	// Not seeded yet → the first page starts the legacy scan in the
	// background, and its result backfills rows.

	seedMembership(memberships, "ch-1", "u-1")
	rootAt := time.Now().Add(-time.Hour)
	messages.messages["ch-1#root-a"] = &model.Message{ID: "root-a", ParentID: "ch-1", AuthorID: "u-2", Body: "root", CreatedAt: rootAt, ReplyCount: 1}
	messages.messages["ch-1#r-1"] = &model.Message{ID: "r-1", ParentID: "ch-1", ParentMessageID: "root-a", AuthorID: "u-1", CreatedAt: rootAt.Add(time.Minute)}
	// An explicitly unfollowed thread the scan would otherwise re-derive:
	messages.messages["ch-1#root-out"] = &model.Message{ID: "root-out", ParentID: "ch-1", AuthorID: "u-2", CreatedAt: rootAt, ReplyCount: 1}
	messages.messages["ch-1#r-2"] = &model.Message{ID: "r-2", ParentID: "ch-1", ParentMessageID: "root-out", AuthorID: "u-1", CreatedAt: rootAt.Add(time.Minute)}
	follows.follows[threadFollowMockKey("u-1", "ch-1", "root-out")] = &model.ThreadFollow{UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: "root-out", Following: false}

	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	waitThreadSeed(t, seeds)
	// The derived participation was persisted, sorted by its latest reply,
	// and the user marked seeded — WITHOUT resurrecting the explicit unfollow.
	if !follows.seeded {
		t.Fatal("seed marker not set")
	}
	f := follows.follows[threadFollowMockKey("u-1", "ch-1", "root-a")]
	if f == nil || !f.Following || f.LastActivityAt == nil || !f.LastActivityAt.Equal(rootAt.Add(time.Minute)) {
		t.Fatalf("participation not seeded with its latest reply: %+v", f)
	}
	if follows.follows[threadFollowMockKey("u-1", "ch-1", "root-out")].Following {
		t.Fatal("seed clobbered an explicit unfollow")
	}

	// From now on the thread lists from the follow rows, with no scans.
	messages.listCalls.Store(0)
	page, err := svc.ListThreadsPage(ctx, "u-1", threadCursorFollowed, 0)
	if err != nil {
		t.Fatalf("followed page after seed: %v", err)
	}
	if len(page.Threads) != 1 || page.Threads[0].ThreadRootID != "root-a" {
		t.Fatalf("threads after seed = %+v, want root-a", page.Threads)
	}
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err != nil {
		t.Fatalf("first page after seed: %v", err)
	}
	if messages.listCalls.Load() != 0 {
		t.Fatalf("post-seed scans = %d, want 0", messages.listCalls.Load())
	}
}

func TestListUserThreads_SeedFailuresRetryLater(t *testing.T) {
	svc, messages, memberships, _, follows := threadIndexService()
	seeds := seedFinished(svc)
	ctx := context.Background()
	seedMembership(memberships, "ch-1", "u-1")
	rootAt := time.Now().Add(-time.Hour)
	messages.messages["ch-1#root-a"] = &model.Message{ID: "root-a", ParentID: "ch-1", AuthorID: "u-2", CreatedAt: rootAt, ReplyCount: 1}
	messages.messages["ch-1#r-1"] = &model.Message{ID: "r-1", ParentID: "ch-1", ParentMessageID: "root-a", AuthorID: "u-1", CreatedAt: rootAt.Add(time.Minute)}

	// Seed write failure → NOT marked seeded; a later visit scans again.
	follows.setManyErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	waitThreadSeed(t, seeds)
	if follows.seeded {
		t.Fatal("failed seed must not mark the user seeded")
	}
	follows.setManyErr = nil

	// Marker write failure is logged; the seed itself persisted.
	follows.markErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	waitThreadSeed(t, seeds)
	follows.markErr = nil
	if follows.follows[threadFollowMockKey("u-1", "ch-1", "root-a")] == nil {
		t.Fatal("seed rows not persisted")
	}

	// IsSeeded probe failure → nothing is scanned; whether a seed is due is
	// asked again on the next visit.
	messages.listCalls.Store(0)
	follows.seededErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err != nil {
		t.Fatalf("ListThreadsPage with probe failure: %v", err)
	}
	if messages.listCalls.Load() != 0 {
		t.Fatalf("scans after a probe failure = %d, want 0", messages.listCalls.Load())
	}

	// The seed's own inputs failing to load postpones it too.
	follows.seededErr = nil
	memberships.listChannelsErr = errors.New("dynamo down")
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	waitThreadSeed(t, seeds)
	if follows.seeded {
		t.Fatal("a seed without its inputs must not mark the user seeded")
	}
}

func TestSend_ReplyRecordsParticipationForBothAuthors(t *testing.T) {
	svc, messages, memberships, _, _ := threadIndexService()
	follows := svc.threadFollows.(*indexedThreadFollowStore)
	ctx := context.Background()

	seedMembership(memberships, "ch-1", "u-replier")
	seedMembership(memberships, "ch-1", "u-root")
	messages.messages["ch-1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch-1", AuthorID: "u-root", Body: "root"}

	if _, err := svc.Send(ctx, "u-replier", "ch-1", ParentChannel, "a reply", "root-1"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	for _, uid := range []string{"u-replier", "u-root"} {
		f := follows.follows[threadFollowMockKey(uid, "ch-1", "root-1")]
		if f == nil || !f.Following {
			t.Fatalf("participation for %s not recorded at send time: %+v", uid, f)
		}
	}
}

func TestListPinned_BatchPath(t *testing.T) {
	svc, messages, memberships, _, _ := threadIndexService()
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	ctx := context.Background()
	memberships.memberships["ch-pin#u-1"] = &model.ChannelMembership{ChannelID: "ch-pin", UserID: "u-1", Role: model.ChannelRoleMember}

	messages.messages["ch-pin#m-1"] = &model.Message{ID: "m-1", ParentID: "ch-pin", AuthorID: "u-1", Body: "first", Pinned: true}
	messages.messages["ch-pin#m-2"] = &model.Message{ID: "m-2", ParentID: "ch-pin", AuthorID: "u-1", Body: "unpinned meanwhile", Pinned: false}
	now := time.Now()
	_ = idx.SetPinIndex(ctx, "ch-pin", "m-1", "u-1", now)
	_ = idx.SetPinIndex(ctx, "ch-pin", "m-2", "u-1", now)    // stale: message no longer pinned
	_ = idx.SetPinIndex(ctx, "ch-pin", "m-gone", "u-1", now) // stale: message deleted

	got, err := svc.ListPinned(ctx, "u-1", "ch-pin", ParentChannel)
	if err != nil {
		t.Fatalf("ListPinned: %v", err)
	}
	if len(got) != 1 || got[0].ID != "m-1" {
		t.Fatalf("pinned = %+v, want only m-1", got)
	}
	// ONE batched read resolved every pin.
	if messages.batchCalls != 1 {
		t.Fatalf("batch reads = %d, want 1", messages.batchCalls)
	}
	// Both stale rows were cleaned out of the index.
	rows, _ := idx.ListPinIndex(ctx, "ch-pin")
	if len(rows) != 1 || rows[0].MessageID != "m-1" {
		t.Fatalf("index after cleanup = %+v, want only m-1", rows)
	}

	// Batch failure surfaces instead of returning a partial pin list.
	messages.batchErr = errors.New("dynamo down")
	if _, err := svc.ListPinned(ctx, "u-1", "ch-pin", ParentChannel); err == nil {
		t.Fatal("expected batch error")
	}
}

func TestStableMediaURLs_MintFailureSkipsItem(t *testing.T) {
	// randRead failing means no token can be minted for a miss — that ID is
	// skipped while cached hits still resolve.
	c := &batchMediaCache{mockCache: newMockCache()}
	ctx := context.Background()
	warm := StableMediaURLs(ctx, c, "avatar", []MediaURLRequest{{ID: "u1:k1", S3Key: "k1", Filename: "a"}})
	if warm["u1:k1"] == "" {
		t.Fatal("warm-up mint failed")
	}
	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	defer func() { randRead = orig }()
	got := StableMediaURLs(ctx, c, "avatar", []MediaURLRequest{
		{ID: "u1:k1", S3Key: "k1", Filename: "a"}, // cached hit
		{ID: "u2:k2", S3Key: "k2", Filename: "a"}, // miss, mint fails
	})
	if got["u1:k1"] == "" || got["u2:k2"] != "" {
		t.Fatalf("mint-failure result = %v, want hit kept + miss skipped", got)
	}
}

func TestListThreadsPage_PerIDRootFallback(t *testing.T) {
	// A NON-batching message store resolves roots one by one — same
	// skip-missing semantics — and the page keeps the follow order.
	messages := newMockMessageStore()
	memberships := newMockMembershipStore()
	svc := NewMessageService(messages, memberships, newMockConversationStore(), newMockPublisher(), newMockBroker())
	svc.SetParentIndex(newMockParentIndex())
	follows := &indexedThreadFollowStore{mockThreadFollowStore: newMockThreadFollowStore(), seeded: true}
	svc.SetThreadFollowStore(follows)
	ctx := context.Background()

	seedMembership(memberships, "ch-1", "u-1")
	older := time.Now().Add(-2 * time.Hour)
	newer := time.Now().Add(-time.Hour)
	messages.messages["ch-1#root-old"] = &model.Message{ID: "root-old", ParentID: "ch-1", AuthorID: "u-2", Body: "old", CreatedAt: older, ReplyCount: 1}
	messages.messages["ch-1#root-new"] = &model.Message{ID: "root-new", ParentID: "ch-1", AuthorID: "u-2", Body: "new", CreatedAt: newer, ReplyCount: 1}
	for root, at := range map[string]time.Time{"root-old": older, "root-new": newer, "root-gone": newer.Add(time.Minute)} {
		follows.follows[threadFollowMockKey("u-1", "ch-1", root)] = &model.ThreadFollow{
			UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: root, Following: true, LastActivityAt: &at,
		}
	}

	page, err := svc.ListThreadsPage(ctx, "u-1", threadCursorFollowed, 0)
	if err != nil {
		t.Fatalf("ListThreadsPage: %v", err)
	}
	got := page.Threads
	if len(got) != 2 || got[0].ThreadRootID != "root-new" || got[1].ThreadRootID != "root-old" {
		t.Fatalf("threads = %+v, want [root-new root-old] with root-gone skipped", got)
	}
	if messages.listCalls.Load() != 0 {
		t.Fatalf("scans = %d, want 0", messages.listCalls.Load())
	}
}
