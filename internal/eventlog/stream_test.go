package eventlog

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newTestStream(t *testing.T, maxLen int64) (*Stream, *miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	return NewStream(client, maxLen), mr, client
}

func appendEvent(t *testing.T, s *Stream, userID, id string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"id":   id,
		"type": "message.new",
		"data": map[string]string{"id": id},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := s.Append(context.Background(), userID, id, payload); err != nil {
		t.Fatalf("Append: %v", err)
	}
	return payload
}

// Append + Replay round-trip: events written into a user's inbox come
// back out in publish order when the cursor is older than all of
// them, and only the strictly-newer ones come back when the cursor
// is mid-stream.
func TestStream_AppendMany(t *testing.T) {
	s, _, _ := newTestStream(t, 0)
	payload, _ := json.Marshal(map[string]any{"id": "01ID0000000000000000000009", "type": "message.new"})

	// Pipelines the same event into every recipient's inbox (skipping empty IDs).
	if err := s.AppendMany(context.Background(), []string{"u1", "", "u2"}, "01ID0000000000000000000009", payload); err != nil {
		t.Fatalf("AppendMany: %v", err)
	}
	for _, uid := range []string{"u1", "u2"} {
		res, err := s.Replay(context.Background(), uid, "00ID0000000000000000000000")
		if err != nil {
			t.Fatalf("Replay %s: %v", uid, err)
		}
		if len(res.Entries) != 1 || res.Entries[0].ID != "01ID0000000000000000000009" {
			t.Errorf("%s inbox = %+v, want the one appended event", uid, res.Entries)
		}
	}

	// All-empty recipient list → no-op, no error.
	if err := s.AppendMany(context.Background(), []string{"", ""}, "01ID0000000000000000000009", payload); err != nil {
		t.Errorf("AppendMany with only empty IDs should be a no-op, got %v", err)
	}

	// Empty eventID → rejected.
	if err := s.AppendMany(context.Background(), []string{"u1"}, "", payload); err == nil {
		t.Error("AppendMany with empty eventID should error")
	}

	// Nil-safe.
	var nilStream *Stream
	if err := nilStream.AppendMany(context.Background(), []string{"u1"}, "x", payload); err != nil {
		t.Errorf("nil stream AppendMany should be a no-op, got %v", err)
	}

	// Pipeline Exec error surfaces (closed client).
	deadStream, _, deadClient := newTestStream(t, 0)
	_ = deadClient.Close()
	if err := deadStream.AppendMany(context.Background(), []string{"u1"}, "01ID0000000000000000000009", payload); err == nil {
		t.Error("AppendMany on a closed client should return the pipeline error")
	}
}

func TestStream_AppendReplayHappyPath(t *testing.T) {
	s, _, _ := newTestStream(t, 0)
	appendEvent(t, s, "u1", "01ID0000000000000000000001")
	appendEvent(t, s, "u1", "01ID0000000000000000000002")
	appendEvent(t, s, "u1", "01ID0000000000000000000003")

	t.Run("cursor before all entries returns everything", func(t *testing.T) {
		res, err := s.Replay(context.Background(), "u1", "00ID0000000000000000000000")
		if err != nil {
			t.Fatalf("Replay: %v", err)
		}
		if got, want := len(res.Entries), 3; got != want {
			t.Fatalf("entries = %d, want %d", got, want)
		}
		// Entries must be oldest-first so the client applies them in
		// the order they originally happened.
		for i, want := range []string{"01ID0000000000000000000001", "01ID0000000000000000000002", "01ID0000000000000000000003"} {
			if res.Entries[i].ID != want {
				t.Errorf("entry[%d] = %q, want %q", i, res.Entries[i].ID, want)
			}
		}
		// A cursor older than the oldest retained entry should NOT
		// be reported exhausted as long as we found the cursor was
		// before the start of a non-trimmed stream. Here the stream
		// has 3 entries and we haven't trimmed anything, but we
		// also didn't see the literal cursor — exhausted IS true.
		if !res.Exhausted {
			t.Error("expected exhausted=true for cursor older than oldest retained entry")
		}
	})

	t.Run("cursor mid-stream returns strictly newer", func(t *testing.T) {
		res, err := s.Replay(context.Background(), "u1", "01ID0000000000000000000002")
		if err != nil {
			t.Fatalf("Replay: %v", err)
		}
		if got, want := len(res.Entries), 1; got != want {
			t.Fatalf("entries = %d, want %d", got, want)
		}
		if res.Entries[0].ID != "01ID0000000000000000000003" {
			t.Errorf("entry = %q, want %q", res.Entries[0].ID, "01ID0000000000000000000003")
		}
		if res.Exhausted {
			t.Error("expected exhausted=false when cursor found in stream")
		}
	})

	t.Run("cursor at the tip returns nothing", func(t *testing.T) {
		res, err := s.Replay(context.Background(), "u1", "01ID0000000000000000000003")
		if err != nil {
			t.Fatalf("Replay: %v", err)
		}
		if len(res.Entries) != 0 {
			t.Fatalf("entries = %d, want 0", len(res.Entries))
		}
		if res.Exhausted {
			t.Error("expected exhausted=false at stream tip")
		}
	})
}

