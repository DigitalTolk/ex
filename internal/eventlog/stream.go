// Package eventlog provides a Redis Streams–backed per-user durable
// inbox for real-time events.
//
// Each user has an inbox stream `evt:<userID>`. When an event is
// published, the broker resolves its recipients, stores the serialized
// event ONCE under `evtp:<eventID>`, and appends only the event ID to each
// recipient's stream (a full copy per recipient made one post to a
// 1000-member channel write megabytes). On a WebSocket
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

// payloadField is the XADD field that carried the full event JSON in every
// recipient's stream. Nothing writes it any more — payloads are stored once
// under payloadKey — but entries written before that change still carry it,
// and Replay keeps reading them.
const payloadField = "e"

// idField carries the event's ULID. A stream entry is now just this field: a
// pointer to the payload stored under payloadKey(id). Entries older than the
// pointer format also hold payloadField; the oldest hold only payloadField and
// fall back to the envelope JSON for the ID.
const idField = "i"

// payloadTTL bounds how long a stored payload stays resolvable. It matches the
// stream's idle TTL: a client away longer than a day replays any pointer whose
// payload has lapsed as a gap, which reports Exhausted and sends it down the
// full-refetch path — the same outcome as its stream lapsing.
const payloadTTL = streamTTL

// payloadKey is where one event's serialized payload lives, shared by every
// recipient stream that points at it. "evtp:" never matches the "evt:*"
// stream SCAN in BackfillTTL.
func payloadKey(eventID string) string {
	return "evtp:" + eventID
}

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

// Append writes the event to one user's inbox (see AppendMany). Events with
// no ID are rejected — the ID is what clients use as the replay cursor and
// dedup key.
func (s *Stream) Append(ctx context.Context, userID string, eventID string, payload []byte) error {
	if s == nil || s.client == nil {
		return nil
	}
	if userID == "" {
		return errors.New("eventlog: empty userID")
	}
	return s.AppendMany(ctx, []string{userID}, eventID, payload)
}

// AppendMany stores the event payload ONCE (payloadKey, payloadTTL) and
// appends a pointer — just the event ID — to every recipient's inbox stream,
// all in a SINGLE pipelined round-trip. The payload SET is queued first, so
// it lands before any pointer that refers to it.
//
// A pipeline error is returned for the caller to retry: partial success
// leaves MID-STREAM HOLES the replay cursor cannot detect (a `replay.done`
// after a hole silently loses the event), so a persistent failure must be
// followed by Drop — an empty stream forces the exhausted → full-refetch path
// instead. A pointer whose payload write was the part that failed replays as
// a gap (Exhausted), never as a silent skip.
func (s *Stream) AppendMany(ctx context.Context, userIDs []string, eventID string, payload []byte) error {
	if s == nil || s.client == nil {
		return nil
	}
	if eventID == "" {
		return errors.New("eventlog: empty eventID")
	}
	recipients := make([]string, 0, len(userIDs))
	for _, uid := range userIDs {
		if uid != "" {
			recipients = append(recipients, uid)
		}
	}
	if len(recipients) == 0 {
		return nil
	}
	pipe := s.client.Pipeline()
	pipe.Set(ctx, payloadKey(eventID), payload, payloadTTL)
	for _, uid := range recipients {
		pipe.XAdd(ctx, &redis.XAddArgs{
			Stream: streamKey(uid),
			MaxLen: s.maxLen,
			Approx: true,
			// The entry's Redis ID is not used — the event's own ULID is the
			// cursor — so let Redis pick it.
			ID:     "*",
			Values: map[string]any{idField: eventID},
		})
		// Refresh the idle TTL on every recipient's stream, so a user who
		// only ever receives (never authors) still keeps a live buffer.
		pipe.Expire(ctx, streamKey(uid), streamTTL)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("eventlog: pipeline xadd: %w", err)
	}
	return nil
}

