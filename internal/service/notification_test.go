package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

func setupNotifier(t *testing.T) (*NotificationService, *mockPublisher, *mockMembershipStore, *mockConversationStore, *mockChannelStore, *mockUserStore) {
	t.Helper()
	pub := newMockPublisher()
	members := newMockMembershipStore()
	conv := newMockConversationStore()
	chans := newMockChannelStore()
	users := newMockUserStore()
	msgs := newMockMessageStore()
	svc := NewNotificationService(pub, members, conv, chans, users, msgs)
	return svc, pub, members, conv, chans, users
}

// setupNotifierWithMessages exposes the message store too so tests can
// pre-seed thread structure and assert the scoped fanout.
func setupNotifierWithMessages(t *testing.T) (*NotificationService, *mockPublisher, *mockMembershipStore, *mockChannelStore, *mockUserStore, *mockMessageStore) {
	t.Helper()
	pub := newMockPublisher()
	members := newMockMembershipStore()
	conv := newMockConversationStore()
	chans := newMockChannelStore()
	users := newMockUserStore()
	msgs := newMockMessageStore()
	svc := NewNotificationService(pub, members, conv, chans, users, msgs)
	return svc, pub, members, chans, users, msgs
}

func setupNotifierWithMessagesAndFollows(t *testing.T) (*NotificationService, *mockPublisher, *mockMembershipStore, *mockConversationStore, *mockChannelStore, *mockUserStore, *mockMessageStore, *mockThreadFollowStore) {
	t.Helper()
	pub := newMockPublisher()
	members := newMockMembershipStore()
	conv := newMockConversationStore()
	chans := newMockChannelStore()
	users := newMockUserStore()
	msgs := newMockMessageStore()
	follows := newMockThreadFollowStore()
	svc := NewNotificationService(pub, members, conv, chans, users, msgs)
	svc.SetThreadFollowStore(follows)
	return svc, pub, members, conv, chans, users, msgs, follows
}

// stubPresence is a tiny PresenceLookup implementation: any userID listed
// in the set is reported online; everyone else is offline.
type stubPresence struct {
	online map[string]bool
}

func (p *stubPresence) IsOnline(userID string) bool { return p.online[userID] }

type recordingMobilePush struct {
	calls []mobilePushCall
	err   error
}

type mobilePushCall struct {
	userID string
	notif  Notification
}

func (p *recordingMobilePush) Send(_ context.Context, userID string, notif Notification) error {
	p.calls = append(p.calls, mobilePushCall{userID: userID, notif: notif})
	return p.err
}

// publishedKinds returns the Notification.Kind for every published event,
// keyed by the recipient channel. Helpful for asserting both who was
// notified AND with what kind in one assertion.
func publishedKinds(pub *mockPublisher) map[string]NotificationKind {
	out := make(map[string]NotificationKind, len(pub.published))
	for _, p := range pub.published {
		var n Notification
		if err := json.Unmarshal(p.event.Data, &n); err != nil {
			continue
		}
		out[p.channel] = n.Kind
	}
	return out
}

// seedAllLevel registers user records whose account notification level is "all
// messages", so an ordinary (non-mention) channel message reaches them. The
// quiet "mentions, DMs & keywords only" default is deliberate (see CLAUDE.md),
// so fanout/push/mute machinery tests opt their recipients into "all" to
// exercise that machinery independently of the level gate.
func seedAllLevel(users *mockUserStore, ids ...string) {
	for _, id := range ids {
		users.users[id] = &model.User{
			ID:          id,
			DisplayName: id,
			NotificationSettings: &model.NotificationSettings{
				DesktopLevel:  model.NotificationLevelAll,
				MobileLevel:   model.MobileNotificationDefault,
				ThreadReplies: true,
			},
		}
	}
}

func publishedNotifications(pub *mockPublisher) map[string]Notification {
	out := make(map[string]Notification, len(pub.published))
	for _, p := range pub.published {
		var n Notification
		if err := json.Unmarshal(p.event.Data, &n); err != nil {
			continue
		}
		out[p.channel] = n
	}
	return out
}

func TestNotificationService_NotifyForMessage_ChannelFanout(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob", "u-carol")
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	members.memberships["ch1#u-carol"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-carol"}

	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	// Author is excluded; two recipients receive the alert.
	if got := len(pub.published); got != 2 {
		t.Fatalf("publish count = %d, want 2", got)
	}
	gotChannels := map[string]bool{}
	for _, p := range pub.published {
		gotChannels[p.channel] = true
		if p.event.Type != events.EventNotificationNew {
			t.Errorf("event type = %q, want %q", p.event.Type, events.EventNotificationNew)
		}
	}
	if !gotChannels[pubsub.UserChannel("u-bob")] || !gotChannels[pubsub.UserChannel("u-carol")] {
		t.Errorf("expected publishes to bob+carol channels, got %v", gotChannels)
	}
	if gotChannels[pubsub.UserChannel("u-author")] {
		t.Error("author should be excluded from notification fanout")
	}
}

func TestNotificationService_NotifyForMessage_SendsMobilePushToSameRecipients(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushSender(push)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob", "u-carol")
	for _, uid := range []string{"u-author", "u-bob", "u-carol"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel)

	if got := len(pub.published); got != 2 {
		t.Fatalf("websocket publish count = %d, want 2", got)
	}
	if got := len(push.calls); got != 2 {
		t.Fatalf("mobile push count = %d, want 2", got)
	}
	got := map[string]bool{}
	for _, call := range push.calls {
		got[call.userID] = true
		if call.notif.DeepLink != "/channel/general" {
			t.Errorf("DeepLink = %q", call.notif.DeepLink)
		}
		if call.notif.Body != "hello" {
			t.Errorf("Body = %q", call.notif.Body)
		}
	}
	if got["u-author"] {
		t.Fatal("sender must not receive mobile push")
	}
	if !got["u-bob"] || !got["u-carol"] {
		t.Fatalf("mobile push recipients = %#v", got)
	}
}

func TestNotificationService_NotifyForMessage_SkipsMobilePushForOnlineRecipients(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushSender(push)
	// u-bob is connected (has a live WebSocket) and so already gets the
	// in-app banner; u-carol is offline and must still receive a push.
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true}})
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob", "u-carol")
	for _, uid := range []string{"u-author", "u-bob", "u-carol"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel)

	// Both recipients still get the in-app WebSocket event — presence only
	// gates the parallel push, never the in-app banner.
	if got := len(pub.published); got != 2 {
		t.Fatalf("websocket publish count = %d, want 2", got)
	}
	if got := len(push.calls); got != 1 {
		t.Fatalf("mobile push count = %d, want 1 (online u-bob suppressed)", got)
	}
	if push.calls[0].userID != "u-carol" {
		t.Fatalf("mobile push recipient = %q, want u-carol (offline)", push.calls[0].userID)
	}
}

// signalPush records each push recipient on a channel so a test can wait on
// (or confirm the absence of) the deferred ack-fallback push deterministically.
type signalPush struct{ sent chan string }

func (p *signalPush) Send(_ context.Context, recipientUserID string, _ Notification) error {
	p.sent <- recipientUserID
	return nil
}

// stubAckStore reports a fixed set of (userID, messageID) acks as delivered.
type stubAckStore struct{ acked map[string]bool }

func (s *stubAckStore) WasNotificationAcked(_ context.Context, userID, messageID string) bool {
	return s.acked[userID+":"+messageID]
}

