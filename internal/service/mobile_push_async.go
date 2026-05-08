package service

import (
	"context"
	"errors"
	"log/slog"
	"sync"
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
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.ctx.Done():
		return nil
	default:
	}
	select {
	case s.queue <- job:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-s.ctx.Done():
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
	for {
		select {
		case <-s.ctx.Done():
			return
		case job := <-s.queue:
			if err := s.inner.Send(s.ctx, job.recipientUserID, job.notification); err != nil {
				if errors.Is(err, context.Canceled) && s.ctx.Err() != nil {
					return
				}
				slog.Warn(
					"mobile push send failed",
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
