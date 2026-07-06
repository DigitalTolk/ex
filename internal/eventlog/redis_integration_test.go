//go:build integration

package eventlog

import (
	"context"
	"fmt"
	"log"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// The per-user inbox stream (XADD MAXLEN + XREVRANGE + ULID-cursor replay) is
// the durable side of the notification/reconnect-replay path. This file starts
// the shared REAL Redis container (testcontainers) the whole package's
// integration suite runs against, so the stream + MAXLEN-trim + cursor
// semantics the replay-exhausted refetch depends on are validated against the
// engine production actually uses.
var (
	redisAddr  string
	redisReady bool
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	req := testcontainers.ContainerRequest{
		Image:        "redis:7-alpine",
		ExposedPorts: []string{"6379/tcp"},
		WaitingFor:   wait.ForListeningPort("6379/tcp").WithStartupTimeout(60 * time.Second),
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{ContainerRequest: req, Started: true})
	if err != nil {
		log.Printf("eventlog integration tests will skip: docker/redis unavailable: %v", err)
		os.Exit(m.Run())
	}
	if host, herr := c.Host(ctx); herr == nil {
		if port, perr := c.MappedPort(ctx, "6379"); perr == nil {
			redisAddr = fmt.Sprintf("%s:%s", host, port.Port())
			redisReady = true
		}
	}
	code := m.Run()
	_ = c.Terminate(ctx)
	os.Exit(code)
}

func newRealStream(t *testing.T, maxLen int64) *Stream {
	t.Helper()
	if !redisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	client := redis.NewClient(&redis.Options{Addr: redisAddr})
	t.Cleanup(func() {
		_ = client.FlushDB(context.Background()).Err()
		_ = client.Close()
	})
	return NewStream(client, maxLen)
}

func ulid(i int) string { return fmt.Sprintf("01ID%022d", i) }

func TestStream_AppendReplay_RealRedis(t *testing.T) {
	s := newRealStream(t, 0)
	ctx := context.Background()
	// Replay parses each payload as a JSON envelope and trusts the embedded ULID
	// (not the Redis-assigned stream ID), so payloads must be real event JSON.
	for i := 1; i <= 3; i++ {
		payload := fmt.Sprintf(`{"id":%q,"type":"message.new"}`, ulid(i))
		if err := s.Append(ctx, "u1", ulid(i), []byte(payload)); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}

	// Cursor found mid-stream → only strictly-newer entries, oldest-first, and
	// NOT exhausted (the cursor was located, so the replay is known-complete).
	res, err := s.Replay(ctx, "u1", ulid(1))
	if err != nil {
		t.Fatalf("Replay from cursor-in-stream: %v", err)
	}
	if res.Exhausted {
		t.Error("a cursor found in the stream must not be reported exhausted")
	}
	if len(res.Entries) != 2 || res.Entries[0].ID != ulid(2) || res.Entries[1].ID != ulid(3) {
		t.Fatalf("replay from ulid(1) returned %d entries, want [ulid2, ulid3] oldest-first", len(res.Entries))
	}

	// Cursor older than every retained entry → all entries returned AND
	// Exhausted=true (conservative: the stream may have been trimmed past the
	// cursor, so the client should full-refetch).
	res, err = s.Replay(ctx, "u1", ulid(0))
	if err != nil {
		t.Fatalf("Replay before-all: %v", err)
	}
	if len(res.Entries) != 3 || !res.Exhausted {
		t.Fatalf("replay before-all: entries=%d exhausted=%v, want 3/true", len(res.Entries), res.Exhausted)
	}
}

func TestStream_ReplayExhaustedAfterTrim_RealRedis(t *testing.T) {
	s := newRealStream(t, 3) // keep only the newest 3
	ctx := context.Background()
	for i := 1; i <= 6; i++ {
		payload := fmt.Sprintf(`{"id":%q}`, ulid(i))
		if err := s.Append(ctx, "u2", ulid(i), []byte(payload)); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}

	// Replay only reads the newest maxLen+1 (=4) entries, so the cursor (id 1)
	// falls outside that window and can't be confirmed → the client is told to
	// full-refetch (Exhausted=true). This is the reconnect-after-a-long-gap
	// path, and it's bounded by the read window (not by approximate trim), so
	// it's deterministic regardless of when Redis actually trims.
	res, err := s.Replay(ctx, "u2", ulid(1))
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if !res.Exhausted {
		t.Fatalf("expected Exhausted=true when the cursor predates the read window, got exhausted=%v", res.Exhausted)
	}
	// The newest maxLen+1 entries still come back even while exhausted.
	if len(res.Entries) != 4 {
		t.Fatalf("entries = %d, want 4 (the newest maxLen+1 read window)", len(res.Entries))
	}
}
