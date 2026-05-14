// Package eventlog provides a Redis Streams–backed per-user durable
// inbox for real-time events.
//
// Each user has an inbox stream `evt:<userID>`. When an event is
// published, the broker resolves its recipients and appends the
// serialized event to each recipient's stream. On a WebSocket
// reconnect, the client sends the last event ID it processed and the
// server replays everything strictly newer than that cursor, then
// switches to live delivery. Streams are trimmed with MAXLEN ~ N to
// bound memory; if the client's cursor is older than the oldest entry
// (or unknown to this stream), the server reports the cursor is
// exhausted and the client falls back to a full refetch.
//
// This package treats Redis as best-effort durable storage — AOF is
// optional. Redis loss → all replays report exhausted → clients fall
// back to existing refetch logic. The replay layer is purely additive.
package eventlog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// DefaultMaxLen is the per-user inbox cap. ~2000 events buys roughly
// an hour of replay for a heavy user without unbounded memory growth.
// Reached by trimming on each XADD with MAXLEN ~ approximate.
const DefaultMaxLen = 2000

// streamKey is the per-user inbox key.
func streamKey(userID string) string {
	return "evt:" + userID
}

// payloadField is the single XADD field name used for the event JSON
// blob. Streams require at least one field; we keep just one so the
// stream is a simple log of opaque bytes.
const payloadField = "e"

// Stream wraps a Redis client for per-user inbox operations.
type Stream struct {
	client *redis.Client
	maxLen int64
}

// NewStream returns a Stream that uses the given Redis client. Pass 0
// for maxLen to use DefaultMaxLen.
func NewStream(client *redis.Client, maxLen int64) *Stream {
	if maxLen <= 0 {
		maxLen = DefaultMaxLen
	}
	return &Stream{client: client, maxLen: maxLen}
}

// Append writes the serialized event to the given user's inbox stream
// with approximate MAXLEN trimming. Events with no ID are rejected —
// the ID is what clients use as the replay cursor and dedup key.
func (s *Stream) Append(ctx context.Context, userID string, eventID string, payload []byte) error {
	if s == nil || s.client == nil {
		return nil
	}
	if userID == "" {
		return errors.New("eventlog: empty userID")
	}
	if eventID == "" {
		return errors.New("eventlog: empty eventID")
	}
	cmd := s.client.XAdd(ctx, &redis.XAddArgs{
		Stream: streamKey(userID),
		MaxLen: s.maxLen,
		Approx: true,
		// We don't need the per-entry stream ID externally — the
		// event's own ULID is the cursor. Let Redis pick the entry ID.
		ID: "*",
		Values: map[string]any{
			payloadField: payload,
		},
	})
	if err := cmd.Err(); err != nil {
		return fmt.Errorf("eventlog: xadd: %w", err)
	}
	return nil
}

// Entry is a replayed event with its embedded ID for the cursor.
type Entry struct {
	ID      string
	Payload []byte
}

// ReplayResult is the outcome of a replay request.
type ReplayResult struct {
	Entries   []Entry
	Exhausted bool // since cursor predates the oldest retained entry — caller should full-refetch
}

// Replay returns all entries in the user's inbox strictly newer than
// `since` (a ULID). Comparison is lexicographic, which matches ULID's
// chronological ordering. If the stream's oldest retained entry has a
// ULID greater than `since`, the cursor has fallen behind retention
// and Exhausted is set so the caller knows to do a full refetch.
//
// An empty `since` returns no entries and Exhausted=false — used by
// fresh connects so the client just starts tracking from the live
// stream.
func (s *Stream) Replay(ctx context.Context, userID string, since string) (ReplayResult, error) {
	var res ReplayResult
	if s == nil || s.client == nil {
		return res, nil
	}
	if userID == "" {
		return res, errors.New("eventlog: empty userID")
	}
	if since == "" {
		return res, nil
	}
	// Walk the full stream — MAXLEN bounds this to ~2000 entries per
	// user. We read newest-first via XRevRange so a long-disconnected
	// client whose cursor is at the very end can early-exit after a
	// single entry comparison rather than scanning the whole stream.
	entries, err := s.client.XRevRangeN(ctx, streamKey(userID), "+", "-", s.maxLen+1).Result()
	if err != nil {
		return res, fmt.Errorf("eventlog: xrevrange: %w", err)
	}
	if len(entries) == 0 {
		// No retained events at all — nothing to replay, nothing to
		// claim is exhausted either.
		return res, nil
	}
	// Collect candidates strictly newer than `since`, oldest-first.
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		payloadAny, ok := e.Values[payloadField]
		if !ok {
			continue
		}
		payloadStr, ok := payloadAny.(string)
		if !ok {
			continue
		}
		// Each stream entry stores the full event envelope; pull the
		// embedded ULID out so we can compare against `since` without
		// trusting the (Redis-assigned) stream entry ID.
		var env struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal([]byte(payloadStr), &env); err != nil {
			continue
		}
		if env.ID == "" {
			continue
		}
		if env.ID <= since {
			// We hit the cursor — everything older is already seen.
			// Reverse the buffer so callers receive oldest-first.
			reverse(out)
			return ReplayResult{Entries: out}, nil
		}
		out = append(out, Entry{ID: env.ID, Payload: []byte(payloadStr)})
	}
	// If we got here without seeing `since`, the cursor predates the
	// oldest retained entry — the stream has been trimmed past it.
	// Tell the caller to fall back to a full refetch instead of
	// believing a partial replay is complete.
	reverse(out)
	return ReplayResult{Entries: out, Exhausted: true}, nil
}

func reverse(a []Entry) {
	for i, j := 0, len(a)-1; i < j; i, j = i+1, j-1 {
		a[i], a[j] = a[j], a[i]
	}
}
