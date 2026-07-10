package service

import (
	"context"
	"fmt"
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

// recordingMobilePush records scheduled pushes (the MobilePushScheduler seam
// the NotificationService uses) and doubles as a provider-side
// MobilePushSender for the task-handler tests.
type recordingMobilePush struct {
	calls []mobilePushCall
	err   error
}

type mobilePushCall struct {
	userID string
	notif  Notification
	delay  time.Duration
}

func (p *recordingMobilePush) Send(_ context.Context, userID string, notif Notification) error {
	p.calls = append(p.calls, mobilePushCall{userID: userID, notif: notif})
	return p.err
}

func (p *recordingMobilePush) SchedulePush(_ context.Context, userID string, notif Notification, delay time.Duration) error {
	p.calls = append(p.calls, mobilePushCall{userID: userID, notif: notif, delay: delay})
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

func TestNotificationService_NotifyDirect(t *testing.T) {
	svc, pub, _, _, _, _ := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)
	// Offline → mobile push fires immediately alongside the desktop publish.
	svc.SetPresence(&stubPresence{online: map[string]bool{}})

	notif := Notification{Kind: NotificationKindReminder, Title: "Reminder", Body: "look", MessageID: "m1"}
	svc.NotifyDirect(context.Background(), "u-1", notif)

	if got := publishedKinds(pub)[pubsub.UserChannel("u-1")]; got != NotificationKindReminder {
		t.Fatalf("desktop publish kind = %q, want reminder", got)
	}
	if len(push.calls) != 1 || push.calls[0].userID != "u-1" {
		t.Fatalf("expected one mobile push to u-1, got %+v", push.calls)
	}
}

func TestNotificationService_NotifyDirect_EmptyUserNoOp(t *testing.T) {
	svc, pub, _, _, _, _ := setupNotifier(t)
	svc.NotifyDirect(context.Background(), "", Notification{Kind: NotificationKindReminder})
	if len(pub.published) != 0 {
		t.Fatalf("empty userID should publish nothing, got %d", len(pub.published))
	}
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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.SetMobilePushScheduler(push)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob", "u-carol")
	for _, uid := range []string{"u-author", "u-bob", "u-carol"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel, nil)

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
	svc.SetMobilePushScheduler(push)
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

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel, nil)

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

// stubAckStore reports a fixed set of (userID, messageID) acks as delivered.
type stubAckStore struct{ acked map[string]bool }

func (s *stubAckStore) WasNotificationAcked(_ context.Context, userID, messageID string) bool {
	return s.acked[userID+":"+messageID]
}

// TestAckFallbackDelayInvariants guards the timing contract that keeps the
// ack-gated mobile fallback from double-notifying an online desktop user. The
// deferred push must not fire before a healthy socket has had a full WS
// keep-alive cycle to prove liveness and surface+ack the alert, and the ack
// marker must still be alive in Redis when the timer reads it.
//
// Source constants (kept in sync by comment, since they live in sibling
// packages): handler.wsKeepAliveInterval = 15s, handler.wsPongTimeout = 10s,
// cache.notifAckTTL = 5m.
func TestAckFallbackDelayInvariants(t *testing.T) {
	const keepAliveCycle = 15*time.Second + 10*time.Second // wsKeepAliveInterval + wsPongTimeout
	const ackMarkerTTL = 5 * time.Minute                   // cache.notifAckTTL
	if ackFallbackDelay < keepAliveCycle {
		t.Errorf("ackFallbackDelay = %v, must be >= one keep-alive cycle (%v) so a healthy socket can ack before the push fires", ackFallbackDelay, keepAliveCycle)
	}
	// The worker reads the ack at DELIVERY time, which can lag the nominal
	// delay by the asynq delayed-task check interval (5s) plus queue wait —
	// the marker TTL must comfortably outlive all of it.
	if ackFallbackDelay+time.Minute >= ackMarkerTTL {
		t.Errorf("ackFallbackDelay = %v, must be well below notifAckTTL (%v) so a recorded ack is still visible when the worker delivers", ackFallbackDelay, ackMarkerTTL)
	}
}

func dmNotifier(t *testing.T) (*NotificationService, *recordingMobilePush) {
	t.Helper()
	svc, _, _, conv, _, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	conv.conversations["c1"] = &model.Conversation{
		ID: "c1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-author", "u-bob"},
	}
	return svc, push
}

