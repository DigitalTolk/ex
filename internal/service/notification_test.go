package service

import (
	"context"
	"encoding/json"
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

// stubPresence is a tiny PresenceLookup implementation: any userID listed
// in the set is reported online; everyone else is offline.
type stubPresence struct {
	online map[string]bool
}

func (p *stubPresence) IsOnline(userID string) bool { return p.online[userID] }

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

func TestNotificationService_NotifyForMessage_ChannelFanout(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
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
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}
	members.memberships["ch1#u-carol"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-carol"}
	// Bob has the channel muted; Carol does not.
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

	var deepLink string
	for _, p := range pub.published {
		if p.event.Type != events.EventNotificationNew {
			continue
		}
		var n Notification
		if err := json.Unmarshal(p.event.Data, &n); err != nil {
			continue
		}
		deepLink = n.DeepLink
		break
	}
	if !strings.Contains(deepLink, "?thread=root-XYZ") {
		t.Errorf("deepLink missing ?thread=root-XYZ: %q", deepLink)
	}
	if !strings.Contains(deepLink, "#msg-root-XYZ") {
		t.Errorf("deepLink missing #msg-root-XYZ: %q", deepLink)
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
