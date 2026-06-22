//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func makeMessage(parentID, id, author, body string) *model.Message {
	return &model.Message{
		ID:        id,
		ParentID:  parentID,
		AuthorID:  author,
		Body:      body,
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}
}

// SDK-call error branches in the message store, exercised via faultClient.

func TestMessageStore_Create_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.Create(ctx, makeMessage("ch-me", "m-e1", "u-a", "hi"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestMessageStore_GetByID_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetByID(ctx, "ch-me", "m-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByID: want errInjected, got %v", err)
	}
}

func TestMessageStore_List_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, _, err := s.List(ctx, "ch-me", "", 10)
	if !errors.Is(err, errInjected) {
		t.Fatalf("List: want errInjected, got %v", err)
	}
}

func TestMessageStore_ListThreadReplies(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(db)

	if err := s.Create(ctx, makeMessage("ch-thr", "01-root", "u-a", "root")); err != nil {
		t.Fatalf("create root: %v", err)
	}
	for _, id := range []string{"02-r1", "03-r2"} {
		r := makeMessage("ch-thr", id, "u-a", "reply")
		r.ParentMessageID = "01-root"
		if err := s.Create(ctx, r); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	// A top-level message (no GSI key) and a reply to a different root must
	// not appear in this thread's index.
	if err := s.Create(ctx, makeMessage("ch-thr", "04-other", "u-a", "other")); err != nil {
		t.Fatalf("create other: %v", err)
	}
	otherReply := makeMessage("ch-thr", "05-x", "u-a", "x")
	otherReply.ParentMessageID = "99-diff"
	if err := s.Create(ctx, otherReply); err != nil {
		t.Fatalf("create other reply: %v", err)
	}

	replies, err := s.ListThreadReplies(ctx, "01-root")
	if err != nil {
		t.Fatalf("ListThreadReplies: %v", err)
	}
	if len(replies) != 2 || replies[0].ID != "02-r1" || replies[1].ID != "03-r2" {
		t.Fatalf("replies = %+v, want [02-r1 03-r2]", replies)
	}

	// Edit/tombstone re-Puts the whole row — the GSI key must survive so the
	// reply doesn't drop out of the thread.
	replies[0].Body = "edited"
	if err := s.Update(ctx, "ch-thr", replies[0]); err != nil {
		t.Fatalf("update: %v", err)
	}
	again, err := s.ListThreadReplies(ctx, "01-root")
	if err != nil {
		t.Fatalf("ListThreadReplies after update: %v", err)
	}
	if len(again) != 2 {
		t.Fatalf("after update len = %d, want 2 (GSI key preserved on Update)", len(again))
	}
}

func TestMessageStore_ListThreadReplies_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	if _, err := s.ListThreadReplies(ctx, "root"); !errors.Is(err, errInjected) {
		t.Fatalf("ListThreadReplies: want errInjected, got %v", err)
	}
}

func TestMessageStore_StampThreadIndex(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(db)

	// A reply that predates the index: created as a plain message (no
	// ParentMessageID), so Create didn't stamp a GSI key. The backfill stamps
	// it after the fact.
	legacy := makeMessage("ch-st", "01-legacy", "u-a", "old reply")
	if err := s.Create(ctx, legacy); err != nil {
		t.Fatalf("create: %v", err)
	}
	if r, err := s.ListThreadReplies(ctx, "00-root"); err != nil || len(r) != 0 {
		t.Fatalf("pre-stamp: err=%v len=%d", err, len(r))
	}

	if err := s.StampThreadIndex(ctx, "ch-st", "01-legacy", "00-root"); err != nil {
		t.Fatalf("StampThreadIndex: %v", err)
	}
	r, err := s.ListThreadReplies(ctx, "00-root")
	if err != nil || len(r) != 1 || r[0].ID != "01-legacy" {
		t.Fatalf("post-stamp: err=%v replies=%+v", err, r)
	}

	// Stamping a non-existent row → ErrNotFound.
	if err := s.StampThreadIndex(ctx, "ch-st", "missing", "00-root"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stamp missing: want ErrNotFound, got %v", err)
	}
}