func withShortAckDelay(t *testing.T) {
	t.Helper()
	orig := ackFallbackDelay
	ackFallbackDelay = 10 * time.Millisecond
	t.Cleanup(func() { ackFallbackDelay = orig })
}

// TestAckFallbackDelayInvariants guards the timing contract that keeps the
// ack-gated mobile fallback from double-notifying an online desktop user. The
// deferred push must not fire before a healthy socket has had a full WS
// keep-alive cycle to prove liveness and surface+ack the alert, and the ack
// marker must still be alive in Redis when the timer reads it.
//
// Source constants (kept in sync by comment, since they live in sibling
// packages): handler.wsKeepAliveInterval = 15s, handler.wsPongTimeout = 10s,
// cache.notifAckTTL = 60s.
func TestAckFallbackDelayInvariants(t *testing.T) {
	const keepAliveCycle = 15*time.Second + 10*time.Second // wsKeepAliveInterval + wsPongTimeout
	const ackMarkerTTL = 60 * time.Second                  // cache.notifAckTTL
	if ackFallbackDelay < keepAliveCycle {
		t.Errorf("ackFallbackDelay = %v, must be >= one keep-alive cycle (%v) so a healthy socket can ack before the push fires", ackFallbackDelay, keepAliveCycle)
	}
	if ackFallbackDelay >= ackMarkerTTL {
		t.Errorf("ackFallbackDelay = %v, must be < notifAckTTL (%v) so a recorded ack is still visible when the deferred push reads it", ackFallbackDelay, ackMarkerTTL)
	}
}

func dmNotifier(t *testing.T) (*NotificationService, *signalPush) {
	t.Helper()
	svc, _, _, conv, _, users := setupNotifier(t)
	push := &signalPush{sent: make(chan string, 4)}
	svc.SetMobilePushSender(push)
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	conv.conversations["c1"] = &model.Conversation{
		ID: "c1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-author", "u-bob"},
	}
	return svc, push
}

func notifyDM(svc *NotificationService) {
	svc.NotifyForMessage(context.Background(),
		&model.Message{ID: "m1", ParentID: "c1", AuthorID: "u-author", Body: "incident!"}, ParentConversation)
}

// THE core fix: an "online" recipient whose desktop NEVER acks (dead/half-open
// socket) must still get the mobile push once the ack window lapses. This is the
// hole the presence-only gate left open.
func TestNotificationService_MobilePush_OnlineButNoAck_FallsBackToPush(t *testing.T) {
	withShortAckDelay(t)
	svc, push := dmNotifier(t)
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true}})
	svc.SetAckStore(&stubAckStore{acked: map[string]bool{}}) // nobody acked

	notifyDM(svc)

	select {
	case uid := <-push.sent:
		if uid != "u-bob" {
			t.Fatalf("deferred push to %q, want u-bob", uid)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("online recipient never acked → mobile push must fire as fallback, but it didn't")
	}
}

// An online recipient whose desktop DID ack must NOT get a redundant push.
func TestNotificationService_MobilePush_OnlineAndAcked_NoPush(t *testing.T) {
	withShortAckDelay(t)
	svc, push := dmNotifier(t)
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true}})
	svc.SetAckStore(&stubAckStore{acked: map[string]bool{"u-bob:m1": true}}) // desktop confirmed

	notifyDM(svc)

	select {
	case uid := <-push.sent:
		t.Fatalf("desktop ack must cancel the deferred push, but it pushed to %q", uid)
	case <-time.After(200 * time.Millisecond): // ack delay is 10ms; 200ms proves no push fired
	}
}

// An offline recipient (no socket to ack) is pushed immediately, no waiting.
func TestNotificationService_MobilePush_Offline_PushesImmediately(t *testing.T) {
	svc, push := dmNotifier(t)
	svc.SetPresence(&stubPresence{online: map[string]bool{}}) // u-bob offline
	svc.SetAckStore(&stubAckStore{acked: map[string]bool{}})

	notifyDM(svc)

	select {
	case uid := <-push.sent:
		if uid != "u-bob" {
			t.Fatalf("immediate push to %q, want u-bob", uid)
		}
	case <-time.After(time.Second):
		t.Fatal("offline recipient must be pushed immediately")
	}
}

// Server shutdown drops a pending deferred push rather than sleeping out the
// full delay then pushing into a closing process.
func TestNotificationService_MobilePush_ShutdownStopsDeferredPush(t *testing.T) {
	svc, push := dmNotifier(t)
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true}})
	svc.SetAckStore(&stubAckStore{acked: map[string]bool{}})
	// A long delay so Close() reliably wins the race against the timer.
	orig := ackFallbackDelay
	ackFallbackDelay = 10 * time.Second
	t.Cleanup(func() { ackFallbackDelay = orig })

	notifyDM(svc) // spawns the deferred-push goroutine (waiting 10s)
	svc.Close()   // signal shutdown → the goroutine returns without pushing
	svc.Close()   // idempotent

	select {
	case uid := <-push.sent:
		t.Fatalf("shutdown must cancel the deferred push, but pushed to %q", uid)
	case <-time.After(200 * time.Millisecond):
	}
}

// Without an ack store wired, an online recipient falls back to the old
// presence-only behaviour (push skipped) — no deferred goroutine, no panic.
func TestNotificationService_MobilePush_OnlineNoAckStore_SkipsPush(t *testing.T) {
	withShortAckDelay(t)
	svc, push := dmNotifier(t)
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true}})
	// No SetAckStore.

	notifyDM(svc)

	select {
	case uid := <-push.sent:
		t.Fatalf("no ack store → online push should be skipped, but pushed to %q", uid)
	case <-time.After(150 * time.Millisecond):
	}
}

func TestNotificationService_MissingMobilePushConfigDoesNotBlockMessageDelivery(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob")
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel)

	if got := len(pub.published); got != 1 {
		t.Fatalf("publish count = %d, want 1", got)
	}
}

func TestNotificationService_MobilePushFailureDoesNotBlockMessageDelivery(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{err: errors.New("provider unavailable")}
	svc.SetMobilePushSender(push)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob")
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel)

	if got := len(pub.published); got != 1 {
		t.Fatalf("publish count = %d, want 1", got)
	}
	if got := len(push.calls); got != 1 {
		t.Fatalf("mobile push attempts = %d, want 1", got)
	}
}

func TestNotificationService_PersistsNotificationState(t *testing.T) {
	svc, _, members, _, chans, users, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	stateStore := newMockUserStateStore()
	stateSvc := NewUserStateService(stateStore, nil)
	svc.SetUserStateService(stateSvc)

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	for _, uid := range []string{"u-author", "u-bob"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid}
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hi @[u-bob|Bob]"}, ParentChannel)
	if _, ok := stateStore.rows[stateStore.key("u-bob", model.UserStateChannelNotification, "ch1")]; !ok {
		t.Fatal("expected channel notification state for mentioned user")
	}
	if err := stateStore.DeleteUserState(ctx, "u-bob", model.UserStateChannelNotification, "ch1"); err != nil {
		t.Fatalf("DeleteUserState: %v", err)
	}

	msgs.messages["ch1#root1"] = &model.Message{ID: "root1", ParentID: "ch1", AuthorID: "u-author", Body: "root", CreatedAt: time.Now()}
	if err := follows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID: "u-bob", ParentID: "ch1", ParentType: ParentChannel, ThreadRootID: "root1", Following: true, UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}
	svc.NotifyForMessage(ctx, &model.Message{ID: "reply1", ParentID: "ch1", ParentMessageID: "root1", AuthorID: "u-author", Body: "reply @[u-bob|Bob]"}, ParentChannel)
	if _, ok := stateStore.rows[stateStore.key("u-bob", model.UserStateThreadNotification, "root1")]; !ok {
		t.Fatal("expected thread notification state for follower")
	}
	if _, ok := stateStore.rows[stateStore.key("u-bob", model.UserStateChannelNotification, "ch1")]; ok {
		t.Fatal("did not expect channel notification state for thread mention")
	}
}

