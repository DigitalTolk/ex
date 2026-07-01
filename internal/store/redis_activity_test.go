package store

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func setupActivityStore(t *testing.T) (*RedisActivityStore, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1, DialTimeout: 150 * time.Millisecond})
	t.Cleanup(func() { _ = client.Close() })
	return NewRedisActivityStore(client), mr
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
	// One stale (8 days old) and one fresh.
	if err := s.AddActivity(ctx, "u-1", activityAt("old", now.Add(-8*24*time.Hour))); err != nil {
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

	n, err := s.UnreadActivityCount(ctx, "u-1")
	if err != nil || n != 0 {
		t.Fatalf("empty unread = %d, %v", n, err)
	}
	_ = s.AddActivity(ctx, "u-1", activityAt("a", base.Add(time.Minute)))
	_ = s.AddActivity(ctx, "u-1", activityAt("b", base.Add(2*time.Minute)))
	if n, _ := s.UnreadActivityCount(ctx, "u-1"); n != 2 {
		t.Fatalf("unread before seen = %d, want 2", n)
	}
	// Mark seen at base+3m → both items are older → unread 0.
	s.now = func() time.Time { return base.Add(3 * time.Minute) }
	if err := s.MarkActivitySeen(ctx, "u-1"); err != nil {
		t.Fatalf("MarkActivitySeen: %v", err)
	}
	if n, _ := s.UnreadActivityCount(ctx, "u-1"); n != 0 {
		t.Fatalf("unread after seen = %d, want 0", n)
	}
	// A newer item bumps unread again.
	_ = s.AddActivity(ctx, "u-1", activityAt("c", base.Add(4*time.Minute)))
	if n, _ := s.UnreadActivityCount(ctx, "u-1"); n != 1 {
		t.Fatalf("unread after new item = %d, want 1", n)
	}
}

func TestRedisActivityStore_UnreadCountError(t *testing.T) {
	s, _ := setupActivityStore(t)
	ctx := context.Background()
	// A valid seen watermark, but the activity key is the wrong type → ZCount
	// errors WRONGTYPE after the Get succeeds, exercising the count-error branch.
	if err := s.client.Set(ctx, activitySeenKey("u-1"), 0, 0).Err(); err != nil {
		t.Fatalf("seed seen: %v", err)
	}
	if err := s.client.Set(ctx, activityKey("u-1"), "not-a-zset", 0).Err(); err != nil {
		t.Fatalf("seed wrong type: %v", err)
	}
	if _, err := s.UnreadActivityCount(ctx, "u-1"); err == nil {
		t.Error("ZCount on a wrong-type key should error")
	}
}

func TestRedisActivityStore_ClientErrors(t *testing.T) {
	s, mr := setupActivityStore(t)
	ctx := context.Background()
	mr.Close() // every command now errors
	if err := s.AddActivity(ctx, "u-1", activityAt("a", time.Now())); err == nil {
		t.Error("AddActivity on closed redis should error")
	}
	if _, err := s.ListActivity(ctx, "u-1"); err == nil {
		t.Error("ListActivity on closed redis should error")
	}
	if _, err := s.UnreadActivityCount(ctx, "u-1"); err == nil {
		t.Error("UnreadActivityCount on closed redis should error")
	}
	if err := s.MarkActivitySeen(ctx, "u-1"); err == nil {
		t.Error("MarkActivitySeen on closed redis should error")
	}
}
