package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// ctxCovStore wraps the package's fakeCtxStore with per-method error taps to
// reach the store-error arms.
type ctxCovStore struct {
	*fakeCtxStore
	failList   bool
	failPut    bool
	failGet    bool
	failDelete bool
}

var errCtxCov = errors.New("ctxcov: injected store failure")

func (s *ctxCovStore) ListContextItems(ctx context.Context, parentType, parentID string) ([]*model.ContextItem, error) {
	if s.failList {
		return nil, errCtxCov
	}
	return s.fakeCtxStore.ListContextItems(ctx, parentType, parentID)
}

func (s *ctxCovStore) PutContextItem(ctx context.Context, it *model.ContextItem) error {
	if s.failPut {
		return errCtxCov
	}
	return s.fakeCtxStore.PutContextItem(ctx, it)
}

func (s *ctxCovStore) GetContextItem(ctx context.Context, parentType, parentID, itemID string) (*model.ContextItem, error) {
	if s.failGet {
		return nil, errCtxCov
	}
	return s.fakeCtxStore.GetContextItem(ctx, parentType, parentID, itemID)
}

func (s *ctxCovStore) DeleteContextItem(ctx context.Context, parentType, parentID, itemID string) error {
	if s.failDelete {
		return errCtxCov
	}
	return s.fakeCtxStore.DeleteContextItem(ctx, parentType, parentID, itemID)
}

func ctxCovService(st *ctxCovStore) *ContextService {
	svc := NewContextService(st, allowAll{})
	n := 0
	svc.newID = func() string { n++; return "ctxcov-" + string(rune('a'+n)) }
	return svc
}

func TestContextCov_WriteStoreErrors(t *testing.T) {
	ctx := context.Background()

	t.Run("list fails", func(t *testing.T) {
		st := &ctxCovStore{fakeCtxStore: newFakeCtxStore(), failList: true}
		_, err := ctxCovService(st).Write(ctx, "u-a", "", "u-a", "ch-1", "channel", "body", false)
		if !errors.Is(err, errCtxCov) {
			t.Fatalf("Write with list failure: want injected error, got %v", err)
		}
	})
	t.Run("put fails", func(t *testing.T) {
		st := &ctxCovStore{fakeCtxStore: newFakeCtxStore(), failPut: true}
		_, err := ctxCovService(st).Write(ctx, "u-a", "", "u-a", "ch-1", "channel", "body", false)
		if !errors.Is(err, errCtxCov) {
			t.Fatalf("Write with put failure: want injected error, got %v", err)
		}
	})
}

func TestContextCov_SetPinned(t *testing.T) {
	ctx := context.Background()
	st := &ctxCovStore{fakeCtxStore: newFakeCtxStore()}
	svc := ctxCovService(st)

	it, err := svc.Write(ctx, "u-a", "", "u-a", "ch-1", "channel", "pin me", false)
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	pinned, err := svc.SetPinned(ctx, "u-a", "ch-1", "channel", it.ID, true)
	if err != nil {
		t.Fatalf("pin: %v", err)
	}
	if !pinned.Pinned {
		t.Fatalf("pin not applied: %+v", pinned)
	}

	// Put failure surfaces from SetPinned.
	st.failPut = true
	if _, err := svc.SetPinned(ctx, "u-a", "ch-1", "channel", it.ID, false); !errors.Is(err, errCtxCov) {
		t.Fatalf("pin with put failure: want injected error, got %v", err)
	}
	st.failPut = false

	// editable's Get error arm.
	st.failGet = true
	if _, err := svc.SetPinned(ctx, "u-a", "ch-1", "channel", it.ID, true); !errors.Is(err, errCtxCov) {
		t.Fatalf("pin with get failure: want injected error, got %v", err)
	}
	st.failGet = false
}

func TestContextCov_EditableAccessDenied(t *testing.T) {
	ctx := context.Background()
	st := newFakeCtxStore()
	svc := NewContextService(st, denyAll{})

	// The access arm inside editable (SetPinned/Delete path), distinct from
	// Write's own access check.
	if _, err := svc.SetPinned(ctx, "u-x", "ch-1", "channel", "any", true); !errors.Is(err, ErrForbidden) {
		t.Fatalf("pin denied: want ErrForbidden, got %v", err)
	}
	if err := svc.Delete(ctx, "u-x", "ch-1", "channel", "any"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("delete denied: want ErrForbidden, got %v", err)
	}
}

func TestContextCov_ListAccessDenied(t *testing.T) {
	svc := NewContextService(newFakeCtxStore(), denyAll{})
	if _, err := svc.List(context.Background(), "u-x", "ch-1", "channel"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("list denied: want ErrForbidden, got %v", err)
	}
}

func TestContextCov_ListHappy(t *testing.T) {
	ctx := context.Background()
	st := &ctxCovStore{fakeCtxStore: newFakeCtxStore()}
	svc := ctxCovService(st)
	if _, err := svc.Write(ctx, "u-a", "", "u-a", "ch-1", "channel", "note", false); err != nil {
		t.Fatalf("write: %v", err)
	}
	items, err := svc.List(ctx, "u-a", "ch-1", "channel")
	if err != nil || len(items) != 1 {
		t.Fatalf("list: want 1 item, got %d (%v)", len(items), err)
	}
}
