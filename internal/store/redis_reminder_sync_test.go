//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

var syncNow = time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)

func syncReminder(id, user, parentID, messageID string, in time.Duration) *model.Reminder {
	return &model.Reminder{
		ID: id, UserID: user, MessageID: messageID, ParentID: parentID, ParentType: "channel",
		MessagePreview: "preview " + id, RemindAt: syncNow.Add(in), CreatedAt: syncNow,
	}
}

func seedReminders(t *testing.T, s *RedisReminderStore, rs ...*model.Reminder) {
	t.Helper()
	for _, r := range rs {
		if err := s.ScheduleReminder(context.Background(), r); err != nil {
			t.Fatalf("schedule %s: %v", r.ID, err)
		}
	}
}

func pendingIDs(t *testing.T, s *RedisReminderStore, userID string) []string {
	t.Helper()
	list, err := s.ListPendingReminders(context.Background(), userID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	ids := make([]string, len(list))
	for i, r := range list {
		ids[i] = r.ID
	}
	return ids
}

// Every reminder is findable from its message — while it's pending, and no
// longer once cancelled or fired — and the index outlives every reminder in it.
func TestRedisReminderStore_MessageIndex(t *testing.T) {
	s, client := setupReminderStore(t)
	ctx := context.Background()
	s.now = func() time.Time { return syncNow }
	seedReminders(t, s,
		syncReminder("r-long", "u-1", "ch-1", "m-1", 48*time.Hour),
		syncReminder("r-short", "u-2", "ch-1", "m-1", time.Hour),
	)
	key := reminderMessageKey("m-1")
	if got := client.SMembers(ctx, key).Val(); len(got) != 2 {
		t.Fatalf("index = %v, want both reminders", got)
	}
	// The shorter reminder scheduled second didn't shorten the index's life.
	if ttl, payload := client.TTL(ctx, key).Val(), client.TTL(ctx, reminderPayloadKey("r-long")).Val(); ttl < payload {
		t.Fatalf("index TTL = %v, want at least the long reminder's %v", ttl, payload)
	}
	if ok, err := s.CancelReminder(ctx, "u-2", "r-short"); err != nil || !ok {
		t.Fatalf("cancel = %v, %v", ok, err)
	}
	if got := client.SMembers(ctx, key).Val(); len(got) != 1 || got[0] != "r-long" {
		t.Fatalf("index after cancel = %v", got)
	}
	s.now = func() time.Time { return syncNow.Add(49 * time.Hour) }
	if claimed, err := s.ClaimDueReminders(ctx, 10); err != nil || len(claimed) != 1 {
		t.Fatalf("claim = %v, %v", claimed, err)
	}
	if got := client.SMembers(ctx, key).Val(); len(got) != 0 {
		t.Fatalf("index after firing = %v, want empty", got)
	}
}

// Leaving a channel takes the user's own reminders there — no one else's,
// and none elsewhere.
func TestRedisReminderStore_CancelRemindersForParent(t *testing.T) {
	s, client := setupReminderStore(t)
	ctx := context.Background()
	s.now = func() time.Time { return syncNow }
	seedReminders(t, s,
		syncReminder("r1", "u-1", "ch-1", "m-1", time.Hour),
		syncReminder("r2", "u-1", "ch-2", "m-2", time.Hour),
		syncReminder("r3", "u-2", "ch-1", "m-1", time.Hour),
	)
	ids, err := s.CancelRemindersForParent(ctx, "u-1", "ch-1")
	if err != nil || len(ids) != 1 || ids[0] != "r1" {
		t.Fatalf("cancelled = %v, %v", ids, err)
	}
	if got := pendingIDs(t, s, "u-1"); len(got) != 1 || got[0] != "r2" {
		t.Fatalf("u-1 pending = %v", got)
	}
	if got := pendingIDs(t, s, "u-2"); len(got) != 1 {
		t.Fatalf("u-2 pending = %v, another user's reminder must stay", got)
	}
	if client.ZScore(ctx, reminderDueKey(), "r1").Err() == nil {
		t.Fatal("a cancelled reminder must leave the due queue")
	}
	if got := client.SMembers(ctx, reminderMessageKey("m-1")).Val(); len(got) != 1 || got[0] != "r3" {
		t.Fatalf("m-1 index = %v", got)
	}
	if ids, err := s.CancelRemindersForParent(ctx, "u-1", "ch-9"); err != nil || ids != nil {
		t.Fatalf("nothing to cancel = %v, %v", ids, err)
	}
}

// Deleting messages takes every pending reminder about them, whoever set it.
func TestRedisReminderStore_CancelRemindersForMessages(t *testing.T) {
	s, client := setupReminderStore(t)
	ctx := context.Background()
	s.now = func() time.Time { return syncNow }
	seedReminders(t, s,
		syncReminder("r1", "u-1", "ch-1", "m-gone", time.Hour),
		syncReminder("r2", "u-2", "ch-1", "m-gone", 2*time.Hour),
		syncReminder("r3", "u-1", "ch-1", "m-gone-too", time.Hour),
		syncReminder("r4", "u-1", "ch-1", "m-kept", time.Hour),
	)
	// An index entry whose reminder already fired is swept, not reported.
	if err := client.SAdd(ctx, reminderMessageKey("m-gone"), "r-fired").Err(); err != nil {
		t.Fatalf("seed stale: %v", err)
	}
	owners, err := s.CancelRemindersForMessages(ctx, []string{"m-gone", "m-gone-too", "m-never"})
	if err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if len(owners) != 2 || len(owners["u-1"]) != 2 || len(owners["u-2"]) != 1 {
		t.Fatalf("owners = %v", owners)
	}
	if got := pendingIDs(t, s, "u-1"); len(got) != 1 || got[0] != "r4" {
		t.Fatalf("u-1 pending = %v", got)
	}
	if got := pendingIDs(t, s, "u-2"); len(got) != 0 {
		t.Fatalf("u-2 pending = %v", got)
	}
	if client.Exists(ctx, reminderMessageKey("m-gone")).Val() != 0 {
		t.Fatal("the message index (and its stale entry) must be gone")
	}
	if owners, err := s.CancelRemindersForMessages(ctx, []string{"m-never"}); err != nil || owners != nil {
		t.Fatalf("nothing to cancel = %v, %v", owners, err)
	}
}

// An edit reaches the pending reminders' previews, keeping when they fire.
func TestRedisReminderStore_UpdateReminderPreview(t *testing.T) {
	s, client := setupReminderStore(t)
	ctx := context.Background()
	s.now = func() time.Time { return syncNow }
	seedReminders(t, s,
		syncReminder("r1", "u-1", "ch-1", "m-1", time.Hour),
		syncReminder("r2", "u-2", "ch-1", "m-1", time.Hour),
		syncReminder("r3", "u-1", "ch-1", "m-2", time.Hour),
	)
	ttlBefore := client.TTL(ctx, reminderPayloadKey("r1")).Val()
	owners, err := s.UpdateReminderPreview(ctx, "m-1", "the corrected text")
	if err != nil || len(owners) != 2 {
		t.Fatalf("update = %v, %v", owners, err)
	}
	r1, err := s.getReminder(ctx, "r1")
	if err != nil || r1.MessagePreview != "the corrected text" || !r1.RemindAt.Equal(syncNow.Add(time.Hour)) {
		t.Fatalf("r1 = %+v, %v", r1, err)
	}
	if ttl := client.TTL(ctx, reminderPayloadKey("r1")).Val(); ttl <= 0 || ttl > ttlBefore {
		t.Fatalf("TTL = %v (was %v), want it kept", ttl, ttlBefore)
	}
	if r3, _ := s.getReminder(ctx, "r3"); r3.MessagePreview != "preview r3" {
		t.Fatalf("another message's reminder changed: %+v", r3)
	}
	if owners, err := s.UpdateReminderPreview(ctx, "m-none", "x"); err != nil || owners != nil {
		t.Fatalf("nothing to update = %v, %v", owners, err)
	}
}

// Each Redis failure surfaces as an error.
func TestRedisReminderStore_SyncErrors(t *testing.T) {
	ctx := context.Background()
	seed := func(t *testing.T) {
		s, _ := setupReminderStore(t)
		s.now = func() time.Time { return syncNow }
		seedReminders(t, s, syncReminder("r1", "u-1", "ch-1", "m-1", time.Hour))
	}
	failing := func(t *testing.T, cmds ...string) *RedisReminderStore {
		s := NewRedisReminderStore(storeRedisClientFailingOn(t, cmds...))
		s.now = func() time.Time { return syncNow }
		return s
	}

	t.Run("parent: listing fails", func(t *testing.T) {
		seed(t)
		if _, err := failing(t, "zrange").CancelRemindersForParent(ctx, "u-1", "ch-1"); !errors.Is(err, errInjected) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("parent: removing fails", func(t *testing.T) {
		seed(t)
		if _, err := failing(t, "srem").CancelRemindersForParent(ctx, "u-1", "ch-1"); !errors.Is(err, errInjected) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("messages: index read fails", func(t *testing.T) {
		seed(t)
		s := failing(t, "smembers")
		if _, err := s.CancelRemindersForMessages(ctx, []string{"m-1"}); !errors.Is(err, errInjected) {
			t.Fatalf("cancel err = %v", err)
		}
		if _, err := s.UpdateReminderPreview(ctx, "m-1", "x"); !errors.Is(err, errInjected) {
			t.Fatalf("update err = %v", err)
		}
	})
	t.Run("messages: payload read fails", func(t *testing.T) {
		seed(t)
		if _, err := failing(t, "mget").CancelRemindersForMessages(ctx, []string{"m-1"}); !errors.Is(err, errInjected) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("messages: removing fails", func(t *testing.T) {
		seed(t)
		if _, err := failing(t, "del").CancelRemindersForMessages(ctx, []string{"m-1"}); !errors.Is(err, errInjected) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("preview: rewriting fails", func(t *testing.T) {
		seed(t)
		if _, err := failing(t, "set").UpdateReminderPreview(ctx, "m-1", "x"); !errors.Is(err, errInjected) {
			t.Fatalf("err = %v", err)
		}
	})
}
