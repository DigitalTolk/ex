package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
)

// MobilePushScheduler durably schedules a mobile push for delivery after a
// delay (0 = as soon as a worker picks it up). The scheduled task must
// survive a process restart: the 30s ack-fallback window regularly spans a
// rolling deploy, and the previous in-memory time.Timer design silently
// dropped every pending fallback push on shutdown — an opted-in alert lost,
// which the notification contract forbids. asynq persists the task in Redis,
// so any instance's worker (including a freshly deployed one) delivers it.
type MobilePushScheduler interface {
	SchedulePush(ctx context.Context, recipientUserID string, n Notification, delay time.Duration) error
}

// TaskTypeMobilePush is the asynq task type for a (possibly deferred) mobile
// push. One task = one recipient × one notification.
const TaskTypeMobilePush = "push:mobile"

// pushMaxRetry bounds provider-level redelivery attempts of a single task
// (the OneSignal sender additionally does 3 fast sub-second retries per
// attempt for momentary blips). Exhausted tasks land in asynq's archive —
// a dead-letter queue, never a silent drop.
const pushMaxRetry = 5

// pushTaskRetention keeps completed tasks (and their TaskIDs) around so a
// duplicate NotifyForMessage for the same message cannot double-push within
// the retention window: the TaskID uniqueness check spans retained tasks.
const pushTaskRetention = time.Hour

// pushTaskTimeout caps a single handler run; the provider HTTP client
// times out far earlier, this is the backstop that frees a stuck worker.
const pushTaskTimeout = 30 * time.Second

// mobilePushTaskPayload is the serialized task body. The full notification
// rides along so the worker needs no store reads at delivery time.
type mobilePushTaskPayload struct {
	RecipientUserID string       `json:"recipientUserID"`
	Notification    Notification `json:"notification"`
}

// mobilePushTaskID makes scheduling idempotent per (message, recipient):
// asynq rejects a second enqueue with the same TaskID while the first task
// is pending, scheduled, active, or retained.
func mobilePushTaskID(recipientUserID, messageID string) string {
	return "push:" + messageID + ":" + recipientUserID
}

// AsynqPushScheduler is the production MobilePushScheduler: it enqueues
// Redis-backed asynq tasks, deferred via ProcessIn for the ack-fallback path.
type AsynqPushScheduler struct {
	client *asynq.Client
}

// NewAsynqPushScheduler wraps an existing go-redis client (built through
// redisx.Options like every other Redis client in the app).
func NewAsynqPushScheduler(rdb redis.UniversalClient) *AsynqPushScheduler {
	return &AsynqPushScheduler{client: asynq.NewClientFromRedisClient(rdb)}
}

func (s *AsynqPushScheduler) SchedulePush(ctx context.Context, recipientUserID string, n Notification, delay time.Duration) error {
	payload := mustJSONBody(json.Marshal(mobilePushTaskPayload{RecipientUserID: recipientUserID, Notification: n}))
	opts := []asynq.Option{
		asynq.MaxRetry(pushMaxRetry),
		asynq.Retention(pushTaskRetention),
		asynq.Timeout(pushTaskTimeout),
	}
	if n.MessageID != "" {
		opts = append(opts, asynq.TaskID(mobilePushTaskID(recipientUserID, n.MessageID)))
	}
	if delay > 0 {
		opts = append(opts, asynq.ProcessIn(delay))
	}
	if _, err := s.client.EnqueueContext(ctx, asynq.NewTask(TaskTypeMobilePush, payload), opts...); err != nil {
		if errors.Is(err, asynq.ErrTaskIDConflict) {
			// Already queued/retained for this message+recipient (an upstream
			// double-publish) — the first task owns delivery.
			return nil
		}
		return fmt.Errorf("push scheduler: enqueue: %w", err)
	}
	return nil
}

// Close releases the scheduler's asynq client. It does NOT touch the shared
// redis connection it was built on — the caller owns that.
func (s *AsynqPushScheduler) Close() error { return s.client.Close() }

