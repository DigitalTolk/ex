//go:build integration

package eventlog

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/redis/go-redis/v9"
)

// A fan-out stores the (potentially large, hast-carrying) event payload ONCE
// and puts only the event ID into each recipient's stream. A full copy per
// recipient made a 1000-member channel write megabytes per event.
func TestStream_AppendManyStoresPayloadOnce(t *testing.T) {
	s, client := newSharedStream(t, 0)
	ctx := context.Background()
	id := ulid(42)
	payload := []byte(fmt.Sprintf(`{"id":%q,"type":"message.new","data":{"body":"a long rendered message"}}`, id))
	recipients := []string{"u1", "u2", "u3"}
	if err := s.AppendMany(ctx, recipients, id, payload); err != nil {
		t.Fatalf("AppendMany: %v", err)
	}

	for _, uid := range recipients {
		entries, err := client.XRange(ctx, streamKey(uid), "-", "+").Result()
		if err != nil {
			t.Fatalf("XRange %s: %v", uid, err)
		}
		if len(entries) != 1 {
			t.Fatalf("%s stream has %d entries, want 1", uid, len(entries))
		}
		if _, inline := entries[0].Values[payloadField]; inline {
			t.Fatalf("%s stream entry carries the payload inline: %v", uid, entries[0].Values)
		}
		if got := entries[0].Values[idField]; got != id {
			t.Fatalf("%s stream entry id = %v, want %s", uid, got, id)
		}
	}

	stored, err := client.Get(ctx, payloadKey(id)).Result()
	if err != nil {
		t.Fatalf("payload key: %v", err)
	}
	if stored != string(payload) {
		t.Fatalf("stored payload = %q, want %q", stored, payload)
	}
	ttl, err := client.TTL(ctx, payloadKey(id)).Result()
	if err != nil {
		t.Fatalf("TTL: %v", err)
	}
	if ttl <= 0 || ttl > payloadTTL {
		t.Fatalf("payload TTL = %v, want (0, %v]", ttl, payloadTTL)
	}

	// Every recipient still replays the full event.
	for _, uid := range recipients {
		res, err := s.Replay(ctx, uid, ulid(0))
		if err != nil {
			t.Fatalf("Replay %s: %v", uid, err)
		}
		if len(res.Entries) != 1 || res.Entries[0].ID != id || string(res.Entries[0].Payload) != string(payload) {
			t.Fatalf("%s replay = %+v, want the one event with its payload", uid, res.Entries)
		}
	}
}

// A pointer whose payload is gone (expired, evicted, or a fan-out whose
// payload write failed) must never be skipped silently: the entry is left
// out AND the replay reports Exhausted, so the client resyncs instead of
// treating the replay as complete.
func TestStream_ReplayMissingPayloadSignalsResync(t *testing.T) {
	s, client := newSharedStream(t, 0)
	ctx := context.Background()
	for i := 1; i <= 3; i++ {
		appendEvent(t, s, "u1", ulid(i))
	}
	if err := client.Del(ctx, payloadKey(ulid(2))).Err(); err != nil {
		t.Fatalf("del payload: %v", err)
	}

	res, err := s.Replay(ctx, "u1", ulid(1))
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(res.Entries) != 1 || res.Entries[0].ID != ulid(3) {
		t.Fatalf("entries = %+v, want only ulid(3) (the resolvable one)", res.Entries)
	}
	if !res.Exhausted {
		t.Fatal("a missing payload must report Exhausted so the client resyncs")
	}

	// Payloads still present → a clean, complete replay.
	res, err = s.Replay(ctx, "u1", ulid(2))
	if err != nil {
		t.Fatalf("Replay past the gap: %v", err)
	}
	if res.Exhausted || len(res.Entries) != 1 || res.Entries[0].ID != ulid(3) {
		t.Fatalf("replay past the gap = %+v exhausted=%v, want [ulid(3)] / false", res.Entries, res.Exhausted)
	}
}

// Streams written before this change hold full-payload entries — both the
// id-field shape and the older envelope-only shape. They must keep replaying,
// in order, next to the new pointer entries.
func TestStream_ReplayFullPayloadEntriesNextToPointers(t *testing.T) {
	s, client := newSharedStream(t, 0)
	ctx := context.Background()
	key := streamKey("u-compat")
	seed := func(values map[string]any) {
		t.Helper()
		if err := client.XAdd(ctx, &redis.XAddArgs{Stream: key, ID: "*", Values: values}).Err(); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	seed(map[string]any{payloadField: fmt.Sprintf(`{"id":%q}`, ulid(1))})
	seed(map[string]any{payloadField: fmt.Sprintf(`{"id":%q,"v":"id-field"}`, ulid(2)), idField: ulid(2)})
	newest := appendEvent(t, s, "u-compat", ulid(3))

	res, err := s.Replay(ctx, "u-compat", ulid(0))
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(res.Entries) != 3 {
		t.Fatalf("entries = %d, want 3", len(res.Entries))
	}
	want := []string{fmt.Sprintf(`{"id":%q}`, ulid(1)), fmt.Sprintf(`{"id":%q,"v":"id-field"}`, ulid(2)), string(newest)}
	for i, w := range want {
		if string(res.Entries[i].Payload) != w {
			t.Errorf("entry[%d] payload = %q, want %q", i, res.Entries[i].Payload, w)
		}
	}
}

// A failing payload lookup surfaces as an error — the WS handler turns any
// replay error into replay.exhausted, never into a "complete" replay.
func TestStream_ReplayPayloadLookupError(t *testing.T) {
	s, plain := newRealStreamFailingOn(t, "mget")
	writer := NewStream(plain, 0)
	appendEvent(t, writer, "u1", ulid(1))
	appendEvent(t, writer, "u1", ulid(2))
	if _, err := s.Replay(context.Background(), "u1", ulid(1)); !errors.Is(err, errInjected) {
		t.Fatalf("Replay error = %v, want errInjected", err)
	}
}
