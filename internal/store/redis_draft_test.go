package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func setupRedisDraftStore(t *testing.T) (*RedisDraftStore, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	// Fail fast when the test closes miniredis (the ClientErrors case) instead of
	// burning seconds on dial retries.
	client := redis.NewClient(&redis.Options{Addr: mr.Addr(), MaxRetries: -1, DialTimeout: 150 * time.Millisecond})
	t.Cleanup(func() { _ = client.Close() })
	return NewRedisDraftStore(client), mr
}

func draftAt(id, user, body string, ts int64) *model.MessageDraft {
	return &model.MessageDraft{ID: id, UserID: user, ParentID: "ch-1", ParentType: "channel", Body: body, Ts: ts}
}

func TestRedisDraftStore_UpsertGetListDelete(t *testing.T) {
	s, _ := setupRedisDraftStore(t)
	ctx := context.Background()

	if _, err := s.Get(ctx, "u-1", "d-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v, want ErrNotFound", err)
	}

	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "hello", 100)); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	got, err := s.Get(ctx, "u-1", "d-1")
	if err != nil || got.Body != "hello" || got.Ts != 100 {
		t.Fatalf("Get = %#v, err=%v", got, err)
	}

	if err := s.Upsert(ctx, draftAt("d-2", "u-1", "world", 100)); err != nil {
		t.Fatalf("Upsert d-2: %v", err)
	}
	list, err := s.List(ctx, "u-1")
	if err != nil || len(list) != 2 {
		t.Fatalf("List = %#v, err=%v", list, err)
	}
	if other, _ := s.List(ctx, "u-other"); len(other) != 0 {
		t.Fatalf("List for another user should be empty, got %#v", other)
	}

	if err := s.Delete(ctx, "u-1", "d-1", 200); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := s.Get(ctx, "u-1", "d-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete = %v, want ErrNotFound", err)
	}
}

func TestRedisDraftStore_LastWriteWins(t *testing.T) {
	s, _ := setupRedisDraftStore(t)
	ctx := context.Background()

	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "v2", 200)); err != nil {
		t.Fatalf("Upsert v2: %v", err)
	}
	// An older write (ts ≤ stored) is dropped.
	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "v1-stale", 150)); err != nil {
		t.Fatalf("stale Upsert: %v", err)
	}
	if got, _ := s.Get(ctx, "u-1", "d-1"); got.Body != "v2" {
		t.Fatalf("stale write should be ignored, got %q", got.Body)
	}
	// An equal ts is also dropped (strictly-newer wins).
	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "v2b", 200)); err != nil {
		t.Fatalf("equal Upsert: %v", err)
	}
	if got, _ := s.Get(ctx, "u-1", "d-1"); got.Body != "v2" {
		t.Fatalf("equal-ts write should be ignored, got %q", got.Body)
	}
	// A newer write wins.
	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "v3", 300)); err != nil {
		t.Fatalf("newer Upsert: %v", err)
	}
	if got, _ := s.Get(ctx, "u-1", "d-1"); got.Body != "v3" {
		t.Fatalf("newer write should win, got %q", got.Body)
	}
}

func TestRedisDraftStore_DeleteTombstoneRejectsStaleResurrect(t *testing.T) {
	s, _ := setupRedisDraftStore(t)
	ctx := context.Background()

	// Draft saved (ts=10), then "sent" → delete at ts=12 (tombstone).
	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "typed", 10)); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if err := s.Delete(ctx, "u-1", "d-1", 12); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	// A delayed keystroke save (ts=10, captured before the send) must NOT
	// resurrect the sent draft.
	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "typed", 10)); err != nil {
		t.Fatalf("late Upsert: %v", err)
	}
	if _, err := s.Get(ctx, "u-1", "d-1"); !errors.Is(err, ErrNotFound) {
		t.Fatal("a pre-send keystroke must not resurrect a sent draft")
	}
	// But typing genuinely new content after the send (ts=20) creates a draft.
	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "new draft", 20)); err != nil {
		t.Fatalf("new Upsert: %v", err)
	}
	if got, err := s.Get(ctx, "u-1", "d-1"); err != nil || got.Body != "new draft" {
		t.Fatalf("post-send edit should create a fresh draft, got %#v err=%v", got, err)
	}
}