func notifyDM(svc *NotificationService) {
	svc.NotifyForMessage(context.Background(),
		&model.Message{ID: "m1", ParentID: "c1", AuthorID: "u-author", Body: "incident!"}, ParentConversation, nil)
}

// THE core contract: an "online" recipient's push is SCHEDULED (deferred by
// the ack window), never skipped — presence alone can't be trusted to mean
// "the desktop will deliver". The ack check happens in the worker at delivery
// time (push_scheduler_test.go covers that half), so the pending task
// survives restarts.
func TestNotificationService_MobilePush_Online_SchedulesDeferredPush(t *testing.T) {
	svc, push := dmNotifier(t)
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true}})
	svc.SetAckStore(&stubAckStore{acked: map[string]bool{}})

	notifyDM(svc)

	if len(push.calls) != 1 {
		t.Fatalf("scheduled pushes = %d, want 1", len(push.calls))
	}
	if got := push.calls[0]; got.userID != "u-bob" || got.delay != ackFallbackDelay {
		t.Fatalf("scheduled (user=%q, delay=%v), want (u-bob, %v)", got.userID, got.delay, ackFallbackDelay)
	}
}

// An offline recipient (no socket to ack) is scheduled for immediate delivery.
func TestNotificationService_MobilePush_Offline_SchedulesImmediately(t *testing.T) {
	svc, push := dmNotifier(t)
	svc.SetPresence(&stubPresence{online: map[string]bool{}}) // u-bob offline
	svc.SetAckStore(&stubAckStore{acked: map[string]bool{}})

	notifyDM(svc)

	if len(push.calls) != 1 {
		t.Fatalf("scheduled pushes = %d, want 1", len(push.calls))
	}
	if got := push.calls[0]; got.userID != "u-bob" || got.delay != 0 {
		t.Fatalf("scheduled (user=%q, delay=%v), want (u-bob, 0)", got.userID, got.delay)
	}
}

// Without an ack store wired, an online recipient falls back to the old
// presence-only behaviour (push skipped) — nothing scheduled, no panic.
func TestNotificationService_MobilePush_OnlineNoAckStore_SkipsPush(t *testing.T) {
	svc, push := dmNotifier(t)
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true}})
	// No SetAckStore.

	notifyDM(svc)

	if len(push.calls) != 0 {
		t.Fatalf("no ack store → online push should be skipped, but scheduled %d", len(push.calls))
	}
}

// A notification without a messageID has nothing to key the ack on — the
// online path degrades to presence-only (skip) rather than a deferred task
// that could never be suppressed.
func TestNotificationService_MobilePush_OnlineNoMessageID_SkipsPush(t *testing.T) {
	svc, _, _, _, _, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)
	users.users["u-1"] = &model.User{ID: "u-1", DisplayName: "One"}
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-1": true}})
	svc.SetAckStore(&stubAckStore{acked: map[string]bool{}})

	svc.NotifyDirect(context.Background(), "u-1", Notification{Kind: NotificationKindReminder, Title: "r", Body: "b"})

	if len(push.calls) != 0 {
		t.Fatalf("no messageID → online push should be skipped, but scheduled %d", len(push.calls))
	}
}

// A scheduler failure is logged loudly but must never block the desktop
// publish that already happened.
func TestNotificationService_MobilePush_ScheduleErrorDoesNotBlock(t *testing.T) {
	svc, push := dmNotifier(t)
	push.err = errors.New("redis down")
	svc.SetPresence(&stubPresence{online: map[string]bool{}})
	svc.SetAckStore(&stubAckStore{acked: map[string]bool{}})

	notifyDM(svc) // must not panic; error only logged

	if len(push.calls) != 1 {
		t.Fatalf("schedule attempts = %d, want 1", len(push.calls))
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

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel, nil)

	if got := len(pub.published); got != 1 {
		t.Fatalf("publish count = %d, want 1", got)
	}
}

