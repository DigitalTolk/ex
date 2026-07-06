//go:build integration

package eventlog

import (
	"context"
	"errors"
	"testing"

	"github.com/redis/go-redis/v9"
)

// errInjected is what cmdFailHook returns for the commands a test targets.
var errInjected = errors.New("injected redis failure")

// cmdFailHook fails exactly the named Redis commands at the go-redis client
// boundary — the seam for exercising Redis error arms against the real
// container (a healthy Redis never errors on these commands). Everything else
// passes through to the wire.
type cmdFailHook struct{ fail map[string]bool }

func (h cmdFailHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h cmdFailHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if h.fail[cmd.Name()] {
			return errInjected
		}
		return next(ctx, cmd)
	}
}

func (h cmdFailHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		for _, cmd := range cmds {
			if h.fail[cmd.Name()] {
				return errInjected
			}
		}
		return next(ctx, cmds)
	}
}

// newRealStreamFailingOn returns a Stream whose named commands fail with
// errInjected, plus a plain (un-hooked) client for seeding. Both talk to the
// shared real-Redis container; the DB is flushed up front and on cleanup so
// the SCAN inside BackfillTTL only sees what the test seeded.
func newRealStreamFailingOn(t *testing.T, cmds ...string) (*Stream, *redis.Client) {
	t.Helper()
	if !redisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	plain := redis.NewClient(&redis.Options{Addr: redisAddr})
	if err := plain.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	hooked := redis.NewClient(&redis.Options{Addr: redisAddr})
	fail := make(map[string]bool, len(cmds))
	for _, c := range cmds {
		fail[c] = true
	}
	hooked.AddHook(cmdFailHook{fail: fail})
	t.Cleanup(func() {
		_ = plain.FlushDB(context.Background()).Err()
		_ = plain.Close()
		_ = hooked.Close()
	})
	return NewStream(hooked, 0), plain
}

// seedLegacyStream XADDs one entry WITHOUT an expiry (raw XADD, bypassing
// Append's EXPIRE) — the exact shape of a pre-TTL legacy inbox stream.
func seedLegacyStream(t *testing.T, client *redis.Client, userID string) {
	t.Helper()
	err := client.XAdd(context.Background(), &redis.XAddArgs{
		Stream: streamKey(userID),
		ID:     "*",
		Values: map[string]any{payloadField: `{"id":"01SEED0000000000000000000001"}`},
	}).Err()
	if err != nil {
		t.Fatalf("seed stream %q: %v", userID, err)
	}
}

// A TTL probe failing mid-scan surfaces — the SCAN itself succeeded, so this
// is a distinct error arm from the closed-client scan failure.
func TestStream_BackfillTTL_TTLError_RealRedis(t *testing.T) {
	s, plain := newRealStreamFailingOn(t, "ttl")
	seedLegacyStream(t, plain, "legacy-ttl")
	if _, err := s.BackfillTTL(context.Background(), false); !errors.Is(err, errInjected) {
		t.Fatalf("BackfillTTL error = %v, want errInjected", err)
	}
}

// Applying the idle TTL to a legacy stream that has none runs EXPIRE; a
// failing EXPIRE surfaces instead of being silently counted as updated.
func TestStream_BackfillTTL_ExpireError_RealRedis(t *testing.T) {
	s, plain := newRealStreamFailingOn(t, "expire")
	seedLegacyStream(t, plain, "legacy-expire")
	res, err := s.BackfillTTL(context.Background(), true)
	if !errors.Is(err, errInjected) {
		t.Fatalf("BackfillTTL error = %v, want errInjected", err)
	}
	if res.Updated != 0 {
		t.Errorf("Updated = %d, want 0 — the failed EXPIRE must not count", res.Updated)
	}
}
