package store

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func setupReminderStore(t *testing.T) (*RedisReminderStore, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1, DialTimeout: 150 * time.Millisecond})
	t.Cleanup(func() { _ = client.Close() })
	return NewRedisReminderStore(client), mr
}

func reminderAt(id, user string, at time.Time) *model.Reminder {
	return &model.Reminder{ID: id, UserID: user, MessageID: "m-" + id, ParentID: "ch-1", ParentType: "channel", RemindAt: at, CreatedAt: at.Add(-time.Hour)}
}

func TestRedisReminderStore_ScheduleListCancel(t *testing.T) {
	s, _ := setupReminderStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	if err := s.ScheduleReminder(ctx, reminderAt("r1", "u-1", now.Add(time.Hour))); err != nil {
		t.Fatalf("Schedule r1: %v", err)
	}
	if err := s.ScheduleReminder(ctx, reminderAt("r2", "u-1", now.Add(30*time.Minute))); err != nil {
		t.Fatalf("Schedule r2: %v", err)
	}
	// Another user's reminder must not appear in u-1's list.
	if err := s.ScheduleReminder(ctx, reminderAt("r3", "u-2", now.Add(time.Hour))); err != nil {
		t.Fatalf("Schedule r3: %v", err)
	}

	list, err := s.ListPendingReminders(ctx, "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 || list[0].ID != "r2" {
		t.Fatalf("expected r2,r1 soonest-first, got %+v", list)
	}

	// Cancelling another user's reminder is refused (false, no error).
	if ok, err := s.CancelReminder(ctx, "u-1", "r3"); err != nil || ok {
		t.Fatalf("cancel foreign = (%v,%v), want (false,nil)", ok, err)
	}
	// Cancelling a missing reminder → false.
	if ok, _ := s.CancelReminder(ctx, "u-1", "nope"); ok {
		t.Fatalf("cancel missing should be false")
	}
	// Cancelling own reminder → true and gone from the list.
	if ok, err := s.CancelReminder(ctx, "u-1", "r1"); err != nil || !ok {
		t.Fatalf("cancel own = (%v,%v), want (true,nil)", ok, err)
	}
	if list, _ := s.ListPendingReminders(ctx, "u-1"); len(list) != 1 || list[0].ID != "r2" {
		t.Fatalf("after cancel expected only r2, got %+v", list)
	}
}

func TestRedisReminderStore_ClaimDue(t *testing.T) {
	s, _ := setupReminderStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	_ = s.ScheduleReminder(ctx, reminderAt("past", "u-1", now.Add(-time.Minute)))
	_ = s.ScheduleReminder(ctx, reminderAt("now", "u-1", now))
	_ = s.ScheduleReminder(ctx, reminderAt("future", "u-1", now.Add(time.Hour)))

	due, err := s.ClaimDueReminders(ctx, 10)
	if err != nil {
		t.Fatalf("ClaimDue: %v", err)
	}
	if len(due) != 2 {
		t.Fatalf("expected 2 due (past,now), got %d: %+v", len(due), due)
	}
	// Claimed reminders are removed from the owner's index and won't fire twice.
	if again, _ := s.ClaimDueReminders(ctx, 10); len(again) != 0 {
		t.Fatalf("second claim should be empty, got %+v", again)
	}
	if list, _ := s.ListPendingReminders(ctx, "u-1"); len(list) != 1 || list[0].ID != "future" {
		t.Fatalf("after claim only future should remain, got %+v", list)
	}
}

func TestRedisReminderStore_ClaimDueSkipsOrphanPayload(t *testing.T) {
	s, _ := setupReminderStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	_ = s.ScheduleReminder(ctx, reminderAt("orphan", "u-1", now.Add(-time.Minute)))
	// Drop the payload out from under the due-queue entry.
	s.client.Del(ctx, reminderPayloadKey("orphan"))
	due, err := s.ClaimDueReminders(ctx, 10)
	if err != nil {
		t.Fatalf("ClaimDue: %v", err)
	}
	if len(due) != 0 {
		t.Fatalf("orphaned payload should yield nothing to fire, got %+v", due)
	}
}

func TestRedisReminderStore_ListDropsStaleIndex(t *testing.T) {
	s, _ := setupReminderStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	_ = s.ScheduleReminder(ctx, reminderAt("stale", "u-1", now.Add(time.Hour)))
	s.client.Del(ctx, reminderPayloadKey("stale")) // payload expired, index lingers
	list, err := s.ListPendingReminders(ctx, "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("stale index entry should be skipped, got %+v", list)
	}
}

// corruptPayload replaces a reminder's payload with a wrong-type (SET) key, so an
// MGET slot comes back nil and a single Get returns WRONGTYPE.
func corruptPayload(t *testing.T, s *RedisReminderStore, id string) {
	t.Helper()
	ctx := context.Background()
	if err := s.client.Del(ctx, reminderPayloadKey(id)).Err(); err != nil {
		t.Fatalf("del payload: %v", err)
	}
	if err := s.client.SAdd(ctx, reminderPayloadKey(id), "x").Err(); err != nil {
		t.Fatalf("corrupt payload: %v", err)
	}
}