func TestNotificationService_MobilePushFailureDoesNotBlockMessageDelivery(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{err: errors.New("provider unavailable")}
	svc.SetMobilePushScheduler(push)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob")
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel, nil)

	if got := len(pub.published); got != 1 {
		t.Fatalf("publish count = %d, want 1", got)
	}
	if got := len(push.calls); got != 1 {
		t.Fatalf("mobile push attempts = %d, want 1", got)
	}
}

func TestNotificationService_PersistsThreadNotificationState(t *testing.T) {
	svc, _, members, _, chans, users, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	stateStore := newMockUserStateStore()
	svc.SetUserStateService(NewUserStateService(stateStore, nil))

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	for _, uid := range []string{"u-author", "u-bob"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid}
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	// A top-level channel message — even a @-mention that fires a desktop alert —
	// persists NO per-user marker: the sidebar badge is driven by the durable seq
	// count, so the O(recipients) write is gone (perf C3).
	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hi @[u-bob|Bob]"}, ParentChannel, nil)
	if len(stateStore.rows) != 0 {
		t.Fatalf("top-level channel message must persist no user-state rows, got %d", len(stateStore.rows))
	}

	// A thread reply DOES persist a thread-notification marker — thread replies
	// don't bump the parent seq, so this is the only durable thread-unread signal.
	msgs.messages["ch1#root1"] = &model.Message{ID: "root1", ParentID: "ch1", AuthorID: "u-author", Body: "root", CreatedAt: time.Now()}
	if err := follows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID: "u-bob", ParentID: "ch1", ParentType: ParentChannel, ThreadRootID: "root1", Following: true, UpdatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}
	svc.NotifyForMessage(ctx, &model.Message{ID: "reply1", ParentID: "ch1", ParentMessageID: "root1", AuthorID: "u-author", Body: "reply @[u-bob|Bob]"}, ParentChannel, nil)
	if _, ok := stateStore.rows[stateStore.key("u-bob", model.UserStateThreadNotification, "root1")]; !ok {
		t.Fatal("expected thread notification state for follower")
	}
	// Posting a reply reads the thread for YOU: the author's seen watermark
	// advances server-side (the client relies on this and skips its own
	// seen PUT — regression guard for one HTTP round-trip per reply).
	if _, ok := stateStore.rows[stateStore.key("u-author", model.UserStateThreadSeen, "root1")]; !ok {
		t.Fatal("expected author thread-seen state after posting a reply")
	}
}

func TestNotificationService_NoChannelMarker_EvenWhenDesktopAlerted(t *testing.T) {
	// Perf C3: a desktop-alerted channel message must NOT write a per-recipient
	// user-state row. The "sound but no badge" cold-load case is now covered by
	// ListUserChannels' seq-derived unreadCount (durable, server-computed), not by
	// an O(recipients) marker write.
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

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello everyone"}, ParentChannel, nil)

	if len(stateStore.rows) != 0 {
		t.Fatalf("desktop-alerted channel message must write no user-state rows (perf C3), got %d", len(stateStore.rows))
	}
}

func TestNotificationService_NotificationStateNoops(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	}, ParentChannel, nil)

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
	}, ParentChannel, nil)

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
	}, ParentChannel, nil)

	kinds := publishedKinds(pub)
	if _, ok := kinds[pubsub.UserChannel("u-replier")]; ok {
		t.Error("unfollowed prior participant should not get thread_reply")
	}
	if got := kinds[pubsub.UserChannel("u-root")]; got != NotificationKindThreadReply {
		t.Errorf("root author should still get thread_reply, got %q", got)
	}
}