// NewMobilePushTaskHandler builds the worker-side handler that runs when a
// scheduled push comes due. The ack check happens HERE, at delivery time —
// not at schedule time — so a desktop that acked any moment before the task
// runs still stands the push down, across instances (the ack marker is
// Redis-backed).
//
// NO presence re-check here — deliberately (see the 2026-07-08 incident):
// every task carries its verdict from schedule time; the deferred path exists
// precisely for the "socket alive but user absent" case, and a delivery-time
// presence gate silently swallowed every alert for an idle-but-open desktop.
// Duplicates are the accepted failure direction.
func NewMobilePushTaskHandler(ack NotificationAckStore, provider MobilePushSender) func(context.Context, *asynq.Task) error {
	return func(ctx context.Context, t *asynq.Task) error {
		var p mobilePushTaskPayload
		if err := json.Unmarshal(t.Payload(), &p); err != nil {
			// A malformed payload can never succeed — archive it, don't retry.
			return fmt.Errorf("mobile push payload unmarshal: %v: %w", err, asynq.SkipRetry)
		}
		if ack != nil && p.Notification.MessageID != "" && ack.WasNotificationAcked(ctx, p.RecipientUserID, p.Notification.MessageID) {
			// Desktop confirmed delivery — no push needed.
			return nil
		}
		if err := provider.Send(ctx, p.RecipientUserID, p.Notification); err != nil {
			if errors.Is(err, ErrPushUndeliverable) {
				// The offline/no-ack fallback produced NO alert for this
				// recipient (no registered device / provider rejected the
				// target). Retrying cannot fix it — log LOUDLY and archive.
				slog.Error("mobile push undeliverable — recipient unreachable, alert not delivered",
					"userID", p.RecipientUserID,
					"parentID", p.Notification.ParentID,
					"messageID", p.Notification.MessageID,
					"kind", p.Notification.Kind,
					"error", err,
				)
				return fmt.Errorf("%v: %w", err, asynq.SkipRetry)
			}
			// Transient (network / 5xx after the provider's own fast retries):
			// return the error so asynq redelivers on the push retry curve.
			slog.Warn("mobile push attempt failed; task will retry",
				"userID", p.RecipientUserID,
				"messageID", p.Notification.MessageID,
				"error", err,
			)
			return err
		}
		return nil
	}
}

// pushRetryDelay is the asynq retry curve for transient push failures:
// 2s, 4s, 8s, 16s, then capped at 30s. Alert pushes are time-sensitive, so
// this is much tighter than asynq's default minutes-scale curve; the
// provider's own sub-second retries already absorbed momentary blips.
func pushRetryDelay(n int, _ error, _ *asynq.Task) time.Duration {
	return min(time.Duration(1<<uint(min(n, 5)))*time.Second, 30*time.Second)
}

// asynqSlogLogger routes asynq's internal logging into the app's slog.
type asynqSlogLogger struct{}

func (asynqSlogLogger) Debug(args ...any) { slog.Debug(fmt.Sprint(args...)) }
func (asynqSlogLogger) Info(args ...any)  { slog.Info(fmt.Sprint(args...)) }
func (asynqSlogLogger) Warn(args ...any)  { slog.Warn(fmt.Sprint(args...)) }
func (asynqSlogLogger) Error(args ...any) { slog.Error(fmt.Sprint(args...)) }
func (asynqSlogLogger) Fatal(args ...any) { slog.Error(fmt.Sprint(args...)) }

// AsynqPushWorkerConfig tunes the worker; zero values take asynq defaults
// (tests shrink DelayedTaskCheckInterval so deferred tasks come due fast).
type AsynqPushWorkerConfig struct {
	Concurrency              int
	DelayedTaskCheckInterval time.Duration
	ShutdownTimeout          time.Duration
}

// defaultPushWorkerConcurrency replaces the old hardcoded 4-goroutine pool.
// Overridable via PUSH_WORKER_CONCURRENCY (see config).
const defaultPushWorkerConcurrency = 8

// AsynqPushWorker runs the delivery side of the push pipeline. Where the old
// in-memory channel dropped queued jobs on Close, Shutdown here waits for
// in-flight tasks (up to ShutdownTimeout) and REQUEUES the rest in Redis for
// the next instance — a deploy can no longer lose a push.
type AsynqPushWorker struct {
	srv     *asynq.Server
	handler func(context.Context, *asynq.Task) error
}

func NewAsynqPushWorker(rdb redis.UniversalClient, handler func(context.Context, *asynq.Task) error, cfg AsynqPushWorkerConfig) *AsynqPushWorker {
	conc := cfg.Concurrency
	if conc <= 0 {
		conc = defaultPushWorkerConcurrency
	}
	srv := asynq.NewServerFromRedisClient(rdb, asynq.Config{
		Concurrency:              conc,
		RetryDelayFunc:           pushRetryDelay,
		Logger:                   asynqSlogLogger{},
		LogLevel:                 asynq.WarnLevel,
		DelayedTaskCheckInterval: cfg.DelayedTaskCheckInterval,
		ShutdownTimeout:          cfg.ShutdownTimeout,
	})
	return &AsynqPushWorker{srv: srv, handler: handler}
}

// Start launches the worker's processing loops (non-blocking).
func (w *AsynqPushWorker) Start() error {
	mux := asynq.NewServeMux()
	mux.HandleFunc(TaskTypeMobilePush, w.handler)
	return w.srv.Start(mux)
}

// Shutdown drains in-flight tasks (bounded by ShutdownTimeout) and requeues
// everything else; scheduled tasks stay in Redis untouched.
func (w *AsynqPushWorker) Shutdown() { w.srv.Shutdown() }
