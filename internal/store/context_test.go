//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func mkCtxItemFixture(id, parentID string) *model.ContextItem {
	return &model.ContextItem{
		ID:         id,
		ParentID:   parentID,
		ParentType: "channel",
		AuthorID:   "u-author",
		Body:       "shared context body",
		CreatedAt:  time.Now().Truncate(time.Millisecond).UTC(),
	}
}

func TestContextStore_CRUD(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewContextStore(db)

	it := mkCtxItemFixture("ctx-1", "ch-1")
	if err := s.PutContextItem(ctx, it); err != nil {
		t.Fatalf("put: %v", err)
	}

	got, err := s.GetContextItem(ctx, "channel", "ch-1", "ctx-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Body != it.Body || got.AuthorID != it.AuthorID {
		t.Fatalf("get mismatch: %+v", got)
	}

	if err := s.PutContextItem(ctx, mkCtxItemFixture("ctx-2", "ch-1")); err != nil {
		t.Fatalf("put 2: %v", err)
	}
	all, err := s.ListContextItems(ctx, "channel", "ch-1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("list: want 2 items, got %d", len(all))
	}

	if err := s.DeleteContextItem(ctx, "channel", "ch-1", "ctx-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.GetContextItem(ctx, "channel", "ch-1", "ctx-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete: want ErrNotFound, got %v", err)
	}
}

func TestContextStore_Put_Validation(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewContextStore(db)
	for _, it := range []*model.ContextItem{
		{ParentID: "ch-1", ParentType: "channel"},              // no ID
		{ID: "ctx-1", ParentType: "channel"},                   // no ParentID
		{ID: "ctx-1", ParentID: "ch-1"},                        // no ParentType
	} {
		if err := s.PutContextItem(ctx, it); err == nil {
			t.Fatalf("put %+v: want validation error, got nil", it)
		}
	}
}

func TestContextStore_SDKErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("Put PutItemError", func(t *testing.T) {
		s := NewContextStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutContextItem(ctx, mkCtxItemFixture("ctx-e", "ch-e")); !errors.Is(err, errInjected) {
			t.Fatalf("PutContextItem: want errInjected, got %v", err)
		}
	})
	t.Run("Get GetItemError", func(t *testing.T) {
		s := NewContextStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetContextItem(ctx, "channel", "ch-e", "ctx-e"); !errors.Is(err, errInjected) {
			t.Fatalf("GetContextItem: want errInjected, got %v", err)
		}
	})
	t.Run("List QueryError", func(t *testing.T) {
		s := NewContextStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListContextItems(ctx, "channel", "ch-e"); !errors.Is(err, errInjected) {
			t.Fatalf("ListContextItems: want errInjected, got %v", err)
		}
	})
	t.Run("Delete DeleteItemError", func(t *testing.T) {
		s := NewContextStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		if err := s.DeleteContextItem(ctx, "channel", "ch-e", "ctx-e"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteContextItem: want errInjected, got %v", err)
		}
	})
}

func TestContextStore_CorruptRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("GetContextItem", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })
		_, err := NewContextStore(faulted).GetContextItem(ctx, "channel", "ch-x", "ctx-x")
		assertUnmarshalErr(t, err, "GetContextItem")
	})
	t.Run("ListContextItems", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) {
			f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
				o.Items = []map[string]types.AttributeValue{corruptRow()}
				return o
			}
		})
		_, err := NewContextStore(faulted).ListContextItems(ctx, "channel", "ch-x")
		assertUnmarshalErr(t, err, "ListContextItems")
	})
}