// A watched keyword landing in a thread reply must reach a member who is NOT a
// thread participant — an explicit "always alert me on this word" interest cuts
// across thread scope (e.g. an incident keyword in a thread reply). Bystanders
// without the keyword still stay quiet.
// A transient member-list load failure must NOT silently swallow the alert: it
// notifies nobody (the audience is genuinely unknown) but that is an incident
// (logged ERROR), not a no-op. This locks the "no silent missed alert" contract.
type stubNameCache struct {
	hits map[string]string
	sets map[string]string
}

func (c *stubNameCache) GetName(_ context.Context, key string) (string, bool) {
	v, ok := c.hits[key]
	return v, ok
}
func (c *stubNameCache) SetName(_ context.Context, key, val string) { c.sets[key] = val }

func TestNotificationService_NameCache(t *testing.T) {
	svc, _, _, _, chans, users := setupNotifier(t)
	nc := &stubNameCache{
		hits: map[string]string{"chan:ch-cached": "cached-name"},
		sets: map[string]string{},
	}
	svc.SetNameCache(nc)
	chans.channels["ch-miss"] = &model.Channel{ID: "ch-miss", Name: "Real", Slug: "real-slug"}
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice"}

	// Channel cache HIT: served from cache, store not consulted.
	if got := svc.parentDisplayName(context.Background(), "ch-cached", ParentChannel); got != "cached-name" {
		t.Errorf("cached channel name = %q, want cached-name", got)
	}
	// Channel cache MISS: reads store, then caches the slug.
	if got := svc.parentDisplayName(context.Background(), "ch-miss", ParentChannel); got != "real-slug" {
		t.Errorf("missed channel name = %q, want real-slug", got)
	}
	if nc.sets["chan:ch-miss"] != "real-slug" {
		t.Errorf("channel name not cached after miss: %v", nc.sets)
	}
	// User cache MISS: reads store, then caches.
	if got := svc.userDisplayName(context.Background(), "u1"); got != "Alice" {
		t.Errorf("user name = %q, want Alice", got)
	}
	if nc.sets["user:u1"] != "Alice" {
		t.Errorf("user name not cached after miss: %v", nc.sets)
	}
	// User cache HIT.
	nc.hits["user:u1"] = "Cached Alice"
	if got := svc.userDisplayName(context.Background(), "u1"); got != "Cached Alice" {
		t.Errorf("cached user name = %q, want Cached Alice", got)
	}
}

// withFastAudienceRetry shrinks the audience-load retry so give-up-path tests
// don't sleep out the production backoff.
func withFastAudienceRetry(t *testing.T) {
	t.Helper()
	orig := audienceRetryInterval
	audienceRetryInterval = time.Millisecond
	t.Cleanup(func() { audienceRetryInterval = orig })
}

// flakyListMembersStore fails ListMembers n times, then delegates — the
// transient-DynamoDB-blip shape the audience retry exists for.
type flakyListMembersStore struct {
	MembershipStore
	failures int
	calls    int
}

func (f *flakyListMembersStore) ListMembers(ctx context.Context, channelID string) ([]*model.ChannelMembership, error) {
	f.calls++
	if f.calls <= f.failures {
		return nil, errors.New("dynamodb throttled")
	}
	return f.MembershipStore.ListMembers(ctx, channelID)
}

// C6 regression: a transient audience-read failure used to zero the ENTIRE
// recipient set (no desktop, no mobile — a silently lost alert). The retry
// must recover it.
func TestNotificationService_NotifyForMessage_TransientMemberLoadError_RetriesAndNotifies(t *testing.T) {
	withFastAudienceRetry(t)
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob")
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	flaky := &flakyListMembersStore{MembershipStore: members, failures: 2}
	svc.members = flaky

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "deploy"}, ParentChannel, nil)

	if got := len(publishedKinds(pub)); got != 1 {
		t.Fatalf("transient member-load error must be retried and notify, got %d notifications", got)
	}
	if flaky.calls != 3 {
		t.Fatalf("ListMembers calls = %d, want 3 (2 failures + success)", flaky.calls)
	}
}

func TestNotificationService_NotifyForMessage_MemberLoadError_NotifiesNobody(t *testing.T) {
	withFastAudienceRetry(t)
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	members.listMembersErr = errors.New("dynamodb throttled")

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "deploy"}, ParentChannel, nil)

	if got := len(publishedKinds(pub)); got != 0 {
		t.Errorf("member-load error should resolve no audience, got %d notifications", got)
	}
}

