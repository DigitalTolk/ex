package service

import (
	"context"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// recordingActivity captures what the fan-out hands to the Activity tab.
type recordingActivity struct {
	mu    sync.Mutex
	calls int
	items map[string]*model.ActivityItem
}

func (r *recordingActivity) RecordForRecipients(_ context.Context, items map[string]*model.ActivityItem) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if r.items == nil {
		r.items = map[string]*model.ActivityItem{}
	}
	for uid, it := range items {
		r.items[uid] = it
	}
}

func TestActivityFor(t *testing.T) {
	cases := []struct {
		name       string
		parentType string
		r          recipientReasons
		wantType   model.ActivityType
		wantKind   model.MentionKind
	}{
		{"explicit mention wins even when muted", ParentChannel, recipientReasons{explicitMention: true, muted: true}, model.ActivityMention, model.MentionKindUser},
		{"explicit mention in a DM", ParentConversation, recipientReasons{explicitMention: true}, model.ActivityMention, model.MentionKindUser},
		{"DM thread reply", ParentConversation, recipientReasons{threadReply: true, threadParticipant: true}, model.ActivityThreadReply, ""},
		{"DM message", ParentConversation, recipientReasons{threadParticipant: true}, model.ActivityDM, ""},
		{"muted channel hides group mentions", ParentChannel, recipientReasons{muted: true, groupMention: true}, "", ""},
		{"group mention", ParentChannel, recipientReasons{groupMention: true}, model.ActivityMention, model.MentionKindAll},
		{"keyword", ParentChannel, recipientReasons{keyword: true}, model.ActivityMention, model.MentionKindKeyword},
		{"followed thread reply", ParentChannel, recipientReasons{threadReply: true, threadParticipant: true, threadReplies: true}, model.ActivityThreadReply, ""},
		// The Activity tab lists replies in your threads whatever the
		// thread-reply notification toggle says; mutes still apply.
		{"thread reply with replies notifications off", ParentChannel, recipientReasons{threadReply: true, threadParticipant: true}, model.ActivityThreadReply, ""},
		{"thread reply in a muted channel", ParentChannel, recipientReasons{threadReply: true, threadParticipant: true, muted: true}, "", ""},
		{"thread reply to a bystander", ParentChannel, recipientReasons{threadReply: true, threadReplies: true}, "", ""},
		{"keyword in a thread reply to a bystander", ParentChannel, recipientReasons{threadReply: true, keyword: true}, model.ActivityMention, model.MentionKindKeyword},
		{"group mention in a thread reply", ParentChannel, recipientReasons{threadReply: true, groupMention: true}, model.ActivityMention, model.MentionKindAll},
		{"plain channel message", ParentChannel, recipientReasons{}, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			typ, kind := activityFor(tc.parentType, tc.r, model.MentionKindAll)
			if typ != tc.wantType || kind != tc.wantKind {
				t.Fatalf("activityFor = (%q, %q), want (%q, %q)", typ, kind, tc.wantType, tc.wantKind)
			}
		})
	}
}

func TestNotificationService_RecordsChannelActivity(t *testing.T) {
	svc, _, members, _, chans, users := setupNotifier(t)
	rec := &recordingActivity{}
	svc.SetActivityRecorder(rec)
	ctx := context.Background()

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	users.users["u-carol"] = &model.User{ID: "u-carol", DisplayName: "Carol"}
	for _, uid := range []string{"u-author", "u-bob", "u-carol"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	// Bob is @-mentioned by name; Carol only through @all.
	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "@[u-bob|Bob] and @all: release freeze Friday"}
	svc.NotifyForMessage(ctx, msg, ParentChannel, nil)

	if rec.calls != 1 {
		t.Fatalf("recorder calls = %d, want 1", rec.calls)
	}
	bob, carol := rec.items["u-bob"], rec.items["u-carol"]
	if bob == nil || bob.Type != model.ActivityMention || bob.MentionKind != model.MentionKindUser {
		t.Fatalf("bob item = %+v", bob)
	}
	if carol == nil || carol.Type != model.ActivityMention || carol.MentionKind != model.MentionKindAll {
		t.Fatalf("carol item = %+v", carol)
	}
	if _, ok := rec.items["u-author"]; ok {
		t.Fatal("the author must not get an activity item for their own message")
	}
	if bob.ID == "" || bob.ID == carol.ID {
		t.Fatalf("each recipient needs their own item id, got %q and %q", bob.ID, carol.ID)
	}
	if bob.MessageID != "m1" || bob.ParentID != "ch1" || bob.ParentType != ParentChannel ||
		bob.ChannelSlug != "general" || bob.ActorID != "u-author" || bob.MessagePreview == "" {
		t.Fatalf("item context not copied from the message: %+v", bob)
	}
}

