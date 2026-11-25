package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// Muting is for a one-to-one chat with a bot or a webhook: it is stored on
// the caller's own row and their other clients are told. A chat with a
// person, a group, someone else's chat and a store failure are all refused.
func TestConversationService_SetMuted(t *testing.T) {
	ctx := context.Background()
	svc, conversations, users, _, publisher := setupConversationService()
	users.users["u-1"] = &model.User{ID: "u-1", DisplayName: "Alice"}
	users.users["u-2"] = &model.User{ID: "u-2", DisplayName: "Bob"}
	users.users["bot-1"] = &model.User{ID: "bot-1", DisplayName: "Deploys", IsBot: true}
	conversations.conversations["c-bot"] = &model.Conversation{ID: "c-bot", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "bot-1"}}
	conversations.conversations["c-person"] = &model.Conversation{ID: "c-person", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}}
	conversations.conversations["c-group"] = &model.Conversation{ID: "c-group", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-1", "bot-1"}}
	conversations.conversations["c-gone"] = &model.Conversation{ID: "c-gone", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "bot-deleted"}}

	if err := svc.SetMuted(ctx, "u-1", "c-bot", true); err != nil {
		t.Fatalf("mute a bot chat: %v", err)
	}
	if on, _ := conversations.ConversationMuted(ctx, "c-bot", "u-1"); !on {
		t.Fatal("the mute was not stored on the caller's row")
	}
	last := publisher.published[len(publisher.published)-1]
	var payload map[string]any
	if err := json.Unmarshal(last.event.Data, &payload); err != nil || last.event.Type != events.EventUserChannelUpdated || payload["conversationID"] != "c-bot" || payload["notificationPrefs"] != true {
		t.Fatalf("event = %s %v, want the row-refetch nudge for c-bot", last.event.Type, payload)
	}
	if err := svc.SetMuted(ctx, "u-1", "c-bot", false); err != nil {
		t.Fatalf("unmute: %v", err)
	}
	if on, _ := conversations.ConversationMuted(ctx, "c-bot", "u-1"); on {
		t.Fatal("still muted after unmute")
	}

	for name, call := range map[string]func() error{
		"a chat with a person":      func() error { return svc.SetMuted(ctx, "u-1", "c-person", true) },
		"a group":                   func() error { return svc.SetMuted(ctx, "u-1", "c-group", true) },
		"someone else's chat":       func() error { return svc.SetMuted(ctx, "u-2", "c-bot", true) },
		"a chat that doesn't exist": func() error { return svc.SetMuted(ctx, "u-1", "c-none", true) },
		"a chat whose bot is gone":  func() error { return svc.SetMuted(ctx, "u-1", "c-gone", true) },
	} {
		if err := call(); err == nil {
			t.Errorf("%s: muted, want a refusal", name)
		}
	}
	conversations.setMutedErr = errors.New("throttled")
	if err := svc.SetMuted(ctx, "u-1", "c-bot", true); err == nil {
		t.Error("store write error not surfaced")
	}
}

// A bot's message into a chat its person muted alerts them for nothing and
// lists nothing in Activity, unless it @-mentions them. The same message
// into an unmuted chat alerts as any DM does; so does one whose mute flag
// can't be read; and a person's DM never reads the flag at all.
func TestNotificationService_MutedBotChat(t *testing.T) {
	ctx := context.Background()
	newEnv := func() (*NotificationService, *mockPublisher, *mockConversationStore) {
		svc, pub, _, conv, _, users := setupNotifier(t)
		users.users["u-alice"] = &model.User{ID: "u-alice", DisplayName: "Alice"}
		users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
		users.users["bot-1"] = &model.User{ID: "bot-1", DisplayName: "Deploys", IsBot: true}
		conv.conversations["c-bot"] = &model.Conversation{ID: "c-bot", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-alice", "bot-1"}}
		conv.conversations["c-people"] = &model.Conversation{ID: "c-people", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-alice", "u-bob"}}
		return svc, pub, conv
	}
	alerts := func(pub *mockPublisher) int {
		n := 0
		for _, p := range pub.published {
			if p.event.Type == events.EventNotificationNew {
				n++
			}
		}
		return n
	}
	fromBot := func(id, body string) *model.Message {
		return &model.Message{ID: id, ParentID: "c-bot", AuthorID: "bot-1", Body: body}
	}

	t.Run("unmuted: the bot's message alerts", func(t *testing.T) {
		svc, pub, _ := newEnv()
		svc.NotifyForMessage(ctx, fromBot("m1", "Deploy finished"), ParentConversation, nil)
		if got := alerts(pub); got != 1 {
			t.Fatalf("alerts = %d, want 1", got)
		}
	})
	t.Run("muted: nothing, and nothing listed", func(t *testing.T) {
		svc, pub, conv := newEnv()
		recorder := &recordingActivity{}
		svc.SetActivityRecorder(recorder)
		conv.muted = map[string]bool{"c-bot#u-alice": true}
		svc.NotifyForMessage(ctx, fromBot("m2", "Deploy finished"), ParentConversation, nil)
		if got := alerts(pub); got != 0 {
			t.Fatalf("alerts = %d, want none", got)
		}
		if len(recorder.items) != 0 {
			t.Fatalf("activity items = %v, want none", recorder.items)
		}
	})
	t.Run("muted: a direct mention still gets through", func(t *testing.T) {
		svc, pub, conv := newEnv()
		conv.muted = map[string]bool{"c-bot#u-alice": true}
		svc.NotifyForMessage(ctx, fromBot("m3", "@[u-alice|Alice] your approval is needed"), ParentConversation, nil)
		if got := alerts(pub); got != 1 {
			t.Fatalf("alerts = %d, want the mention", got)
		}
	})
	t.Run("the flag can't be read: alert", func(t *testing.T) {
		svc, pub, conv := newEnv()
		conv.muted = map[string]bool{"c-bot#u-alice": true}
		conv.mutedErr = errors.New("dynamo down")
		svc.NotifyForMessage(ctx, fromBot("m4", "Deploy finished"), ParentConversation, nil)
		if got := alerts(pub); got != 1 {
			t.Fatalf("alerts = %d, want 1 (a failed read is not a mute)", got)
		}
	})
	t.Run("a person's DM ignores any flag", func(t *testing.T) {
		svc, pub, conv := newEnv()
		conv.muted = map[string]bool{"c-people#u-alice": true}
		svc.NotifyForMessage(ctx, &model.Message{ID: "m5", ParentID: "c-people", AuthorID: "u-bob", Body: "lunch?"}, ParentConversation, nil)
		if got := alerts(pub); got != 1 {
			t.Fatalf("alerts = %d, want 1: people can't be muted", got)
		}
	})
}
