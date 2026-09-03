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

func mkAgentSubFixture(id, parentID string) *model.AgentSubscription {
	return &model.AgentSubscription{
		ID:         id,
		AgentID:    "a-gg",
		CreatorID:  "u-creator",
		ParentID:   parentID,
		ParentType: "channel",
		Keywords:   []string{"budget"},
	}
}

func TestAgentMemoryStore_RoundTrip(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)

	m := &model.AgentMemory{
		AgentID:   "a-gg",
		InvokerID: "u-alice",
		Content:   "prefers TL;DR answers",
		UpdatedAt: time.Now().Truncate(time.Millisecond).UTC(),
	}
	if err := s.PutAgentMemory(ctx, m); err != nil {
		t.Fatalf("put: %v", err)
	}
	got, err := s.GetAgentMemory(ctx, "u-alice", "a-gg")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Content != m.Content {
		t.Fatalf("get mismatch: %+v", got)
	}
	if _, err := s.GetAgentMemory(ctx, "u-alice", "a-other"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get absent: want ErrNotFound, got %v", err)
	}
}

func TestAgentMemoryStore_Validation(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)
	if err := s.PutAgentMemory(ctx, &model.AgentMemory{InvokerID: "u-x"}); err == nil {
		t.Fatal("put without agentID: want error")
	}
	if err := s.PutAgentSubscription(ctx, &model.AgentSubscription{ID: "sub-x"}); err == nil {
		t.Fatal("put subscription without parentID: want error")
	}
}

func TestAgentSubscriptionStore_CRUD(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)

	if err := s.PutAgentSubscription(ctx, mkAgentSubFixture("sub-1", "ch-1")); err != nil {
		t.Fatalf("put 1: %v", err)
	}
	if err := s.PutAgentSubscription(ctx, mkAgentSubFixture("sub-2", "ch-1")); err != nil {
		t.Fatalf("put 2: %v", err)
	}
	if err := s.PutAgentSubscription(ctx, mkAgentSubFixture("sub-3", "ch-2")); err != nil {
		t.Fatalf("put 3: %v", err)
	}

	byParent, err := s.ListSubscriptionsByParent(ctx, "ch-1")
	if err != nil {
		t.Fatalf("list by parent: %v", err)
	}
	if len(byParent) != 2 {
		t.Fatalf("list by parent: want 2, got %d", len(byParent))
	}

	all, err := s.ListAllSubscriptions(ctx)
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("list all: want 3, got %d", len(all))
	}

	if err := s.DeleteAgentSubscription(ctx, "ch-1", "sub-1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	byParent, err = s.ListSubscriptionsByParent(ctx, "ch-1")
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if len(byParent) != 1 {
		t.Fatalf("list after delete: want 1, got %d", len(byParent))
	}
}

func TestAgentMemSubs_SDKErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("PutMemory PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		err := s.PutAgentMemory(ctx, &model.AgentMemory{AgentID: "a", InvokerID: "u"})
		if !errors.Is(err, errInjected) {
			t.Fatalf("PutAgentMemory: want errInjected, got %v", err)
		}
	})
	t.Run("GetMemory GetItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetAgentMemory(ctx, "u", "a"); !errors.Is(err, errInjected) {
			t.Fatalf("GetAgentMemory: want errInjected, got %v", err)
		}
	})
	t.Run("PutSubscription PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutAgentSubscription(ctx, mkAgentSubFixture("sub-e", "ch-e")); !errors.Is(err, errInjected) {
			t.Fatalf("PutAgentSubscription: want errInjected, got %v", err)
		}
	})
	t.Run("ListByParent QueryError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListSubscriptionsByParent(ctx, "ch-e"); !errors.Is(err, errInjected) {
			t.Fatalf("ListSubscriptionsByParent: want errInjected, got %v", err)
		}
	})
	t.Run("ListAll QueryError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListAllSubscriptions(ctx); !errors.Is(err, errInjected) {
			t.Fatalf("ListAllSubscriptions: want errInjected, got %v", err)
		}
	})
	t.Run("DeleteSubscription DeleteItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		if err := s.DeleteAgentSubscription(ctx, "ch-e", "sub-e"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteAgentSubscription: want errInjected, got %v", err)
		}
	})
}

func TestAgentMemSubs_CorruptRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("GetAgentMemory", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })
		_, err := NewAgentStore(faulted).GetAgentMemory(ctx, "u-x", "a-x")
		assertUnmarshalErr(t, err, "GetAgentMemory")
	})
	t.Run("unmarshalSubs via ListByParent", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) {
			f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
				o.Items = []map[string]types.AttributeValue{corruptRow()}
				return o
			}
		})
		_, err := NewAgentStore(faulted).ListSubscriptionsByParent(ctx, "ch-x")
		assertUnmarshalErr(t, err, "ListSubscriptionsByParent")
	})
}