// ListPendingReminders hides AND sweeps a past-due reminder (a ghost whose
// post-claim cleanup failed, or one about to fire) — only future reminders are
// "pending".
func TestRedisReminderStore_ListHidesPastDue(t *testing.T) {
	s, _ := setupReminderStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	_ = s.ScheduleReminder(ctx, reminderAt("ghost", "u-1", now.Add(-time.Minute))) // already past
	_ = s.ScheduleReminder(ctx, reminderAt("future", "u-1", now.Add(time.Hour)))

	list, err := s.ListPendingReminders(ctx, "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].ID != "future" {
		t.Fatalf("only the future reminder is pending, got %+v", list)
	}
	// The ghost's index entry was swept, not left dangling.
	if n, _ := s.client.ZCard(ctx, reminderUserKey("u-1")).Result(); n != 1 {
		t.Fatalf("past-due index entry should be swept, card=%d", n)
	}
}

// Cancel reads a single payload with Get, so a wrong-type payload still surfaces
// as an error (it's not the batch MGET path).
func TestRedisReminderStore_CancelSurfacesPayloadError(t *testing.T) {
	s, _ := setupReminderStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	_ = s.ScheduleReminder(ctx, reminderAt("r-cancel", "u-2", now.Add(time.Hour)))
	corruptPayload(t, s, "r-cancel")
	if _, err := s.CancelReminder(ctx, "u-2", "r-cancel"); err == nil {
		t.Error("Cancel should surface a wrong-type payload error")
	}
}

// The batch (MGET) paths drop unreadable payloads — both a wrong-type key (nil
// slot) and a non-JSON string — rather than erroring, and List sweeps the stale
// index entries.
func TestRedisReminderStore_BatchSkipsUnreadablePayloads(t *testing.T) {
	s, _ := setupReminderStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	// Empty user → no MGET, no error.
	if list, err := s.ListPendingReminders(ctx, "nobody"); err != nil || list != nil {
		t.Fatalf("empty-user list = %v, %v", list, err)
	}

	_ = s.ScheduleReminder(ctx, reminderAt("r-wrongtype", "u-1", now.Add(time.Hour)))
	corruptPayload(t, s, "r-wrongtype") // SET → MGET nil → decode !ok
	_ = s.ScheduleReminder(ctx, reminderAt("r-badjson", "u-1", now.Add(2*time.Hour)))
	if err := s.client.Set(ctx, reminderPayloadKey("r-badjson"), "not-json", 0).Err(); err != nil {
		t.Fatalf("seed bad json: %v", err)
	}
	_ = s.ScheduleReminder(ctx, reminderAt("r-good", "u-1", now.Add(3*time.Hour)))

	list, err := s.ListPendingReminders(ctx, "u-1")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 1 || list[0].ID != "r-good" {
		t.Fatalf("only the readable reminder should survive, got %+v", list)
	}
	if n, _ := s.client.ZCard(ctx, reminderUserKey("u-1")).Result(); n != 1 {
		t.Fatalf("stale index entries should be swept, card=%d", n)
	}

	// A due-but-unreadable reminder is claimed off the queue and skipped.
	_ = s.ScheduleReminder(ctx, reminderAt("r-due-bad", "u-1", now.Add(-time.Minute)))
	if err := s.client.Set(ctx, reminderPayloadKey("r-due-bad"), "not-json", 0).Err(); err != nil {
		t.Fatalf("seed due bad json: %v", err)
	}
	due, err := s.ClaimDueReminders(ctx, 10)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if len(due) != 0 {
		t.Fatalf("unreadable due reminder should be skipped, got %+v", due)
	}
}

func TestRedisReminderStore_CancelPipelineError(t *testing.T) {
	s, _ := setupReminderStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	_ = s.ScheduleReminder(ctx, reminderAt("r-pipe", "u-pipe", now.Add(time.Hour)))
	// Payload stays valid (getReminder succeeds) but the user index is now the
	// wrong type, so the pipelined ZRem fails → pipe.Exec error branch.
	if err := s.client.Del(ctx, reminderUserKey("u-pipe")).Err(); err != nil {
		t.Fatalf("del index: %v", err)
	}
	if err := s.client.Set(ctx, reminderUserKey("u-pipe"), "not-a-zset", 0).Err(); err != nil {
		t.Fatalf("corrupt index: %v", err)
	}
	if _, err := s.CancelReminder(ctx, "u-pipe", "r-pipe"); err == nil {
		t.Error("Cancel should surface the pipeline ZRem error")
	}
}

func TestRedisReminderStore_ClientErrors(t *testing.T) {
	s, mr := setupReminderStore(t)
	ctx := context.Background()
	mr.Close()
	if err := s.ScheduleReminder(ctx, reminderAt("r", "u-1", time.Now().Add(time.Hour))); err == nil {
		t.Error("Schedule on closed redis should error")
	}
	if _, err := s.ListPendingReminders(ctx, "u-1"); err == nil {
		t.Error("List on closed redis should error")
	}
	if _, err := s.CancelReminder(ctx, "u-1", "r"); err == nil {
		t.Error("Cancel on closed redis should error")
	}
	if _, err := s.ClaimDueReminders(ctx, 10); err == nil {
		t.Error("ClaimDue on closed redis should error")
	}
}
