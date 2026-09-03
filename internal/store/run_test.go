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

func mkRunFixture(id, ownerID string, deadline time.Time) *model.Run {
	now := time.Now().Truncate(time.Millisecond).UTC()
	return &model.Run{
		ID:         id,
		AgentID:    "a-gg",
		OwnerID:    ownerID,
		InvokerID:  ownerID,
		ParentID:   "ch-1",
		ParentType: "channel",
		MessageID:  "m-1",
		State:      model.RunStateQueued,
		Mode:       "direct",
		Prompt:     "answer the question",
		Deadline:   deadline.UTC(),
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}

func mkRunEventFixture(runID string, seq int64) *model.RunEvent {
	return &model.RunEvent{
		RunID:     runID,
		Seq:       seq,
		ActorID:   "a-gg",
		Type:      "run.invoked",
		CreatedAt: time.Now().Truncate(time.Millisecond).UTC(),
	}
}

func TestRunStore_CreateClaimLifecycle(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewRunStore(db)
	deadline := time.Now().Add(10 * time.Minute)

	run := mkRunFixture("run-1", "u-owner", deadline)
	if err := s.CreateRun(ctx, run); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.CreateRun(ctx, mkRunFixture("run-1", "u-owner", deadline)); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate create: want ErrAlreadyExists, got %v", err)
	}
	if err := s.CreateRun(ctx, &model.Run{ID: "half"}); err == nil {
		t.Fatal("create without owner: want error")
	}

	got, err := s.GetRun(ctx, "run-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.State != model.RunStateQueued || got.Prompt != run.Prompt {
		t.Fatalf("get mismatch: %+v", got)
	}
	if _, err := s.GetRun(ctx, "run-absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get absent: want ErrNotFound, got %v", err)
	}

	queued, err := s.ListQueuedRuns(ctx, "u-owner", 10)
	if err != nil {
		t.Fatalf("queued: %v", err)
	}
	if len(queued) != 1 || queued[0] != "run-1" {
		t.Fatalf("queued: want [run-1], got %v", queued)
	}

	// Claim: META moves queued→acknowledged and the queue row vanishes,
	// atomically.
	lease := time.Now().Add(30 * time.Second)
	claimed := *got
	if err := s.ClaimRun(ctx, &claimed, "runner-1", lease); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if claimed.State != model.RunStateAcknowledged || claimed.RunnerID != "runner-1" {
		t.Fatalf("claim did not mutate run: %+v", claimed)
	}
	queued, err = s.ListQueuedRuns(ctx, "u-owner", 10)
	if err != nil || len(queued) != 0 {
		t.Fatalf("queue after claim: want empty, got %v (%v)", queued, err)
	}
	// The losing racer (still holding the queued snapshot) gets ErrStaleRun.
	loser := *got
	if err := s.ClaimRun(ctx, &loser, "runner-2", lease); !errors.Is(err, ErrStaleRun) {
		t.Fatalf("second claim: want ErrStaleRun, got %v", err)
	}

	// Heartbeat renews only the lease.
	if err := s.RenewRunLease(ctx, "run-1", "runner-1", time.Now().Add(time.Minute)); err != nil {
		t.Fatalf("renew: %v", err)
	}
	// A different runner (reassignment) must not renew.
	if err := s.RenewRunLease(ctx, "run-1", "runner-9", time.Now().Add(time.Minute)); !errors.Is(err, ErrStaleRun) {
		t.Fatalf("renew wrong runner: want ErrStaleRun, got %v", err)
	}

	// Optimistic transition to a NON-terminal state keeps it in ACTIVE_RUNS…
	claimed.State = model.RunStateRunning
	if err := s.UpdateRun(ctx, &claimed, model.RunStateAcknowledged); err != nil {
		t.Fatalf("update to running: %v", err)
	}
	active, err := s.ListActiveRuns(ctx)
	if err != nil || len(active) != 1 {
		t.Fatalf("active: want 1, got %d (%v)", len(active), err)
	}
	// …a stale writer loses…
	staleRun := claimed
	staleRun.State = model.RunStateCompleted
	if err := s.UpdateRun(ctx, &staleRun, model.RunStateAcknowledged); !errors.Is(err, ErrStaleRun) {
		t.Fatalf("stale update: want ErrStaleRun, got %v", err)
	}
	// …and a terminal transition drops it from the index.
	claimed.State = model.RunStateCompleted
	if err := s.UpdateRun(ctx, &claimed, model.RunStateRunning); err != nil {
		t.Fatalf("update to completed: %v", err)
	}
	active, err = s.ListActiveRuns(ctx)
	if err != nil || len(active) != 0 {
		t.Fatalf("active after terminal: want 0, got %d (%v)", len(active), err)
	}
	// Terminal runs also refuse lease renewal.
	if err := s.RenewRunLease(ctx, "run-1", "runner-1", time.Now().Add(time.Minute)); !errors.Is(err, ErrStaleRun) {
		t.Fatalf("renew terminal: want ErrStaleRun, got %v", err)
	}
}

