package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// Round-2 perf work: request-path call-count reductions. Each test pins that
// the cheap path stays cheap (no avatar work on the auth check, batched reads
// where batch capabilities exist) without changing observable behavior.

// avatarPanicSigner fails the test if any avatar presigning happens — the
// status-only lookup must never touch the avatar pipeline.
type avatarPanicSigner struct{ t *testing.T }

func (s avatarPanicSigner) PresignedGetURL(context.Context, string, time.Duration) (string, error) {
	s.t.Fatal("UserStatus must not resolve avatars")
	return "", nil
}

func TestUserStatus(t *testing.T) {
	ctx := context.Background()

	t.Run("cache hit skips store and avatars", func(t *testing.T) {
		users := newMockUserStore()
		cache := newMockCache()
		svc := NewUserService(users, cache, avatarPanicSigner{t}, nil)
		cache.users["u1"] = &model.User{ID: "u1", Status: "active", AvatarKey: "avatars/a.png"}

		status, err := svc.UserStatus(ctx, "u1")
		if err != nil || status != "active" {
			t.Fatalf("UserStatus = %q (err=%v), want active", status, err)
		}
	})

	t.Run("cache miss reads store and fills cache", func(t *testing.T) {
		users := newMockUserStore()
		cache := newMockCache()
		svc := NewUserService(users, cache, avatarPanicSigner{t}, nil)
		users.users["u2"] = &model.User{ID: "u2", Status: "deactivated"}

		status, err := svc.UserStatus(ctx, "u2")
		if err != nil || status != "deactivated" {
			t.Fatalf("UserStatus = %q (err=%v), want deactivated", status, err)
		}
		if cache.users["u2"] == nil {
			t.Fatal("miss must fill the cache so the next request is one GET")
		}
	})

	t.Run("nil cache goes straight to store", func(t *testing.T) {
		users := newMockUserStore()
		svc := NewUserService(users, nil, avatarPanicSigner{t}, nil)
		users.users["u3"] = &model.User{ID: "u3", Status: "active"}
		if status, err := svc.UserStatus(ctx, "u3"); err != nil || status != "active" {
			t.Fatalf("UserStatus = %q (err=%v)", status, err)
		}
	})

	t.Run("unknown user surfaces the error", func(t *testing.T) {
		users := newMockUserStore()
		users.getUserErr = errors.New("not found")
		svc := NewUserService(users, newMockCache(), nil, nil)
		if _, err := svc.UserStatus(ctx, "u-missing"); err == nil {
			t.Fatal("expected error for unknown user (middleware treats it as 401)")
		}
	})
}

// ---------------------------------------------------------------------------
// Batched presence
// ---------------------------------------------------------------------------

// batchFakePresenceStore adds the one-MGET capability over the plain fake.
type batchFakePresenceStore struct {
	*fakePresenceStore
	batchErr   error
	batchCalls int
}

func (s *batchFakePresenceStore) ArePresenceOnline(_ context.Context, ids []string) (map[string]bool, error) {
	s.batchCalls++
	if s.batchErr != nil {
		return nil, s.batchErr
	}
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = len(s.conns[id]) > 0
	}
	return out, nil
}

