package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// A group message became a private channel: what its people were writing
// there goes along to the channel's composer.
func TestDraftService_MoveConversationDrafts(t *testing.T) {
	svc, drafts, pub := newDraftTestService()
	ctx := context.Background()
	at := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	put := func(userID, parentID, parentType, root, body string) string {
		id := draftID(userID, parentType, parentID, root)
		drafts.rows[drafts.key(userID, id)] = &model.MessageDraft{
			ID: id, UserID: userID, ParentID: parentID, ParentType: parentType, ParentMessageID: root,
			Body: body, AttachmentIDs: []string{"att-" + body}, CreatedAt: at, UpdatedAt: at, Gen: "g-" + body,
		}
		return id
	}
	topOld := put("u-1", "g-1", ParentConversation, "", "top")
	threadOld := put("u-1", "g-1", ParentConversation, "r-1", "thread")
	otherConv := put("u-1", "dm-1", ParentConversation, "", "elsewhere")
	channelDraft := put("u-1", "ch-1", ParentChannel, "", "channel")
	theirs := put("u-2", "g-1", ParentConversation, "", "theirs")

	svc.MoveConversationDrafts(ctx, []string{"u-1", "u-2", "u-3"}, "g-1")

	for _, tc := range []struct {
		user, old, root, body string
	}{{"u-1", topOld, "", "top"}, {"u-1", threadOld, "r-1", "thread"}, {"u-2", theirs, "", "theirs"}} {
		if _, ok := drafts.rows[drafts.key(tc.user, tc.old)]; ok {
			t.Errorf("%s's %q draft is still with the group", tc.user, tc.body)
		}
		moved := drafts.rows[drafts.key(tc.user, draftID(tc.user, ParentChannel, "g-1", tc.root))]
		if moved == nil || moved.ParentType != ParentChannel || moved.Body != tc.body || moved.ParentMessageID != tc.root ||
			len(moved.AttachmentIDs) != 1 || !moved.CreatedAt.Equal(at) || moved.Gen == "" || moved.Gen == "g-"+tc.body {
			t.Errorf("%s's %q draft in the channel = %+v", tc.user, tc.body, moved)
		}
	}
	for _, id := range []string{otherConv, channelDraft} {
		if _, ok := drafts.rows[drafts.key("u-1", id)]; !ok {
			t.Errorf("a draft elsewhere (%s) was moved", id)
		}
	}
	// Each tab hears of the draft that went and the one that came.
	told := 0
	for _, p := range pub.published {
		if p.event.Type == events.EventDraftUpdated {
			told++
		}
	}
	if told != 6 {
		t.Fatalf("draft.updated events = %d, want 6", told)
	}
}

func TestDraftService_MoveConversationDrafts_Failures(t *testing.T) {
	ctx := context.Background()
	seed := func(drafts *mockDraftStore) string {
		id := draftID("u-1", ParentConversation, "g-1", "")
		drafts.rows[drafts.key("u-1", id)] = &model.MessageDraft{ID: id, UserID: "u-1", ParentID: "g-1", ParentType: ParentConversation, Body: "hi", Gen: "g"}
		return id
	}

	// No list: nothing moves.
	svc, drafts, _ := newDraftTestService()
	old := seed(drafts)
	drafts.listErr = errors.New("redis down")
	svc.MoveConversationDrafts(ctx, []string{"u-1"}, "g-1")
	if _, ok := drafts.rows[drafts.key("u-1", old)]; !ok {
		t.Fatal("a draft that couldn't be listed was lost")
	}

	// A draft that can't be written to the channel stays with the group.
	svc, drafts, _ = newDraftTestService()
	old = seed(drafts)
	drafts.upsertErr = errors.New("redis down")
	svc.MoveConversationDrafts(ctx, []string{"u-1"}, "g-1")
	if _, ok := drafts.rows[drafts.key("u-1", old)]; !ok {
		t.Fatal("a draft that couldn't be moved was lost")
	}

	// So does one when the channel's composer already has one.
	svc, drafts, _ = newDraftTestService()
	old = seed(drafts)
	there := draftID("u-1", ParentChannel, "g-1", "")
	drafts.rows[drafts.key("u-1", there)] = &model.MessageDraft{ID: there, UserID: "u-1", ParentID: "g-1", ParentType: ParentChannel, Body: "newer", Gen: "n"}
	svc.MoveConversationDrafts(ctx, []string{"u-1"}, "g-1")
	if drafts.rows[drafts.key("u-1", there)].Body != "newer" {
		t.Fatal("moving overwrote a draft already in the channel")
	}
	if _, ok := drafts.rows[drafts.key("u-1", old)]; !ok {
		t.Fatal("a draft that couldn't be moved was lost")
	}

	// Moved, but the old copy couldn't be removed: logged, the move stands.
	svc, drafts, _ = newDraftTestService()
	seed(drafts)
	drafts.deleteUncondErr = errors.New("redis down")
	svc.MoveConversationDrafts(ctx, []string{"u-1"}, "g-1")
	if drafts.rows[drafts.key("u-1", there)] == nil {
		t.Fatal("the draft wasn't moved")
	}
}