func TestNotificationService_PersistsChannelNotification_ForNonMentionAllLevel(t *testing.T) {
	// Regression: the exact "sound but no sidebar badge" report. u-bob set THIS
	// channel's desktop level to "all messages" but isn't @-mentioned. The
	// previous code only persisted channel-notification state for mentions, so a
	// plain channel message played a sound (notification.new published) yet the
	// sidebar stayed read on a cold reload. Persisting for any desktop-alerted
	// channel message fixes that.
	svc, _, members, _, chans, users, _, _ := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	stateStore := newMockUserStateStore()
	svc.SetUserStateService(NewUserStateService(stateStore, nil))

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	for _, uid := range []string{"u-author", "u-bob"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid}
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	all := model.NotificationLevelAll
	members.userChannels = []*model.UserChannel{{UserID: "u-bob", ChannelID: "ch1", DesktopLevel: &all}}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello everyone"}, ParentChannel)

	if _, ok := stateStore.rows[stateStore.key("u-bob", model.UserStateChannelNotification, "ch1")]; !ok {
		t.Fatal("expected channel notification persisted for non-mention 'all'-level desktop alert")
	}
}

func TestNotificationService_DoesNotPersistChannelNotification_WhenNotDesktopAlerted(t *testing.T) {
	// The complement: a plain channel message at the quiet default neither
	// publishes nor persists — the channel must stay read.
	svc, _, members, _, chans, users, _, _ := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	stateStore := newMockUserStateStore()
	svc.SetUserStateService(NewUserStateService(stateStore, nil))

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	for _, uid := range []string{"u-author", "u-bob"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid}
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello everyone"}, ParentChannel)

	if _, ok := stateStore.rows[stateStore.key("u-bob", model.UserStateChannelNotification, "ch1")]; ok {
		t.Fatal("did not expect channel notification for a non-alerted plain message")
	}
}

func TestNotificationService_NotificationStateNoops(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
	svc.markChannelNotification(context.Background(), "u-1", "ch-1")
	svc.markThreadNotification(context.Background(), "u-1", nil, ParentChannel)
	svc.SetUserStateService(NewUserStateService(newMockUserStateStore(), nil))
	svc.markThreadNotification(context.Background(), "u-1", &model.Message{ID: "m1"}, ParentChannel)
}

func TestNotificationService_NotifyForMessage_ThreadReply_OnlyParticipantsAndRootAuthor(t *testing.T) {
	// Regression: thread replies used to fan out to every channel
	// member. They should be scoped to the thread root author + the
	// users who have already replied in this thread (plus explicit
	// @-mentions, which keep working through their own path).
	svc, pub, members, chans, users, msgs := setupNotifierWithMessages(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-root"] = &model.User{ID: "u-root", DisplayName: "Alice"}
	users.users["u-replier"] = &model.User{ID: "u-replier", DisplayName: "Bob"}
	users.users["u-replier2"] = &model.User{ID: "u-replier2", DisplayName: "Eve"}
	users.users["u-bystander"] = &model.User{ID: "u-bystander", DisplayName: "Carol"}
	members.memberships["ch1#u-root"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-root"}
	members.memberships["ch1#u-replier"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-replier"}
	members.memberships["ch1#u-replier2"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-replier2"}
	members.memberships["ch1#u-bystander"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bystander"}

	// Thread structure: u-root posted m-root; u-replier replied with
	// m-r1; now u-replier2 is posting m-r2. m-r1 is the prior reply
	// already in the store.
	msgs.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-root", Body: "ask"}
	msgs.messages["ch1#m-r1"] = &model.Message{ID: "m-r1", ParentID: "ch1", AuthorID: "u-replier", ParentMessageID: "m-root", Body: "first"}

	msg := &model.Message{ID: "m-r2", ParentID: "ch1", AuthorID: "u-replier2", ParentMessageID: "m-root", Body: "second"}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	// Expected recipients: u-root (thread root author) + u-replier
	// (prior participant). u-replier2 is excluded as the sending author.
	// u-bystander never participated → no notification.
	gotChannels := map[string]bool{}
	for _, p := range pub.published {
		gotChannels[p.channel] = true
	}
	if !gotChannels[pubsub.UserChannel("u-root")] {
		t.Error("expected thread-root author to be notified")
	}
	if !gotChannels[pubsub.UserChannel("u-replier")] {
		t.Error("expected prior thread participant to be notified")
	}
	if gotChannels[pubsub.UserChannel("u-bystander")] {
		t.Error("bystander (never in thread) must NOT be notified for a thread reply")
	}
	if gotChannels[pubsub.UserChannel("u-replier2")] {
		t.Error("author of the new reply must not notify themselves")
	}
	if got := len(pub.published); got != 2 {
		t.Errorf("publish count = %d, want 2 (root author + prior replier)", got)
	}
	for _, p := range pub.published {
		var n Notification
		if err := json.Unmarshal(p.event.Data, &n); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if n.Kind != NotificationKindThreadReply {
			t.Errorf("kind = %q, want thread_reply", n.Kind)
		}
	}
}

func TestNotificationService_NotifyForMessage_ThreadReply_IncludesExplicitFollowers(t *testing.T) {
	svc, pub, members, _, chans, users, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	for _, uid := range []string{"u-root", "u-replier", "u-follower"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid}
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	msgs.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-root", Body: "ask"}
	if err := follows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID: "u-follower", ParentID: "ch1", ParentType: ParentChannel, ThreadRootID: "m-root", Following: true,
	}); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r1", ParentID: "ch1", AuthorID: "u-replier", ParentMessageID: "m-root", Body: "reply",
	}, ParentChannel)

	kinds := publishedKinds(pub)
	if got := kinds[pubsub.UserChannel("u-follower")]; got != NotificationKindThreadReply {
		t.Errorf("explicit follower should get thread_reply, got %q", got)
	}
}

func TestNotificationService_NotifyForMessage_ThreadReply_SkipsStaleExplicitFollowers(t *testing.T) {
	svc, pub, members, _, chans, users, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	for _, uid := range []string{"u-root", "u-replier", "u-stale"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid}
	}
	for _, uid := range []string{"u-root", "u-replier"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	msgs.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-root", Body: "ask"}
	if err := follows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID: "u-stale", ParentID: "ch1", ParentType: ParentChannel, ThreadRootID: "m-root", Following: true,
	}); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r1", ParentID: "ch1", AuthorID: "u-replier", ParentMessageID: "m-root", Body: "reply",
	}, ParentChannel)

	kinds := publishedKinds(pub)
	if _, ok := kinds[pubsub.UserChannel("u-stale")]; ok {
		t.Error("stale explicit follower without channel membership must not get thread_reply")
	}
	if got := kinds[pubsub.UserChannel("u-root")]; got != NotificationKindThreadReply {
		t.Errorf("current root author should still get thread_reply, got %q", got)
	}
}