func TestPresenceOnlineMany(t *testing.T) {
	t.Run("local sessions answer without touching the store", func(t *testing.T) {
		store := &batchFakePresenceStore{fakePresenceStore: newFakePresenceStore()}
		svc := NewPresenceService(store, nil)
		svc.OnConnect(context.Background(), "u-local", "c-local")
		got := svc.OnlineMany([]string{"u-local"})
		if !got["u-local"] || store.batchCalls != 0 {
			t.Fatalf("local = %v (batchCalls=%d), want true with no store read", got, store.batchCalls)
		}
	})

	t.Run("remote users resolve in one batched read", func(t *testing.T) {
		store := &batchFakePresenceStore{fakePresenceStore: newFakePresenceStore()}
		store.conns["u-remote-on"] = map[string]bool{"c1": true, "c2": true}
		svc := NewPresenceService(store, nil)
		got := svc.OnlineMany([]string{"u-remote-on", "u-remote-off"})
		if !got["u-remote-on"] || got["u-remote-off"] {
			t.Fatalf("remote = %v", got)
		}
		if store.batchCalls != 1 {
			t.Fatalf("batchCalls = %d, want 1", store.batchCalls)
		}
	})

	t.Run("batch failure reads as offline (fail toward delivery)", func(t *testing.T) {
		store := &batchFakePresenceStore{fakePresenceStore: newFakePresenceStore(), batchErr: errors.New("redis down")}
		store.conns["u-remote-on"] = map[string]bool{"c1": true}
		svc := NewPresenceService(store, nil)
		if got := svc.OnlineMany([]string{"u-remote-on"}); got["u-remote-on"] {
			t.Fatalf("batch failure must read offline, got %v", got)
		}
	})

	t.Run("non-batch store falls back to per-user reads", func(t *testing.T) {
		store := newFakePresenceStore()
		store.conns["u-a"] = map[string]bool{"c1": true}
		svc := NewPresenceService(store, nil)
		got := svc.OnlineMany([]string{"u-a", "u-b"})
		if !got["u-a"] || got["u-b"] {
			t.Fatalf("fallback = %v", got)
		}
	})

	t.Run("nil store leaves remote users offline", func(t *testing.T) {
		svc := NewPresenceService(nil, nil)
		if got := svc.OnlineMany([]string{"u-x"}); got["u-x"] {
			t.Fatalf("nil store = %v, want offline", got)
		}
	})
}

// batchStubPresence records how presence was consulted: batch calls vs
// per-user IsOnline calls.
type batchStubPresence struct {
	stubPresence
	batchCalls  int
	singleCalls int
}

func (p *batchStubPresence) IsOnline(userID string) bool {
	p.singleCalls++
	return p.online[userID]
}

func (p *batchStubPresence) OnlineMany(ids []string) map[string]bool {
	p.batchCalls++
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = p.online[id]
	}
	return out
}

// The @here filter and the mobile-push presence checks must consult presence
// via ONE batched read when the lookup supports it — never a per-member
// IsOnline loop — while keeping the delivery semantics identical: online-only
// @here mentions, offline recipients pushed immediately.
func TestNotifyForMessage_BatchedPresence(t *testing.T) {
	svc, pub, members, conv, chans, users := setupNotifier(t)
	_ = conv
	ctx := context.Background()
	presence := &batchStubPresence{stubPresence: stubPresence{online: map[string]bool{"u-bob": true}}}
	svc.SetPresence(presence)
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	members.memberships["ch1#u-carol"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-carol"}

	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "@here anyone?"}
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

	// Semantics unchanged: online bob got the @here mention, offline carol
	// did not.
	kinds := publishedKinds(pub)
	if kinds[pubsub.UserChannel("u-bob")] != NotificationKindMention {
		t.Errorf("online u-bob should receive @here mention; got %q", kinds[pubsub.UserChannel("u-bob")])
	}
	if kinds[pubsub.UserChannel("u-carol")] == NotificationKindMention {
		t.Error("offline u-carol must not receive a mention from @here")
	}
	// Offline carol's mobile fallback pushed immediately (nothing can ack);
	// online bob's push is DEFERRED (ack-gated), so no immediate send.
	for _, c := range push.calls {
		if c.userID == "u-bob" {
			t.Error("online u-bob must not receive an immediate push (ack-gated deferral)")
		}
	}
	// Presence consulted via batch reads only — one for @here (whole member
	// list), one for the mobile recipients — regardless of member count.
	if presence.batchCalls != 2 {
		t.Errorf("batch presence calls = %d, want 2 (@here + mobile)", presence.batchCalls)
	}
	if presence.singleCalls != 0 {
		t.Errorf("per-user IsOnline calls = %d, want 0", presence.singleCalls)
	}
}