func TestRunStore_DeadlineSweepAndParentList(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewRunStore(db)

	past := mkRunFixture("run-past", "u-o", time.Now().Add(-time.Minute))
	future := mkRunFixture("run-future", "u-o", time.Now().Add(time.Hour))
	if err := s.CreateRun(ctx, past); err != nil {
		t.Fatalf("create past: %v", err)
	}
	if err := s.CreateRun(ctx, future); err != nil {
		t.Fatalf("create future: %v", err)
	}

	overdue, err := s.ListActiveRunsPastDeadline(ctx, time.Now(), 10)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if len(overdue) != 1 || overdue[0].ID != "run-past" {
		t.Fatalf("sweep: want [run-past], got %+v", overdue)
	}

	byParent, err := s.ListRunsByParent(ctx, "ch-1", 10)
	if err != nil {
		t.Fatalf("by parent: %v", err)
	}
	if len(byParent) != 2 {
		t.Fatalf("by parent: want 2, got %d", len(byParent))
	}

	// A queued run failed before any claim: its queue row is swept separately.
	if err := s.DeleteQueueEntry(ctx, "u-o", "run-past"); err != nil {
		t.Fatalf("delete queue entry: %v", err)
	}
	queued, err := s.ListQueuedRuns(ctx, "u-o", 10)
	if err != nil || len(queued) != 1 {
		t.Fatalf("queue after entry delete: want 1, got %v (%v)", queued, err)
	}
}

func TestRunStore_EventsAndDigest(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewRunStore(db)

	if err := s.AppendRunEvent(ctx, &model.RunEvent{Seq: 1}); err == nil {
		t.Fatal("event without runID: want error")
	}
	if err := s.AppendRunEvent(ctx, mkRunEventFixture("run-1", 1)); err != nil {
		t.Fatalf("append 1: %v", err)
	}
	if err := s.AppendRunEvent(ctx, mkRunEventFixture("run-1", 2)); err != nil {
		t.Fatalf("append 2: %v", err)
	}
	// A retried seq is an idempotent no-op, not a duplicate.
	if err := s.AppendRunEvent(ctx, mkRunEventFixture("run-1", 2)); err != nil {
		t.Fatalf("retry append: %v", err)
	}

	evts, err := s.ListRunEvents(ctx, "run-1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(evts) != 2 || evts[0].Seq != 1 || evts[1].Seq != 2 || evts[0].RunID != "run-1" {
		t.Fatalf("list mismatch: %+v", evts)
	}

	if err := s.DeleteRunEvents(ctx, "run-1"); err != nil {
		t.Fatalf("delete events: %v", err)
	}
	evts, err = s.ListRunEvents(ctx, "run-1")
	if err != nil || len(evts) != 0 {
		t.Fatalf("list after delete: want none, got %v (%v)", evts, err)
	}

	d := &model.RunDigest{RunID: "run-1", AgentID: "a-gg", InvokerID: "u-i", Summary: "did the thing", State: model.RunStateCompleted, CreatedAt: time.Now().UTC()}
	if err := s.PutDigest(ctx, d); err != nil {
		t.Fatalf("put digest: %v", err)
	}
	got, err := s.GetDigest(ctx, "run-1")
	if err != nil {
		t.Fatalf("get digest: %v", err)
	}
	if got.Summary != d.Summary || got.RunID != "run-1" {
		t.Fatalf("digest mismatch: %+v", got)
	}
	if _, err := s.GetDigest(ctx, "run-none"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("digest absent: want ErrNotFound, got %v", err)
	}
}