// Empty cursor (fresh client) skips replay entirely — no entries,
// not exhausted — so the client just starts tracking the live
// stream. This is the default "first connect" path.
func TestStream_ReplayEmptyCursor(t *testing.T) {
	s, _, _ := newTestStream(t, 0)
	appendEvent(t, s, "u1", "01ID0000000000000000000001")

	res, err := s.Replay(context.Background(), "u1", "")
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(res.Entries) != 0 {
		t.Errorf("entries = %d, want 0 for empty cursor", len(res.Entries))
	}
	if res.Exhausted {
		t.Error("expected exhausted=false for empty cursor")
	}
}

// A user whose inbox is empty (never appended, or trimmed to zero by
// Redis) gets an empty replay — not exhausted, just nothing to
// replay. The cursor stays valid for the next reconnect.
func TestStream_ReplayEmptyStream(t *testing.T) {
	s, _, _ := newTestStream(t, 0)
	res, err := s.Replay(context.Background(), "u-fresh", "01ID0000000000000000000001")
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(res.Entries) != 0 {
		t.Errorf("entries = %d, want 0", len(res.Entries))
	}
	if res.Exhausted {
		t.Error("expected exhausted=false when stream is empty (nothing to be exhausted from)")
	}
}

// Cursor predates the oldest retained entry — the stream has been
// trimmed past it. Replay returns whatever's still there and reports
// exhausted so the caller falls back to a full refetch.
func TestStream_ReplayExhaustedAfterTrim(t *testing.T) {
	s, _, _ := newTestStream(t, 2) // MAXLEN ~ 2
	appendEvent(t, s, "u1", "01ID0000000000000000000001")
	appendEvent(t, s, "u1", "01ID0000000000000000000002")
	appendEvent(t, s, "u1", "01ID0000000000000000000003")
	appendEvent(t, s, "u1", "01ID0000000000000000000004")

	res, err := s.Replay(context.Background(), "u1", "01ID0000000000000000000001")
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if !res.Exhausted {
		t.Error("expected exhausted=true when cursor predates retained entries")
	}
	// Whatever survived the trim should still be flushed to the
	// client — dropping data the client is about to refetch anyway
	// is harmless (dedups by ID) but flushing what we have closes
	// the gap faster.
	if len(res.Entries) == 0 {
		t.Error("expected some entries even on exhausted path")
	}
}

// Append must reject empty userID and empty eventID — both are
// programmer errors that would corrupt the cursor/dedup contract.
func TestStream_AppendRejectsEmptyInputs(t *testing.T) {
	s, _, _ := newTestStream(t, 0)
	if err := s.Append(context.Background(), "", "01ID", []byte("{}")); err == nil {
		t.Error("expected error for empty userID")
	}
	if err := s.Append(context.Background(), "u1", "", []byte("{}")); err == nil {
		t.Error("expected error for empty eventID")
	}
}

// A nil Stream and a Stream with a nil client are both safe no-ops —
// the WS handler always calls into the inbox without checking if
// durability was wired, so the package has to absorb that gracefully.
func TestStream_NilSafe(t *testing.T) {
	var s *Stream
	if err := s.Append(context.Background(), "u", "01", []byte("{}")); err != nil {
		t.Errorf("nil Stream Append should be a no-op, got %v", err)
	}
	res, err := s.Replay(context.Background(), "u", "01")
	if err != nil {
		t.Errorf("nil Stream Replay should be a no-op, got %v", err)
	}
	if len(res.Entries) != 0 || res.Exhausted {
		t.Error("nil Stream Replay should return empty result")
	}

	s = &Stream{} // client unset
	if err := s.Append(context.Background(), "u", "01", []byte("{}")); err != nil {
		t.Errorf("client-less Stream Append should be a no-op, got %v", err)
	}
	res, err = s.Replay(context.Background(), "u", "01")
	if err != nil {
		t.Errorf("client-less Stream Replay should be a no-op, got %v", err)
	}
	if len(res.Entries) != 0 || res.Exhausted {
		t.Error("client-less Stream Replay should return empty result")
	}
}