// Offline recipients must still get the immediate push through the batched
// path — the reliability contract's fail-toward-delivery direction.
func TestNotifyForMessage_BatchedPresence_OfflineDMPushesImmediately(t *testing.T) {
	svc, _, _, conv, _, users := setupNotifier(t)
	ctx := context.Background()
	presence := &batchStubPresence{stubPresence: stubPresence{online: map[string]bool{}}}
	svc.SetPresence(presence)
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)

	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	conv.conversations["dm1"] = &model.Conversation{ID: "dm1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-author", "u-dana"}}

	msg := &model.Message{ID: "m2", ParentID: "dm1", AuthorID: "u-author", Body: "hey"}
	svc.NotifyForMessage(ctx, msg, ParentConversation, nil)

	found := false
	for _, c := range push.calls {
		if c.userID == "u-dana" {
			found = true
		}
	}
	if !found {
		t.Fatal("offline DM recipient must receive an immediate mobile push")
	}
	if presence.singleCalls != 0 {
		t.Errorf("per-user IsOnline calls = %d, want 0 (batched)", presence.singleCalls)
	}
}

// ---------------------------------------------------------------------------
// ID-only topic lists + caller-supplied presence topics
// ---------------------------------------------------------------------------

func TestListUserChannelIDs(t *testing.T) {
	memberships := newMockMembershipStore()
	svc := NewChannelService(newMockChannelStore(), memberships, nil, nil, nil, nil, nil)
	memberships.userChannels = []*model.UserChannel{
		{UserID: "u-1", ChannelID: "ch-a"},
		{UserID: "u-1", ChannelID: "ch-b"},
	}
	ids, err := svc.ListUserChannelIDs(context.Background(), "u-1")
	if err != nil || len(ids) != 2 || ids[0] != "ch-a" || ids[1] != "ch-b" {
		t.Fatalf("ids = %v (err=%v)", ids, err)
	}

	memberships.listChannelsErr = errors.New("dynamo down")
	if _, err := svc.ListUserChannelIDs(context.Background(), "u-1"); err == nil {
		t.Fatal("expected store error to surface")
	}
}

func TestListUserConversationIDs(t *testing.T) {
	convs := newMockConversationStore()
	svc := NewConversationService(convs, newMockUserStore(), nil, nil, nil)
	convs.userConvs["u-1"] = []*model.UserConversation{
		{UserID: "u-1", ConversationID: "c-active", Activated: true},
		// Not yet activated and created by someone else → hidden, same rule
		// as the full list.
		{UserID: "u-1", ConversationID: "c-hidden", Activated: false, CreatedBy: "u-2"},
		// Not activated but the user created it → visible.
		{UserID: "u-1", ConversationID: "c-own", Activated: false, CreatedBy: "u-1"},
	}
	ids, err := svc.ListUserConversationIDs(context.Background(), "u-1")
	if err != nil || len(ids) != 2 {
		t.Fatalf("ids = %v (err=%v), want [c-active c-own]", ids, err)
	}
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	if !seen["c-active"] || !seen["c-own"] || seen["c-hidden"] {
		t.Fatalf("ids = %v", ids)
	}

	convs.listErr = errors.New("dynamo down")
	if _, err := svc.ListUserConversationIDs(context.Background(), "u-1"); err == nil {
		t.Fatal("expected store error to surface")
	}
}

// OnConnect with caller-supplied topics publishes to exactly those topics
// without invoking the audience resolver; OnDisconnect without topics
// resolves fresh (memberships may have changed over the connection).
func TestPresenceTransitions_CallerTopicsSkipResolver(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(newFakePresenceStore(), pub)
	resolverCalls := 0
	svc.SetPresenceAudienceResolver(func(context.Context, string) []string {
		resolverCalls++
		return []string{"topic-resolved"}
	})
	ctx := context.Background()

	svc.OnConnect(ctx, "u-1", "conn-1", "topic-a", "topic-b")
	if resolverCalls != 0 {
		t.Fatalf("resolver calls after OnConnect = %d, want 0 (topics supplied)", resolverCalls)
	}
	topics := map[string]bool{}
	for _, p := range pub.published {
		topics[p.channel] = true
	}
	if !topics["topic-a"] || !topics["topic-b"] || topics["topic-resolved"] {
		t.Fatalf("published topics = %v, want the supplied pair", topics)
	}

	pub.published = nil
	svc.OnDisconnect(ctx, "u-1", "conn-1")
	if resolverCalls != 1 {
		t.Fatalf("resolver calls after OnDisconnect = %d, want 1 (fresh audience)", resolverCalls)
	}
	if len(pub.published) != 1 || pub.published[0].channel != "topic-resolved" {
		t.Fatalf("disconnect published = %+v, want topic-resolved", pub.published)
	}
}

