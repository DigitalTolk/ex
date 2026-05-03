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
	rows      map[string]*model.UserChannelCategory // key: userID + "#" + id
	createErr error
	listErr   error
	updateErr error
	deleteErr error
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
	svc := NewCategoryService(newStubCategoryStore(), newMockPublisher())
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