// Replay must propagate Redis errors so the WS handler can log them
// and fall back to replay.exhausted rather than silently delivering
// partial data.
func TestStream_ReplayPropagatesRedisError(t *testing.T) {
	s, mr, _ := newTestStream(t, 0)
	appendEvent(t, s, "u1", "01ID0000000000000000000001")
	mr.Close() // simulate Redis loss
	_, err := s.Replay(context.Background(), "u1", "01ID0000000000000000000000")
	if err == nil {
		t.Error("expected error after Redis closed")
	}
}

// Append must propagate Redis errors so the publisher (which logs
// them) doesn't believe the durability fan-out succeeded.
func TestStream_AppendPropagatesRedisError(t *testing.T) {
	s, mr, _ := newTestStream(t, 0)
	mr.Close()
	err := s.Append(context.Background(), "u1", "01ID", []byte("{}"))
	if err == nil {
		t.Error("expected error after Redis closed")
	}
}

// DefaultMaxLen kicks in when caller passes 0 — defends against an
// accidentally-unbounded stream that would consume Redis memory.
func TestNewStream_AppliesDefaultMaxLen(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	s := NewStream(client, 0)
	if s.maxLen != DefaultMaxLen {
		t.Errorf("maxLen = %d, want %d", s.maxLen, DefaultMaxLen)
	}
	s = NewStream(client, -10)
	if s.maxLen != DefaultMaxLen {
		t.Errorf("maxLen for negative input = %d, want %d", s.maxLen, DefaultMaxLen)
	}
	s = NewStream(client, 5)
	if s.maxLen != 5 {
		t.Errorf("maxLen = %d, want 5", s.maxLen)
	}
}

// Entries whose stored payload doesn't include an `id` (corrupted /
// pre-replay legacy) must be skipped silently — the stream is
// best-effort and one bad entry shouldn't break the whole replay.
func TestStream_ReplaySkipsEntriesWithoutID(t *testing.T) {
	s, _, client := newTestStream(t, 0)
	// Inject a payload without an `id` field.
	_ = client.XAdd(context.Background(), &redis.XAddArgs{
		Stream: "evt:u1",
		ID:     "*",
		Values: map[string]any{"e": `{"type":"x"}`},
	}).Err()
	appendEvent(t, s, "u1", "01ID0000000000000000000002")
	res, err := s.Replay(context.Background(), "u1", "01ID0000000000000000000000")
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(res.Entries) != 1 || res.Entries[0].ID != "01ID0000000000000000000002" {
		t.Errorf("expected only the well-formed entry to come back, got %+v", res.Entries)
	}
}

// Append refreshes the per-user inbox stream's idle TTL on every write, so an
// actively-connected user never lets the replay buffer lapse.
func TestStream_AppendSetsTTL(t *testing.T) {
	s, _, client := newTestStream(t, 0)
	appendEvent(t, s, "u1", "01ID0000000000000000000001")
	ttl, err := client.TTL(context.Background(), "evt:u1").Result()
	if err != nil {
		t.Fatalf("TTL: %v", err)
	}
	if ttl <= 0 || ttl > streamTTL {
		t.Errorf("Append TTL = %v, want (0, %v]", ttl, streamTTL)
	}
}

// AppendMany sets the idle TTL on every recipient's stream — including a user
// who only ever receives (never authors) events.
func TestStream_AppendManySetsTTL(t *testing.T) {
	s, _, client := newTestStream(t, 0)
	payload, _ := json.Marshal(map[string]any{"id": "01ID0000000000000000000005", "type": "message.new"})
	if err := s.AppendMany(context.Background(), []string{"u1", "u2"}, "01ID0000000000000000000005", payload); err != nil {
		t.Fatalf("AppendMany: %v", err)
	}
	for _, uid := range []string{"u1", "u2"} {
		ttl, err := client.TTL(context.Background(), "evt:"+uid).Result()
		if err != nil {
			t.Fatalf("TTL %s: %v", uid, err)
		}
		if ttl <= 0 || ttl > streamTTL {
			t.Errorf("%s TTL = %v, want (0, %v]", uid, ttl, streamTTL)
		}
	}
}