func TestNotificationService_NotifyForMessage_ThreadReply_KeywordNotifiesNonParticipant(t *testing.T) {
	svc, pub, members, _, chans, users, msgs, _ := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-root"] = &model.User{ID: "u-root", DisplayName: "Root"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	kw := model.DefaultNotificationSettingsForNewUser("Watcher")
	kw.Keywords = []string{"outage"}
	users.users["u-watcher"] = &model.User{ID: "u-watcher", DisplayName: "Watcher", NotificationSettings: &kw}
	users.users["u-quiet"] = &model.User{ID: "u-quiet", DisplayName: "Quiet"}
	for _, uid := range []string{"u-root", "u-author", "u-watcher", "u-quiet"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	msgs.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-root", Body: "ask"}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r1", ParentID: "ch1", AuthorID: "u-author", ParentMessageID: "m-root", Body: "we have an outage",
	}, ParentChannel, nil)

	kinds := publishedKinds(pub)
	if _, ok := kinds[pubsub.UserChannel("u-watcher")]; !ok {
		t.Error("keyword watcher should be notified about a thread reply containing their keyword, even as a non-participant")
	}
	if _, ok := kinds[pubsub.UserChannel("u-quiet")]; ok {
		t.Error("a non-participant WITHOUT the keyword must stay quiet for thread chatter")
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
	}, ParentConversation, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.SetMobilePushScheduler(push)
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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello everyone"}, ParentChannel, nil)

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

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello everyone"}, ParentChannel, nil)

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

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "conv1", AuthorID: "u-author", Body: "yo"}, ParentConversation, nil)

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

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hey @[u-bob|Bob] look"}, ParentChannel, nil)

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

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "has anyone seen Bob today?"}, ParentChannel, nil)

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
	svc.SetMobilePushScheduler(push)
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
		&model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "deploy started"}, ParentChannel, nil)

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
		&model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "deploy started"}, ParentChannel, nil)

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
		&model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "paging @[u-bob|Bob]"}, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)
	if len(pub.published) != 0 {
		t.Errorf("system messages must not produce notifications, got %d", len(pub.published))
	}
}

func TestNotificationService_NotifyForMessage_SkipsNilAndBrokenAudience(t *testing.T) {
	withFastAudienceRetry(t)
	svc, pub, members, conv, _, _ := setupNotifier(t)
	svc.NotifyForMessage(context.Background(), nil, ParentChannel, nil)
	if len(pub.published) != 0 {
		t.Fatalf("nil message published %d notifications", len(pub.published))
	}

	members.listMembersErr = errors.New("members down")
	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel, nil)
	if len(pub.published) != 0 {
		t.Fatalf("member load error published %d notifications", len(pub.published))
	}

	conv.getErr = errors.New("conversation down")
	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m2", ParentID: "c1", AuthorID: "u-author", Body: "hello"}, ParentConversation, nil)
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
	svc.NotifyForMessage(ctx, msg, ParentConversation, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentConversation, nil)

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
	seedAllLevel(users, "u-bob")
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author", WebhookUsername: "CI Bot",
		MessageAttachments: []model.MessageAttachment{{Title: "Build #42 failed", Text: "main is red"}},
	}, ParentChannel, nil)

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
	svc.NotifyForMessage(context.Background(), msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentConversation, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentConversation, nil)

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
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

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
	svc.SetMobilePushScheduler(push)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	seedAllLevel(users, "u-author", "u-bob")
	for _, uid := range []string{"u-author", "u-bob"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	// Attachments-only webhook message: the override username drives the
	// title and the attachment fallback drives the body.
	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u-author",
		WebhookUsername:    "CI Bot",
		MessageAttachments: []model.MessageAttachment{{Fallback: "build failed"}},
	}, ParentChannel, nil)

	// Both members opted into "all messages". The creator is a normal
	// recipient too: the webhook sentinel authored the post, so u-author is
	// NOT excluded the way a real message author would be.
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

