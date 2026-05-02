//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func makeCategory(userID, id, name string, position int) *model.UserChannelCategory {
	return &model.UserChannelCategory{
		UserID:    userID,
		ID:        id,
		Name:      name,
		Position:  position,
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}
}

func TestCategoryStore_CreateAndGet(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	c := makeCategory("u-cat-1", "cat-a", "Engineering", 1)
	if err := s.Create(ctx, c); err != nil {
		t.Fatalf("Create: %v", err)
	}

	got, err := s.Get(ctx, "u-cat-1", "cat-a")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "Engineering" {
		t.Errorf("Name = %q, want Engineering", got.Name)
	}
	if got.Position != 1 {
		t.Errorf("Position = %d, want 1", got.Position)
	}
	if got.UserID != "u-cat-1" || got.ID != "cat-a" {
		t.Errorf("identity mismatch: %+v", got)
	}
}

func TestCategoryStore_Create_DuplicateRejected(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	c := makeCategory("u-cat-dup", "cat-d", "Eng", 1)
	if err := s.Create(ctx, c); err != nil {
		t.Fatalf("first Create: %v", err)
	}

	// Re-creating the same (userID, ID) must fail with ErrAlreadyExists.
	if err := s.Create(ctx, c); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second Create: err = %v, want ErrAlreadyExists", err)
	}
}

func TestCategoryStore_Create_DuplicateNameRejectedPerUser(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	if err := s.Create(ctx, makeCategory("u-cat-dup-name", "cat-a", "Engineering", 1)); err != nil {
		t.Fatalf("first Create: %v", err)
	}
	if err := s.Create(ctx, makeCategory("u-cat-dup-name", "cat-b", " engineering ", 2)); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second Create: err = %v, want ErrAlreadyExists", err)
	}
	if err := s.Create(ctx, makeCategory("u-cat-other-name", "cat-c", "Engineering", 1)); err != nil {
		t.Fatalf("same name for different user should be allowed: %v", err)
	}
}

func TestCategoryStore_Create_RequiresIdentity(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	if err := s.Create(ctx, nil); err == nil {
		t.Error("expected error for nil category")
	}
	if err := s.Create(ctx, &model.UserChannelCategory{ID: "x"}); err == nil {
		t.Error("expected error for missing UserID")
	}
	if err := s.Create(ctx, &model.UserChannelCategory{UserID: "u"}); err == nil {
		t.Error("expected error for missing ID")
	}
}

func TestCategoryStore_Get_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	if _, err := s.Get(ctx, "u-missing", "cat-missing"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestCategoryStore_List_OrdersByPosition(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	uid := "u-cat-list"
	// Insert in non-monotonic order so we can verify the store's sort.
	cats := []*model.UserChannelCategory{
		makeCategory(uid, "c-3", "Gamma", 3),
		makeCategory(uid, "c-1", "Alpha", 1),
		makeCategory(uid, "c-2", "Beta", 2),
	}
	for _, c := range cats {
		if err := s.Create(ctx, c); err != nil {
			t.Fatalf("Create %s: %v", c.ID, err)
		}
	}
	// A category for a different user must not leak into the result.
	if err := s.Create(ctx, makeCategory("u-other", "c-stray", "stray", 0)); err != nil {
		t.Fatalf("Create stray: %v", err)
	}

	got, err := s.List(ctx, uid)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("len = %d, want 3 (got %+v)", len(got), got)
	}
	wantIDs := []string{"c-1", "c-2", "c-3"}
	for i, want := range wantIDs {
		if got[i].ID != want {
			t.Errorf("got[%d].ID = %q, want %q", i, got[i].ID, want)
		}
	}
}

func TestCategoryStore_List_EmptyForUnknownUser(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	got, err := s.List(ctx, "u-no-cats")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("len = %d, want 0", len(got))
	}
}

func TestCategoryStore_Update_NameAndPosition(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	uid := "u-cat-upd"
	c := makeCategory(uid, "c-u", "Old", 1)
	if err := s.Create(ctx, c); err != nil {
		t.Fatalf("Create: %v", err)
	}

	c.Name = "New"
	c.Position = 9
	if err := s.Update(ctx, c); err != nil {
		t.Fatalf("Update: %v", err)
	}

	got, err := s.Get(ctx, uid, "c-u")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if got.Name != "New" || got.Position != 9 {
		t.Errorf("update not persisted: %+v", got)
	}
}

func TestCategoryStore_Update_DuplicateNameRejected(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	uid := "u-cat-upd-dup"
	if err := s.Create(ctx, makeCategory(uid, "c-a", "Engineering", 1)); err != nil {
		t.Fatalf("Create A: %v", err)
	}
	c := makeCategory(uid, "c-b", "Support", 2)
	if err := s.Create(ctx, c); err != nil {
		t.Fatalf("Create B: %v", err)
	}

	c.Name = " engineering "
	if err := s.Update(ctx, c); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("Update: err = %v, want ErrAlreadyExists", err)
	}
}

func TestCategoryStore_Update_NotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	c := makeCategory("u-ghost", "c-ghost", "Ghost", 1)
	if err := s.Update(ctx, c); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestCategoryStore_Update_RequiresIdentity(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	if err := s.Update(ctx, nil); err == nil {
		t.Error("expected error for nil category")
	}
	if err := s.Update(ctx, &model.UserChannelCategory{ID: "x"}); err == nil {
		t.Error("expected error for missing UserID")
	}
	if err := s.Update(ctx, &model.UserChannelCategory{UserID: "u"}); err == nil {
		t.Error("expected error for missing ID")
	}
}

func TestCategoryStore_Delete(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	uid := "u-cat-del"
	c := makeCategory(uid, "c-del", "Del", 1)
	if err := s.Create(ctx, c); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.Delete(ctx, uid, "c-del"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get(ctx, uid, "c-del"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound after delete, got %v", err)
	}
	if err := s.Create(ctx, makeCategory(uid, "c-del-2", "Del", 2)); err != nil {
		t.Fatalf("recreate same name after Delete: %v", err)
	}
}

func TestCategoryStore_Delete_Idempotent(t *testing.T) {
	// DynamoDB DeleteItem succeeds on a missing key — verify that the
	// store mirrors that contract instead of returning ErrNotFound.
	db := setupDynamoDB(t)
	s := NewCategoryStore(db)
	ctx := context.Background()

	if err := s.Delete(ctx, "u-no-such", "cat-no-such"); err != nil {
		t.Errorf("Delete of missing should be a no-op, got %v", err)
	}
}

// TestCategoryStore_Get_NonexistentTable covers the wrap-and-return
// branch in Get when the underlying GetItem call errors.
func TestCategoryStore_Get_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	s := NewCategoryStore(db)
	if _, err := s.Get(context.Background(), "u", "c"); err == nil {
		t.Error("expected error on missing table")
	}
}

// TestCategoryStore_List_NonexistentTable covers the Query error path.
func TestCategoryStore_List_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	s := NewCategoryStore(db)
	if _, err := s.List(context.Background(), "u"); err == nil {
		t.Error("expected error on missing table")
	}
}

// TestCategoryStore_Delete_NonexistentTable covers the DeleteItem error
// path. DynamoDB DeleteItem ordinarily succeeds on a missing key, but a
// missing table returns ResourceNotFoundException which the store
// wraps and surfaces.
func TestCategoryStore_Delete_NonexistentTable(t *testing.T) {
	db := brokenDB(t)
	s := NewCategoryStore(db)
	if err := s.Delete(context.Background(), "u", "c"); err == nil {
		t.Error("expected error on missing table")
	}
}