// BackfillTTL applies the idle TTL to legacy streams that have none, leaves
// already-expiring streams alone, and (in dry-run) reports without writing.
func TestStream_BackfillTTL(t *testing.T) {
	s, _, client := newTestStream(t, 0)
	ctx := context.Background()
	// A legacy stream with no TTL (raw XADD, bypassing Append's expire).
	if err := client.XAdd(ctx, &redis.XAddArgs{Stream: "evt:legacy", ID: "*", Values: map[string]any{"e": "{}"}}).Err(); err != nil {
		t.Fatalf("seed legacy: %v", err)
	}
	// A stream that already has a TTL (via Append).
	appendEvent(t, s, "fresh", "01ID0000000000000000000007")

	// Dry-run: counts the missing-TTL stream but writes nothing.
	res, err := s.BackfillTTL(ctx, false)
	if err != nil {
		t.Fatalf("BackfillTTL dry-run: %v", err)
	}
	if res.Scanned != 2 || res.Missing != 1 || res.Updated != 0 {
		t.Errorf("dry-run result = %+v, want scanned=2 missing=1 updated=0", res)
	}
	if ttl, _ := client.TTL(ctx, "evt:legacy").Result(); ttl != -1*time.Nanosecond {
		t.Errorf("dry-run must not set a TTL, got %v", ttl)
	}

	// Apply: sets the TTL on the legacy stream only.
	res, err = s.BackfillTTL(ctx, true)
	if err != nil {
		t.Fatalf("BackfillTTL apply: %v", err)
	}
	if res.Missing != 1 || res.Updated != 1 {
		t.Errorf("apply result = %+v, want missing=1 updated=1", res)
	}
	if ttl, _ := client.TTL(ctx, "evt:legacy").Result(); ttl <= 0 || ttl > streamTTL {
		t.Errorf("legacy TTL after apply = %v, want (0, %v]", ttl, streamTTL)
	}

	// Re-run is idempotent: nothing left without a TTL.
	res, err = s.BackfillTTL(ctx, true)
	if err != nil {
		t.Fatalf("BackfillTTL rerun: %v", err)
	}
	if res.Missing != 0 || res.Updated != 0 {
		t.Errorf("rerun result = %+v, want missing=0 updated=0", res)
	}
}

// A nil Stream (durability disabled) no-ops rather than panicking.
func TestStream_BackfillTTLNil(t *testing.T) {
	var s *Stream
	res, err := s.BackfillTTL(context.Background(), true)
	if err != nil || res.Scanned != 0 {
		t.Errorf("nil BackfillTTL = (%+v, %v), want (empty, nil)", res, err)
	}
}

// Replay rejects an empty userID and skips structurally-malformed stream
// entries (missing payload field, unparseable JSON) rather than failing the
// whole replay.
func TestStream_ReplayEmptyUserAndMalformed(t *testing.T) {
	s, _, client := newTestStream(t, 0)
	ctx := context.Background()
	if _, err := s.Replay(ctx, "", "01ID0000000000000000000001"); err == nil {
		t.Error("Replay with empty userID should error")
	}
	// Entry missing the payload field.
	_ = client.XAdd(ctx, &redis.XAddArgs{Stream: "evt:u1", ID: "*", Values: map[string]any{"other": "x"}}).Err()
	// Entry whose payload is not valid JSON.
	_ = client.XAdd(ctx, &redis.XAddArgs{Stream: "evt:u1", ID: "*", Values: map[string]any{"e": "not-json"}}).Err()
	// A well-formed entry that should still come back.
	appendEvent(t, s, "u1", "01ID0000000000000000000002")
	res, err := s.Replay(ctx, "u1", "01ID0000000000000000000000")
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(res.Entries) != 1 || res.Entries[0].ID != "01ID0000000000000000000002" {
		t.Fatalf("malformed entries should be skipped, got %+v", res.Entries)
	}
}

// A transport error during the SCAN surfaces (closed client).
func TestStream_BackfillTTLScanError(t *testing.T) {
	deadStream, _, deadClient := newTestStream(t, 0)
	_ = deadClient.Close()
	if _, err := deadStream.BackfillTTL(context.Background(), true); err == nil {
		t.Error("BackfillTTL on a closed client should return the scan error")
	}
}
