package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

// actionCard is an app message with every kind of button: an ack and a link
// in a section, a vote and an app button in a row, and a vote for one person
// only inside a card.
func actionCard() *model.Message {
	ack := btn("ack", "Acknowledge")
	ack.ExAction = model.ExActionAck
	vote := btn("vote", "+1")
	vote.ExAction = model.ExActionVote
	only := btn("mine", "Mine")
	only.ExAction = model.ExActionVote
	only.AllowedUsers = []string{"user-2"}
	link := btn("open", "Open")
	link.URL = "https://ex.test"
	return &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: WebhookAuthorID, Body: "card", WebhookID: "wh",
		Blocks: model.Blocks{
			{Type: model.BlockSection, BlockID: "s", Text: plain("t"), Accessory: &ack},
			{Type: model.BlockActions, BlockID: "row", Elements: []model.BlockElement{
				{Type: model.TextPlain, ActionID: "vote", Content: "a text element is never a button"}, vote, btn("app", "Ask app"), link,
			}},
		},
		MessageAttachments: []model.MessageAttachment{{Blocks: model.Blocks{
			{Type: model.BlockActions, BlockID: "card", Elements: []model.BlockElement{only}},
		}}},
	}
}

// actMsg clicks and returns the message the click left.
func actMsg(svc *MessageService, ctx context.Context, userID, parentID, parentType, msgID, blockID, actionID string) (*model.Message, error) {
	res, err := svc.Act(ctx, userID, parentID, parentType, msgID, blockID, actionID)
	if err != nil {
		return nil, err
	}
	return res.Message, nil
}

func actionFixture(t *testing.T) (*MessageService, *mockMessageStore, *mockPublisher) {
	t.Helper()
	svc, messages, memberships, _, publisher := setupMessageService()
	for _, u := range []string{"user-1", "user-2"} {
		memberships.memberships["ch1#"+u] = &model.ChannelMembership{ChannelID: "ch1", UserID: u, Role: model.ChannelRoleMember}
	}
	messages.messages["ch1#m1"] = actionCard()
	return svc, messages, publisher
}

func TestButtonAtAndMayClick(t *testing.T) {
	m := actionCard()
	for _, c := range []struct{ block, action string }{{"s", "ack"}, {"row", "vote"}, {"row", "app"}, {"card", "mine"}} {
		if e, ok := ButtonAt(m, c.block, c.action); !ok || e.ActionID != c.action {
			t.Errorf("ButtonAt(%s, %s) = %#v %v", c.block, c.action, e, ok)
		}
	}
	for _, c := range []struct{ block, action string }{{"s", "nope"}, {"missing", "ack"}, {"card", "vote"}} {
		if _, ok := ButtonAt(m, c.block, c.action); ok {
			t.Errorf("ButtonAt(%s, %s) found a button", c.block, c.action)
		}
	}
	only, _ := ButtonAt(m, "card", "mine")
	if !MayClick(only, "user-2") || MayClick(only, "user-1") || !MayClick(btn("x", "x"), "anyone") {
		t.Fatal("MayClick")
	}
}

func TestAct_AckKeepsTheFirstClicker(t *testing.T) {
	svc, messages, publisher := actionFixture(t)
	ctx := context.Background()
	msg, err := actMsg(svc, ctx, "user-1", "ch1", ParentChannel, "m1", "s", "ack")
	if err != nil {
		t.Fatalf("ack: %v", err)
	}
	if len(msg.ActionTallies) != 1 || msg.ActionTallies[0].UserIDs[0] != "user-1" || msg.Version != 1 || msg.EditedAt != nil {
		t.Fatalf("after ack: %#v", msg)
	}
	if len(publisher.published) != 1 {
		t.Fatalf("published %d events, want 1", len(publisher.published))
	}
	// A second ack changes nothing and broadcasts nothing.
	again, err := actMsg(svc, ctx, "user-2", "ch1", ParentChannel, "m1", "s", "ack")
	if err != nil || again.ActionTallies[0].UserIDs[0] != "user-1" || again.Version != 1 {
		t.Fatalf("second ack: %#v %v", again, err)
	}
	if len(publisher.published) != 1 || messages.messages["ch1#m1"].Version != 1 {
		t.Fatal("a no-op click must not write or broadcast")
	}
}