func TestRedisDraftStore_DeleteOlderThanStoredIsNoop(t *testing.T) {
	s, _ := setupRedisDraftStore(t)
	ctx := context.Background()

	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "fresh", 100)); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	// A stale delete (ts < stored) must not remove the newer draft.
	if err := s.Delete(ctx, "u-1", "d-1", 50); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, err := s.Get(ctx, "u-1", "d-1"); err != nil || got.Body != "fresh" {
		t.Fatalf("stale delete should be a no-op, got %#v err=%v", got, err)
	}
}

func TestRedisDraftStore_ClientErrors(t *testing.T) {
	s, mr := setupRedisDraftStore(t)
	ctx := context.Background()
	mr.Close()
	if err := s.Upsert(ctx, draftAt("d-1", "u-1", "x", 1)); err == nil {
		t.Error("Upsert should error when Redis is down")
	}
	if _, err := s.Get(ctx, "u-1", "d-1"); err == nil {
		t.Error("Get should error when Redis is down")
	}
	if _, err := s.List(ctx, "u-1"); err == nil {
		t.Error("List should error when Redis is down")
	}
	if err := s.Delete(ctx, "u-1", "d-1", 1); err == nil {
		t.Error("Delete should error when Redis is down")
	}
}

// Regression for the "Redis memory only ever grows" leak: draft IDs are
// deterministic per scope, so every scope a user ever sent in left a
// PERMANENT tombstone field in draftts:{u} (and every send refreshed the
// hash TTL, so it never expired). Aged pure tombstones must be swept by
// the next write; fresh tombstones and live drafts must survive.
func TestRedisDraftStore_SweepsAgedTombstones(t *testing.T) {
	s, mr := setupRedisDraftStore(t)
	ctx := context.Background()
	base := time.Now()
	s.now = func() time.Time { return base }

	// A cleared draft (the send path) leaves a tombstone…
	if err := s.Delete(ctx, "u1", "scope-old", base.UnixMilli()); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	// …and a live draft plus a second, recent tombstone exist alongside it.
	if err := s.Upsert(ctx, &model.MessageDraft{ID: "scope-live", UserID: "u1", Body: "wip", Ts: base.UnixMilli()}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	if err := s.Delete(ctx, "u1", "scope-fresh", base.Add(time.Hour).UnixMilli()); err != nil {
		t.Fatalf("Delete fresh: %v", err)
	}
	if got := mr.HGet("draftts:u1", "scope-old"); got == "" {
		t.Fatal("precondition: tombstone for scope-old must exist")
	}

	// Eight days later, ANY write sweeps the aged tombstone…
	s.now = func() time.Time { return base.Add(8 * 24 * time.Hour) }
	if err := s.Delete(ctx, "u1", "scope-new", base.Add(8*24*time.Hour).UnixMilli()); err != nil {
		t.Fatalf("Delete new: %v", err)
	}
	if got := mr.HGet("draftts:u1", "scope-old"); got != "" {
		t.Fatalf("aged tombstone must be swept, still present: %q", got)
	}
	if got := mr.HGet("draftts:u1", "scope-fresh"); got != "" {
		t.Fatalf("aged tombstone scope-fresh must be swept too, still present: %q", got)
	}
	// The live draft keeps BOTH its content and its ts (it is not a tombstone)…
	if got := mr.HGet("draft:u1", "scope-live"); got == "" {
		t.Fatal("live draft content must never be swept")
	}
	if got := mr.HGet("draftts:u1", "scope-live"); got == "" {
		t.Fatal("live draft ts must never be swept")
	}
	// …and the just-written tombstone survives (it is inside the window).
	if got := mr.HGet("draftts:u1", "scope-new"); got == "" {
		t.Fatal("fresh tombstone must survive the sweep")
	}

	// LWW is untouched for surviving tombstones: a delayed save older than
	// the fresh tombstone still loses.
	if err := s.Upsert(ctx, &model.MessageDraft{ID: "scope-new", UserID: "u1", Body: "stale", Ts: base.UnixMilli()}); err != nil {
		t.Fatalf("Upsert stale: %v", err)
	}
	if got := mr.HGet("draft:u1", "scope-new"); got != "" {
		t.Fatalf("delayed save must not resurrect a sent draft, got %q", got)
	}
}
