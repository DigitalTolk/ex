//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func scheduled(userID, id string, sendAt time.Time, state model.ScheduledMessageState) *model.ScheduledMessage {
	return &model.ScheduledMessage{
		ID: id, UserID: userID, ParentID: "ch-1", ParentType: "channel",
		Body: "standup moves to 10:15", AttachmentIDs: []string{"att-1"},
		SendAt: sendAt.UTC().Truncate(time.Millisecond), State: state,
		CreatedAt: time.Now().UTC().Truncate(time.Millisecond),
	}
}

func TestScheduledMessageStore_CRUD(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewScheduledMessageStore(db)
	ctx := context.Background()
	at := time.Now().Add(time.Hour)

	m := scheduled("u-1", "s-1", at, model.ScheduledMessagePending)
	if err := s.PutScheduledMessage(ctx, m); err != nil {
		t.Fatalf("Put: %v", err)
	}
	_ = s.PutScheduledMessage(ctx, scheduled("u-1", "s-2", at, model.ScheduledMessageFailed))
	_ = s.PutScheduledMessage(ctx, scheduled("u-2", "s-3", at, model.ScheduledMessagePending))

	got, err := s.GetScheduledMessage(ctx, "u-1", "s-1")
	if err != nil || got.Body != m.Body || !got.SendAt.Equal(m.SendAt) || got.AttachmentIDs[0] != "att-1" {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	if _, err := s.GetScheduledMessage(ctx, "u-2", "s-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("someone else's: want ErrNotFound, got %v", err)
	}
	list, err := s.ListScheduledMessages(ctx, "u-1")
	if err != nil || len(list) != 2 {
		t.Fatalf("List = %d, %v; want 2 (pending + failed, only u-1's)", len(list), err)
	}
	if err := s.DeleteScheduledMessage(ctx, "u-1", "s-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.GetScheduledMessage(ctx, "u-1", "s-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete: %v", err)
	}
}

func TestScheduledMessageStore_DueQueueAndClaims(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewScheduledMessageStore(db)
	ctx := context.Background()
	now := time.Now()

	early := scheduled("u-1", "s-early", now.Add(-2*time.Minute), model.ScheduledMessagePending)
	later := scheduled("u-2", "s-later", now.Add(-time.Minute), model.ScheduledMessagePending)
	future := scheduled("u-1", "s-future", now.Add(time.Hour), model.ScheduledMessagePending)
	failed := scheduled("u-1", "s-failed", now.Add(-time.Hour), model.ScheduledMessageFailed)
	for _, m := range []*model.ScheduledMessage{later, early, future, failed} {
		if err := s.PutScheduledMessage(ctx, m); err != nil {
			t.Fatalf("Put %s: %v", m.ID, err)
		}
	}

	// Only pending messages whose time has come, soonest first, across users.
	due, err := s.ListDueScheduledMessages(ctx, now, 10)
	if err != nil || len(due) != 2 || due[0].ID != "s-early" || due[1].ID != "s-later" {
		t.Fatalf("due = %+v, %v", due, err)
	}
	if due[0].DueKey != ScheduledDueKey(early.SendAt, "s-early") {
		t.Fatalf("due key = %q", due[0].DueKey)
	}
	if one, _ := s.ListDueScheduledMessages(ctx, now, 1); len(one) != 1 {
		t.Fatalf("limit not applied: %d", len(one))
	}

	// Exactly one claim wins; a stale key never does.
	lease := now.Add(2 * time.Minute)
	if ok, err := s.ClaimScheduledMessage(ctx, "u-1", "s-early", "stale-key", lease); ok || err != nil {
		t.Fatalf("stale claim = %v, %v", ok, err)
	}
	if ok, err := s.ClaimScheduledMessage(ctx, "u-1", "s-early", due[0].DueKey, lease); !ok || err != nil {
		t.Fatalf("claim = %v, %v", ok, err)
	}
	if ok, _ := s.ClaimScheduledMessage(ctx, "u-1", "s-early", due[0].DueKey, lease); ok {
		t.Fatal("second claim won too")
	}
	// Claimed: out of the queue until its lease lapses, then due again.
	if d, _ := s.ListDueScheduledMessages(ctx, now, 10); len(d) != 1 || d[0].ID != "s-later" {
		t.Fatalf("claimed message still due: %+v", d)
	}
	if d, _ := s.ListDueScheduledMessages(ctx, lease, 10); len(d) != 2 || d[1].ID != "s-early" || d[1].DueKey != ScheduledDueKey(lease, "s-early") {
		t.Fatalf("lapsed lease not due again: %+v", d)
	}

	// A failed message isn't queued: claimed with "" — once.
	if ok, err := s.ClaimScheduledMessage(ctx, "u-1", "s-failed", "", lease); !ok || err != nil {
		t.Fatalf("claim failed message = %v, %v", ok, err)
	}
	if ok, _ := s.ClaimScheduledMessage(ctx, "u-1", "s-failed", "", lease); ok {
		t.Fatal("second claim of a failed message won too")
	}
	// Nothing to claim for a message that doesn't exist.
	if ok, err := s.ClaimScheduledMessage(ctx, "u-1", "s-gone", "", lease); ok || err != nil {
		t.Fatalf("claim of missing message = %v, %v", ok, err)
	}
}

func TestScheduledMessageStore_Errors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	m := scheduled("u-1", "s-1", time.Now().Add(-time.Minute), model.ScheduledMessagePending)
	if err := NewScheduledMessageStore(db).PutScheduledMessage(ctx, m); err != nil {
		t.Fatalf("seed: %v", err)
	}
	fault := func(cfg func(*faultClient)) *ScheduledMessageStoreImpl {
		return NewScheduledMessageStore(withFault(db, cfg))
	}
	if err := fault(func(f *faultClient) { f.failPutItem = true }).PutScheduledMessage(ctx, m); !errors.Is(err, errInjected) {
		t.Errorf("Put: %v", err)
	}
	if _, err := fault(func(f *faultClient) { f.failGetItem = true }).GetScheduledMessage(ctx, "u-1", "s-1"); !errors.Is(err, errInjected) {
		t.Errorf("Get: %v", err)
	}
	if _, err := fault(func(f *faultClient) { f.transformGetItem = corruptGetItem }).GetScheduledMessage(ctx, "u-1", "s-1"); err == nil {
		t.Error("Get corrupt: want error")
	}
	if _, err := fault(func(f *faultClient) { f.failQuery = true }).ListScheduledMessages(ctx, "u-1"); !errors.Is(err, errInjected) {
		t.Errorf("List: %v", err)
	}
	if _, err := fault(func(f *faultClient) { f.transformQuery = corruptQuery }).ListScheduledMessages(ctx, "u-1"); err == nil {
		t.Error("List corrupt: want error")
	}
	if err := fault(func(f *faultClient) { f.failDeleteItem = true }).DeleteScheduledMessage(ctx, "u-1", "s-1"); !errors.Is(err, errInjected) {
		t.Errorf("Delete: %v", err)
	}
	if _, err := fault(func(f *faultClient) { f.failQuery = true }).ListDueScheduledMessages(ctx, time.Now(), 5); !errors.Is(err, errInjected) {
		t.Errorf("ListDue: %v", err)
	}
	if _, err := fault(func(f *faultClient) { f.transformQuery = corruptQuery }).ListDueScheduledMessages(ctx, time.Now(), 5); err == nil {
		t.Error("ListDue corrupt: want error")
	}
	if _, err := fault(func(f *faultClient) { f.failUpdateItem = true }).ClaimScheduledMessage(ctx, "u-1", "s-1", "k", time.Now()); !errors.Is(err, errInjected) {
		t.Errorf("Claim: %v", err)
	}
}
