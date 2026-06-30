package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

func reminderDueKey() string                { return "reminders:due" }
func reminderUserKey(userID string) string  { return "reminders:user:" + userID }
func reminderPayloadKey(id string) string   { return "reminder:" + id }

// reminderPayloadBuffer is how long a reminder's payload outlives its fire time
// before Redis reclaims it, covering a poller that is briefly down. The due-queue
// claim deletes the payload on fire anyway; this is only a backstop.
const reminderPayloadBuffer = 7 * 24 * time.Hour

// RedisReminderStore stores scheduled message reminders in Redis.
//
//   - reminders:due            ZSET    score=remindAt(epoch ms) → reminderID   (global due queue)
//   - reminders:user:{userID}  ZSET    score=remindAt(epoch ms) → reminderID   (per-user index for list/cancel)
//   - reminder:{id}            STRING  JSON(Reminder)                          (payload)
//
// The global due queue lets a single background poller across all instances find
// fired reminders with one ranged read; claiming is an atomic per-id ZREM so a
// reminder fires exactly once even with multiple pollers.
type RedisReminderStore struct {
	client *redis.Client
	now    func() time.Time
}

// NewRedisReminderStore builds a RedisReminderStore over the given client.
func NewRedisReminderStore(client *redis.Client) *RedisReminderStore {
	return &RedisReminderStore{client: client, now: time.Now}
}

// ScheduleReminder persists a reminder and indexes it in the global due queue
// and the owner's index.
func (s *RedisReminderStore) ScheduleReminder(ctx context.Context, r *model.Reminder) error {
	payload, err := json.Marshal(r)
	if err != nil { // coverage-ignore: Reminder is scalar fields; Marshal cannot fail
		return fmt.Errorf("store: marshal reminder: %w", err)
	}
	ttl := max(time.Until(r.RemindAt)+reminderPayloadBuffer, reminderPayloadBuffer)
	score := float64(r.RemindAt.UnixMilli())
	pipe := s.client.Pipeline()
	pipe.Set(ctx, reminderPayloadKey(r.ID), payload, ttl)
	pipe.ZAdd(ctx, reminderDueKey(), redis.Z{Score: score, Member: r.ID})
	pipe.ZAdd(ctx, reminderUserKey(r.UserID), redis.Z{Score: score, Member: r.ID})
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("store: schedule reminder: %w", err)
	}
	return nil
}

// getReminder loads a reminder payload by id. Returns ErrNotFound when absent.
func (s *RedisReminderStore) getReminder(ctx context.Context, id string) (*model.Reminder, error) {
	raw, err := s.client.Get(ctx, reminderPayloadKey(id)).Result()
	if errors.Is(err, redis.Nil) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: get reminder: %w", err)
	}
	var r model.Reminder
	if err := json.Unmarshal([]byte(raw), &r); err != nil { // coverage-ignore: round-trip of a value this store wrote
		return nil, fmt.Errorf("store: unmarshal reminder: %w", err)
	}
	return &r, nil
}

// ListPendingReminders returns the user's not-yet-fired reminders, soonest first.
func (s *RedisReminderStore) ListPendingReminders(ctx context.Context, userID string) ([]*model.Reminder, error) {
	ids, err := s.client.ZRange(ctx, reminderUserKey(userID), 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("store: list reminders: %w", err)
	}
	reminders := make([]*model.Reminder, 0, len(ids))
	for _, id := range ids {
		r, err := s.getReminder(ctx, id)
		if errors.Is(err, ErrNotFound) {
			// Payload expired/raced out from under the index — drop the stale
			// index entry and skip.
			_ = s.client.ZRem(ctx, reminderUserKey(userID), id).Err()
			continue
		}
		if err != nil {
			return nil, err
		}
		reminders = append(reminders, r)
	}
	return reminders, nil
}

// CancelReminder removes a pending reminder owned by userID. Returns false when
// no such reminder exists for the user (already fired, cancelled, or not theirs).
func (s *RedisReminderStore) CancelReminder(ctx context.Context, userID, id string) (bool, error) {
	r, err := s.getReminder(ctx, id)
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if r.UserID != userID {
		// Not the caller's reminder — refuse without leaking its existence.
		return false, nil
	}
	pipe := s.client.Pipeline()
	pipe.Del(ctx, reminderPayloadKey(id))
	pipe.ZRem(ctx, reminderDueKey(), id)
	pipe.ZRem(ctx, reminderUserKey(userID), id)
	if _, err := pipe.Exec(ctx); err != nil {
		return false, fmt.Errorf("store: cancel reminder: %w", err)
	}
	return true, nil
}

// claimDueScript atomically pops up to ARGV[2] due reminder ids (score <= now)
// off the global due queue and returns them. Because Redis runs the whole script
// atomically, an id is returned to exactly one poller even across instances — the
// ZREM happens before any concurrent invocation can read it — so reminders never
// double-fire. KEYS[1]=due queue; ARGV[1]=nowMs; ARGV[2]=limit.
var claimDueScript = redis.NewScript(`
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[1], id)
end
return ids
`)

// ClaimDueReminders atomically claims and returns reminders whose RemindAt is at
// or before now, up to limit. The claim (range + remove from the due queue) is a
// single atomic Lua script, so concurrent pollers never double-fire. The payload
// and per-user index entry are cleaned up for every claimed id.
func (s *RedisReminderStore) ClaimDueReminders(ctx context.Context, limit int) ([]*model.Reminder, error) {
	nowMs := s.now().UnixMilli()
	res, err := claimDueScript.Run(ctx, s.client, []string{reminderDueKey()}, nowMs, limit).Result()
	if err != nil {
		return nil, fmt.Errorf("store: claim due reminders: %w", err)
	}
	raw, _ := res.([]any)
	claimed := make([]*model.Reminder, 0, len(raw))
	for _, v := range raw {
		id, ok := v.(string)
		if !ok { // coverage-ignore: ZRANGEBYSCORE members are always bulk strings
			continue
		}
		r, err := s.getReminder(ctx, id)
		if errors.Is(err, ErrNotFound) {
			// Payload gone (expired) — nothing to fire; index cleanup is lazy.
			continue
		}
		if err != nil {
			return nil, err
		}
		_ = s.client.ZRem(ctx, reminderUserKey(r.UserID), id).Err()
		_ = s.client.Del(ctx, reminderPayloadKey(id)).Err()
		claimed = append(claimed, r)
	}
	return claimed, nil
}
