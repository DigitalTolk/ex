//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// One approved decision authorizes ONE action: the first consume wins, a
// second (a replay, or a concurrent action racing for the same "yes") is
// stale, and a pending or denied approval can never be consumed.
func TestApprovalStore_ConsumeOnce(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewRunStore(db)
	at := time.Now().Truncate(time.Millisecond)

	if err := s.PutApproval(ctx, mkApprovalFixture("ap-c", "run-c")); err != nil {
		t.Fatal(err)
	}
	if err := s.ConsumeApproval(ctx, "run-c", "ap-c", at); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("pending approval consumed: %v", err)
	}
	if err := s.SettleApproval(ctx, "run-c", "ap-c", model.ApprovalApproved, "u-alice", "", "", at); err != nil {
		t.Fatal(err)
	}
	if err := s.ConsumeApproval(ctx, "run-c", "ap-c", at); err != nil {
		t.Fatalf("first consume: %v", err)
	}
	got, err := s.GetApproval(ctx, "run-c", "ap-c")
	if err != nil || got.ConsumedAt == nil || !got.ConsumedAt.Equal(at) {
		t.Fatalf("consumedAt not recorded: %+v %v", got, err)
	}
	if err := s.ConsumeApproval(ctx, "run-c", "ap-c", at); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("second consume must be stale, got %v", err)
	}
	if err := s.ConsumeApproval(ctx, "run-c", "ap-absent", at); !errors.Is(err, ErrStaleApproval) {
		t.Fatalf("absent approval: want stale, got %v", err)
	}
	faulted := NewRunStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if err := faulted.ConsumeApproval(ctx, "run-c", "ap-c", at); !errors.Is(err, errInjected) {
		t.Fatalf("UpdateItem error: want errInjected, got %v", err)
	}
}
