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

func mkApprovalFixture(id, runID string) *model.Approval {
	now := time.Now().Truncate(time.Millisecond).UTC()
	return &model.Approval{
		ID:        id,
		RunID:     runID,
		AgentID:   "a-gg",
		InvokerID: "u-alice",
		Summary:   "run terraform apply?",
		State:     model.ApprovalPending,
		Deadline:  now.Add(10 * time.Minute),
		CreatedAt: now,
	}
}

func mkArtifactFixture(id, runID string) *model.Artifact {
	return &model.Artifact{
		ID:        id,
		RunID:     runID,
		AgentID:   "a-gg",
		InvokerID: "u-alice",
		Kind:      "markdown",
		Title:     "plan",
		Content:   "# plan\n- step",
		CreatedAt: time.Now().Truncate(time.Millisecond).UTC(),
	}
}

func TestApprovalStore_Lifecycle(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewRunStore(db)

	a := mkApprovalFixture("ap-1", "run-1")
	if err := s.PutApproval(ctx, a); err != nil {
		t.Fatalf("put: %v", err)
	}
	// Duplicate ID: the attribute_not_exists condition rejects it.
	if err := s.PutApproval(ctx, mkApprovalFixture("ap-1", "run-1")); err == nil {
		t.Fatal("duplicate approval: want error, got nil")
	}

	got, err := s.GetApproval(ctx, "run-1", "ap-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.State != model.ApprovalPending || got.Summary != a.Summary {
		t.Fatalf("get mismatch: %+v", got)
	}
	if _, err := s.GetApproval(ctx, "run-1", "ap-absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get absent: want ErrNotFound, got %v", err)
	}

	// Decide it; the pending-conditional lets exactly one writer win.
	decidedAt := time.Now().UTC()
	if err := s.SettleApproval(ctx, "run-1", "ap-1", "approved", "u-alice", "", "looks fine", decidedAt); err != nil {
		t.Fatalf("settle: %v", err)
	}
	got, err = s.GetApproval(ctx, "run-1", "ap-1")
	if err != nil {
		t.Fatalf("get after settle: %v", err)
	}
	if got.State != "approved" || got.DecidedBy != "u-alice" || got.Note != "looks fine" {
		t.Fatalf("settle not persisted: %+v", got)
	}
	// A second decision (or the expiry sweep) loses the race.
	if err := s.SettleApproval(ctx, "run-1", "ap-1", "denied", "u-bob", "", "", decidedAt); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("re-settle: want ErrStaleApproval, got %v", err)
	}

	if err := s.PutApproval(ctx, mkApprovalFixture("ap-2", "run-1")); err != nil {
		t.Fatalf("put 2: %v", err)
	}
	all, err := s.ListApprovals(ctx, "run-1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("list: want 2 approvals, got %d", len(all))
	}
}

func TestApprovalStore_Validation(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewRunStore(db)
	if err := s.PutApproval(ctx, &model.Approval{RunID: "run-1"}); err == nil {
		t.Fatal("approval without id: want error")
	}
	if err := s.PutArtifact(ctx, &model.Artifact{ID: "art-1"}); err == nil {
		t.Fatal("artifact without runID: want error")
	}
}

func TestArtifactStore_PutAndList(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewRunStore(db)

	if err := s.PutArtifact(ctx, mkArtifactFixture("art-1", "run-1")); err != nil {
		t.Fatalf("put 1: %v", err)
	}
	if err := s.PutArtifact(ctx, mkArtifactFixture("art-2", "run-1")); err != nil {
		t.Fatalf("put 2: %v", err)
	}
	all, err := s.ListArtifacts(ctx, "run-1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("list: want 2 artifacts, got %d", len(all))
	}
	if all[0].Title != "plan" || all[0].Content == "" {
		t.Fatalf("artifact mismatch: %+v", all[0])
	}
}

func TestRunExtras_SDKErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("PutApproval PutItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutApproval(ctx, mkApprovalFixture("ap-e", "run-e")); !errors.Is(err, errInjected) {
			t.Fatalf("PutApproval: want errInjected, got %v", err)
		}
	})
	t.Run("GetApproval GetItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetApproval(ctx, "run-e", "ap-e"); !errors.Is(err, errInjected) {
			t.Fatalf("GetApproval: want errInjected, got %v", err)
		}
	})
	t.Run("SettleApproval UpdateItemError", func(t *testing.T) {
		// Seed a real pending approval so only the UpdateItem fails —
		// exercising the non-condition error branch, not the stale one.
		if err := NewRunStore(db).PutApproval(ctx, mkApprovalFixture("ap-f", "run-f")); err != nil {
			t.Fatalf("seed: %v", err)
		}
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
		err := s.SettleApproval(ctx, "run-f", "ap-f", "approved", "u", "", "", time.Now())
		if !errors.Is(err, errInjected) {
			t.Fatalf("SettleApproval: want errInjected, got %v", err)
		}
	})
	t.Run("ListApprovals QueryError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListApprovals(ctx, "run-e"); !errors.Is(err, errInjected) {
			t.Fatalf("ListApprovals: want errInjected, got %v", err)
		}
	})
	t.Run("PutArtifact PutItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutArtifact(ctx, mkArtifactFixture("art-e", "run-e")); !errors.Is(err, errInjected) {
			t.Fatalf("PutArtifact: want errInjected, got %v", err)
		}
	})
	t.Run("ListArtifacts QueryError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListArtifacts(ctx, "run-e"); !errors.Is(err, errInjected) {
			t.Fatalf("ListArtifacts: want errInjected, got %v", err)
		}
	})
}

func TestRunExtras_CorruptRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	corruptQ := func(f *faultClient) {
		f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
			o.Items = []map[string]types.AttributeValue{corruptRow()}
			return o
		}
	}

	t.Run("GetApproval", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })
		_, err := NewRunStore(faulted).GetApproval(ctx, "run-x", "ap-x")
		assertUnmarshalErr(t, err, "GetApproval")
	})
	t.Run("ListApprovals", func(t *testing.T) {
		_, err := NewRunStore(withFault(db, corruptQ)).ListApprovals(ctx, "run-x")
		assertUnmarshalErr(t, err, "ListApprovals")
	})
	t.Run("ListArtifacts", func(t *testing.T) {
		_, err := NewRunStore(withFault(db, corruptQ)).ListArtifacts(ctx, "run-x")
		assertUnmarshalErr(t, err, "ListArtifacts")
	})
}
