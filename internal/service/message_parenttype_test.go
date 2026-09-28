package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// Message.ParentType isn't persisted, so every read path must stamp it — a
// DM message listed without it made the client file its reminder under
// "channel", which the server then rejected (403).
func TestMessageService_ListPathsStampParentType(t *testing.T) {
	svc, messages, _, conversations, _ := setupMessageService()
	ctx := context.Background()
	conversations.conversations["dm-1"] = &model.Conversation{ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}}
	root := &model.Message{ID: "m-1", ParentID: "dm-1", AuthorID: "u-2", Body: "root", ReplyCount: 1}
	reply := &model.Message{ID: "m-2", ParentID: "dm-1", AuthorID: "u-1", Body: "reply", ParentMessageID: "m-1"}
	next := &model.Message{ID: "m-3", ParentID: "dm-1", AuthorID: "u-2", Body: "next"}
	for _, m := range []*model.Message{root, reply, next} {
		messages.messages["dm-1#"+m.ID] = m
	}
	assertStamped := func(t *testing.T, path string, msgs []*model.Message) {
		t.Helper()
		if len(msgs) == 0 {
			t.Fatalf("%s returned no messages", path)
		}
		for _, m := range msgs {
			if m.ParentType != ParentConversation {
				t.Errorf("%s: message %s ParentType = %q, want %q", path, m.ID, m.ParentType, ParentConversation)
			}
		}
	}
	reset := func() {
		for _, m := range []*model.Message{root, reply, next} {
			m.ParentType = ""
		}
	}

	msgs, _, err := svc.List(ctx, "u-1", "dm-1", ParentConversation, "", 50)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	assertStamped(t, "List", msgs)

	reset()
	msgs, _, err = svc.ListAfter(ctx, "u-1", "dm-1", ParentConversation, "m-1", 50)
	if err != nil {
		t.Fatalf("ListAfter: %v", err)
	}
	assertStamped(t, "ListAfter", msgs)

	reset()
	msgs, _, _, err = svc.ListAround(ctx, "u-1", "dm-1", ParentConversation, "m-1", 10, 10)
	if err != nil {
		t.Fatalf("ListAround: %v", err)
	}
	assertStamped(t, "ListAround", msgs)

	reset()
	msgs, err = svc.ListThreadMessages(ctx, "u-1", "dm-1", ParentConversation, "m-1")
	if err != nil {
		t.Fatalf("ListThreadMessages: %v", err)
	}
	assertStamped(t, "ListThreadMessages", msgs)

	// Un-backfilled thread → the scan fallback must stamp too.
	reset()
	messages.noThreadIndex = true
	msgs, err = svc.ListThreadMessages(ctx, "u-1", "dm-1", ParentConversation, "m-1")
	if err != nil {
		t.Fatalf("ListThreadMessages (scan): %v", err)
	}
	assertStamped(t, "ListThreadMessages (scan)", msgs)
}