// Regression: webhook posts must respect each recipient's notification level.
// A forceAll flag used to bypass the level machinery and alert every non-muted
// member even when they had chosen the quiet "mentions, DMs & keywords" level
// for the channel — a webhook post is gated exactly like a regular message.
func TestNotifyForMessage_Webhook_RespectsNotificationLevel(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "alerts", Slug: "alerts", Type: model.ChannelTypePublic}
	for _, uid := range []string{"u-quiet", "u-keyword", "u-all", "u-muted"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	// u-quiet stays on the quiet default (no saved settings); u-keyword is
	// quiet but the post matches one of their keywords; u-all opted into
	// "all messages"; u-muted opted into "all" but muted the channel.
	users.users["u-keyword"] = &model.User{ID: "u-keyword", DisplayName: "K",
		NotificationSettings: &model.NotificationSettings{
			DesktopLevel: model.NotificationLevelMentions,
			Keywords:     []string{"deploy"},
		}}
	seedAllLevel(users, "u-all", "u-muted")
	members.userChannels = []*model.UserChannel{
		{UserID: "u-muted", ChannelID: "ch1", Muted: true},
	}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "webhook", WebhookUsername: "CI Bot",
		Body: "deploy finished",
	}, ParentChannel, nil)

	got := publishedNotifications(pub)
	if _, ok := got[pubsub.UserChannel("u-quiet")]; ok {
		t.Error("quiet-level member was notified for a webhook post — the level must gate webhooks like any message")
	}
	if _, ok := got[pubsub.UserChannel("u-muted")]; ok {
		t.Error("muted member was notified for a webhook post")
	}
	if _, ok := got[pubsub.UserChannel("u-keyword")]; !ok {
		t.Error("keyword match did not alert on a webhook post")
	}
	if _, ok := got[pubsub.UserChannel("u-all")]; !ok {
		t.Error(`"all messages" member was not alerted for a webhook post`)
	}
}