// ---------------------------------------------------------------------------
// Channel search/browse batching
// ---------------------------------------------------------------------------

func TestSearchPublic_BatchedChannelReads(t *testing.T) {
	channels := &batchMockChannelStore{mockChannelStore: newMockChannelStore()}
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	users.users["user-1"] = &model.User{ID: "user-1", DisplayName: "U"}
	svc := NewChannelService(channels, memberships, users, nil, nil, nil, nil)
	channels.channels["c-1"] = &model.Channel{ID: "c-1", Name: "one", Type: model.ChannelTypePublic}
	channels.channels["c-2"] = &model.Channel{ID: "c-2", Name: "two", Type: model.ChannelTypePublic}
	channels.channels["c-arch"] = &model.Channel{ID: "c-arch", Name: "old", Type: model.ChannelTypePublic, Archived: true}
	svc.SetSearcher(&stubChannelSearcher{ids: []string{"c-1", "c-gone", "c-arch", "c-2"}})

	got, err := svc.SearchPublic(context.Background(), "user-1", "x", 10)
	if err != nil {
		t.Fatalf("SearchPublic: %v", err)
	}
	if len(got) != 2 || got[0].ID != "c-1" || got[1].ID != "c-2" {
		t.Fatalf("hits = %+v, want [c-1 c-2] in search order", got)
	}
	if channels.batchCalls != 1 {
		t.Fatalf("batch reads = %d, want 1 for all hits", channels.batchCalls)
	}

	// Batch failure degrades to the per-ID loop — search stays best-effort.
	channels.batchErr = errors.New("dynamo down")
	got, err = svc.SearchPublic(context.Background(), "user-1", "x", 10)
	if err != nil || len(got) != 2 {
		t.Fatalf("fallback hits = %+v (err=%v), want the same 2", got, err)
	}
}

func TestSearchPublic_GuestScopeErrorSurfaces(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelServiceWithUsersGuest(t)
	channels.channels["c-1"] = &model.Channel{ID: "c-1", Name: "one", Type: model.ChannelTypePublic}
	svc.SetSearcher(&stubChannelSearcher{ids: []string{"c-1"}})
	memberships.listChannelsErr = errors.New("dynamo down")
	if _, err := svc.SearchPublic(context.Background(), "guest-1", "x", 10); err == nil {
		t.Fatal("guest-scope read failure must surface, not leak unscoped results")
	}
}

func TestGuestBrowse_BatchedChannelReads(t *testing.T) {
	channels := &batchMockChannelStore{mockChannelStore: newMockChannelStore()}
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	users.users["guest-1"] = &model.User{ID: "guest-1", DisplayName: "G", SystemRole: model.SystemRoleGuest}
	svc := NewChannelService(channels, memberships, users, nil, nil, nil, nil)
	channels.channels["c-pub"] = &model.Channel{ID: "c-pub", Name: "pub", Type: model.ChannelTypePublic}
	channels.channels["c-priv"] = &model.Channel{ID: "c-priv", Name: "priv", Type: model.ChannelTypePrivate}
	memberships.userChannels = []*model.UserChannel{
		{UserID: "guest-1", ChannelID: "c-pub"},
		{UserID: "guest-1", ChannelID: "c-priv"},
		{UserID: "guest-1", ChannelID: "c-gone"},
	}

	got, _, err := svc.BrowsePublic(context.Background(), "guest-1", 50, "")
	if err != nil {
		t.Fatalf("BrowsePublic: %v", err)
	}
	if len(got) != 1 || got[0].ID != "c-pub" {
		t.Fatalf("guest browse = %+v, want only the public membership", got)
	}
	if channels.batchCalls != 1 {
		t.Fatalf("batch reads = %d, want 1", channels.batchCalls)
	}
}

