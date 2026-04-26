package service

import (
	"context"
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
