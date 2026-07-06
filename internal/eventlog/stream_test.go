package eventlog

import (
	"context"
	"testing"

	"github.com/redis/go-redis/v9"
)

// lazyClient returns a go-redis client that is never dialed — the tests below
// exercise pure validation/constructor paths that error (or return) before any
// Redis I/O, so no server is needed. Redis-backed Stream tests live in the
// integration-tagged files and run against a real container.
func lazyClient(t *testing.T) *redis.Client {
	t.Helper()
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:0"})
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// Append must reject empty userID and empty eventID — both are
// programmer errors that would corrupt the cursor/dedup contract.
func TestStream_AppendRejectsEmptyInputs(t *testing.T) {
	s := NewStream(lazyClient(t), 0)
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

// DefaultMaxLen kicks in when caller passes 0 — defends against an
// accidentally-unbounded stream that would consume Redis memory.
func TestNewStream_AppliesDefaultMaxLen(t *testing.T) {
	client := lazyClient(t)
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

// A nil Stream (durability disabled) no-ops rather than panicking.
func TestStream_BackfillTTLNil(t *testing.T) {
	var s *Stream
	res, err := s.BackfillTTL(context.Background(), true)
	if err != nil || res.Scanned != 0 {
		t.Errorf("nil BackfillTTL = (%+v, %v), want (empty, nil)", res, err)
	}
}

// A transport error during the SCAN surfaces (closed client — go-redis fails
// the command before any I/O, so no server is involved).
func TestStream_BackfillTTLScanError(t *testing.T) {
	deadClient := redis.NewClient(&redis.Options{Addr: "127.0.0.1:0"})
	_ = deadClient.Close()
	deadStream := NewStream(deadClient, 0)
	if _, err := deadStream.BackfillTTL(context.Background(), true); err == nil {
		t.Error("BackfillTTL on a closed client should return the scan error")
	}
}

// parseStreamEntry is the per-entry decode Replay runs on each stream record.
// The non-string-payload arm cannot be reached through go-redis (stream values
// always arrive as bulk strings), so the helper is exercised directly with the
// full matrix of skippable shapes plus the happy path.
func TestParseStreamEntry(t *testing.T) {
	cases := []struct {
		name   string
		values map[string]any
		wantID string
		wantOK bool
	}{
		{"missing payload field", map[string]any{"other": "x"}, "", false},
		{"non-string payload", map[string]any{payloadField: 42}, "", false},
		{"malformed JSON", map[string]any{payloadField: "not-json"}, "", false},
		{"empty ID", map[string]any{payloadField: `{"type":"x"}`}, "", false},
		{"well-formed", map[string]any{payloadField: `{"id":"01OK","type":"x"}`}, "01OK", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, ok := parseStreamEntry(tc.values)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if e.ID != tc.wantID {
				t.Errorf("ID = %q, want %q", e.ID, tc.wantID)
			}
			if raw, isStr := tc.values[payloadField].(string); ok && isStr && string(e.Payload) != raw {
				t.Errorf("Payload = %q, want the raw payload string %q", e.Payload, raw)
			}
		})
	}
}