func TestNotificationService_NotifyForMessage_ThreadReply_ExcludesUnfollowedParticipants(t *testing.T) {
	svc, pub, members, _, chans, users, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	for _, uid := range []string{"u-root", "u-replier", "u-author"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid}
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	msgs.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-root", Body: "ask"}
	msgs.messages["ch1#m-r1"] = &model.Message{ID: "m-r1", ParentID: "ch1", AuthorID: "u-replier", ParentMessageID: "m-root", Body: "prior"}
	if err := follows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID: "u-replier", ParentID: "ch1", ParentType: ParentChannel, ThreadRootID: "m-root", Following: false,
	}); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r2", ParentID: "ch1", AuthorID: "u-author", ParentMessageID: "m-root", Body: "reply",
	}, ParentChannel)

	kinds := publishedKinds(pub)
	if _, ok := kinds[pubsub.UserChannel("u-replier")]; ok {
		t.Error("unfollowed prior participant should not get thread_reply")
	}
	if got := kinds[pubsub.UserChannel("u-root")]; got != NotificationKindThreadReply {
		t.Errorf("root author should still get thread_reply, got %q", got)
	}
}

func TestNotificationService_NotifyForMessage_DMThreadReply_NotifiesConversationParticipants(t *testing.T) {
	svc, pub, _, conv, _, users, msgs, _ := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()

	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	users.users["u-carol"] = &model.User{ID: "u-carol", DisplayName: "Carol"}
	conv.conversations["conv1"] = &model.Conversation{
		ID: "conv1", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-author", "u-bob", "u-carol"},
	}
	msgs.messages["conv1#m-root"] = &model.Message{ID: "m-root", ParentID: "conv1", AuthorID: "u-bob", Body: "ask"}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r1", ParentID: "conv1", AuthorID: "u-author", ParentMessageID: "m-root", Body: "reply",
	}, ParentConversation)

	kinds := publishedKinds(pub)
	if got := kinds[pubsub.UserChannel("u-bob")]; got != NotificationKindThreadReply {
		t.Errorf("DM root author should get thread_reply, got %q", got)
	}
	if got := kinds[pubsub.UserChannel("u-carol")]; got != NotificationKindThreadReply {
		t.Errorf("other DM participant should get thread_reply even without activity, got %q", got)
	}
	if _, ok := kinds[pubsub.UserChannel("u-author")]; ok {
		t.Error("author must not receive their own DM thread notification")
	}
}

func TestNotificationService_NotifyForMessage_ThreadReply_StillNotifiesExplicitMentions(t *testing.T) {
	// Mentions cut across thread scope: even if the mentioned user
	// has never participated in the thread, an @-mention should reach
	// them so they can hop in.
	svc, pub, members, chans, users, msgs := setupNotifierWithMessages(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-root"] = &model.User{ID: "u-root", DisplayName: "Alice"}
	users.users["u-replier"] = &model.User{ID: "u-replier", DisplayName: "Bob"}
	users.users["u-mentioned"] = &model.User{ID: "u-mentioned", DisplayName: "Dave"}
	members.memberships["ch1#u-root"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-root"}
	members.memberships["ch1#u-replier"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-replier"}
	members.memberships["ch1#u-mentioned"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-mentioned"}

	msgs.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-root", Body: "ask"}

	msg := &model.Message{
		ID: "m-r1", ParentID: "ch1", AuthorID: "u-replier", ParentMessageID: "m-root",
		Body: "hey @[u-mentioned|Dave] take a look",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	got := publishedKinds(pub)
	if got[pubsub.UserChannel("u-root")] != NotificationKindThreadReply {
		t.Errorf("root author should get thread_reply, got %q", got[pubsub.UserChannel("u-root")])
	}
	if got[pubsub.UserChannel("u-mentioned")] != NotificationKindMention {
		t.Errorf("mentioned user should get a mention, got %q", got[pubsub.UserChannel("u-mentioned")])
	}
}

func TestNotificationService_NotifyForMessage_RespectsMute(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushSender(push)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	members.memberships["ch1#u-carol"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-carol"}
	// Both want all messages; Bob has the channel muted, Carol does not.
	seedAllLevel(users, "u-bob", "u-carol")
	members.userChannels = []*model.UserChannel{
		{UserID: "u-bob", ChannelID: "ch1", Muted: true},
		{UserID: "u-carol", ChannelID: "ch1", Muted: false},
	}

	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hi"}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	if got := len(pub.published); got != 1 {
		t.Fatalf("publish count = %d, want 1 (muted user excluded)", got)
	}
	if pub.published[0].channel != pubsub.UserChannel("u-carol") {
		t.Errorf("expected only carol to be notified, got %s", pub.published[0].channel)
	}
	if got := len(push.calls); got != 1 {
		t.Fatalf("mobile push count = %d, want 1", got)
	}
	if push.calls[0].userID != "u-carol" {
		t.Fatalf("mobile push recipient = %q, want u-carol", push.calls[0].userID)
	}
}

// --- Default-level matrix (the real account default is "mentions, DMs &
// keywords only"; the fanout/mute tests above opt into "all" via seedAllLevel).
// These pin the behavior an end user actually experiences out of the box, plus
// the per-channel "all messages" override that the client-side regression was
// silently dropping. ---

func TestNotificationService_NotifyForMessage_ChannelPlainMessageAtDefault_Suppressed(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	// u-bob has no saved settings → resolves to the quiet default (mentions
	// only, no keywords). A plain, non-mention channel message must NOT notify.
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello everyone"}, ParentChannel)

	if got := len(pub.published); got != 0 {
		t.Fatalf("plain channel message at default level published %d, want 0", got)
	}
}

func TestNotificationService_NotifyForMessage_ChannelOverrideAllLevel_Publishes(t *testing.T) {
	// The exact scenario the user hit: account default is quiet, but the user
	// set THIS channel's desktop level to "all messages". A plain channel
	// message must then publish a notification.new (kind=message) to them.
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"} // default account settings
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	all := model.NotificationLevelAll
	members.userChannels = []*model.UserChannel{
		{UserID: "u-bob", ChannelID: "ch1", DesktopLevel: &all},
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello everyone"}, ParentChannel)

	if got := len(pub.published); got != 1 {
		t.Fatalf("channel-override 'all' published %d, want 1", got)
	}
	if got := publishedKinds(pub)[pubsub.UserChannel("u-bob")]; got != NotificationKindMessage {
		t.Errorf("kind = %q, want message", got)
	}
	if pub.published[0].channel != pubsub.UserChannel("u-bob") {
		t.Errorf("recipient channel = %q, want u-bob", pub.published[0].channel)
	}
}

func TestNotificationService_NotifyForMessage_DMPlainMessageAtDefault_Publishes(t *testing.T) {
	// DMs are always notifiable — "direct messages" is part of even the quiet
	// default level — so a plain DM at default settings still pings.
	svc, pub, _, conv, _, users := setupNotifier(t)
	ctx := context.Background()

	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"} // default settings
	conv.conversations["conv1"] = &model.Conversation{
		ID: "conv1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-author", "u-bob"},
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "conv1", AuthorID: "u-author", Body: "yo"}, ParentConversation)

	if got := len(pub.published); got != 1 {
		t.Fatalf("DM at default level published %d, want 1", got)
	}
	if got := publishedKinds(pub)[pubsub.UserChannel("u-bob")]; got != NotificationKindMessage {
		t.Errorf("kind = %q, want message", got)
	}
}

func TestNotificationService_NotifyForMessage_ChannelMentionAtDefault_Publishes(t *testing.T) {
	// An explicit @-mention bypasses the level gate entirely, so it pings even
	// at the quiet default with no per-channel override.
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"} // default settings
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hey @[u-bob|Bob] look"}, ParentChannel)

	if got := publishedKinds(pub)[pubsub.UserChannel("u-bob")]; got != NotificationKindMention {
		t.Fatalf("mention at default published kind %q, want mention", got)
	}
}

func TestNotificationService_NotifyForMessage_ChannelKeywordAtDefault_Publishes(t *testing.T) {
	// A keyword hit (here the user's seeded name keyword) surfaces a message at
	// the quiet default even without an @-mention or per-channel override.
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	kwSettings := model.DefaultNotificationSettingsForNewUser("Bob")
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob", NotificationSettings: &kwSettings}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "has anyone seen Bob today?"}, ParentChannel)

	if got := publishedKinds(pub)[pubsub.UserChannel("u-bob")]; got != NotificationKindMessage {
		t.Fatalf("keyword hit at default published kind %q, want message", got)
	}
}

// --- Mobile notification level matrix. Offline recipients keep the push path
// synchronous (no ack/timer), isolating the eff.MobileLevel switch arms that
// the default-level tests (which only exercise MobileNotificationDefault) miss.

func mobileLevelSetup(t *testing.T, mobile model.MobileNotificationLevel) (*NotificationService, *mockPublisher, *recordingMobilePush, *mockMembershipStore, *mockChannelStore, *mockUserStore) {
	t.Helper()
	svc, pub, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushSender(push)
	svc.SetPresence(&stubPresence{online: map[string]bool{}}) // recipient offline → immediate push
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob", NotificationSettings: &model.NotificationSettings{
		DesktopLevel: model.NotificationLevelMentions, // quiet desktop
		MobileLevel:  mobile,
	}}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	return svc, pub, push, members, chans, users
}

func TestNotificationService_MobileLevelAll_PushesPlainChannelMessage(t *testing.T) {
	svc, pub, push, _, _, _ := mobileLevelSetup(t, model.MobileNotificationAll)
	svc.NotifyForMessage(context.Background(),
		&model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "deploy started"}, ParentChannel)

	// Desktop is quiet (mentions-only) so no banner; mobile is "all" so it pushes.
	if len(pub.published) != 0 {
		t.Fatalf("desktop published %d, want 0 (desktop level is mentions)", len(pub.published))
	}
	if len(push.calls) != 1 || push.calls[0].userID != "u-bob" {
		t.Fatalf("mobile push calls = %#v, want one to u-bob (mobile level all)", push.calls)
	}
}

func TestNotificationService_MobileLevelMentions_SuppressesPlainChannelMessage(t *testing.T) {
	svc, pub, push, _, _, _ := mobileLevelSetup(t, model.MobileNotificationMentions)
	svc.NotifyForMessage(context.Background(),
		&model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "deploy started"}, ParentChannel)

	if len(pub.published) != 0 {
		t.Fatalf("desktop published %d, want 0", len(pub.published))
	}
	if len(push.calls) != 0 {
		t.Fatalf("mobile push calls = %#v, want 0 (plain message, mobile level mentions)", push.calls)
	}
}