func TestAct_VoteToggles(t *testing.T) {
	svc, messages, _ := actionFixture(t)
	ctx := context.Background()
	vote := func(user string) []model.ActionTally {
		t.Helper()
		m, err := actMsg(svc, ctx, user, "ch1", ParentChannel, "m1", "row", "vote")
		if err != nil {
			t.Fatalf("vote by %s: %v", user, err)
		}
		return m.ActionTallies
	}
	if got := vote("user-1"); len(got) != 1 || len(got[0].UserIDs) != 1 {
		t.Fatalf("first vote: %#v", got)
	}
	if got := vote("user-2"); len(got[0].UserIDs) != 2 {
		t.Fatalf("second vote: %#v", got)
	}
	if got := vote("user-1"); len(got[0].UserIDs) != 1 || got[0].UserIDs[0] != "user-2" {
		t.Fatalf("taken back: %#v", got)
	}
	if got := vote("user-2"); got != nil {
		t.Fatalf("last vote taken back leaves no tallies: %#v", got)
	}
	if v := messages.messages["ch1#m1"].Version; v != 4 {
		t.Fatalf("version = %d, want 4", v)
	}
}

func TestApplyBuiltInAction_KeepsOtherTallies(t *testing.T) {
	m := &model.Message{ActionTallies: []model.ActionTally{
		{BlockID: "a", ActionID: "x", UserIDs: []string{"u1"}},
		{BlockID: "b", ActionID: "y", UserIDs: []string{"u1"}},
	}}
	if !applyBuiltInAction(m, "b", "y", model.ExActionVote, "u1", time.Now()) {
		t.Fatal("taking a vote back is a change")
	}
	if len(m.ActionTallies) != 1 || m.ActionTallies[0].BlockID != "a" {
		t.Fatalf("other tallies lost: %#v", m.ActionTallies)
	}
}

func TestAct_OnlyTheNamedPeopleMayClick(t *testing.T) {
	svc, _, _ := actionFixture(t)
	ctx := context.Background()
	if _, err := actMsg(svc, ctx, "user-1", "ch1", ParentChannel, "m1", "card", "mine"); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("not allowed: %v", err)
	}
	if m, err := actMsg(svc, ctx, "user-2", "ch1", ParentChannel, "m1", "card", "mine"); err != nil || len(m.ActionTallies) != 1 {
		t.Fatalf("allowed: %#v %v", m, err)
	}
}

func TestAct_Refusals(t *testing.T) {
	svc, messages, _ := actionFixture(t)
	ctx := context.Background()
	if _, err := actMsg(svc, ctx, "stranger", "ch1", ParentChannel, "m1", "s", "ack"); err == nil {
		t.Fatal("a non-member clicked")
	}
	if _, err := actMsg(svc, ctx, "user-1", "ch1", ParentChannel, "gone", "s", "ack"); err == nil {
		t.Fatal("a missing message was clicked")
	}
	for _, c := range []struct {
		block, action string
		want          error
	}{
		{"s", "nope", ErrCardChanged},
		{"row", "open", apperr.ErrValidation},
		{"row", "app", ErrAppNotSetUp},
	} {
		if _, err := actMsg(svc, ctx, "user-1", "ch1", ParentChannel, "m1", c.block, c.action); !errors.Is(err, c.want) {
			t.Errorf("%s/%s: want %v, got %v", c.block, c.action, c.want, err)
		}
	}
	deleted := actionCard()
	deleted.Deleted = true
	messages.messages["ch1#m1"] = deleted
	if _, err := actMsg(svc, ctx, "user-1", "ch1", ParentChannel, "m1", "s", "ack"); !errors.Is(err, ErrCardChanged) {
		t.Fatalf("deleted: %v", err)
	}
}

func TestAct_RetriesAfterLosingARace(t *testing.T) {
	svc, messages, _ := actionFixture(t)
	ctx := context.Background()
	messages.forcedConflicts = actionAttempts - 1
	if m, err := actMsg(svc, ctx, "user-1", "ch1", ParentChannel, "m1", "row", "vote"); err != nil || len(m.ActionTallies) != 1 {
		t.Fatalf("after %d lost races: %#v %v", actionAttempts-1, m, err)
	}
	messages.forcedConflicts = actionAttempts
	if _, err := actMsg(svc, ctx, "user-2", "ch1", ParentChannel, "m1", "row", "vote"); !errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("every attempt lost: %v", err)
	}
	messages.updateErr = errors.New("dynamo down")
	if _, err := actMsg(svc, ctx, "user-2", "ch1", ParentChannel, "m1", "row", "vote"); err == nil || errors.Is(err, apperr.ErrConflict) {
		t.Fatalf("store failure: %v", err)
	}
}
