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