// The thread.updated audience — everyone whose /threads list shows this
// thread. Regression matrix for the two classes the old MessageService
// copy of these rules MISSED (follow-all-threads users and bystanders
// pulled in by this reply's own notification), alongside the invariants
// carried over from that copy: reply author included even past an
// unfollow, explicit followers included, unfollowed repliers and
// departed followers excluded, quiet bystanders excluded.
func TestNotifyForMessage_ThreadUpdated_AudienceMatrix(t *testing.T) {
	svc, pub, members, _, chans, users, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	all := []string{"sender", "root-author", "replier", "follower", "bystander", "unfollowed-replier", "follow-all", "pulled-in"}
	for _, uid := range all {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	users.users["sender"] = &model.User{ID: "sender", DisplayName: "Sender"}
	// follow-all opted into following every thread; quiet level otherwise.
	users.users["follow-all"] = &model.User{ID: "follow-all", DisplayName: "FA",
		NotificationSettings: &model.NotificationSettings{
			DesktopLevel:     model.NotificationLevelMentions,
			ThreadReplies:    true,
			FollowAllThreads: true,
		}}
	created := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	msgs.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "root-author", Body: "root text", CreatedAt: created, ReplyCount: 2}
	msgs.messages["ch1#old-1"] = &model.Message{ID: "old-1", ParentID: "ch1", ParentMessageID: "root", AuthorID: "replier", CreatedAt: created.Add(time.Minute)}
	msgs.messages["ch1#old-2"] = &model.Message{ID: "old-2", ParentID: "ch1", ParentMessageID: "root", AuthorID: "unfollowed-replier", CreatedAt: created.Add(2 * time.Minute)}
	for _, f := range []*model.ThreadFollow{
		{UserID: "follower", ParentID: "ch1", ThreadRootID: "root", Following: true},
		{UserID: "left-follower", ParentID: "ch1", ThreadRootID: "root", Following: true}, // not a member anymore
		{UserID: "unfollowed-replier", ParentID: "ch1", ThreadRootID: "root", Following: false},
		{UserID: "sender", ParentID: "ch1", ThreadRootID: "root", Following: false}, // posting re-opts them in
	} {
		if err := follows.SetThreadFollow(ctx, f); err != nil {
			t.Fatalf("SetThreadFollow: %v", err)
		}
	}

	lastReply := created.Add(3 * time.Minute)
	updatedRoot := &model.Message{ID: "root", ParentID: "ch1", AuthorID: "root-author", Body: "root text", CreatedAt: created, ReplyCount: 3, LastReplyAt: &lastReply}
	// The reply @-mentions "pulled-in", a bystander: the mention alert gives
	// them a notification row, so their /threads list gains this thread and
	// they must receive the live patch too.
	msg := &model.Message{
		ID: "m-new", ParentID: "ch1", ParentMessageID: "root", AuthorID: "sender",
		Body: "a reply for @[pulled-in|PI]", CreatedAt: lastReply,
	}
	svc.NotifyForMessage(ctx, msg, ParentChannel, updatedRoot)

	got, summary := threadUpdateRecipients(pub)
	for _, want := range []string{"sender", "root-author", "replier", "follower", "follow-all", "pulled-in"} {
		if !got[want] {
			t.Errorf("thread.updated missing for %q (got %v)", want, got)
		}
	}
	for _, no := range []string{"bystander", "left-follower", "unfollowed-replier"} {
		if got[no] {
			t.Errorf("did not expect thread.updated for %q", no)
		}
	}
	if summary == nil {
		t.Fatal("no thread.updated payload captured")
	}
	if summary.ThreadRootID != "root" || summary.RootAuthorID != "root-author" || summary.RootBody != "root text" {
		t.Errorf("summary root fields = %+v", summary)
	}
	if summary.ReplyCount != 3 {
		t.Errorf("ReplyCount = %d, want 3", summary.ReplyCount)
	}
	if !summary.LatestActivityAt.Equal(lastReply) {
		t.Errorf("LatestActivityAt = %v, want LastReplyAt %v", summary.LatestActivityAt, lastReply)
	}
}

// Without an authoritative root (IncrementReplyMetadata failed) no
// thread.updated may be published — a stale replyCount must never be
// live-patched — while the reply notifications themselves still fire.
func TestNotifyForMessage_ThreadUpdated_NilRootSkipsPatch(t *testing.T) {
	svc, pub, members, _, chans, users, msgs, _ := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	for _, uid := range []string{"sender", "root-author"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	seedAllLevel(users, "root-author")
	created := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	msgs.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "root-author", Body: "root", CreatedAt: created, ReplyCount: 1}

	msg := &model.Message{ID: "m-new", ParentID: "ch1", ParentMessageID: "root", AuthorID: "sender", Body: "reply"}
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

	if got, _ := threadUpdateRecipients(pub); len(got) != 0 {
		t.Fatalf("thread.updated published to %v despite nil root", got)
	}
	if _, ok := publishedNotifications(pub)[pubsub.UserChannel("root-author")]; !ok {
		t.Fatal("reply notification must still fire when the metadata bump failed")
	}
}