// Drop deletes the given users' inbox streams entirely. Called when a
// fan-out append persistently failed: those streams may now have mid-stream
// holes that replay cannot detect, and a poisoned-but-plausible stream is
// WORSE than no stream — an empty stream sends the reconnecting client down
// the exhausted → full-refetch path, which recovers everything.
func (s *Stream) Drop(ctx context.Context, userIDs []string) error {
	if s == nil || s.client == nil || len(userIDs) == 0 {
		return nil
	}
	keys := make([]string, 0, len(userIDs))
	for _, uid := range userIDs {
		if uid != "" {
			keys = append(keys, streamKey(uid))
		}
	}
	if len(keys) == 0 {
		return nil
	}
	if err := s.client.Del(ctx, keys...).Err(); err != nil {
		return fmt.Errorf("eventlog: drop streams: %w", err)
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
		if len(keys) > 0 {
			// One pipelined TTL sweep per SCAN batch instead of a round trip
			// per key, then one pipelined EXPIRE batch for the fixes.
			ttlPipe := s.client.Pipeline()
			ttlCmds := make([]*redis.DurationCmd, len(keys))
			for i, key := range keys {
				ttlCmds[i] = ttlPipe.TTL(ctx, key)
			}
			if _, err := ttlPipe.Exec(ctx); err != nil {
				return res, fmt.Errorf("eventlog: backfill ttl: %w", err)
			}
			var fix []string
			for i := range keys {
				res.Scanned++
				// -1 = key exists with no expiry; -2 = gone (raced); >0 = set.
				if ttlCmds[i].Val() != -1*time.Nanosecond {
					continue
				}
				res.Missing++
				if apply {
					fix = append(fix, keys[i])
				}
			}
			if len(fix) > 0 {
				expPipe := s.client.Pipeline()
				for _, key := range fix {
					expPipe.Expire(ctx, key, streamTTL)
				}
				if _, err := expPipe.Exec(ctx); err != nil {
					return res, fmt.Errorf("eventlog: backfill expire: %w", err)
				}
				res.Updated += len(fix)
			}
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
	Entries []Entry
	// Exhausted means the replay cannot be proven complete — the cursor
	// predates the oldest retained entry, or an entry's payload could no
	// longer be resolved — so the caller must full-refetch.
	Exhausted bool
}

// streamEntry is one decoded stream record. ref marks a pointer entry whose
// payload still has to be fetched from payloadKey(ID).
type streamEntry struct {
	Entry
	ref bool
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
	// user, and pointer entries are just IDs, so the read is small; only
	// the payloads of entries newer than the cursor are fetched afterwards.
	// We read newest-first via XRevRange so the scan stops at the cursor.
	entries, err := s.client.XRevRangeN(ctx, streamKey(userID), "+", "-", s.maxLen+1).Result()
	if err != nil {
		return res, fmt.Errorf("eventlog: xrevrange: %w", err)
	}
	if len(entries) == 0 {
		// The client HAS a cursor (a since of "" returned above), so it saw a
		// retained entry once — an empty stream means everything was trimmed,
		// TTL-reaped, or dropped since. Continuity is unverifiable: report
		// Exhausted so the client falls back to a full refetch instead of
		// believing an empty replay means "nothing happened".
		return ReplayResult{Exhausted: true}, nil
	}
	// Collect candidates strictly newer than `since`, newest-first.
	candidates := make([]streamEntry, 0, len(entries))
	foundCursor := false
	for _, e := range entries {
		entry, ok := parseStreamEntry(e.Values)
		if !ok {
			continue
		}
		if entry.ID <= since {
			// We hit the cursor — everything older is already seen.
			foundCursor = true
			break
		}
		candidates = append(candidates, entry)
	}
	reverse(candidates) // callers receive oldest-first
	out, gap, err := s.resolvePayloads(ctx, candidates)
	if err != nil {
		return res, err
	}
	// Not seeing `since` means the cursor predates the oldest retained entry
	// (the stream was trimmed past it); a gap means a pointer's payload is
	// gone. Either way the replay is not provably complete, so the caller
	// falls back to a full refetch instead of believing it caught up.
	return ReplayResult{Entries: out, Exhausted: !foundCursor || gap}, nil
}

// resolvePayloads fills in the payload of every pointer entry with ONE MGET,
// keeping the oldest-first order. An entry whose payload is gone is left out
// and reported as a gap — dropping it silently would make a replay that
// skipped an event look complete.
func (s *Stream) resolvePayloads(ctx context.Context, candidates []streamEntry) ([]Entry, bool, error) {
	var keys []string
	for _, c := range candidates {
		if c.ref {
			keys = append(keys, payloadKey(c.ID))
		}
	}
	var payloads []any
	if len(keys) > 0 {
		var err error
		if payloads, err = s.client.MGet(ctx, keys...).Result(); err != nil {
			return nil, false, fmt.Errorf("eventlog: mget payloads: %w", err)
		}
	}
	out := make([]Entry, 0, len(candidates))
	gap := false
	next := 0
	for _, c := range candidates {
		if !c.ref {
			out = append(out, c.Entry)
			continue
		}
		// MGET answers nil for a missing key and a string otherwise.
		payload, ok := payloads[next].(string)
		next++
		if !ok {
			gap = true
			continue
		}
		out = append(out, Entry{ID: c.ID, Payload: []byte(payload)})
	}
	return out, gap, nil
}

// parseStreamEntry decodes one XREVRANGE entry's values map. Three shapes
// exist:
//   - pointer (current): only idField; the payload lives under payloadKey.
//   - full payload with idField: written before payloads were stored once.
//   - full payload only: the oldest entries; the ID comes from the envelope.
//
// Returns ok=false for entries Replay must skip: a pointer with no usable ID,
// a payload that is not a string (the map is typed any; go-redis always
// delivers bulk strings, but the shape alone doesn't guarantee it), malformed
// envelope JSON, or an envelope with no ID.
func parseStreamEntry(values map[string]any) (streamEntry, bool) {
	id, _ := values[idField].(string)
	payloadAny, inline := values[payloadField]
	if !inline {
		if id == "" {
			return streamEntry{}, false
		}
		return streamEntry{Entry: Entry{ID: id}, ref: true}, true
	}
	payloadStr, ok := payloadAny.(string)
	if !ok {
		return streamEntry{}, false
	}
	if id != "" {
		return streamEntry{Entry: Entry{ID: id, Payload: []byte(payloadStr)}}, true
	}
	var env struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal([]byte(payloadStr), &env); err != nil {
		return streamEntry{}, false
	}
	if env.ID == "" {
		return streamEntry{}, false
	}
	return streamEntry{Entry: Entry{ID: env.ID, Payload: []byte(payloadStr)}}, true
}

func reverse(a []streamEntry) {
	for i, j := 0, len(a)-1; i < j; i, j = i+1, j-1 {
		a[i], a[j] = a[j], a[i]
	}
}
