//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func makeDraft(userID, id, body string, updatedAt time.Time) *model.MessageDraft {
	return &model.MessageDraft{
		ID:         id,
		UserID:     userID,
		ParentID:   "ch-1",
		ParentType: "channel",
		Body:       body,
		UpdatedAt:  updatedAt,
		CreatedAt:  updatedAt.Add(-time.Minute),
	}
}

func TestDraftStore_UpsertGetListDelete(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewDraftStore(db)
	ctx := context.Background()
	now := time.Now().Truncate(time.Millisecond)

	if err := s.Upsert(ctx, makeDraft("u-draft", "draft-1", "first", now)); err != nil {
		t.Fatalf("Upsert first: %v", err)
	}
	if err := s.Upsert(ctx, makeDraft("u-draft", "draft-2", "second", now.Add(time.Second))); err != nil {
		t.Fatalf("Upsert second: %v", err)
	}
	if err := s.Upsert(ctx, makeDraft("u-other", "draft-other", "hidden", now)); err != nil {
		t.Fatalf("Upsert other user: %v", err)
	}

	got, err := s.Get(ctx, "u-draft", "draft-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Body != "first" || got.ParentID != "ch-1" || got.ParentType != "channel" {
		t.Fatalf("got = %+v", got)
	}

	list, err := s.List(ctx, "u-draft")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("List len = %d, want 2: %+v", len(list), list)
	}

	updated := makeDraft("u-draft", "draft-1", "updated", now.Add(2*time.Second))
	updated.AttachmentIDs = []string{"att-1"}
	if err := s.Upsert(ctx, updated); err != nil {
		t.Fatalf("Upsert update: %v", err)
	}
	got, err = s.Get(ctx, "u-draft", "draft-1")
	if err != nil {
		t.Fatalf("Get updated: %v", err)
	}
	if got.Body != "updated" || len(got.AttachmentIDs) != 1 {
		t.Fatalf("updated got = %+v", got)
	}

	if err := s.Delete(ctx, "u-draft", "draft-1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get(ctx, "u-draft", "draft-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete err = %v, want ErrNotFound", err)
	}
}

func TestDraftStore_GetMissing(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewDraftStore(db)

	if _, err := s.Get(context.Background(), "u-missing", "draft-missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get err = %v, want ErrNotFound", err)
	}
}
