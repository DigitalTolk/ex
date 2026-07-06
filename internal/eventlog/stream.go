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
	"time"

	"github.com/redis/go-redis/v9"
)

// DefaultMaxLen is the per-user inbox cap. ~2000 events buys roughly
// an hour of replay for a heavy user without unbounded memory growth.
// Reached by trimming on each XADD with MAXLEN ~ approximate.
const DefaultMaxLen = 2000

// streamTTL is the idle expiry on each per-user inbox stream, refreshed on
// every append. MAXLEN bounds a stream's *length*, but without an expiry an
// idle or departed user's stream would pin ~2000 event blobs in RAM forever —
// the keys are never otherwise deleted. 24h means an actively-connected user
// (who appends, and so refreshes, well within a day) always keeps a warm replay
// buffer, while anyone away longer than a day simply gets the already-supported
// `Exhausted` → full-refetch path on return (e.g. Monday back in the office).
// Replay is purely additive, so losing the buffer is never a correctness issue,
// only a one-off refetch. See package doc.
const streamTTL = 24 * time.Hour

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
	// XADD + EXPIRE in one round-trip so the stream's idle TTL is refreshed on
	// every append (an active user never lets it lapse).
	pipe := s.client.Pipeline()
	pipe.XAdd(ctx, &redis.XAddArgs{
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
	pipe.Expire(ctx, streamKey(userID), streamTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("eventlog: xadd: %w", err)
	}
	return nil
}

// AppendMany pipelines the same event into many users' inbox streams in a
// SINGLE Redis round-trip, instead of one XADD (and one goroutine) per
// recipient — the previous fan-out did O(recipients) separate round-trips on
// every persistent event (including every reaction/edit). Best-effort: a
// pipeline error is returned for the caller to log, but partial success is
// possible and acceptable (replay is purely additive).
func (s *Stream) AppendMany(ctx context.Context, userIDs []string, eventID string, payload []byte) error {
	if s == nil || s.client == nil {
		return nil
	}
	if eventID == "" {
		return errors.New("eventlog: empty eventID")
	}
	pipe := s.client.Pipeline()
	queued := 0
	for _, uid := range userIDs {
		if uid == "" {
			continue
		}
		pipe.XAdd(ctx, &redis.XAddArgs{
			Stream: streamKey(uid),
			MaxLen: s.maxLen,
			Approx: true,
			ID:     "*",
			Values: map[string]any{payloadField: payload},
		})
		// Refresh the idle TTL on every recipient's stream too, so a user who
		// only ever receives (never authors) still keeps a live buffer.
		pipe.Expire(ctx, streamKey(uid), streamTTL)
		queued++
	}
	if queued == 0 {
		return nil
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("eventlog: pipeline xadd: %w", err)
	}
	return nil
}

// BackfillResult reports what BackfillTTL saw and did.
type BackfillResult struct {
	Scanned int // inbox streams visited
	Missing int // streams that had no expiry set
	Updated int // streams an expiry was actually applied to (0 in dry-run)
}

// BackfillTTL one-shot applies the idle TTL to inbox streams created before the
// TTL existed. New appends self-heal (each refreshes the expiry), but a stream
// belonging to a user who never receives another event would otherwise keep no
// expiry forever — exactly the leaked memory we want to reclaim. SCANs `evt:*`,
// and for each key with no TTL (-1) sets streamTTL when apply is true. Keys that
// already have an expiry, or vanish mid-scan, are left alone, so this is
// idempotent and safe to re-run.
func (s *Stream) BackfillTTL(ctx context.Context, apply bool) (BackfillResult, error) {
	var res BackfillResult
	if s == nil || s.client == nil {
		return res, nil
	}
	var cursor uint64
	for {
		keys, next, err := s.client.Scan(ctx, cursor, streamKey("*"), 200).Result()
		if err != nil {
			return res, fmt.Errorf("eventlog: backfill scan: %w", err)
		}
		for _, key := range keys {
			res.Scanned++
			ttl, err := s.client.TTL(ctx, key).Result()
			if err != nil {
				return res, fmt.Errorf("eventlog: backfill ttl %q: %w", key, err)
			}
			// -1 = key exists with no expiry; -2 = key gone (raced); >0 = set.
			if ttl != -1*time.Nanosecond {
				continue
			}
			res.Missing++
			if !apply {
				continue
			}
			if err := s.client.Expire(ctx, key, streamTTL).Err(); err != nil {
				return res, fmt.Errorf("eventlog: backfill expire %q: %w", key, err)
			}
			res.Updated++
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	return res, nil
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
		entry, ok := parseStreamEntry(e.Values)
		if !ok {
			continue
		}
		if entry.ID <= since {
			// We hit the cursor — everything older is already seen.
			// Reverse the buffer so callers receive oldest-first.
			reverse(out)
			return ReplayResult{Entries: out}, nil
		}
		out = append(out, entry)
	}
	// If we got here without seeing `since`, the cursor predates the
	// oldest retained entry — the stream has been trimmed past it.
	// Tell the caller to fall back to a full refetch instead of
	// believing a partial replay is complete.
	reverse(out)
	return ReplayResult{Entries: out, Exhausted: true}, nil
}

// parseStreamEntry turns one XREVRANGE entry's values map into an Entry.
// Each stream entry stores the full event envelope under payloadField; the
// embedded ULID is pulled out so Replay can compare against its cursor
// without trusting the (Redis-assigned) stream entry ID. Returns ok=false
// for entries Replay must skip: no payload field, a payload that is not a
// string (the map is typed any; go-redis always delivers bulk strings, but
// the shape alone doesn't guarantee it), malformed envelope JSON, or an
// envelope with no ID.
func parseStreamEntry(values map[string]any) (Entry, bool) {
	payloadAny, ok := values[payloadField]
	if !ok {
		return Entry{}, false
	}
	payloadStr, ok := payloadAny.(string)
	if !ok {
		return Entry{}, false
	}
	var env struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(payloadStr), &env); err != nil {
		return Entry{}, false
	}
	if env.ID == "" {
		return Entry{}, false
	}
	return Entry{ID: env.ID, Payload: []byte(payloadStr)}, true
}

func reverse(a []Entry) {
	for i, j := 0, len(a)-1; i < j; i, j = i+1, j-1 {
		a[i], a[j] = a[j], a[i]
	}
}