func TestRunStore_SDKErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	deadline := time.Now().Add(time.Hour)

	// Seeds for the ops that need a real row before the fault.
	real := NewRunStore(db)
	seeded := mkRunFixture("run-s", "u-s", deadline)
	if err := real.CreateRun(ctx, seeded); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	if err := real.AppendRunEvent(ctx, mkRunEventFixture("run-s", 1)); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	t.Run("CreateRun TransactError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
		if err := s.CreateRun(ctx, mkRunFixture("run-e", "u-e", deadline)); !errors.Is(err, errInjected) {
			t.Fatalf("CreateRun: want errInjected, got %v", err)
		}
	})
	t.Run("GetRun GetItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetRun(ctx, "run-s"); !errors.Is(err, errInjected) {
			t.Fatalf("GetRun: want errInjected, got %v", err)
		}
	})
	t.Run("UpdateRun PutItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.UpdateRun(ctx, seeded, model.RunStateQueued); !errors.Is(err, errInjected) {
			t.Fatalf("UpdateRun: want errInjected, got %v", err)
		}
	})
	t.Run("RenewRunLease UpdateItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
		if err := s.RenewRunLease(ctx, "run-s", "runner-x", time.Now()); !errors.Is(err, errInjected) {
			t.Fatalf("RenewRunLease: want errInjected, got %v", err)
		}
	})
	t.Run("ListQueuedRuns QueryError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListQueuedRuns(ctx, "u-s", 5); !errors.Is(err, errInjected) {
			t.Fatalf("ListQueuedRuns: want errInjected, got %v", err)
		}
	})
	t.Run("ClaimRun TransactError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
		r := *seeded
		if err := s.ClaimRun(ctx, &r, "runner-x", time.Now()); !errors.Is(err, errInjected) {
			t.Fatalf("ClaimRun: want errInjected, got %v", err)
		}
	})
	t.Run("DeleteQueueEntry DeleteItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		if err := s.DeleteQueueEntry(ctx, "u-s", "run-s"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteQueueEntry: want errInjected, got %v", err)
		}
	})
	t.Run("Sweep and lists QueryError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListActiveRunsPastDeadline(ctx, time.Now(), 5); !errors.Is(err, errInjected) {
			t.Fatalf("ListActiveRunsPastDeadline: want errInjected, got %v", err)
		}
		if _, err := s.ListActiveRuns(ctx); !errors.Is(err, errInjected) {
			t.Fatalf("ListActiveRuns: want errInjected, got %v", err)
		}
		if _, err := s.ListRunsByParent(ctx, "ch-1", 5); !errors.Is(err, errInjected) {
			t.Fatalf("ListRunsByParent: want errInjected, got %v", err)
		}
		if _, err := s.ListRunEvents(ctx, "run-s"); !errors.Is(err, errInjected) {
			t.Fatalf("ListRunEvents: want errInjected, got %v", err)
		}
		if err := s.DeleteRunEvents(ctx, "run-s"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteRunEvents query: want errInjected, got %v", err)
		}
	})
	t.Run("AppendRunEvent PutItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.AppendRunEvent(ctx, mkRunEventFixture("run-s", 9)); !errors.Is(err, errInjected) {
			t.Fatalf("AppendRunEvent: want errInjected, got %v", err)
		}
	})
	t.Run("DeleteRunEvents per-row DeleteItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
		if err := s.DeleteRunEvents(ctx, "run-s"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteRunEvents delete: want errInjected, got %v", err)
		}
	})
	t.Run("PutDigest PutItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.PutDigest(ctx, &model.RunDigest{RunID: "run-s"}); !errors.Is(err, errInjected) {
			t.Fatalf("PutDigest: want errInjected, got %v", err)
		}
	})
	t.Run("GetDigest GetItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetDigest(ctx, "run-s"); !errors.Is(err, errInjected) {
			t.Fatalf("GetDigest: want errInjected, got %v", err)
		}
	})
}

func TestRunStore_CorruptRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	corruptQ := func(f *faultClient) {
		f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
			o.Items = []map[string]types.AttributeValue{corruptRow()}
			return o
		}
	}
	corruptG := func(f *faultClient) { f.transformGetItem = corruptGetItem }

	t.Run("GetRun", func(t *testing.T) {
		_, err := NewRunStore(withFault(db, corruptG)).GetRun(ctx, "run-x")
		assertUnmarshalErr(t, err, "GetRun")
	})
	t.Run("GetDigest", func(t *testing.T) {
		_, err := NewRunStore(withFault(db, corruptG)).GetDigest(ctx, "run-x")
		assertUnmarshalErr(t, err, "GetDigest")
	})
	t.Run("ListQueuedRuns", func(t *testing.T) {
		_, err := NewRunStore(withFault(db, corruptQ)).ListQueuedRuns(ctx, "u-x", 5)
		assertUnmarshalErr(t, err, "ListQueuedRuns")
	})
	t.Run("ListActiveRunsPastDeadline", func(t *testing.T) {
		_, err := NewRunStore(withFault(db, corruptQ)).ListActiveRunsPastDeadline(ctx, time.Now(), 5)
		assertUnmarshalErr(t, err, "ListActiveRunsPastDeadline")
	})
	t.Run("ListActiveRuns", func(t *testing.T) {
		_, err := NewRunStore(withFault(db, corruptQ)).ListActiveRuns(ctx)
		assertUnmarshalErr(t, err, "ListActiveRuns")
	})
	t.Run("ListRunsByParent", func(t *testing.T) {
		_, err := NewRunStore(withFault(db, corruptQ)).ListRunsByParent(ctx, "ch-x", 5)
		assertUnmarshalErr(t, err, "ListRunsByParent")
	})
	t.Run("ListRunEvents", func(t *testing.T) {
		_, err := NewRunStore(withFault(db, corruptQ)).ListRunEvents(ctx, "run-x")
		assertUnmarshalErr(t, err, "ListRunEvents")
	})
	t.Run("DeleteRunEvents skips unreadable rows", func(t *testing.T) {
		// A corrupt EVT row can't key a delete — the loop skips it and the
		// call still succeeds.
		if err := NewRunStore(withFault(db, corruptQ)).DeleteRunEvents(ctx, "run-x"); err != nil {
			t.Fatalf("DeleteRunEvents corrupt skip: %v", err)
		}
	})
}
