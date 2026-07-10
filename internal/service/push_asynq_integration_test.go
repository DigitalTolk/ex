//go:build integration

package service

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/redis/go-redis/v9"
)

// These tests run the REAL asynq pipeline (scheduler → Redis → worker →
// provider) against the package's shared Redis container. They pin the two
// durability properties the old in-memory design lost:
//   1. a scheduled (deferred) push survives a worker restart — the deploy
//      case that silently dropped every pending ack-fallback push;
//   2. TaskID dedup collapses duplicate schedules of the same message.

// pushSignalProvider is a chan-based MobilePushSender so tests can wait on
// delivery (or prove its absence) deterministically.
type pushSignalProvider struct {
	mu   sync.Mutex
	sent chan string
}

func (p *pushSignalProvider) Send(_ context.Context, recipientUserID string, _ Notification) error {
	p.sent <- recipientUserID
	return nil
}

func newAsynqHarness(t *testing.T, ack NotificationAckStore) (*AsynqPushScheduler, *pushSignalProvider, func() *AsynqPushWorker) {
	t.Helper()
	if !serviceRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	opts, err := redisx.Options("redis://" + serviceRedisAddr)
	if err != nil {
		t.Fatalf("redis options: %v", err)
	}
	rdb := redis.NewClient(opts)
	t.Cleanup(func() { _ = rdb.Close() })
	if err := rdb.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	sched := NewAsynqPushScheduler(rdb)
	t.Cleanup(func() { _ = sched.Close() })
	provider := &pushSignalProvider{sent: make(chan string, 16)}
	// startWorker builds a fresh worker each call — the restart tests need a
	// second instance after shutting the first down. Tight check interval so
	// deferred tasks come due in test time.
	startWorker := func() *AsynqPushWorker {
		w := NewAsynqPushWorker(rdb, NewMobilePushTaskHandler(ack, provider), AsynqPushWorkerConfig{
			Concurrency:              2,
			DelayedTaskCheckInterval: 50 * time.Millisecond,
			ShutdownTimeout:          2 * time.Second,
		})
		if err := w.Start(); err != nil {
			t.Fatalf("worker start: %v", err)
		}
		return w
	}
	return sched, provider, startWorker
}

func waitForPush(t *testing.T, provider *pushSignalProvider, want string, timeout time.Duration) {
	t.Helper()
	select {
	case uid := <-provider.sent:
		if uid != want {
			t.Fatalf("push delivered to %q, want %q", uid, want)
		}
	case <-time.After(timeout):
		t.Fatalf("push for %q never delivered", want)
	}
}

func assertNoPush(t *testing.T, provider *pushSignalProvider, within time.Duration) {
	t.Helper()
	select {
	case uid := <-provider.sent:
		t.Fatalf("unexpected push delivered to %q", uid)
	case <-time.After(within):
	}
}

func TestAsynqPush_ImmediateDelivery(t *testing.T) {
	sched, provider, startWorker := newAsynqHarness(t, &stubAckStore{acked: map[string]bool{}})
	w := startWorker()
	defer w.Shutdown()

	notif := Notification{Kind: NotificationKindMessage, Title: "Alice", MessageID: "m-imm"}
	if err := sched.SchedulePush(context.Background(), "u-bob", notif, 0); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	waitForPush(t, provider, "u-bob", 5*time.Second)
}

func TestAsynqPush_DeferredDelivery_FiresWithoutAck(t *testing.T) {
	sched, provider, startWorker := newAsynqHarness(t, &stubAckStore{acked: map[string]bool{}})
	w := startWorker()
	defer w.Shutdown()

	notif := Notification{Kind: NotificationKindMessage, MessageID: "m-def"}
	if err := sched.SchedulePush(context.Background(), "u-bob", notif, 300*time.Millisecond); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	// Not due yet — nothing may fire early.
	assertNoPush(t, provider, 150*time.Millisecond)
	waitForPush(t, provider, "u-bob", 10*time.Second)
}

func TestAsynqPush_DeferredDelivery_AckSuppresses(t *testing.T) {
	// The ack lands while the task is scheduled; the worker must read it at
	// delivery time and stand down.
	sched, provider, startWorker := newAsynqHarness(t, &stubAckStore{acked: map[string]bool{"u-bob:m-ack": true}})
	w := startWorker()
	defer w.Shutdown()

	notif := Notification{Kind: NotificationKindMessage, MessageID: "m-ack"}
	if err := sched.SchedulePush(context.Background(), "u-bob", notif, 200*time.Millisecond); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	assertNoPush(t, provider, 1500*time.Millisecond)
}

// THE deploy-survival regression (old design: in-memory time.Timer dropped on
// shutdown → every pending ack-fallback push lost on every deploy). Now the
// task lives in Redis: worker one shuts down BEFORE the task is due, worker
// two (the "new deploy") delivers it.
func TestAsynqPush_DeferredTaskSurvivesWorkerRestart(t *testing.T) {
	sched, provider, startWorker := newAsynqHarness(t, &stubAckStore{acked: map[string]bool{}})

	w1 := startWorker()
	notif := Notification{Kind: NotificationKindMessage, Title: "incident", MessageID: "m-deploy"}
	if err := sched.SchedulePush(context.Background(), "u-bob", notif, 500*time.Millisecond); err != nil {
		t.Fatalf("schedule: %v", err)
	}
	w1.Shutdown() // deploy begins: old instance gone before the push is due
	assertNoPush(t, provider, 100*time.Millisecond)

	w2 := startWorker() // new instance comes up
	defer w2.Shutdown()
	waitForPush(t, provider, "u-bob", 10*time.Second)
}

// TaskID dedup: duplicate schedules of the same (message, recipient) collapse
// to one delivery, whether the duplicate arrives before or after completion
// (retention keeps the ID reserved).
func TestAsynqPush_DuplicateScheduleDedups(t *testing.T) {
	sched, provider, startWorker := newAsynqHarness(t, &stubAckStore{acked: map[string]bool{}})

	notif := Notification{Kind: NotificationKindMessage, MessageID: "m-dup"}
	// Both enqueued before any worker runs, so the second is a guaranteed
	// TaskID conflict — and SchedulePush must swallow it as a no-op.
	if err := sched.SchedulePush(context.Background(), "u-bob", notif, 200*time.Millisecond); err != nil {
		t.Fatalf("schedule #1: %v", err)
	}
	if err := sched.SchedulePush(context.Background(), "u-bob", notif, 200*time.Millisecond); err != nil {
		t.Fatalf("duplicate schedule must be a no-op, got %v", err)
	}

	w := startWorker()
	defer w.Shutdown()
	waitForPush(t, provider, "u-bob", 10*time.Second)
	// Retention keeps the completed task's ID reserved: a late re-publish of
	// the same message still cannot double-push.
	if err := sched.SchedulePush(context.Background(), "u-bob", notif, 0); err != nil {
		t.Fatalf("post-completion duplicate schedule must be a no-op, got %v", err)
	}
	assertNoPush(t, provider, 1200*time.Millisecond)
}