func TestNotificationService_MobileLevelMentions_PushesAnExplicitMention(t *testing.T) {
	svc, pub, push, _, _, _ := mobileLevelSetup(t, model.MobileNotificationMentions)
	svc.NotifyForMessage(context.Background(),
		&model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "paging @[u-bob|Bob]"}, ParentChannel)

	// An explicit @-mention is eligible at the mentions level on BOTH surfaces.
	if got := publishedKinds(pub)[pubsub.UserChannel("u-bob")]; got != NotificationKindMention {
		t.Fatalf("desktop kind = %q, want mention", got)
	}
	if len(push.calls) != 1 || push.calls[0].userID != "u-bob" {
		t.Fatalf("mobile push calls = %#v, want one to u-bob", push.calls)
	}
}

func TestNotificationService_NotifyForMessage_SkipsSystemMessages(t *testing.T) {
	svc, pub, _, _, _, _ := setupNotifier(t)
	ctx := context.Background()
	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "X joined", System: true}
	svc.NotifyForMessage(ctx, msg, ParentChannel)
	if len(pub.published) != 0 {
		t.Errorf("system messages must not produce notifications, got %d", len(pub.published))
	}
}

func TestNotificationService_NotifyForMessage_SkipsNilAndBrokenAudience(t *testing.T) {
	svc, pub, members, conv, _, _ := setupNotifier(t)
	svc.NotifyForMessage(context.Background(), nil, ParentChannel)
	if len(pub.published) != 0 {
		t.Fatalf("nil message published %d notifications", len(pub.published))
	}

	members.listMembersErr = errors.New("members down")
	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel)
	if len(pub.published) != 0 {
		t.Fatalf("member load error published %d notifications", len(pub.published))
	}

	conv.getErr = errors.New("conversation down")
	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m2", ParentID: "c1", AuthorID: "u-author", Body: "hello"}, ParentConversation)
	if len(pub.published) != 0 {
		t.Fatalf("conversation load error published %d notifications", len(pub.published))
	}
}

func TestNotificationService_NotifyForMessage_Conversation(t *testing.T) {
	svc, pub, _, conv, _, users := setupNotifier(t)
	ctx := context.Background()

	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	conv.conversations["c1"] = &model.Conversation{
		ID:             "c1",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-author", "u-other"},
	}

	msg := &model.Message{ID: "m1", ParentID: "c1", AuthorID: "u-author", Body: "hey"}
	svc.NotifyForMessage(ctx, msg, ParentConversation)

	if got := len(pub.published); got != 1 {
		t.Fatalf("publish count = %d, want 1", got)
	}
	if pub.published[0].channel != pubsub.UserChannel("u-other") {
		t.Errorf("expected publish to other participant, got %s", pub.published[0].channel)
	}
}

func TestNotificationService_NotifyForMessage_ThreadReplyKind(t *testing.T) {
	pub := newMockPublisher()
	members := newMockMembershipStore()
	conv := newMockConversationStore()
	chans := newMockChannelStore()
	users := newMockUserStore()
	msgs := newMockMessageStore()
	svc := NewNotificationService(pub, members, conv, chans, users, msgs)
	ctx := context.Background()

	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-other"] = &model.User{ID: "u-other", DisplayName: "Bob"}
	conv.conversations["c1"] = &model.Conversation{
		ID:             "c1",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-author", "u-other"},
	}
	// Thread root authored by u-other so they get the thread_reply
	// notification when u-author replies.
	msgs.messages["c1#m1"] = &model.Message{ID: "m1", ParentID: "c1", AuthorID: "u-other", Body: "ask"}

	msg := &model.Message{
		ID:              "m2",
		ParentID:        "c1",
		AuthorID:        "u-author",
		Body:            "reply",
		ParentMessageID: "m1",
	}
	svc.NotifyForMessage(ctx, msg, ParentConversation)

	if len(pub.published) != 1 {
		t.Fatalf("publish count = %d, want 1", len(pub.published))
	}
	body := string(pub.published[0].event.Data)
	if !strings.Contains(body, `"kind":"thread_reply"`) {
		t.Errorf("expected kind=thread_reply, got body %s", body)
	}
}