// ---------------------------------------------------------------------------
// Attachment batch access + preview loading
// ---------------------------------------------------------------------------

// batchAttachmentAccessChecker implements the batch capability the service
// asserts: one call answers a whole batch.
type batchAttachmentAccessChecker struct {
	fakeAttachmentAccessChecker
	set        map[string]bool
	batchErr   error
	batchCalls int
}

func (f *batchAttachmentAccessChecker) MessageAttachmentIDs(context.Context, string, string, string, string) (map[string]bool, error) {
	f.batchCalls++
	if f.batchErr != nil {
		return nil, f.batchErr
	}
	return f.set, nil
}

func TestGetManyForUser_BatchedAccessCheck(t *testing.T) {
	ctx := context.Background()
	storeM := newMockAttachmentStore()
	svc := NewAttachmentService(storeM, nil, newMockPublisher())
	checker := &batchAttachmentAccessChecker{set: map[string]bool{"att-1": true, "att-2": true}}
	svc.SetAccessChecker(checker)

	storeM.byID["att-1"] = &model.Attachment{ID: "att-1", CreatedBy: "u-2", MessageIDs: []string{"m-1"}}
	storeM.byID["att-2"] = &model.Attachment{ID: "att-2", CreatedBy: "u-2", MessageIDs: []string{"m-1"}}
	// Referenced by a DIFFERENT message → denied by the set.
	storeM.byID["att-foreign"] = &model.Attachment{ID: "att-foreign", CreatedBy: "u-2", MessageIDs: []string{"m-9"}}
	// The caller's own not-yet-attached upload stays visible (owner rule).
	storeM.byID["att-own"] = &model.Attachment{ID: "att-own", CreatedBy: "u-1"}

	got, err := svc.GetManyForUser(ctx, "u-1", []string{"att-1", "att-2", "att-foreign", "att-own", "att-missing"}, "ch-1", ParentChannel, "m-1")
	if err != nil {
		t.Fatalf("GetManyForUser: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d attachments, want 3 (set pair + own upload)", len(got))
	}
	if checker.batchCalls != 1 {
		t.Fatalf("access checks = %d, want 1 for the whole batch", checker.batchCalls)
	}

	// Definitive denial (non-member): only the owner rule survives.
	checker.batchErr = ErrForbidden
	got, err = svc.GetManyForUser(ctx, "u-1", []string{"att-1", "att-own"}, "ch-1", ParentChannel, "m-1")
	if err != nil || len(got) != 1 || got[0].ID != "att-own" {
		t.Fatalf("denied batch = %+v (err=%v), want only the own upload", got, err)
	}

	// Transient failure fails the whole batch — never a silently shrunken 200.
	checker.batchErr = errors.New("dynamo down")
	if _, err := svc.GetManyForUser(ctx, "u-1", []string{"att-1"}, "ch-1", ParentChannel, "m-1"); err == nil {
		t.Fatal("transient access failure must fail the batch")
	}
}

func TestMessageAttachmentIDs(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1", Role: model.ChannelRoleMember}
	messages.messages["ch-1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch-1", AttachmentIDs: []string{"att-1", "att-2"}}

	ids, err := svc.MessageAttachmentIDs(ctx, "u-1", "ch-1", ParentChannel, "m-1")
	if err != nil || len(ids) != 2 || !ids["att-1"] || !ids["att-2"] {
		t.Fatalf("ids = %v (err=%v)", ids, err)
	}
	if _, err := svc.MessageAttachmentIDs(ctx, "u-outsider", "ch-1", ParentChannel, "m-1"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-member = %v, want ErrForbidden", err)
	}
	if _, err := svc.MessageAttachmentIDs(ctx, "u-1", "ch-1", ParentChannel, "m-gone"); err == nil {
		t.Fatal("missing message must error")
	}
}

// batchMockAttachmentStore adds the batched-read capability.
type batchMockAttachmentStore struct {
	*mockAttachmentStore
	batchErr   error
	batchCalls int
}

