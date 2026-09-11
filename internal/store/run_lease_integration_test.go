//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// RenewRunLease must extend ONLY the lease + updatedAt, never touching the
// spend counters — the whole point of the surgical partial update is that a
// heartbeat's stale read can't clobber a concurrent Spend.Posts bump.
func TestRunStore_RenewRunLease(t *testing.T) {
	db := setupDynamoDB(t)
	if db == nil {
		return
	}
	rs := NewRunStore(db)
	ctx := context.Background()

	orig := time.Now().UTC().Add(30 * time.Second)
	run := &model.Run{
		ID:             "run-lease-1",
		OwnerID:        "u-owner",
		AgentID:        "agent-1",
		ParentID:       "chan-1",
		ParentType:     "channel",
		State:          model.RunStateRunning,
		RunnerID:       "runner-A",
		LeaseExpiresAt: &orig,
		Deadline:       time.Now().UTC().Add(5 * time.Minute),
		Spend:          model.RunSpend{Turns: 3, Posts: 2, InputTokens: 100, OutputTokens: 50},
		CreatedAt:      time.Now().UTC(),
	}
	if err := rs.CreateRun(ctx, run); err != nil {
		t.Fatalf("create run: %v", err)
	}

	newLease := time.Now().UTC().Add(2 * time.Minute)
	if err := rs.RenewRunLease(ctx, run.ID, "runner-A", newLease); err != nil {
		t.Fatalf("renew lease: %v", err)
	}

	got, err := rs.GetRun(ctx, run.ID)
	if err != nil {
		t.Fatalf("get run: %v", err)
	}
	// Spend is untouched.
	if got.Spend != run.Spend {
		t.Fatalf("spend clobbered: got %+v want %+v", got.Spend, run.Spend)
	}
	// Lease moved forward.
	if got.LeaseExpiresAt == nil || !got.LeaseExpiresAt.Equal(newLease) {
		t.Fatalf("lease not renewed: got %v want %v", got.LeaseExpiresAt, newLease)
	}

	// A different runner can't renew the lease (run was reassigned/stolen).
	if err := rs.RenewRunLease(ctx, run.ID, "runner-B", time.Now().UTC()); !errors.Is(err, ErrStaleRun) {
		t.Fatalf("wrong-runner renew: got %v want ErrStaleRun", err)
	}

	// A terminal run rejects the renewal.
	term := *got
	term.State = model.RunStateCompleted
	if err := rs.UpdateRun(ctx, &term, model.RunStateRunning); err != nil {
		t.Fatalf("mark terminal: %v", err)
	}
	if err := rs.RenewRunLease(ctx, run.ID, "runner-A", time.Now().UTC()); !errors.Is(err, ErrStaleRun) {
		t.Fatalf("terminal renew: got %v want ErrStaleRun", err)
	}
}