func TestNotificationService_RecordsHereMentionKind(t *testing.T) {
	svc, _, members, _, chans, users := setupNotifier(t)
	rec := &recordingActivity{}
	svc.SetActivityRecorder(rec)
	svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true}})

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "@here standup"}, ParentChannel, nil)

	if got := rec.items["u-bob"]; got == nil || got.MentionKind != model.MentionKindHere {
		t.Fatalf("bob item = %+v, want an @here mention", got)
	}
}

func TestNotificationService_RecordsDMActivity(t *testing.T) {
	svc, _, _, conv, _, users := setupNotifier(t)
	rec := &recordingActivity{}
	svc.SetActivityRecorder(rec)

	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	conv.conversations["c1"] = &model.Conversation{ID: "c1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-author", "u-other"}}

	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "c1", AuthorID: "u-author", Body: "quick call?"}, ParentConversation, nil)

	got := rec.items["u-other"]
	if got == nil || got.Type != model.ActivityDM || got.ChannelSlug != "" || got.ParentType != ParentConversation {
		t.Fatalf("DM item = %+v", got)
	}
}

func TestNotificationService_NoActivityForPlainChannelMessage(t *testing.T) {
	svc, _, members, _, chans, users := setupNotifier(t)
	rec := &recordingActivity{}
	svc.SetActivityRecorder(rec)

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-bob") // notified about everything, but nothing is addressed to them
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel, nil)

	if rec.calls != 0 {
		t.Fatalf("a plain channel message must not reach the Activity tab, got %d calls", rec.calls)
	}
}

// A webhook post's items are flagged as a bot's, and a thread reply's items
// carry the thread root (parentMessageID) so the row can open the thread.
func TestNotificationService_ActivityCarriesWebhookAndThreadRoot(t *testing.T) {
	svc, _, members, _, chans, users := setupNotifier(t)
	rec := &recordingActivity{}
	svc.SetActivityRecorder(rec)

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "alerts", Slug: "alerts", Type: model.ChannelTypePublic}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	members.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob"}

	svc.NotifyForMessage(context.Background(), &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: WebhookAuthorID, WebhookUsername: "pagerduty",
		ParentMessageID: "root-1", Body: "@[u-bob|Bob] disk full",
	}, ParentChannel, nil)

	got := rec.items["u-bob"]
	if got == nil || !got.Webhook || got.ActorName != "pagerduty" || got.ParentMessageID != "root-1" {
		t.Fatalf("item = %+v, want a webhook item carrying the thread root", got)
	}
	if got.MessagePreview != "@Bob disk full" {
		t.Fatalf("preview = %q", got.MessagePreview)
	}
}

// Bots and agents in the audience still get their notification decision, but
// no activity item: nobody reads a machine's stream.
func TestNotificationService_NoActivityForMachineMembers(t *testing.T) {
	svc, _, members, _, chans, users := setupNotifier(t)
	rec := &recordingActivity{}
	svc.SetActivityRecorder(rec)

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	users.users["agent-1"] = &model.User{ID: "agent-1", DisplayName: "gg", Kind: model.UserKindAgent}
	users.users["bot-1"] = &model.User{ID: "bot-1", DisplayName: "alerts", IsBot: true}
	for _, uid := range []string{"u-author", "u-bob", "agent-1", "bot-1"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "@all heads up"}, ParentChannel, nil)

	if len(rec.items) != 1 || rec.items["u-bob"] == nil {
		t.Fatalf("items = %v, want only the human member", rec.items)
	}
}