// Conversation thread replies notify EVERY participant (DMs bypass the
// level machinery), and each notified recipient gains a thread-
// notification row that surfaces the thread in their /threads list — so
// all of them receive the live thread.updated patch too, including a
// participant who never posted in the thread (the old MessageService
// audience copy wrongly excluded them, leaving their freshly-added
// /threads row stale). With no LastReplyAt on the root the summary falls
// back to the root CreatedAt.
func TestNotifyForMessage_ThreadUpdated_ConversationParticipants(t *testing.T) {
	svc, pub, _, conv, _, users, msgs, _ := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	conv.conversations["conv1"] = &model.Conversation{ID: "conv1", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-1", "u-2", "u-3"}}
	users.users["u-1"] = &model.User{ID: "u-1", DisplayName: "One"}
	created := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	msgs.messages["conv1#root"] = &model.Message{ID: "root", ParentID: "conv1", AuthorID: "u-2", Body: "root", CreatedAt: created}

	root := &model.Message{ID: "root", ParentID: "conv1", AuthorID: "u-2", Body: "root", CreatedAt: created, ReplyCount: 1}
	msg := &model.Message{ID: "m-r", ParentID: "conv1", ParentMessageID: "root", AuthorID: "u-1", Body: "reply"}
	svc.NotifyForMessage(ctx, msg, ParentConversation, root)

	got, summary := threadUpdateRecipients(pub)
	for _, want := range []string{"u-1", "u-2", "u-3"} {
		if !got[want] {
			t.Fatalf("thread.updated = %v, want all participants (%s missing)", got, want)
		}
	}
	if summary == nil || !summary.LatestActivityAt.Equal(created) {
		t.Fatalf("LatestActivityAt = %+v, want CreatedAt fallback %v", summary, created)
	}
}

// batchRecordingPublisher implements the EachPublisher capability so the
// notify fan-out's pipelined path (one round-trip for the whole batch) is
// exercised — mockPublisher covers the sequential fallback.
type batchRecordingPublisher struct {
	mockPublisher
	batches [][]events.PublishItem
}

func (p *batchRecordingPublisher) PublishEach(_ context.Context, items []events.PublishItem) error {
	p.batches = append(p.batches, append([]events.PublishItem(nil), items...))
	return nil
}

func TestNotificationService_DesktopFanOutUsesBatchedPublish(t *testing.T) {
	pub := &batchRecordingPublisher{}
	members := &mockMembershipStore{memberships: map[string]*model.ChannelMembership{}}
	conv := &mockConversationStore{conversations: map[string]*model.Conversation{}}
	chans := &mockChannelStore{channels: map[string]*model.Channel{}}
	users := newMockUserStore()
	svc := NewNotificationService(pub, members, conv, chans, users, nil)

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-b", "u-c", "u-d")
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	for _, uid := range []string{"u-b", "u-c", "u-d"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel, nil)

	if len(pub.batches) != 1 {
		t.Fatalf("batched publishes = %d, want exactly 1 pipelined batch", len(pub.batches))
	}
	if got := len(pub.batches[0]); got != 3 {
		t.Fatalf("batch size = %d, want 3 recipients", got)
	}
	seen := map[string]bool{}
	for _, it := range pub.batches[0] {
		seen[it.Channel] = true
		if it.Event.Type != events.EventNotificationNew {
			t.Fatalf("batch item type = %q", it.Event.Type)
		}
	}
	for _, uid := range []string{"u-b", "u-c", "u-d"} {
		if !seen[pubsub.UserChannel(uid)] {
			t.Fatalf("recipient %s missing from the batch (%v)", uid, seen)
		}
	}
	// The per-recipient Publish path must NOT also fire.
	if got := len(pub.published); got != 0 {
		t.Fatalf("per-recipient publishes = %d, want 0 when the batch capability exists", got)
	}
}

// A wide fan-out with parallel badge writes: every recipient still gets
// exactly one alert with the correct per-recipient count (run with -race in
// CI, this also guards the bounded-parallel write path).
func TestNotificationService_WideFanOutParallelBumps(t *testing.T) {
	svc, pub, members, _, chans, users := setupBumpNotifier(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	const n = 60
	ids := make([]string, 0, n)
	for i := 0; i < n; i++ {
		uid := fmt.Sprintf("u-%03d", i)
		ids = append(ids, uid)
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	seedAllLevel(users, ids...)
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "all hands"}, ParentChannel, nil)

	notifs := publishedNotifications(pub)
	if len(notifs) != n {
		t.Fatalf("published notifications = %d, want %d", len(notifs), n)
	}
	for _, uid := range ids {
		nf, ok := notifs[pubsub.UserChannel(uid)]
		if !ok {
			t.Fatalf("recipient %s missing", uid)
		}
		if nf.ParentUnreadNotifyCount != 1 {
			t.Fatalf("recipient %s count = %d, want 1", uid, nf.ParentUnreadNotifyCount)
		}
	}
}
