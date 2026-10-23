// The durable safety net behind the in-process notification fan-out. The
// live fan-out runs on a detached goroutine right after the message commits;
// a deploy or crash in that window used to lose the message's popup,
// Activity row and push for good. Every send now also schedules an asynq task
// (Redis-backed, survives restarts, any instance runs it) a little later; a
// completed fan-out leaves a "notified" marker, and the task re-runs the
// fan-out only when that marker is missing. The normal path gains no latency:
// it never waits for the task. Duplicates beat silence — a fan-out that was
// still running when its check came due can alert twice.

package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
)

// TaskTypeNotifyCheck is the asynq task type of the fan-out safety net. One
// task per message.
const TaskTypeNotifyCheck = "notify:check"

// notifySafetyNetDelay is how long after the send the check runs: well past
// a normal fan-out (milliseconds; seconds with audience-read retries), so the
// marker is already there. A var so tests can shrink it.
var notifySafetyNetDelay = 30 * time.Second

// notifyCheckMaxRetry bounds re-runs of a check whose fan-out could not
// complete (audience unreadable); asynq archives it after that — a
// dead-letter, never a silent drop.
const notifyCheckMaxRetry = 10

// notifiedMarkerTTL outlives the check (and its retries) by a wide margin.
const notifiedMarkerTTL = time.Hour

// notifyCheckPayload is the task body: just the message's coordinates — the
// handler reads the message as it is when the check runs.
type notifyCheckPayload struct {
	ParentID   string `json:"parentID"`
	ParentType string `json:"parentType"`
	MessageID  string `json:"messageID"`
}

// notifyCheckTaskID makes the check idempotent per message.
func notifyCheckTaskID(messageID string) string { return "notify:" + messageID }

// ScheduleNotifyCheck arms the safety net for msg. The app's one asynq
// producer (AsynqPushScheduler) carries both the mobile pushes and these
// checks.
func (s *AsynqPushScheduler) ScheduleNotifyCheck(ctx context.Context, msg *model.Message, parentType string) error {
	payload := mustJSONBody(json.Marshal(notifyCheckPayload{ParentID: msg.ParentID, ParentType: parentType, MessageID: msg.ID}))
	_, err := s.client.EnqueueContext(ctx, asynq.NewTask(TaskTypeNotifyCheck, payload),
		asynq.TaskID(notifyCheckTaskID(msg.ID)),
		asynq.ProcessIn(notifySafetyNetDelay),
		asynq.MaxRetry(notifyCheckMaxRetry),
		asynq.Retention(pushTaskRetention),
		asynq.Timeout(detachedTimeout),
	)
	if err != nil && !errors.Is(err, asynq.ErrTaskIDConflict) {
		return fmt.Errorf("notify safety net: enqueue: %w", err)
	}
	return nil
}

// NotifyMarker records which messages' fan-outs completed.
type NotifyMarker interface {
	MarkNotified(ctx context.Context, messageID string) error
	WasNotified(ctx context.Context, messageID string) (bool, error)
}

// SetNotifyMarker wires the completed-fan-out marker the safety net reads.
func (s *NotificationService) SetNotifyMarker(m NotifyMarker) { s.marker = m }

// RedisNotifyMarker is the production NotifyMarker: one short-lived key per
// message, visible to every instance.
type RedisNotifyMarker struct {
	rdb redis.UniversalClient
}

// NewRedisNotifyMarker wraps a Redis client built through redisx.Options.
func NewRedisNotifyMarker(rdb redis.UniversalClient) *RedisNotifyMarker {
	return &RedisNotifyMarker{rdb: rdb}
}

func notifiedMarkerKey(messageID string) string { return "notified:" + messageID }

func (m *RedisNotifyMarker) MarkNotified(ctx context.Context, messageID string) error {
	return m.rdb.Set(ctx, notifiedMarkerKey(messageID), 1, notifiedMarkerTTL).Err()
}

func (m *RedisNotifyMarker) WasNotified(ctx context.Context, messageID string) (bool, error) {
	n, err := m.rdb.Exists(ctx, notifiedMarkerKey(messageID)).Result()
	return n > 0, err
}

// NotifyCheckTaskHandler is the worker side of the safety net. It needs the
// notifier's message store and marker (production wires both; boot refuses
// otherwise). Outcomes: marker present → done; message gone or deleted →
// done (nothing left to alert about); otherwise the fan-out runs now, and an
// audience that still can't be read is returned as an error so asynq retries.
func (s *NotificationService) NotifyCheckTaskHandler() func(context.Context, *asynq.Task) error {
	return func(ctx context.Context, t *asynq.Task) error {
		var p notifyCheckPayload
		if err := json.Unmarshal(t.Payload(), &p); err != nil {
			return fmt.Errorf("notify check payload unmarshal: %v: %w", err, asynq.SkipRetry)
		}
		done, err := s.marker.WasNotified(ctx, p.MessageID)
		if err != nil {
			return fmt.Errorf("notify check: read marker: %w", err)
		}
		if done {
			return nil
		}
		msg, err := s.messages.GetMessage(ctx, p.ParentID, p.MessageID)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("notify check: read message: %w", err)
		}
		if msg.Deleted {
			return nil
		}
		var root *model.Message
		if msg.ParentMessageID != "" {
			if r, err := s.messages.GetMessage(ctx, p.ParentID, msg.ParentMessageID); err == nil {
				root = r
			}
		}
		slog.WarnContext(ctx, "notification fan-out had not completed — the safety net is running it now",
			"messageID", p.MessageID, "parentID", p.ParentID, "parentType", p.ParentType)
		if !s.notifyAndMark(ctx, msg, p.ParentType, root) {
			return fmt.Errorf("notify check: audience for %s still unreadable", p.MessageID)
		}
		return nil
	}
}

// NotificationsWired reports whether the notifier has everything the safety
// net needs. Boot refuses to serve without it.
func (s *NotificationService) NotificationsWired() error {
	if s.marker == nil || s.messages == nil {
		return errors.New("notification service: safety-net marker or message store not wired")
	}
	return nil
}
