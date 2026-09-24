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

func mkTaskClaimFixture(label string) *model.TaskClaim {
	return &model.TaskClaim{
		ParentID:     "ch-1",
		ThreadRootID: "m-root",
		Label:        label,
		AgentID:      "a-gg",
		InvokerID:    "u-alice",
		CreatedAt:    time.Now().Truncate(time.Millisecond).UTC(),
	}
}

func mkAgentFollowFixture(agentID, invokerID string) *model.AgentThreadFollow {
	return &model.AgentThreadFollow{
		ParentID:     "ch-1",
		ParentType:   "channel",
		ThreadRootID: "m-root",
		AgentID:      agentID,
		InvokerID:    invokerID,
		LastPostAt:   time.Now().Truncate(time.Millisecond).UTC(),
	}
}

func TestTaskClaimStore_FirstWriteWins(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)

	if err := s.PutTaskClaim(ctx, mkTaskClaimFixture("backend")); err != nil {
		t.Fatalf("first claim: %v", err)
	}
	// Same label again — the atomic tiebreak must reject the loser.
	if err := s.PutTaskClaim(ctx, mkTaskClaimFixture("backend")); !errors.Is(err, ErrClaimTaken) {
		t.Fatalf("duplicate claim: want ErrClaimTaken, got %v", err)
	}
	if err := s.PutTaskClaim(ctx, mkTaskClaimFixture("frontend")); err != nil {
		t.Fatalf("second label: %v", err)
	}

	claims, err := s.ListTaskClaims(ctx, "ch-1", "m-root")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(claims) != 2 {
		t.Fatalf("list: want 2 claims, got %d", len(claims))
	}
}

func TestTaskClaimStore_Validation(t *testing.T) {
	db := setupDynamoDB(t)
	if err := NewAgentStore(db).PutTaskClaim(context.Background(), &model.TaskClaim{ParentID: "ch-1"}); err == nil {
		t.Fatal("claim without threadRootID/label: want error")
	}
}

func TestAgentFollowStore_UpsertAndList(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAgentStore(db)

	f := mkAgentFollowFixture("a-gg", "u-alice")
	if err := s.PutAgentFollow(ctx, f); err != nil {
		t.Fatalf("put: %v", err)
	}
	// Re-put refreshes (upsert), not duplicates.
	f.LastPostAt = f.LastPostAt.Add(time.Minute)
	if err := s.PutAgentFollow(ctx, f); err != nil {
		t.Fatalf("re-put: %v", err)
	}
	if err := s.PutAgentFollow(ctx, mkAgentFollowFixture("a-qib", "u-alice")); err != nil {
		t.Fatalf("second agent: %v", err)
	}

	follows, err := s.ListAgentFollows(ctx, "ch-1", "m-root")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(follows) != 2 {
		t.Fatalf("list: want 2 follows, got %d", len(follows))
	}
}

func TestAgentFollowStore_Validation(t *testing.T) {
	db := setupDynamoDB(t)
	if err := NewAgentStore(db).PutAgentFollow(context.Background(), &model.AgentThreadFollow{ParentID: "ch-1"}); err == nil {
		t.Fatal("follow without required fields: want error")
	}
}

func TestAgentThread_SDKErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("PutTaskClaim PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutTaskClaim(ctx, mkTaskClaimFixture("e")); !errors.Is(err, errInjected) {
			t.Fatalf("PutTaskClaim: want errInjected, got %v", err)
		}
	})
	t.Run("ListTaskClaims QueryError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListTaskClaims(ctx, "ch-e", "m-e"); !errors.Is(err, errInjected) {
			t.Fatalf("ListTaskClaims: want errInjected, got %v", err)
		}
	})
	t.Run("PutAgentFollow PutItemError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutAgentFollow(ctx, mkAgentFollowFixture("a-e", "u-e")); !errors.Is(err, errInjected) {
			t.Fatalf("PutAgentFollow: want errInjected, got %v", err)
		}
	})
	t.Run("ListAgentFollows QueryError", func(t *testing.T) {
		s := NewAgentStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListAgentFollows(ctx, "ch-e", "m-e"); !errors.Is(err, errInjected) {
			t.Fatalf("ListAgentFollows: want errInjected, got %v", err)
		}
	})
}

func TestAgentThread_CorruptRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	corruptQ := func(f *faultClient) {
		f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
			o.Items = []map[string]types.AttributeValue{corruptRow()}
			return o
		}
	}

	t.Run("ListTaskClaims", func(t *testing.T) {
		_, err := NewAgentStore(withFault(db, corruptQ)).ListTaskClaims(ctx, "ch-x", "m-x")
		assertUnmarshalErr(t, err, "ListTaskClaims")
	})
	t.Run("ListAgentFollows", func(t *testing.T) {
		_, err := NewAgentStore(withFault(db, corruptQ)).ListAgentFollows(ctx, "ch-x", "m-x")
		assertUnmarshalErr(t, err, "ListAgentFollows")
	})
}