func TestMessageStore_StampThreadIndex_UpdateError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if err := s.StampThreadIndex(ctx, "ch-st", "m", "root"); !errors.Is(err, errInjected) {
		t.Fatalf("StampThreadIndex: want errInjected, got %v", err)
	}
}

// ListAfter with an empty cursor short-circuits to an empty result.
func TestMessageStore_ListAfter_EmptyCursor(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(db)
	msgs, hasMore, err := s.ListAfter(ctx, "ch-me", "", 10)
	if err != nil {
		t.Fatalf("ListAfter empty: %v", err)
	}
	if len(msgs) != 0 || hasMore {
		t.Fatalf("ListAfter empty: want no results, got %d hasMore=%v", len(msgs), hasMore)
	}
}

func TestMessageStore_ListAfter_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, _, err := s.ListAfter(ctx, "ch-me", "m-cursor", 10)
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListAfter: want errInjected, got %v", err)
	}
}

func TestMessageStore_Update_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	msg := makeMessage("ch-mu", "m-u", "u-a", "hi")
	if err := NewMessageStore(db).Create(ctx, msg); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewMessageStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	msg.Body = "edited"
	err := s.Update(ctx, "ch-mu", msg)
	if !errors.Is(err, errInjected) {
		t.Fatalf("Update: want errInjected, got %v", err)
	}
}

func TestMessageStore_Delete_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.Delete(ctx, "ch-me", "m-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete: want errInjected, got %v", err)
	}
}

// IncrementReplyMetadata on a missing root hits the conditional-check-failed →
// ErrNotFound branch (the GET succeeds against a seeded root; the UpdateItem
// condition is what we want to drive, so we seed then delete is overkill —
// instead a never-created root makes GetByID return ErrNotFound first).
func TestMessageStore_IncrementReplyMetadata_RootMissing(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(db)
	_, err := s.IncrementReplyMetadata(ctx, "ch-irm", "m-missing", time.Now(), "u-r")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("IncrementReplyMetadata missing: want ErrNotFound, got %v", err)
	}
}

// IncrementReplyMetadata returns ErrNotFound when the root vanishes between the
// GetByID pre-read and the conditional UpdateItem (TOCTOU). deleteOnUpdateClient
// (defined in category_error_test.go) deletes the row just before UpdateItem.
func TestMessageStore_IncrementReplyMetadata_VanishedRoot(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	root := makeMessage("ch-irm3", "m-root3", "u-a", "root")
	if err := NewMessageStore(db).Create(ctx, root); err != nil {
		t.Fatalf("seed: %v", err)
	}
	doc := &deleteOnUpdateClient{
		DynamoAPI: db.Client,
		table:     db.Table,
		pk:        parentPK("ch-irm3"),
		sk:        msgSK("m-root3"),
	}
	s := NewMessageStore(&DB{Client: doc, Table: db.Table})
	_, err := s.IncrementReplyMetadata(ctx, "ch-irm3", "m-root3", time.Now(), "u-r")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("IncrementReplyMetadata vanished root: want ErrNotFound, got %v", err)
	}
}

func TestMessageStore_IncrementReplyMetadata_UpdateItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	root := makeMessage("ch-irm2", "m-root", "u-a", "root")
	if err := NewMessageStore(db).Create(ctx, root); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// GetByID succeeds (real client); only UpdateItem faults → the SDK-error
	// branch (not ErrNotFound).
	s := NewMessageStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	_, err := s.IncrementReplyMetadata(ctx, "ch-irm2", "m-root", time.Now(), "u-r")
	if !errors.Is(err, errInjected) {
		t.Fatalf("IncrementReplyMetadata: want errInjected, got %v", err)
	}
}
