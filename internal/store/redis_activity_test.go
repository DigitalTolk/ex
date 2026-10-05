//go:build integration

package store

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

func setupActivityStore(t *testing.T) (*RedisActivityStore, *redis.Client) {
	t.Helper()
	client := storeRedisClient(t)
	return NewRedisActivityStore(client), client
}

// unreadIDs lists the ids of the user's unread items, newest first.
func unreadIDs(t *testing.T, s *RedisActivityStore, userID string) []string {
	t.Helper()
	items, err := s.ListActivity(context.Background(), userID)
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	var ids []string
	for _, it := range items {
		if !it.Read {
			ids = append(ids, it.ID)
		}
	}
	return ids
}

func activityAt(id string, at time.Time) *model.ActivityItem {
	return &model.ActivityItem{ID: id, Type: model.ActivityReaction, CreatedAt: at, MessageID: "m-" + id, ParentID: "ch-1", ParentType: "channel"}
}

func TestRedisActivityStore_AddListOrder(t *testing.T) {
	s, _ := setupActivityStore(t)
	ctx := context.Background()
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return base }

	for i, at := range []time.Time{base, base.Add(time.Minute), base.Add(2 * time.Minute)} {
		if err := s.AddActivity(ctx, "u-1", activityAt(string(rune('a'+i)), at)); err != nil {
			t.Fatalf("AddActivity: %v", err)
		}
	}
	items, err := s.ListActivity(ctx, "u-1")
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	if len(items) != 3 || items[0].ID != "c" || items[2].ID != "a" {
		t.Fatalf("expected newest-first c,b,a, got %d items %+v", len(items), items)
	}
}

func TestRedisActivityStore_TrimsToMax(t *testing.T) {
	s, _ := setupActivityStore(t)
	ctx := context.Background()
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return base }
	for i := range activityMaxItems + 5 {
		it := activityAt("a"+strconv.Itoa(i), base.Add(time.Duration(i)*time.Second))
		if err := s.AddActivity(ctx, "u-1", it); err != nil {
			t.Fatalf("AddActivity %d: %v", i, err)
		}
	}
	items, err := s.ListActivity(ctx, "u-1")
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	if len(items) != activityMaxItems {
		t.Fatalf("expected trim to %d, got %d", activityMaxItems, len(items))
	}
}

func TestRedisActivityStore_DropsExpired(t *testing.T) {
	s, _ := setupActivityStore(t)
	ctx := context.Background()
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }
	// One stale (31 days old) and one fresh.
	if err := s.AddActivity(ctx, "u-1", activityAt("old", now.Add(-31*24*time.Hour))); err != nil {
		t.Fatalf("add old: %v", err)
	}
	if err := s.AddActivity(ctx, "u-1", activityAt("new", now)); err != nil {
		t.Fatalf("add new: %v", err)
	}
	items, err := s.ListActivity(ctx, "u-1")
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	if len(items) != 1 || items[0].ID != "new" {
		t.Fatalf("expected only the fresh item, got %+v", items)
	}
}

func TestRedisActivityStore_UnreadAndSeen(t *testing.T) {
	s, _ := setupActivityStore(t)
	ctx := context.Background()
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return base }

	if ids := unreadIDs(t, s, "u-1"); len(ids) != 0 {
		t.Fatalf("empty stream unread = %v", ids)
	}
	_ = s.AddActivity(ctx, "u-1", activityAt("a", base.Add(time.Minute)))
	_ = s.AddActivity(ctx, "u-1", activityAt("b", base.Add(2*time.Minute)))
	if ids := unreadIDs(t, s, "u-1"); len(ids) != 2 {
		t.Fatalf("unread before seen = %v, want 2", ids)
	}
	// Mark seen at base+3m → both items are older → none unread.
	s.now = func() time.Time { return base.Add(3 * time.Minute) }
	if err := s.MarkActivitySeen(ctx, "u-1"); err != nil {
		t.Fatalf("MarkActivitySeen: %v", err)
	}
	if ids := unreadIDs(t, s, "u-1"); len(ids) != 0 {
		t.Fatalf("unread after seen = %v, want none", ids)
	}
	// A newer item is unread again.
	_ = s.AddActivity(ctx, "u-1", activityAt("c", base.Add(4*time.Minute)))
	if ids := unreadIDs(t, s, "u-1"); len(ids) != 1 || ids[0] != "c" {
		t.Fatalf("unread after new item = %v, want [c]", ids)
	}
}

