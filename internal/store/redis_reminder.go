package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/redis/go-redis/v9"
)

func reminderDueKey() string               { return "reminders:due" }
func reminderUserKey(userID string) string { return "reminders:user:" + userID }
func reminderPayloadKey(id string) string  { return "reminder:" + id }

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
	payload := mustJSON(json.Marshal(r))
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
	r, ok := decodeReminder(raw)
	if !ok {
		return nil, fmt.Errorf("store: unmarshal reminder %q", id)
	}
	return r, nil
}

// decodeReminder turns one MGET slot into a reminder. A nil slot (missing or
// wrong-type key) or an unparseable payload yields ok=false so the batch callers
// can treat both as "drop this stale entry" without an extra round-trip.
func decodeReminder(v any) (*model.Reminder, bool) {
	raw, ok := v.(string)
	if !ok {
		return nil, false
	}
	var r model.Reminder
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, false
	}
	return &r, true
}

// payloadKeysFor maps reminder ids to their payload keys for an MGET.
func payloadKeysFor(ids []string) []string {
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = reminderPayloadKey(id)
	}
	return keys
}

// ListPendingReminders returns the user's not-yet-fired reminders, soonest first.
// Payloads are fetched in one MGET rather than a GET per id, and any index entry
// whose payload has aged out is swept in a single ZREM.
func (s *RedisReminderStore) ListPendingReminders(ctx context.Context, userID string) ([]*model.Reminder, error) {
	ids, err := s.client.ZRange(ctx, reminderUserKey(userID), 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("store: list reminders: %w", err)
	}
	if len(ids) == 0 {
		return nil, nil
	}
	vals, err := s.client.MGet(ctx, payloadKeysFor(ids)...).Result()
	if err != nil {
		return nil, fmt.Errorf("store: list reminders mget: %w", err)
	}
	now := s.now()
	reminders := make([]*model.Reminder, 0, len(vals))
	var stale []any
	for i, v := range vals {
		r, ok := decodeReminder(v)
		// Drop the index entry when the payload is unreadable (corrupt/expired)
		// OR the reminder is already past its fire time — a past-due entry is
		// either a reminder that fired but whose post-claim cleanup failed (a
		// ghost) or one the poller is about to claim; neither is "pending", and
		// sweeping it here self-heals a ghost without racing the poller (which
		// claims off the due queue, not this index).
		if !ok || !r.RemindAt.After(now) {
			stale = append(stale, ids[i])
			continue
		}
		reminders = append(reminders, r)
	}
	if len(stale) > 0 {
		_ = s.client.ZRem(ctx, reminderUserKey(userID), stale...).Err()
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
	res, err := redisx.RunScript(ctx, s.client, claimDueScript, []string{reminderDueKey()}, nowMs, limit).Result()
	if err != nil {
		return nil, fmt.Errorf("store: claim due reminders: %w", err)
	}
	raw, _ := res.([]any)
	ids := make([]string, 0, len(raw))
	for _, v := range raw {
		if id, ok := v.(string); ok {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil, nil
	}
	// One MGET for all claimed payloads, then one pipeline for the per-id cleanup
	// — instead of a GET + ZREM + DEL round-trip per reminder.
	vals, err := s.client.MGet(ctx, payloadKeysFor(ids)...).Result()
	if err != nil {
		return nil, fmt.Errorf("store: claim due reminders mget: %w", err)
	}
	claimed := make([]*model.Reminder, 0, len(vals))
	pipe := s.client.Pipeline()
	for i, v := range vals {
		r, ok := decodeReminder(v)
		if !ok {
			// Payload gone/corrupt but the id was already claimed off the due
			// queue, so this reminder will NEVER fire. That is an undeliverable
			// alert — log it loudly (per the notifications "must be loud"
			// invariant) rather than dropping it silently. The dangling per-user
			// index entry is swept on the owner's next list.
			slog.Warn("reminder claimed but payload unreadable; alert lost", "reminderID", ids[i])
			continue
		}
		pipe.ZRem(ctx, reminderUserKey(r.UserID), ids[i])
		pipe.Del(ctx, reminderPayloadKey(ids[i]))
		claimed = append(claimed, r)
	}
	if len(claimed) > 0 {
		// Cleanup is best-effort: the reminders are already claimed and will fire
		// regardless. A failure leaves a payload+index entry behind, but the
		// past-due sweep in ListPendingReminders keeps it out of the pending list.
		if _, err := pipe.Exec(ctx); err != nil {
			slog.Warn("reminder post-claim cleanup failed; entries swept on next list", "error", err)
		}
	}
	return claimed, nil
}
