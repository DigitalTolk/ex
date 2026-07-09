package service

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/DigitalTolk/ex/internal/safe"
)

const (
	defaultMobilePushQueueSize = 1024
	defaultMobilePushWorkers   = 4
)

var errMobilePushQueueFull = errors.New("mobile push queue full")

type mobilePushJob struct {
	recipientUserID string
	notification    Notification
}

// AsyncMobilePushSender keeps external push delivery off the message-send
// path. The notification service has already decided who should receive a
// notification; this wrapper only bounds provider work and drops excess jobs
// instead of letting OneSignal latency stall message delivery.
type AsyncMobilePushSender struct {
	inner  MobilePushSender
	queue  chan mobilePushJob
	ctx    context.Context
	cancel context.CancelFunc

	closeOnce sync.Once
	wg        sync.WaitGroup
}

func NewAsyncMobilePushSender(inner MobilePushSender, queueSize, workers int) *AsyncMobilePushSender {
	if inner == nil {
		return nil
	}
	if queueSize <= 0 {
		queueSize = defaultMobilePushQueueSize
	}
	if workers <= 0 {
		workers = defaultMobilePushWorkers
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &AsyncMobilePushSender{
		inner:  inner,
		queue:  make(chan mobilePushJob, queueSize),
		ctx:    ctx,
		cancel: cancel,
	}
	s.wg.Add(workers)
	for range workers {
		go s.worker()
	}
	return s
}

func (s *AsyncMobilePushSender) Send(ctx context.Context, recipientUserID string, n Notification) error {
	if s == nil || s.inner == nil {
		return nil
	}
	job := mobilePushJob{recipientUserID: recipientUserID, notification: n}
	// Deterministic precedence: caller cancellation, then sender shutdown,
	// then a non-blocking enqueue. (An all-in-one select picks randomly when
	// several cases are ready — e.g. cancelled ctx + full queue — which made
	// the outcome, and the individual arms, nondeterministic.)
	if err := ctx.Err(); err != nil {
		return err
	}
	if s.ctx.Err() != nil {
		return nil
	}
	select {
	case s.queue <- job:
		return nil
	default:
		return errMobilePushQueueFull
	}
}

func (s *AsyncMobilePushSender) Close() {
	if s == nil {
		return
	}
	s.closeOnce.Do(func() {
		s.cancel()
		s.wg.Wait()
	})
}

func (s *AsyncMobilePushSender) worker() {
	defer s.wg.Done()
	// A panic in a push Send must not crash the process (and with it every WS
	// client on this instance); recover and let the worker exit cleanly.
	defer safe.Recover()
	for {
		select {
		case <-s.ctx.Done():
			return
		case job := <-s.queue:
			// NO presence re-check here — deliberately. Every job in this queue
			// already carries its delivery verdict: the offline-immediate path
			// enqueued because nothing could ack, and the deferred ack-fallback
			// path enqueued because the desktop did NOT ack within the window —
			// which is precisely the "socket alive but user absent" case the
			// fallback exists for. A delivery-time IsOnline skip silently
			// swallowed every alert for an idle-but-open desktop (presence
			// online for hours, zero pushes): the exact class of loss the
			// notification contract forbids. Duplicates (rare reconnect during
			// queue latency) are the accepted failure direction.
			if err := s.inner.Send(s.ctx, job.recipientUserID, job.notification); err != nil {
				if errors.Is(err, context.Canceled) && s.ctx.Err() != nil {
					return
				}
				// An undeliverable push (no registered device / provider 4xx)
				// means the OFFLINE fallback surfaced nothing — the recipient
				// got no desktop popup (they're offline) and no mobile push.
				// For an incident channel that is a silent miss, so log it at
				// ERROR with an explicit marker rather than burying it in WARN.
				if errors.Is(err, ErrPushUndeliverable) {
					slog.Error(
						"mobile push UNDELIVERABLE — recipient has no reachable device; offline fallback produced no alert",
						"userID", job.recipientUserID,
						"parentID", job.notification.ParentID,
						"parentType", job.notification.ParentType,
						"messageID", job.notification.MessageID,
						"kind", job.notification.Kind,
						"error", err,
					)
					continue
				}
				slog.Warn(
					"mobile push send failed (transient, retries exhausted)",
					"userID", job.recipientUserID,
					"parentID", job.notification.ParentID,
					"parentType", job.notification.ParentType,
					"messageID", job.notification.MessageID,
					"kind", job.notification.Kind,
					"error", err,
				)
			}
		}
	}
}

var _ MobilePushSender = (*AsyncMobilePushSender)(nil)