func TestRedisActivityStore_SetActivityRead(t *testing.T) {
	s, _ := setupActivityStore(t)
	ctx := context.Background()
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return base }
	_ = s.AddActivity(ctx, "u-1", activityAt("a", base.Add(time.Minute)))
	_ = s.AddActivity(ctx, "u-1", activityAt("b", base.Add(2*time.Minute)))

	// No ids is a no-op.
	if err := s.SetActivityRead(ctx, "u-1", nil, true); err != nil {
		t.Fatalf("SetActivityRead(nil): %v", err)
	}
	// Read one item: only the other stays unread.
	if err := s.SetActivityRead(ctx, "u-1", []string{"a"}, true); err != nil {
		t.Fatalf("SetActivityRead read: %v", err)
	}
	if ids := unreadIDs(t, s, "u-1"); len(ids) != 1 || ids[0] != "b" {
		t.Fatalf("unread after reading a = %v, want [b]", ids)
	}
	// Mark it unread again.
	if err := s.SetActivityRead(ctx, "u-1", []string{"a"}, false); err != nil {
		t.Fatalf("SetActivityRead unread: %v", err)
	}
	if ids := unreadIDs(t, s, "u-1"); len(ids) != 2 {
		t.Fatalf("unread after marking a unread = %v, want 2", ids)
	}
	// Mark all read, then mark an item below the watermark unread: the
	// explicit unread wins over the watermark.
	s.now = func() time.Time { return base.Add(5 * time.Minute) }
	if err := s.MarkActivitySeen(ctx, "u-1"); err != nil {
		t.Fatalf("MarkActivitySeen: %v", err)
	}
	if err := s.SetActivityRead(ctx, "u-1", []string{"b"}, false); err != nil {
		t.Fatalf("SetActivityRead unread after seen: %v", err)
	}
	if ids := unreadIDs(t, s, "u-1"); len(ids) != 1 || ids[0] != "b" {
		t.Fatalf("unread after marking b unread = %v, want [b]", ids)
	}
	// Mark all read again clears the explicit unread.
	if err := s.MarkActivitySeen(ctx, "u-1"); err != nil {
		t.Fatalf("MarkActivitySeen again: %v", err)
	}
	if ids := unreadIDs(t, s, "u-1"); len(ids) != 0 {
		t.Fatalf("unread after second mark all = %v, want none", ids)
	}
}

func TestRedisActivityStore_RemoveActivity(t *testing.T) {
	s, client := setupActivityStore(t)
	ctx := context.Background()
	base := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return base }
	_ = s.AddActivity(ctx, "u-1", activityAt("a", base.Add(time.Minute)))
	_ = s.AddActivity(ctx, "u-1", activityAt("b", base.Add(2*time.Minute)))
	_ = s.SetActivityRead(ctx, "u-1", []string{"a"}, true)
	// A member that isn't JSON is left alone.
	if err := client.ZAdd(ctx, activityKey("u-1"), redisZ(float64(base.UnixMilli()), "not-json")).Err(); err != nil {
		t.Fatalf("seed corrupt member: %v", err)
	}

	if err := s.RemoveActivity(ctx, "u-1", nil); err != nil {
		t.Fatalf("RemoveActivity(nil): %v", err)
	}
	if err := s.RemoveActivity(ctx, "u-1", []string{"a", "missing"}); err != nil {
		t.Fatalf("RemoveActivity: %v", err)
	}
	if n, _ := client.ZCard(ctx, activityKey("u-1")).Result(); n != 2 {
		t.Fatalf("stream size after remove = %d, want 2 (b + corrupt member)", n)
	}
	if ok, _ := client.SIsMember(ctx, activityReadKey("u-1"), "a").Result(); ok {
		t.Fatal("removed item should leave the read set")
	}
	// Removing only unknown ids still succeeds.
	if err := s.RemoveActivity(ctx, "u-1", []string{"missing"}); err != nil {
		t.Fatalf("RemoveActivity unknown: %v", err)
	}
}

func TestRedisActivityStore_ListReadStateErrors(t *testing.T) {
	ctx := context.Background()
	cases := []struct {
		name string
		key  func(string) string
	}{
		{"read set wrong type", activityReadKey},
		{"unread set wrong type", activityUnreadKey},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, client := setupActivityStore(t)
			// No watermark, so Exec reports the redis.Nil from GET first and the
			// set's own error is what fails the read.
			if err := client.Set(ctx, tc.key("u-1"), "not-a-set", 0).Err(); err != nil {
				t.Fatalf("seed: %v", err)
			}
			if _, err := s.ListActivity(ctx, "u-1"); err == nil {
				t.Fatal("ListActivity should fail on a wrong-type read-state key")
			}
		})
	}
	t.Run("watermark not a number", func(t *testing.T) {
		s, client := setupActivityStore(t)
		if err := client.Set(ctx, activitySeenKey("u-1"), "abc", 0).Err(); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if _, err := s.ListActivity(ctx, "u-1"); err == nil {
			t.Fatal("ListActivity should fail on a non-numeric watermark")
		}
	})
}

func TestRedisActivityStore_ListWrongTypeStream(t *testing.T) {
	s, _ := setupActivityStore(t)
	ctx := context.Background()
	// The stream key is the wrong type → the range fails inside the pipeline.
	if err := s.client.Set(ctx, activityKey("u-1"), "not-a-zset", 0).Err(); err != nil {
		t.Fatalf("seed wrong type: %v", err)
	}
	if _, err := s.ListActivity(ctx, "u-1"); err == nil {
		t.Error("ListActivity on a wrong-type stream should error")
	}
}

func TestRedisActivityStore_ClientErrors(t *testing.T) {
	s, mrClient := setupActivityStore(t)
	ctx := context.Background()
	_ = mrClient.Close() // closed client: every command now errors
	if err := s.AddActivity(ctx, "u-1", activityAt("a", time.Now())); err == nil {
		t.Error("AddActivity on closed redis should error")
	}
	if _, err := s.ListActivity(ctx, "u-1"); err == nil {
		t.Error("ListActivity on closed redis should error")
	}
	if err := s.SetActivityRead(ctx, "u-1", []string{"a"}, true); err == nil {
		t.Error("SetActivityRead on closed redis should error")
	}
	if err := s.RemoveActivity(ctx, "u-1", []string{"a"}); err == nil {
		t.Error("RemoveActivity on closed redis should error")
	}
	if err := s.MarkActivitySeen(ctx, "u-1"); err == nil {
		t.Error("MarkActivitySeen on closed redis should error")
	}
}
