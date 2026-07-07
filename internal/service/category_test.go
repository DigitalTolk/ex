package service

import (
	"context"
	"errors"
	"sort"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// stubCategoryStore is a small in-memory CategoryStore for tests.
type stubCategoryStore struct {
	rows            map[string]*model.UserChannelCategory // key: userID + "#" + id
	createErr       error
	listErr         error
	listNil         bool // when true, List returns a nil slice (no error)
	updateErr       error
	deleteErr       error
	setPositionsErr error
	lastPositions   map[string]int
}

func newStubCategoryStore() *stubCategoryStore {
	return &stubCategoryStore{rows: map[string]*model.UserChannelCategory{}}
}

func (s *stubCategoryStore) key(uid, id string) string { return uid + "#" + id }

func (s *stubCategoryStore) Create(_ context.Context, c *model.UserChannelCategory) error {
	if s.createErr != nil {
		return s.createErr
	}
	s.rows[s.key(c.UserID, c.ID)] = c
	return nil
}

func (s *stubCategoryStore) Get(_ context.Context, userID, id string) (*model.UserChannelCategory, error) {
	c, ok := s.rows[s.key(userID, id)]
	if !ok {
		return nil, store.ErrNotFound
	}
	return c, nil
}

func (s *stubCategoryStore) List(_ context.Context, userID string) ([]*model.UserChannelCategory, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	if s.listNil {
		return nil, nil
	}
	out := make([]*model.UserChannelCategory, 0)
	for _, c := range s.rows {
		if c.UserID == userID {
			out = append(out, c)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Position != out[j].Position {
			return out[i].Position < out[j].Position
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

func (s *stubCategoryStore) Update(_ context.Context, c *model.UserChannelCategory) error {
	if s.updateErr != nil {
		return s.updateErr
	}
	if _, ok := s.rows[s.key(c.UserID, c.ID)]; !ok {
		return store.ErrNotFound
	}
	s.rows[s.key(c.UserID, c.ID)] = c
	return nil
}

func (s *stubCategoryStore) Delete(_ context.Context, userID, id string) error {
	if s.deleteErr != nil {
		return s.deleteErr
	}
	delete(s.rows, s.key(userID, id))
	return nil
}

func TestCategoryService_Create_AppendsToEnd(t *testing.T) {
	cs := newStubCategoryStore()
	pub := newMockPublisher()
	svc := NewCategoryService(cs, pub)
	ctx := context.Background()

	a, err := svc.Create(ctx, "u-1", "Engineering")
	if err != nil {
		t.Fatalf("Create A: %v", err)
	}
	b, err := svc.Create(ctx, "u-1", "Customer support")
	if err != nil {
		t.Fatalf("Create B: %v", err)
	}
	if a.Position >= b.Position {
		t.Errorf("expected B to be appended; got A.Position=%d B.Position=%d", a.Position, b.Position)
	}
	if a.Name != "Engineering" || b.Name != "Customer support" {
		t.Errorf("names not preserved: %q, %q", a.Name, b.Name)
	}
}

func TestCategoryService_Create_RejectsBlankName(t *testing.T) {
	svc := NewCategoryService(newStubCategoryStore(), newMockPublisher())
	if _, err := svc.Create(context.Background(), "u-1", "  "); err == nil {
		t.Fatal("blank name must be rejected")
	}
}

func TestCategoryService_Create_RejectsDuplicateName(t *testing.T) {
	svc := NewCategoryService(newStubCategoryStore(), newMockPublisher())
	ctx := context.Background()
	if _, err := svc.Create(ctx, "u-1", "Engineering"); err != nil {
		t.Fatalf("first Create: %v", err)
	}
	if _, err := svc.Create(ctx, "u-1", " engineering "); !errors.Is(err, ErrCategoryNameTaken) {
		t.Fatalf("second Create: err = %v, want ErrCategoryNameTaken", err)
	}
	if _, err := svc.Create(ctx, "u-2", "Engineering"); err != nil {
		t.Fatalf("same name for different user should be allowed: %v", err)
	}
}

func TestCategoryService_List_ReturnsEmptySliceNotNil(t *testing.T) {
	cs := newStubCategoryStore()
	cs.listNil = true // store returns nil; service must coerce to empty slice
	svc := NewCategoryService(cs, newMockPublisher())
	got, err := svc.List(context.Background(), "u-empty")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if got == nil {
		t.Error("List must return a non-nil slice for unknown users")
	}
	if len(got) != 0 {
		t.Errorf("len = %d, want 0", len(got))
	}
}

func TestCategoryService_List_Error(t *testing.T) {
	cs := newStubCategoryStore()
	cs.listErr = errors.New("list failed")
	svc := NewCategoryService(cs, newMockPublisher())
	if _, err := svc.List(context.Background(), "u-1"); err == nil {
		t.Fatal("expected list error")
	}
}

func TestCategoryService_Update_RenameAndReorder(t *testing.T) {
	cs := newStubCategoryStore()
	svc := NewCategoryService(cs, newMockPublisher())
	ctx := context.Background()

	c, _ := svc.Create(ctx, "u-1", "Eng")
	newName := "Engineering"
	newPos := 5
	updated, err := svc.Update(ctx, "u-1", c.ID, &newName, &newPos)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Name != "Engineering" || updated.Position != 5 {
		t.Errorf("update not applied: %+v", updated)
	}
}

func TestCategoryService_Update_BlankNameRejected(t *testing.T) {
	cs := newStubCategoryStore()
	svc := NewCategoryService(cs, newMockPublisher())
	ctx := context.Background()
	c, _ := svc.Create(ctx, "u-1", "Eng")
	blank := "   "
	if _, err := svc.Update(ctx, "u-1", c.ID, &blank, nil); err == nil {
		t.Fatal("blank rename must be rejected")
	}
}

func TestCategoryService_Update_RejectsDuplicateName(t *testing.T) {
	cs := newStubCategoryStore()
	svc := NewCategoryService(cs, newMockPublisher())
	ctx := context.Background()
	if _, err := svc.Create(ctx, "u-1", "Engineering"); err != nil {
		t.Fatalf("Create A: %v", err)
	}
	b, err := svc.Create(ctx, "u-1", "Support")
	if err != nil {
		t.Fatalf("Create B: %v", err)
	}
	name := " engineering "
	if _, err := svc.Update(ctx, "u-1", b.ID, &name, nil); !errors.Is(err, ErrCategoryNameTaken) {
		t.Fatalf("Update: err = %v, want ErrCategoryNameTaken", err)
	}
}

func TestCategoryService_Update_NotFound(t *testing.T) {
	svc := NewCategoryService(newStubCategoryStore(), newMockPublisher())
	if _, err := svc.Update(context.Background(), "u-1", "missing", nil, nil); err == nil {
		t.Fatal("expected error for missing category")
	}
}

func TestCategoryService_Delete(t *testing.T) {
	cs := newStubCategoryStore()
	svc := NewCategoryService(cs, newMockPublisher())
	ctx := context.Background()
	c, _ := svc.Create(ctx, "u-1", "Eng")
	if err := svc.Delete(ctx, "u-1", c.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, ok := cs.rows[cs.key("u-1", c.ID)]; ok {
		t.Error("expected row to be removed")
	}
}

func TestCategoryService_Create_StoreErrorPropagates(t *testing.T) {
	cs := newStubCategoryStore()
	cs.createErr = errors.New("boom")
	svc := NewCategoryService(cs, newMockPublisher())
	if _, err := svc.Create(context.Background(), "u-1", "Eng"); err == nil {
		t.Fatal("expected wrapped error")
	}
}

func TestCategoryService_Create_ListErrorPropagates(t *testing.T) {
	cs := newStubCategoryStore()
	cs.listErr = errors.New("list boom")
	svc := NewCategoryService(cs, newMockPublisher())
	if _, err := svc.Create(context.Background(), "u-1", "Eng"); err == nil {
		t.Fatal("expected wrapped list error")
	}
}

func TestCategoryService_Create_AlreadyExistsMapsToNameTaken(t *testing.T) {
	cs := newStubCategoryStore()
	cs.createErr = store.ErrAlreadyExists
	svc := NewCategoryService(cs, newMockPublisher())
	if _, err := svc.Create(context.Background(), "u-1", "Eng"); !errors.Is(err, ErrCategoryNameTaken) {
		t.Fatalf("err = %v, want ErrCategoryNameTaken", err)
	}
}

func TestCategoryService_Update_StoreErrors(t *testing.T) {
	ctx := context.Background()

	t.Run("list error", func(t *testing.T) {
		cs := newStubCategoryStore()
		svc := NewCategoryService(cs, newMockPublisher())
		c, _ := svc.Create(ctx, "u-1", "Eng")
		cs.listErr = errors.New("list boom")
		name := "Engineering"
		if _, err := svc.Update(ctx, "u-1", c.ID, &name, nil); err == nil {
			t.Fatal("expected list error")
		}
	})

	t.Run("already exists maps to name taken", func(t *testing.T) {
		cs := newStubCategoryStore()
		svc := NewCategoryService(cs, newMockPublisher())
		c, _ := svc.Create(ctx, "u-1", "Eng")
		cs.updateErr = store.ErrAlreadyExists
		if _, err := svc.Update(ctx, "u-1", c.ID, nil, nil); !errors.Is(err, ErrCategoryNameTaken) {
			t.Fatalf("err = %v, want ErrCategoryNameTaken", err)
		}
	})

	t.Run("generic update error", func(t *testing.T) {
		cs := newStubCategoryStore()
		svc := NewCategoryService(cs, newMockPublisher())
		c, _ := svc.Create(ctx, "u-1", "Eng")
		cs.updateErr = errors.New("update boom")
		if _, err := svc.Update(ctx, "u-1", c.ID, nil, nil); err == nil {
			t.Fatal("expected update error")
		}
	})
}

func TestCategoryService_Delete_StoreErrorPropagates(t *testing.T) {
	cs := newStubCategoryStore()
	cs.deleteErr = errors.New("boom")
	svc := NewCategoryService(cs, newMockPublisher())
	if err := svc.Delete(context.Background(), "u-1", "x"); err == nil {
		t.Fatal("expected wrapped error")
	}
}


func (s *stubCategoryStore) SetPositions(_ context.Context, userID string, positions map[string]int) error {
	if s.setPositionsErr != nil {
		return s.setPositionsErr
	}
	s.lastPositions = positions
	for id, pos := range positions {
		if row, ok := s.rows[userID+"#"+id]; ok {
			row.Position = pos
		}
	}
	return nil
}

func TestCategoryService_Move(t *testing.T) {
	ctx := context.Background()
	cs := newStubCategoryStore()
	pub := newMockPublisher()
	svc := NewCategoryService(cs, pub)
	cs.rows["u1#cat-a"] = &model.UserChannelCategory{UserID: "u1", ID: "cat-a", Name: "A", Position: 1}
	cs.rows["u1#cat-b"] = &model.UserChannelCategory{UserID: "u1", ID: "cat-b", Name: "B", Position: 2}
	cs.rows["u1#cat-c"] = &model.UserChannelCategory{UserID: "u1", ID: "cat-c", Name: "C", Position: 3}

	// Drop C after A: server renumbers densely — A, C, B.
	got, err := svc.Move(ctx, "u1", "cat-c", "cat-a")
	if err != nil {
		t.Fatalf("Move: %v", err)
	}
	order := []string{}
	for _, c := range got {
		order = append(order, c.ID)
	}
	if len(order) != 3 || order[0] != "cat-a" || order[1] != "cat-c" || order[2] != "cat-b" {
		t.Fatalf("order = %v, want [cat-a cat-c cat-b]", order)
	}
	if got[0].Position != 1024 || got[1].Position != 2048 || got[2].Position != 3072 {
		t.Fatalf("positions = %d,%d,%d, want dense 1024-step", got[0].Position, got[1].Position, got[2].Position)
	}
	// Only rows whose position changed are written.
	if len(cs.lastPositions) != 3 {
		t.Fatalf("written positions = %v (all changed from 1,2,3)", cs.lastPositions)
	}
	if len(pub.published) != 1 {
		t.Fatalf("published = %+v, want one categories update", pub.published)
	}

	// Move to the very top (empty anchor).
	got, err = svc.Move(ctx, "u1", "cat-b", "")
	if err != nil {
		t.Fatalf("Move top: %v", err)
	}
	if got[0].ID != "cat-b" {
		t.Fatalf("order after top move = %v", got)
	}

	// A drop that reproduces the current layout writes nothing: every row
	// already sits at its dense slot.
	cs.lastPositions = nil
	if _, err := svc.Move(ctx, "u1", "cat-c", "cat-a"); err != nil {
		t.Fatalf("no-op Move: %v", err)
	}
	if len(cs.lastPositions) != 0 {
		t.Fatalf("no-op move must write nothing, wrote %v", cs.lastPositions)
	}

	// Equal positions (e.g. two legacy zero rows) fall back to the ID
	// tiebreak, matching the client's sort so the anchor stays stable.
	cs.rows["u1#cat-z1"] = &model.UserChannelCategory{UserID: "u1", ID: "cat-z1", Name: "Z1", Position: 9000}
	cs.rows["u1#cat-z2"] = &model.UserChannelCategory{UserID: "u1", ID: "cat-z2", Name: "Z2", Position: 9000}
	got, err = svc.Move(ctx, "u1", "cat-a", "")
	if err != nil {
		t.Fatalf("Move with tied positions: %v", err)
	}
	last := got[len(got)-2].ID + ">" + got[len(got)-1].ID
	if last != "cat-z1>cat-z2" {
		t.Fatalf("tied rows ordered %q, want ID-ascending cat-z1>cat-z2", last)
	}
}

func TestCategoryService_MoveErrors(t *testing.T) {
	ctx := context.Background()
	cs := newStubCategoryStore()
	svc := NewCategoryService(cs, newMockPublisher())
	cs.rows["u1#cat-a"] = &model.UserChannelCategory{UserID: "u1", ID: "cat-a", Name: "A", Position: 1}
	cs.rows["u1#cat-b"] = &model.UserChannelCategory{UserID: "u1", ID: "cat-b", Name: "B", Position: 2}

	if _, err := svc.Move(ctx, "u1", "", "cat-a"); !errors.Is(err, ErrSidebarInvalid) {
		t.Fatalf("empty id err = %v, want ErrSidebarInvalid", err)
	}
	// Anchoring on itself means the client saw a layout that cannot exist.
	if _, err := svc.Move(ctx, "u1", "cat-a", "cat-a"); !errors.Is(err, ErrSidebarConflict) {
		t.Fatalf("self anchor err = %v, want ErrSidebarConflict", err)
	}
	if _, err := svc.Move(ctx, "u1", "cat-missing", ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing category err = %v, want ErrNotFound", err)
	}
	// A deleted anchor = stale layout → conflict, so the client refetches.
	if _, err := svc.Move(ctx, "u1", "cat-a", "cat-deleted"); !errors.Is(err, ErrSidebarConflict) {
		t.Fatalf("stale anchor err = %v, want ErrSidebarConflict", err)
	}

	cs.listErr = errors.New("dynamo down")
	if _, err := svc.Move(ctx, "u1", "cat-a", ""); err == nil {
		t.Fatal("expected list error")
	}
	cs.listErr = nil

	cs.setPositionsErr = errors.New("transact failed")
	if _, err := svc.Move(ctx, "u1", "cat-b", ""); err == nil {
		t.Fatal("expected set positions error")
	}
}