func (m *batchMockAttachmentStore) GetAttachmentsByIDs(_ context.Context, ids []string) ([]*model.Attachment, error) {
	m.batchCalls++
	if m.batchErr != nil {
		return nil, m.batchErr
	}
	out := make([]*model.Attachment, 0, len(ids))
	for _, id := range ids {
		if a, ok := m.byID[id]; ok {
			out = append(out, a)
		}
	}
	return out, nil
}

func TestLoadForPreview(t *testing.T) {
	ctx := context.Background()

	t.Run("batch arm resolves in one read, input order, misses skipped", func(t *testing.T) {
		storeM := &batchMockAttachmentStore{mockAttachmentStore: newMockAttachmentStore()}
		svc := NewAttachmentService(storeM, nil, newMockPublisher())
		storeM.byID["a-1"] = &model.Attachment{ID: "a-1", Filename: "one.txt"}
		storeM.byID["a-2"] = &model.Attachment{ID: "a-2", Filename: "two.txt"}
		got := svc.LoadForPreview(ctx, []string{"a-2", "a-gone", "a-1"})
		if len(got) != 2 || got[0].ID != "a-2" || got[1].ID != "a-1" {
			t.Fatalf("preview = %+v, want [a-2 a-1]", got)
		}
		if storeM.batchCalls != 1 {
			t.Fatalf("batch reads = %d, want 1", storeM.batchCalls)
		}
		// Batch failure degrades to empty (previews are best-effort).
		storeM.batchErr = errors.New("dynamo down")
		if got := svc.LoadForPreview(ctx, []string{"a-1"}); len(got) != 0 {
			t.Fatalf("batch failure = %+v, want empty", got)
		}
	})

	t.Run("plain store falls back to per-ID reads", func(t *testing.T) {
		storeM := newMockAttachmentStore()
		svc := NewAttachmentService(storeM, nil, newMockPublisher())
		storeM.byID["a-1"] = &model.Attachment{ID: "a-1"}
		got := svc.LoadForPreview(ctx, []string{"a-1", "a-gone"})
		if len(got) != 1 || got[0].ID != "a-1" {
			t.Fatalf("fallback preview = %+v", got)
		}
	})

	t.Run("empty input is a no-op", func(t *testing.T) {
		svc := NewAttachmentService(newMockAttachmentStore(), nil, newMockPublisher())
		if got := svc.LoadForPreview(ctx, nil); got != nil {
			t.Fatalf("empty = %v", got)
		}
	})
}

// A conversation top-level send loads the conversation ONCE — the access
// check's row is reused by the activity block instead of a second
// GetConversation for the same request.
func TestSend_ConversationLoadedOnce(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	conversations.conversations["dm-1"] = &model.Conversation{
		ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}, Activated: true,
	}
	if _, err := svc.Send(context.Background(), "u-1", "dm-1", ParentConversation, "hello", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if conversations.getCalls != 1 {
		t.Fatalf("GetConversation calls = %d, want 1 per send", conversations.getCalls)
	}
}

// previewCapableMLAttachments implements the batched preview capability the
// unfurl loader asserts.
type previewCapableMLAttachments struct {
	fakeMLAttachments
	previewCalls int
}

func (f *previewCapableMLAttachments) LoadForPreview(_ context.Context, ids []string) []*model.Attachment {
	f.previewCalls++
	out := make([]*model.Attachment, 0, len(ids))
	for _, id := range ids {
		if a, ok := f.byID[id]; ok {
			out = append(out, a)
		}
	}
	return out
}

func TestMessageLink_LoadAttachments_UsesBatchCapability(t *testing.T) {
	atts := &previewCapableMLAttachments{fakeMLAttachments: fakeMLAttachments{byID: map[string]*model.Attachment{
		"a-1": {ID: "a-1", Filename: "doc.pdf", ContentType: "application/pdf"},
		"a-2": {ID: "a-2", Filename: "img.png", ContentType: "image/png"},
	}}}
	svc := NewMessageLinkService("", nil, nil, nil, nil, nil, atts)
	msg := &model.Message{ID: "m-1", AttachmentIDs: []string{"a-1", "a-2", "a-gone"}}
	got := svc.loadAttachments(context.Background(), msg)
	if len(got) != 2 {
		t.Fatalf("loaded = %+v, want 2", got)
	}
	if atts.previewCalls != 1 {
		t.Fatalf("preview batch calls = %d, want 1", atts.previewCalls)
	}
}

