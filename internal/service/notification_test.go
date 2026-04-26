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
	svc := NewNotificationService(pub, members, conv, chans, users)
	return svc, pub, members, conv, chans, users
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
	svc, pub, _, conv, _, users := setupNotifier(t)
	ctx := context.Background()

	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	conv.conversations["c1"] = &model.Conversation{
		ID:             "c1",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-author", "u-other"},
	}

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
	// Decode payload kind via the JSON path.
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