func TestNotificationService_PreviewBody_ClampsAndStripsNewlines(t *testing.T) {
	if got := previewBody("hello\nworld"); got != "hello world" {
		t.Errorf("previewBody newlines = %q, want %q", got, "hello world")
	}
	long := strings.Repeat("x", 200)
	got := previewBody(long)
	if len([]rune(got)) > 140 {
		t.Errorf("previewBody clamp: rune len = %d, want <= 140", len([]rune(got)))
	}
	if !strings.HasSuffix(got, "…") {
		t.Errorf("previewBody clamp: missing ellipsis, got %q", got)
	}
}

func TestPreviewBody_FlattensMentionsAndRendersEmoji(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"user mention", "hi @[u-1|Alice]", "hi @Alice"},
		{"channel mention", "see ~[ch-1|general]", "see ~general"},
		{"both mention kinds", "@[u-1|Bob] check ~[ch-9|incidents]", "@Bob check ~incidents"},
		{"known emoji shortcode", "deploy done :tada:", "deploy done 🎉"},
		{"canonical-name emoji (frontend remap)", "hmm :thinking: :muscle:", "hmm 🤔 💪"},
		{"multiple emoji", ":fire: prod is :fire:", "🔥 prod is 🔥"},
		{"toned emoji renders base glyph", "nice :thumbsup::skin-tone-3:", "nice 👍"},
		{"unknown toned shortcode left as-is", "x :notareal::skin-tone-2:", "x :notareal::skin-tone-2:"},
		{"unknown/custom shortcode is left as-is", "love :my_custom_logo:", "love :my_custom_logo:"},
		{"mention + emoji together", "@[u-1|Ann] :wave:", "@Ann 👋"},
		{"plain text untouched", "all clear", "all clear"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := previewBody(tc.in); got != tc.want {
				t.Errorf("previewBody(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// The generated shortcode map must be wired and contain the common shortcodes
// the picker emits — a guard against the generator/map silently going missing.
func TestEmojiShortcodeMap_Wired(t *testing.T) {
	if len(emojiShortcodeToUnicode) < 1000 {
		t.Fatalf("emoji shortcode map has %d entries, want a full set (regenerate via build-emoji-data.mjs)", len(emojiShortcodeToUnicode))
	}
	for sc, want := range map[string]string{"smile": "😄", "thumbsup": "👍", "tada": "🎉", "thinking": "🤔", "muscle": "💪"} {
		if got := emojiShortcodeToUnicode[sc]; got != want {
			t.Errorf("emojiShortcodeToUnicode[%q] = %q, want %q", sc, got, want)
		}
	}
}

func TestNotificationBody_WebhookAttachmentSynthesis(t *testing.T) {
	att := func(a model.MessageAttachment) *model.Message {
		return &model.Message{ID: "m", WebhookUsername: "CI Bot", MessageAttachments: []model.MessageAttachment{a}}
	}
	cases := []struct {
		name string
		msg  *model.Message
		want string
	}{
		{"body wins over attachments", &model.Message{Body: "hello", MessageAttachments: []model.MessageAttachment{{Title: "ignored"}}}, "hello"},
		{"fallback wins when present", att(model.MessageAttachment{Fallback: "build failed", Title: "Build #42"}), "build failed"},
		{"title+text synthesized when no fallback", att(model.MessageAttachment{Title: "Build #42 failed", Text: "commit abc on main"}), "Build #42 failed — commit abc on main"},
		{"pretext+title+text ordered", att(model.MessageAttachment{Pretext: "Deploy", Title: "prod", Text: "v1.2.3"}), "Deploy — prod — v1.2.3"},
		{"fields rendered title: value", att(model.MessageAttachment{Fields: []model.MessageAttachmentField{{Title: "Status", Value: "failed"}, {Title: "Env", Value: "prod"}}}), "Status: failed — Env: prod"},
		{"field value-only and title-only", att(model.MessageAttachment{Fields: []model.MessageAttachmentField{{Value: "just a value"}, {Title: "just a title"}}}), "just a value — just a title"},
		{"footer as last resort", att(model.MessageAttachment{Footer: "via Jenkins"}), "via Jenkins"},
		{"author name as final resort", att(model.MessageAttachment{AuthorName: "Grafana"}), "Grafana"},
		{"whitespace-only fields are skipped", att(model.MessageAttachment{Fallback: "   ", Title: "  Real title  "}), "Real title"},
		{"entirely empty attachment yields empty", att(model.MessageAttachment{}), ""},
		{"falls through to a later non-empty attachment", &model.Message{MessageAttachments: []model.MessageAttachment{{}, {Title: "second one"}}}, "second one"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := notificationBody(tc.msg); got != tc.want {
				t.Errorf("notificationBody = %q, want %q", got, tc.want)
			}
		})
	}
}

// An attachments-only webhook with NO fallback must still produce a meaningful
// popup body (the regression: it arrived near-empty).
func TestNotificationService_WebhookAttachmentNoFallback_PopupNotEmpty(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author", WebhookUsername: "CI Bot",
		MessageAttachments: []model.MessageAttachment{{Title: "Build #42 failed", Text: "main is red"}},
	}, ParentChannel)

	notif := publishedNotifications(pub)[pubsub.UserChannel("u-bob")]
	if notif.Body != "Build #42 failed — main is red" {
		t.Fatalf("notification body = %q, want the synthesized summary", notif.Body)
	}
}

// Thread-reply notifications must include the thread query + #msg-
// fragment so clicking the popup opens the thread panel and highlights
// the root, not just the parent channel scrolled to the bottom.
func TestNotifyForMessage_ThreadReply_DeepLinkOpensThread(t *testing.T) {
	svc, pub, members, channels, users, msgs := setupNotifierWithMessages(t)
	channels.channels["ch-thr"] = &model.Channel{ID: "ch-thr", Slug: "thr-room", Name: "thr-room"}
	members.memberships["ch-thr#u-author"] = &model.ChannelMembership{ChannelID: "ch-thr", UserID: "u-author"}
	members.memberships["ch-thr#u-recip"] = &model.ChannelMembership{ChannelID: "ch-thr", UserID: "u-recip"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "A"}
	users.users["u-recip"] = &model.User{ID: "u-recip", DisplayName: "R"}
	// Seed the thread root authored by u-recip so the thread fanout
	// has someone to notify; otherwise no notification is emitted and
	// there's no deep link to inspect.
	msgs.messages["ch-thr#root-XYZ"] = &model.Message{ID: "root-XYZ", ParentID: "ch-thr", AuthorID: "u-recip", Body: "ask"}

	msg := &model.Message{
		ID:              "m-reply",
		ParentID:        "ch-thr",
		AuthorID:        "u-author",
		ParentMessageID: "root-XYZ",
		Body:            "hi",
	}
	svc.NotifyForMessage(context.Background(), msg, ParentChannel)

	var notif Notification
	for _, p := range pub.published {
		if p.event.Type != events.EventNotificationNew {
			continue
		}
		if err := json.Unmarshal(p.event.Data, &notif); err != nil {
			continue
		}
		break
	}
	deepLink := notif.DeepLink
	if !strings.Contains(deepLink, "?thread=root-XYZ") {
		t.Errorf("deepLink missing ?thread=root-XYZ: %q", deepLink)
	}
	if !strings.Contains(deepLink, "#msg-root-XYZ") {
		t.Errorf("deepLink missing #msg-root-XYZ: %q", deepLink)
	}
	if notif.ParentMessageID != "root-XYZ" {
		t.Errorf("ParentMessageID = %q, want root-XYZ", notif.ParentMessageID)
	}
}