// ---------------------------------------------------------------------------
// Webhook @name target fast paths
// ---------------------------------------------------------------------------

// directResolvingUserStub gives the webhook resolver the point-read + search
// capabilities and records which path answered.
type directResolvingUserStub struct {
	byID      map[string]*model.User
	byEmail   map[string]*model.User
	searchHit []*model.User
	searchErr error
	listCalls int
	byIDCalls int
	emailErr  error
}

func (d *directResolvingUserStub) List(context.Context, int, string) ([]*model.User, string, error) {
	d.listCalls++
	var out []*model.User
	for _, u := range d.byID {
		out = append(out, u)
	}
	return out, "", nil
}

func (d *directResolvingUserStub) GetByID(_ context.Context, id string) (*model.User, error) {
	d.byIDCalls++
	if u, ok := d.byID[id]; ok {
		return u, nil
	}
	return nil, store.ErrNotFound
}

func (d *directResolvingUserStub) GetByEmail(_ context.Context, email string) (*model.User, error) {
	if d.emailErr != nil {
		return nil, d.emailErr
	}
	if u, ok := d.byEmail[email]; ok {
		return u, nil
	}
	return nil, store.ErrNotFound
}

func (d *directResolvingUserStub) Search(context.Context, string, int) ([]*model.User, error) {
	if d.searchErr != nil {
		return nil, d.searchErr
	}
	return d.searchHit, nil
}

func TestFindWebhookTargetUser_FastPaths(t *testing.T) {
	ctx := context.Background()
	alice := &model.User{ID: "01USERAAAAAAAAAAAAAAAAAAAA", DisplayName: "Alice", Email: "alice@x.io"}

	t.Run("email resolves via the email index, no directory walk", func(t *testing.T) {
		users := &directResolvingUserStub{byEmail: map[string]*model.User{"alice@x.io": alice}}
		svc := NewIncomingWebhookService(&fakeWebhookStore{}, nil, nil, nil, "")
		svc.SetUserResolver(users)
		got, err := svc.findWebhookTargetUser(ctx, "Alice@X.io ")
		if err != nil || got.ID != alice.ID {
			t.Fatalf("got %+v (err=%v)", got, err)
		}
		if users.listCalls != 0 {
			t.Fatalf("listCalls = %d, want 0", users.listCalls)
		}
	})

	t.Run("raw user ID resolves via a point read", func(t *testing.T) {
		users := &directResolvingUserStub{byID: map[string]*model.User{alice.ID: alice}}
		svc := NewIncomingWebhookService(&fakeWebhookStore{}, nil, nil, nil, "")
		svc.SetUserResolver(users)
		got, err := svc.findWebhookTargetUser(ctx, alice.ID)
		if err != nil || got.ID != alice.ID {
			t.Fatalf("got %+v (err=%v)", got, err)
		}
		if users.listCalls != 0 {
			t.Fatalf("listCalls = %d, want 0", users.listCalls)
		}
	})

	t.Run("display name resolves via the search index", func(t *testing.T) {
		users := &directResolvingUserStub{searchHit: []*model.User{alice}}
		svc := NewIncomingWebhookService(&fakeWebhookStore{}, nil, nil, nil, "")
		svc.SetUserResolver(users)
		got, err := svc.findWebhookTargetUser(ctx, "alice")
		if err != nil || got.ID != alice.ID {
			t.Fatalf("got %+v (err=%v)", got, err)
		}
		if users.listCalls != 0 {
			t.Fatalf("listCalls = %d, want 0", users.listCalls)
		}
	})

	t.Run("index misses fall back to the directory walk", func(t *testing.T) {
		users := &directResolvingUserStub{
			byID:      map[string]*model.User{alice.ID: alice},
			searchErr: errors.New("index down"),
			emailErr:  errors.New("index down"),
		}
		svc := NewIncomingWebhookService(&fakeWebhookStore{}, nil, nil, nil, "")
		svc.SetUserResolver(users)
		got, err := svc.findWebhookTargetUser(ctx, "alice")
		if err != nil || got.ID != alice.ID {
			t.Fatalf("fallback got %+v (err=%v)", got, err)
		}
		if users.listCalls == 0 {
			t.Fatal("expected the directory walk fallback to run")
		}
	})
}

