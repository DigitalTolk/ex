//go:build integration

package store

import (
	"context"
	"errors"
	"strings"
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
	t.Run("DeleteRunEvents BatchWriteItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failBatchWriteItem = true }))
		if err := s.DeleteRunEvents(ctx, "run-s"); !errors.Is(err, errInjected) {
			t.Fatalf("DeleteRunEvents batch delete: want errInjected, got %v", err)
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
	// DeleteRunEvents decodes nothing (its query projects KEYS ONLY), so it has
	// no corrupt-row arm; its batching is covered in
	// TestRunStore_DeleteRunEventsBatches.
}

// DeleteRunEvents deletes in batches of 25 with an UnprocessedItems drain: a
// task-mode timeline is turn-uncapped, so "a handful of rows" is not a bound.
func TestRunStore_DeleteRunEventsBatches(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewRunStore(db)
	// 60 rows → three batches, the last one partial.
	for i := 1; i <= 60; i++ {
		if err := s.AppendRunEvent(ctx, &model.RunEvent{RunID: "run-many", Seq: int64(i), Type: "turn"}); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	if evts, err := s.ListRunEvents(ctx, "run-many"); err != nil || len(evts) != 60 {
		t.Fatalf("seeded %d events (err %v), want 60", len(evts), err)
	}
	if err := s.DeleteRunEvents(ctx, "run-many"); err != nil {
		t.Fatalf("DeleteRunEvents: %v", err)
	}
	if evts, err := s.ListRunEvents(ctx, "run-many"); err != nil || len(evts) != 0 {
		t.Fatalf("after delete: %d events (err %v), want 0", len(evts), err)
	}
}

// A batch DynamoDB reports as unprocessed is retried, and an endlessly
// unprocessed batch fails loudly rather than silently leaving rows behind.
func TestRunStore_DeleteRunEventsUnprocessed(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	seed := func(runID string) {
		if err := NewRunStore(db).AppendRunEvent(ctx, &model.RunEvent{RunID: runID, Seq: 1, Type: "turn"}); err != nil {
			t.Fatalf("append: %v", err)
		}
	}

	seed("run-unp1")
	retryOnce := &unprocessedClient{DynamoAPI: db.Client, table: db.Table, remaining: 1}
	if err := NewRunStore(&DB{Client: retryOnce, Table: db.Table}).DeleteRunEvents(ctx, "run-unp1"); err != nil {
		t.Fatalf("retry then succeed: %v", err)
	}

	seed("run-unp2")
	never := &unprocessedClient{DynamoAPI: db.Client, table: db.Table, remaining: 99}
	err := NewRunStore(&DB{Client: never, Table: db.Table}).DeleteRunEvents(ctx, "run-unp2")
	if err == nil || !strings.Contains(err.Error(), "unprocessed after retries") {
		t.Fatalf("exhausted retries must fail loudly, got %v", err)
	}
}

// AddRunSpend/AddRunPosts are the ATOMIC counter writers: they apply deltas to
// the committed row rather than rewriting it from a caller snapshot, so two
// writers that observed the same state cannot revert each other.
func TestRunStore_AtomicCounters(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewRunStore(db)

	run := mkRunFixture("run-atomic", "u-1", time.Now().Add(time.Hour))
	if err := s.CreateRun(ctx, run); err != nil {
		t.Fatalf("create: %v", err)
	}
	lease := time.Now().Add(time.Minute).UTC().Truncate(time.Millisecond)
	if err := s.ClaimRun(ctx, run, "r-1", lease); err != nil {
		t.Fatalf("claim: %v", err)
	}

	// A batch's deltas, a state move, a rolling-deadline extension and a lease
	// renewal all ride one update.
	newDeadline := time.Now().Add(2 * time.Hour).UTC().Truncate(time.Millisecond)
	newLease := time.Now().Add(5 * time.Minute).UTC().Truncate(time.Millisecond)
	got, err := s.AddRunSpend(ctx, run.ID, "r-1", RunSpendDelta{
		Turns: 2, InputTokens: 30, OutputTokens: 40, LastRunnerSeq: 7,
		State: model.RunStateRunning, Deadline: newDeadline, Lease: newLease,
	})
	if err != nil {
		t.Fatalf("add spend: %v", err)
	}
	if got.Spend.Turns != 2 || got.Spend.InputTokens != 30 || got.Spend.OutputTokens != 40 {
		t.Fatalf("committed spend = %+v", got.Spend)
	}
	if got.LastRunnerSeq != 7 || got.State != model.RunStateRunning {
		t.Fatalf("committed seq/state = %d/%s", got.LastRunnerSeq, got.State)
	}
	if !got.Deadline.Equal(newDeadline) || got.LeaseExpiresAt == nil || !got.LeaseExpiresAt.Equal(newLease) {
		t.Fatalf("committed deadline/lease = %v / %v", got.Deadline, got.LeaseExpiresAt)
	}

	// A post bump lands on top WITHOUT touching the turn counters, and a
	// second spend batch adds to what is already committed.
	posted, err := s.AddRunPosts(ctx, run.ID, 1)
	if err != nil {
		t.Fatalf("add posts: %v", err)
	}
	if posted.Spend.Posts != 1 || posted.Spend.Turns != 2 {
		t.Fatalf("post bump clobbered the ledger: %+v", posted.Spend)
	}
	again, err := s.AddRunSpend(ctx, run.ID, "r-1", RunSpendDelta{Turns: 1, LastRunnerSeq: 9})
	if err != nil {
		t.Fatalf("add spend 2: %v", err)
	}
	if again.Spend.Turns != 3 || again.Spend.Posts != 1 {
		t.Fatalf("second batch did not accumulate: %+v", again.Spend)
	}

	// Another runner is refused; so is a terminal run.
	if _, err := s.AddRunSpend(ctx, run.ID, "r-evil", RunSpendDelta{Turns: 1}); !errors.Is(err, ErrStaleRun) {
		t.Fatalf("foreign runner: want ErrStaleRun, got %v", err)
	}
	done := *again
	done.State = model.RunStateCompleted
	if err := s.UpdateRun(ctx, &done, model.RunStateRunning); err != nil {
		t.Fatalf("terminalize: %v", err)
	}
	if _, err := s.AddRunSpend(ctx, run.ID, "r-1", RunSpendDelta{Turns: 1}); !errors.Is(err, ErrStaleRun) {
		t.Fatalf("terminal run: want ErrStaleRun, got %v", err)
	}
	if _, err := s.AddRunPosts(ctx, run.ID, 1); !errors.Is(err, ErrStaleRun) {
		t.Fatalf("terminal post bump: want ErrStaleRun, got %v", err)
	}
}

func TestRunStore_AtomicCountersErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("UpdateItemError", func(t *testing.T) {
		s := NewRunStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
		if _, err := s.AddRunSpend(ctx, "run-e", "r-1", RunSpendDelta{}); !errors.Is(err, errInjected) {
			t.Fatalf("AddRunSpend: want errInjected, got %v", err)
		}
		if _, err := s.AddRunPosts(ctx, "run-e", 1); !errors.Is(err, errInjected) {
			t.Fatalf("AddRunPosts: want errInjected, got %v", err)
		}
	})
	t.Run("corrupt returned row", func(t *testing.T) {
		run := mkRunFixture("run-corrupt", "u-1", time.Now().Add(time.Hour))
		if err := NewRunStore(db).CreateRun(ctx, run); err != nil {
			t.Fatalf("create: %v", err)
		}
		if err := NewRunStore(db).ClaimRun(ctx, run, "r-1", time.Now().Add(time.Minute)); err != nil {
			t.Fatalf("claim: %v", err)
		}
		faulted := withFault(db, func(f *faultClient) {
			f.transformUpdateItem = func(o *dynamodb.UpdateItemOutput) *dynamodb.UpdateItemOutput {
				o.Attributes = corruptRow()
				return o
			}
		})
		_, err := NewRunStore(faulted).AddRunSpend(ctx, run.ID, "r-1", RunSpendDelta{Turns: 1})
		assertUnmarshalErr(t, err, "AddRunSpend")
	})
}