// previewBody must flatten the wire-form mention `@[id|name]` into the
// readable `@name` so the OS popup reads naturally. Without this, the
// user would see "Alice mentioned: hi @[U-2|Bob]" — completely opaque.
func TestNotificationService_PreviewBody_ResolvesUserMentions(t *testing.T) {
	in := "hi @[U-2|Bob], can you take a look? cc @[U-3|Carol Q.]"
	out := previewBody(in)
	if strings.Contains(out, "@[") {
		t.Errorf("previewBody did not flatten user mentions: %q", out)
	}
	if !strings.Contains(out, "@Bob") {
		t.Errorf("previewBody missing @Bob: %q", out)
	}
	if !strings.Contains(out, "@Carol Q.") {
		t.Errorf("previewBody missing @Carol Q.: %q", out)
	}
}

// Group mentions (@all / @here) are NOT in `@[id|name]` form, so they
// flow through unchanged. Lock that down so a future regex tweak can't
// accidentally munge them.
func TestNotificationService_PreviewBody_LeavesGroupMentionsAlone(t *testing.T) {
	if got := previewBody("attention @all please"); got != "attention @all please" {
		t.Errorf("@all changed: %q", got)
	}
	if got := previewBody("@here check this"); got != "@here check this" {
		t.Errorf("@here changed: %q", got)
	}
}

func TestNotificationService_DisplayNameFallbacksAndTitles(t *testing.T) {
	svc, _, _, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	if got := svc.parentDisplayName(ctx, "ch-missing", ParentChannel); got != "ch-missing" {
		t.Fatalf("missing channel parentDisplayName = %q, want ID", got)
	}
	chans.channels["ch-name"] = &model.Channel{ID: "ch-name", Name: "General"}
	if got := svc.parentDisplayName(ctx, "ch-name", ParentChannel); got != "General" {
		t.Fatalf("channel name fallback = %q, want General", got)
	}
	if got := svc.parentDisplayName(ctx, "c1", ParentConversation); got != "" {
		t.Fatalf("conversation parentDisplayName = %q, want empty", got)
	}

	if got := svc.userDisplayName(ctx, "u-missing"); got != "u-missing" {
		t.Fatalf("missing userDisplayName = %q, want ID", got)
	}
	users.users["u-email"] = &model.User{ID: "u-email", Email: "email@example.com"}
	if got := svc.userDisplayName(ctx, "u-email"); got != "email@example.com" {
		t.Fatalf("email fallback userDisplayName = %q", got)
	}

	if got := titleFor(NotificationKindThreadReply, ParentConversation, "", "Alice"); got != "Alice replied" {
		t.Fatalf("thread conversation title = %q", got)
	}
	if got := titleFor(NotificationKindMention, ParentConversation, "", "Alice"); got != "Alice mentioned you" {
		t.Fatalf("mention conversation title = %q", got)
	}
	if got := titleFor("unknown", ParentChannel, "general", "Alice"); got != "Alice" {
		t.Fatalf("unknown title = %q", got)
	}
}

func TestIsNotifiable(t *testing.T) {
	for _, k := range []NotificationKind{NotificationKindMessage, NotificationKindMention, NotificationKindThreadReply} {
		if !IsNotifiable(k) {
			t.Errorf("IsNotifiable(%q) = false, want true", k)
		}
	}
	if IsNotifiable("never_registered_kind") {
		t.Error("IsNotifiable should return false for unknown kinds")
	}
}

func TestChannelService_SetMute_PersistsAndPublishesEvent(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u-1", Role: model.ChannelRoleMember,
	}

	if err := svc.SetMute(ctx, "u-1", "ch1", true); err != nil {
		t.Fatalf("SetMute true: %v", err)
	}
	if !memberships.mutes["ch1#u-1"] {
		t.Error("expected mute to be set true in store")
	}

	if err := svc.SetMute(ctx, "u-1", "ch1", false); err != nil {
		t.Fatalf("SetMute false: %v", err)
	}
	if memberships.mutes["ch1#u-1"] {
		t.Error("expected mute to be cleared")
	}
}

func TestChannelService_SetMute_NotMember(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	ctx := context.Background()
	if err := svc.SetMute(ctx, "u-1", "ch-missing", true); err == nil {
		t.Fatal("expected error when caller is not a member of the channel")
	}
}

// satisfy unused-import lint when fields are touched only in init; pin time import.
var _ = time.Now

// ============================================================================
// Mentions
// ============================================================================