// conditionalClearUserStore adds the atomic status-clear capability over the
// plain mock.
type conditionalClearUserStore struct {
	*mockUserStore
	clearResult bool
	clearErr    error
	clearCalls  int
	updateCalls int
}

func (m *conditionalClearUserStore) UpdateUser(ctx context.Context, u *model.User) error {
	m.updateCalls++
	return m.mockUserStore.UpdateUser(ctx, u)
}

func (m *conditionalClearUserStore) ClearUserStatusIfExpired(_ context.Context, _ string, _ time.Time, _ time.Time) (bool, error) {
	m.clearCalls++
	return m.clearResult, m.clearErr
}

func TestClearExpiredStatuses_ConditionalClearPath(t *testing.T) {
	ctx := context.Background()
	past := time.Now().Add(-time.Minute)
	seed := func() *conditionalClearUserStore {
		users := &conditionalClearUserStore{mockUserStore: newMockUserStore(), clearResult: true}
		users.users["u-1"] = &model.User{ID: "u-1", Status: "active", UserStatus: &model.UserStatus{Text: "away", ClearAt: &past}}
		return users
	}

	t.Run("cleared: one conditional write, no read, no full update", func(t *testing.T) {
		users := seed()
		svc := NewUserService(users, newMockCache(), nil, newMockPublisher())
		cleared, err := svc.ClearExpiredStatuses(ctx, time.Now(), 100)
		if err != nil || cleared != 1 {
			t.Fatalf("cleared = %d (err=%v), want 1", cleared, err)
		}
		if users.clearCalls != 1 || users.updateCalls != 0 {
			t.Fatalf("clearCalls=%d updateCalls=%d, want 1/0", users.clearCalls, users.updateCalls)
		}
	})

	t.Run("condition lost (fresh status): skipped, nothing published", func(t *testing.T) {
		users := seed()
		users.clearResult = false
		pub := newMockPublisher()
		svc := NewUserService(users, nil, nil, pub)
		cleared, err := svc.ClearExpiredStatuses(ctx, time.Now(), 100)
		if err != nil || cleared != 0 {
			t.Fatalf("cleared = %d (err=%v), want 0", cleared, err)
		}
		if len(pub.published) != 0 {
			t.Fatalf("published = %+v, want none", pub.published)
		}
	})

	t.Run("write failure surfaces", func(t *testing.T) {
		users := seed()
		users.clearErr = errors.New("dynamo down")
		svc := NewUserService(users, nil, nil, nil)
		if _, err := svc.ClearExpiredStatuses(ctx, time.Now(), 100); err == nil {
			t.Fatal("expected conditional clear failure to surface")
		}
	})
}

// checkAccess's conversation arm surfaces conversationAccess failures for
// non-Send callers (typing gate, list reads).
func TestCheckAccess_ConversationErrorSurfaces(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	if err := svc.CheckAccess(context.Background(), "u-1", "conv-missing", ParentConversation); err == nil {
		t.Fatal("expected missing conversation to fail access")
	}
	conversations.conversations["conv-1"] = &model.Conversation{ID: "conv-1", ParticipantIDs: []string{"u-1"}}
	if err := svc.CheckAccess(context.Background(), "u-1", "conv-1", ParentConversation); err != nil {
		t.Fatalf("participant access: %v", err)
	}
	if err := svc.CheckAccess(context.Background(), "u-out", "conv-1", ParentConversation); !errors.Is(err, ErrForbidden) {
		t.Fatalf("outsider = %v, want ErrForbidden", err)
	}
}
