package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"testing"
	"time"

	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
)

func mobilePushTask(t *testing.T, userID string, n Notification) *asynq.Task {
	t.Helper()
	payload := mustJSONBody(json.Marshal(mobilePushTaskPayload{RecipientUserID: userID, Notification: n}))
	return asynq.NewTask(TaskTypeMobilePush, payload)
}

// The 2026-07-08 incident contract, restated for the asynq worker: the
// handler must NOT re-check presence at delivery time — the task carries its
// verdict. Structurally, NewMobilePushTaskHandler cannot even reach a
// presence lookup (it receives only the ack store and the provider), so this
// test pins the delivery path: no ack recorded → provider is called even
// though the recipient was "online" when the deferred task was scheduled.
func TestMobilePushTaskHandler_NoAck_DeliversToProvider(t *testing.T) {
	provider := &recordingMobilePush{}
	h := NewMobilePushTaskHandler(&stubAckStore{acked: map[string]bool{}}, provider)

	notif := Notification{Kind: NotificationKindMessage, Title: "Alice", Body: "incident!", MessageID: "m1"}
	if err := h(context.Background(), mobilePushTask(t, "u-bob", notif)); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(provider.calls) != 1 || provider.calls[0].userID != "u-bob" {
		t.Fatalf("provider calls = %+v, want one for u-bob", provider.calls)
	}
	if provider.calls[0].notif.MessageID != "m1" {
		t.Fatalf("notification payload lost in transit: %+v", provider.calls[0].notif)
	}
}

// Desktop acked before the task came due → the push stands down.
func TestMobilePushTaskHandler_Acked_SuppressesPush(t *testing.T) {
	provider := &recordingMobilePush{}
	h := NewMobilePushTaskHandler(&stubAckStore{acked: map[string]bool{"u-bob:m1": true}}, provider)

	notif := Notification{Kind: NotificationKindMessage, MessageID: "m1"}
	if err := h(context.Background(), mobilePushTask(t, "u-bob", notif)); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(provider.calls) != 0 {
		t.Fatalf("acked push must be suppressed, provider calls = %+v", provider.calls)
	}
}

// Without an ack store (or without a messageID to key on) the handler
// delivers — fail toward the audible alert.
func TestMobilePushTaskHandler_NoAckStoreOrNoMessageID_Delivers(t *testing.T) {
	provider := &recordingMobilePush{}
	h := NewMobilePushTaskHandler(nil, provider)
	if err := h(context.Background(), mobilePushTask(t, "u-1", Notification{MessageID: "m1"})); err != nil {
		t.Fatalf("nil ack store: %v", err)
	}

	h2 := NewMobilePushTaskHandler(&stubAckStore{acked: map[string]bool{}}, provider)
	if err := h2(context.Background(), mobilePushTask(t, "u-2", Notification{})); err != nil {
		t.Fatalf("empty messageID: %v", err)
	}
	if len(provider.calls) != 2 {
		t.Fatalf("provider calls = %d, want 2", len(provider.calls))
	}
}

// An undeliverable push (provider 4xx / accepted-but-no-target) is archived,
// not retried: the error carries asynq.SkipRetry.
func TestMobilePushTaskHandler_Undeliverable_SkipsRetry(t *testing.T) {
	provider := &recordingMobilePush{err: fmt.Errorf("status 400: %w", ErrPushUndeliverable)}
	h := NewMobilePushTaskHandler(&stubAckStore{acked: map[string]bool{}}, provider)

	err := h(context.Background(), mobilePushTask(t, "u-bob", Notification{MessageID: "m1"}))
	if !errors.Is(err, asynq.SkipRetry) {
		t.Fatalf("undeliverable must wrap asynq.SkipRetry, got %v", err)
	}
}

// A transient provider failure is returned as-is so asynq redelivers.
func TestMobilePushTaskHandler_TransientError_Retries(t *testing.T) {
	provider := &recordingMobilePush{err: errors.New("onesignal: request failed with status 502")}
	h := NewMobilePushTaskHandler(&stubAckStore{acked: map[string]bool{}}, provider)

	err := h(context.Background(), mobilePushTask(t, "u-bob", Notification{MessageID: "m1"}))
	if err == nil || errors.Is(err, asynq.SkipRetry) {
		t.Fatalf("transient failure must be retryable, got %v", err)
	}
}

// A malformed payload can never succeed — archived, never retried.
func TestMobilePushTaskHandler_MalformedPayload_SkipsRetry(t *testing.T) {
	provider := &recordingMobilePush{}
	h := NewMobilePushTaskHandler(nil, provider)

	err := h(context.Background(), asynq.NewTask(TaskTypeMobilePush, []byte("{not json")))
	if !errors.Is(err, asynq.SkipRetry) {
		t.Fatalf("malformed payload must wrap asynq.SkipRetry, got %v", err)
	}
	if len(provider.calls) != 0 {
		t.Fatalf("malformed payload must not reach the provider")
	}
}

func TestMobilePushTaskID(t *testing.T) {
	if got := mobilePushTaskID("u-1", "m-9"); got != "push:m-9:u-1" {
		t.Fatalf("task id = %q", got)
	}
}

// The retry curve is tight (alert pushes are time-sensitive) and capped.
func TestPushRetryDelayCurve(t *testing.T) {
	want := map[int]time.Duration{
		1: 2 * time.Second,
		2: 4 * time.Second,
		3: 8 * time.Second,
		4: 16 * time.Second,
		5: 30 * time.Second, // 32s capped
		9: 30 * time.Second, // shift clamped, still capped
	}
	for n, d := range want {
		if got := pushRetryDelay(n, nil, nil); got != d {
			t.Errorf("pushRetryDelay(%d) = %v, want %v", n, got, d)
		}
	}
}

// The slog adapter must accept every asynq log level without panicking (Fatal
// maps to Error — the app never lets a queue library kill the process).
func TestAsynqSlogLogger(t *testing.T) {
	orig := slog.Default()
	t.Cleanup(func() { slog.SetDefault(orig) })
	l := asynqSlogLogger{}
	l.Debug("d", 1)
	l.Info("i", 2)
	l.Warn("w", 3)
	l.Error("e", 4)
	l.Fatal("f", 5)
}

// A non-conflict enqueue failure (Redis unreachable) must surface — the
// caller logs it loudly as a potentially lost alert.
func TestAsynqPushScheduler_EnqueueErrorSurfaces(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 50 * time.Millisecond, MaxRetries: -1})
	t.Cleanup(func() { _ = rdb.Close() })
	sched := NewAsynqPushScheduler(rdb)
	t.Cleanup(func() { _ = sched.Close() })

	err := sched.SchedulePush(context.Background(), "u-1", Notification{MessageID: "m1"}, 0)
	if err == nil || errors.Is(err, asynq.ErrTaskIDConflict) {
		t.Fatalf("unreachable redis must surface an enqueue error, got %v", err)
	}
}

// Zero-value worker config takes the service defaults (concurrency).
func TestNewAsynqPushWorker_DefaultConcurrency(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	t.Cleanup(func() { _ = rdb.Close() })
	if w := NewAsynqPushWorker(rdb, func(context.Context, *asynq.Task) error { return nil }, AsynqPushWorkerConfig{}); w == nil {
		t.Fatal("worker must construct with default config")
	}
}