func TestNotifyForMessage_DirectMention_NotifiesUserAsMentionKind(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	members.memberships["ch1#u-carol"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-carol"}
	// Carol is a plain (non-mentioned) member who wants all messages.
	seedAllLevel(users, "u-carol")

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "hey @[u-bob|Bob], can you check this?",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	kinds := publishedKinds(pub)
	if got := kinds[pubsub.UserChannel("u-bob")]; got != NotificationKindMention {
		t.Errorf("u-bob should receive mention kind; got %q", got)
	}
	if got := kinds[pubsub.UserChannel("u-carol")]; got != NotificationKindMessage {
		t.Errorf("u-carol should receive ordinary message kind; got %q", got)
	}
	if _, ok := kinds[pubsub.UserChannel("u-author")]; ok {
		t.Error("author must never receive their own notification")
	}
}

func TestNotifyForMessage_DirectMention_BypassesMute(t *testing.T) {
	// A direct @-mention overrides the mute preference — that's the
	// social contract the UI promises ("@-mentions always reach you").
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	// Bob has the channel muted but is directly mentioned — must still ping.
	members.userChannels = []*model.UserChannel{
		{UserID: "u-bob", ChannelID: "ch1", Muted: true},
	}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@[u-bob|Bob] urgent",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	kinds := publishedKinds(pub)
	if got := kinds[pubsub.UserChannel("u-bob")]; got != NotificationKindMention {
		t.Errorf("muted user with direct mention should still get mention; got %q", got)
	}
}

func TestNotifyForMessage_AtAll_NotifiesAllMembersAsMention(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	members.memberships["ch1#u-carol"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-carol"}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@all please review",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	kinds := publishedKinds(pub)
	for _, uid := range []string{"u-bob", "u-carol"} {
		if got := kinds[pubsub.UserChannel(uid)]; got != NotificationKindMention {
			t.Errorf("@all should mention %s; got kind=%q", uid, got)
		}
	}
}

func TestNotifyForMessage_AtAll_NotificationKeepsGroupMentionCopy(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@all please review",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	notifs := publishedNotifications(pub)
	got := notifs[pubsub.UserChannel("u-bob")]
	if got.Kind != NotificationKindMention {
		t.Fatalf("kind = %q, want %q", got.Kind, NotificationKindMention)
	}
	if !strings.Contains(got.Title, "@all") {
		t.Errorf("@all title lost group mention: %q", got.Title)
	}
	if !strings.Contains(got.Body, "@all") {
		t.Errorf("@all body lost group mention: %q", got.Body)
	}
}

func TestNotifyForMessage_AtAll_RespectsMute(t *testing.T) {
	// @all is a group mention — it follows the polite "respect mute" rule
	// rather than the bypass behaviour of a direct mention.
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	members.memberships["ch1#u-carol"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-carol"}
	members.userChannels = []*model.UserChannel{
		{UserID: "u-bob", ChannelID: "ch1", Muted: true},
	}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@all heads up",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	kinds := publishedKinds(pub)
	if _, ok := kinds[pubsub.UserChannel("u-bob")]; ok {
		t.Error("@all must not ping a user who muted the channel")
	}
	if got := kinds[pubsub.UserChannel("u-carol")]; got != NotificationKindMention {
		t.Errorf("@all should still ping unmuted carol; got %q", got)
	}
}

func TestNotifyForMessage_AtHere_OnlyOnlineMembers(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()
	svc.SetPresence(&stubPresence{online: map[string]bool{
		"u-bob": true,
		// carol is offline
	}})

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	members.memberships["ch1#u-carol"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-carol"}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@here anyone?",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	kinds := publishedKinds(pub)
	if got := kinds[pubsub.UserChannel("u-bob")]; got != NotificationKindMention {
		t.Errorf("online u-bob should receive @here mention; got %q", got)
	}
	// Offline u-carol still receives the normal message-kind alert (everyone
	// in the channel does) — but must NOT receive a @here mention.
	if got := kinds[pubsub.UserChannel("u-carol")]; got == NotificationKindMention {
		t.Error("offline u-carol must not receive a mention from @here")
	}
}

func TestNotifyForMessage_AtHere_NotificationKeepsGroupMentionCopy(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true}})

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@here anyone?",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	notifs := publishedNotifications(pub)
	got := notifs[pubsub.UserChannel("u-bob")]
	if got.Kind != NotificationKindMention {
		t.Fatalf("kind = %q, want %q", got.Kind, NotificationKindMention)
	}
	if !strings.Contains(got.Title, "@here") {
		t.Errorf("@here title lost group mention: %q", got.Title)
	}
	if !strings.Contains(got.Body, "@here") {
		t.Errorf("@here body lost group mention: %q", got.Body)
	}
}

func TestNotifyForMessage_AtHere_NoPresenceLookup_NoOp(t *testing.T) {
	// When PresenceLookup isn't wired, @here notifies nobody — better
	// than spamming the whole channel.
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@here ?",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	kinds := publishedKinds(pub)
	for ch, kind := range kinds {
		if kind == NotificationKindMention {
			t.Errorf("@here without presence wired should produce no mention; got mention to %s", ch)
		}
	}
}

func TestNotifyForMessage_AuthorNeverNotifiedByOwnMention(t *testing.T) {
	// Mentioning yourself in your own message is a no-op — the de-dup
	// logic in resolveMentionRecipients explicitly drops msg.AuthorID.
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-author": true, "u-bob": true}})

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@[u-author|Alice] @here @all",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	kinds := publishedKinds(pub)
	if _, ok := kinds[pubsub.UserChannel("u-author")]; ok {
		t.Error("author must never receive a notification triggered by their own message")
	}
}

func TestNotifyForMessage_MentionTakesPrecedenceOverRegularMessage(t *testing.T) {
	// A user who is both a regular member AND directly mentioned should
	// receive ONE notification (the mention), not two.
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "hi @[u-bob|Bob]",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	bobChan := pubsub.UserChannel("u-bob")
	count := 0
	for _, p := range pub.published {
		if p.channel == bobChan {
			count++
		}
	}
	if count != 1 {
		t.Errorf("u-bob should be notified once (mention only), got %d events", count)
	}
}

func TestNotifyForMessage_MentionInDM_StillWorks(t *testing.T) {
	// Direct mentions in a 1:1 conversation are redundant (the recipient
	// gets a message-kind notification anyway) but should still work and
	// upgrade the kind from message → mention.
	svc, pub, _, conv, _, users := setupNotifier(t)
	ctx := context.Background()
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	conv.conversations["c1"] = &model.Conversation{
		ID:             "c1",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-author", "u-other"},
	}

	msg := &model.Message{
		ID: "m1", ParentID: "c1", AuthorID: "u-author",
		Body: "@[u-other|Other] please look",
	}
	svc.NotifyForMessage(ctx, msg, ParentConversation)

	kinds := publishedKinds(pub)
	if got := kinds[pubsub.UserChannel("u-other")]; got != NotificationKindMention {
		t.Errorf("expected mention kind in DM; got %q", got)
	}
}

func TestNotifyForMessage_AtAll_InGroupConversation(t *testing.T) {
	svc, pub, _, conv, _, users := setupNotifier(t)
	ctx := context.Background()
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	conv.conversations["c1"] = &model.Conversation{
		ID:             "c1",
		Type:           model.ConversationTypeGroup,
		ParticipantIDs: []string{"u-author", "u-x", "u-y"},
	}

	msg := &model.Message{
		ID: "m1", ParentID: "c1", AuthorID: "u-author",
		Body: "@all heads up",
	}
	svc.NotifyForMessage(ctx, msg, ParentConversation)

	kinds := publishedKinds(pub)
	for _, uid := range []string{"u-x", "u-y"} {
		if got := kinds[pubsub.UserChannel(uid)]; got != NotificationKindMention {
			t.Errorf("@all in group conversation should mention %s; got %q", uid, got)
		}
	}
}

func TestNotifyForMessage_MentionTitle_IncludesChannelName(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	msg := &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		Body: "@[u-bob|Bob] hi",
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel)

	for _, p := range pub.published {
		if p.channel != pubsub.UserChannel("u-bob") {
			continue
		}
		var n Notification
		if err := json.Unmarshal(p.event.Data, &n); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if !strings.Contains(n.Title, "mentioned you") || !strings.Contains(n.Title, "general") {
			t.Errorf("expected mention title to include 'mentioned you' and channel name; got %q", n.Title)
		}
		return
	}
	t.Fatal("no notification published to u-bob")
}

func TestNotificationService_WebhookUsernameAndFallbackBody(t *testing.T) {
	svc, _, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushSender(push)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice (creator)"}
	for _, uid := range []string{"u-author", "u-bob"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	// Attachments-only webhook message: the override username drives the
	// title and the attachment fallback drives the body.
	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		WebhookUsername:    "CI Bot",
		MessageAttachments: []model.MessageAttachment{{Fallback: "build failed"}},
	}, ParentChannel)

	// Webhook posts notify EVERY member, including u-author — the webhook's
	// creator wired up the alert and wants it, they didn't write the message.
	// (A regular message would exclude the author, leaving only u-bob.)
	if len(push.calls) != 2 {
		t.Fatalf("push count = %d, want 2 (both members incl. webhook creator)", len(push.calls))
	}
	recipients := map[string]bool{}
	for _, c := range push.calls {
		recipients[c.userID] = true
		if !c.notif.Webhook {
			t.Errorf("notif.Webhook = false, want true for webhook post")
		}
	}
	if !recipients["u-author"] || !recipients["u-bob"] {
		t.Fatalf("recipients = %v, want both u-author and u-bob", recipients)
	}
	notif := push.calls[0].notif
	if notif.Body != "build failed" {
		t.Fatalf("notification body = %q, want fallback", notif.Body)
	}
	if !strings.Contains(notif.Title, "CI Bot") {
		t.Fatalf("notification title = %q, want webhook username", notif.Title)
	}
}
