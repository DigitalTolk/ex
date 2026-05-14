package eventlog

import (
	"context"
	"encoding/json"
	"testing"

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
