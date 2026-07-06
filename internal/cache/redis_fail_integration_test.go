//go:build integration

package cache

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// errInjected is what cmdFailHook returns for the commands a test targets.
var errInjected = errors.New("injected redis failure")

// cmdFailHook fails exactly the named Redis commands at the go-redis client
// boundary — the seam for exercising Redis error arms against the real
// container (a healthy Redis never errors on these commands). Everything else
// passes through to the wire. An EMPTY filter fails every command — for
// exercising "the server answers each command with an error" paths (and,
// unlike a dead connection, without dial retries).
type cmdFailHook struct{ fail map[string]bool }

func (h cmdFailHook) matches(name string) bool { return len(h.fail) == 0 || h.fail[name] }

func (h cmdFailHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h cmdFailHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if h.matches(cmd.Name()) {
			return errInjected
		}
		return next(ctx, cmd)
	}
}

func (h cmdFailHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		for _, cmd := range cmds {
			if h.matches(cmd.Name()) {
				return errInjected
			}
		}
		return next(ctx, cmds)
	}
}

// realRedisClient returns a plain (un-hooked) client against the shared
// container, for seeding and out-of-band manipulation.
func realRedisClient(t *testing.T) *redis.Client {
	t.Helper()
	if !cacheRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	client := redis.NewClient(&redis.Options{Addr: cacheRedisAddr})
	t.Cleanup(func() { _ = client.Close() })
	return client
}

// cacheFailingOn returns a RedisCache for which the named commands fail with
// errInjected; every other command hits the real container. With NO commands
// named, every command fails.
func cacheFailingOn(t *testing.T, cmds ...string) *RedisCache {
	t.Helper()
	if !cacheRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	client := redis.NewClient(&redis.Options{Addr: cacheRedisAddr})
	fail := make(map[string]bool, len(cmds))
	for _, c := range cmds {
		fail[c] = true
	}
	client.AddHook(cmdFailHook{fail: fail})
	t.Cleanup(func() { _ = client.Close() })
	return &RedisCache{client: client}
}

// AllowRequest's first hit of a window INCRs then EXPIREs; a failing EXPIRE
// must surface — a window key that never expires would rate-limit the caller
// forever, so the limiter cannot pretend that write succeeded.
func TestAllowRequest_ExpireError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "expire")
	if _, err := c.AllowRequest(context.Background(), "expire-fail", 5, time.Minute); !errors.Is(err, errInjected) {
		t.Fatalf("AllowRequest error = %v, want errInjected", err)
	}
}

// IncrementPresence INCRs then refreshes the presence TTL; the EXPIRE failure
// arm must surface rather than report a healthy online transition.
func TestIncrementPresence_ExpireError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "expire")
	if _, err := c.IncrementPresence(context.Background(), "presence-expire-fail"); !errors.Is(err, errInjected) {
		t.Fatalf("IncrementPresence error = %v, want errInjected", err)
	}
}

// When the last connection drops, DecrementPresence deletes the counter key;
// a failing DEL surfaces instead of claiming a clean offline transition.
func TestDecrementPresence_DelError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "del")
	ctx := context.Background()
	// Seed exactly one live connection through the same hooked cache — only
	// DEL is rigged to fail, so the INCR + EXPIRE seed path is real.
	if _, err := c.IncrementPresence(ctx, "presence-del-fail"); err != nil {
		t.Fatalf("seed IncrementPresence: %v", err)
	}
	if _, err := c.DecrementPresence(ctx, "presence-del-fail"); !errors.Is(err, errInjected) {
		t.Fatalf("DecrementPresence error = %v, want errInjected", err)
	}
}

// With more than one live connection, DecrementPresence keeps the key and
// refreshes its TTL; the EXPIRE failure on that non-zero path must surface.
func TestDecrementPresence_ExpireError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "expire")
	plain := realRedisClient(t)
	ctx := context.Background()
	// Seed two connections via the plain client — the hooked cache's own
	// IncrementPresence would trip on its EXPIRE before we got here.
	if err := plain.Set(ctx, presenceKeyPrefix+"presence-expire2", 2, time.Minute).Err(); err != nil {
		t.Fatalf("seed presence count: %v", err)
	}
	if _, err := c.DecrementPresence(ctx, "presence-expire2"); !errors.Is(err, errInjected) {
		t.Fatalf("DecrementPresence error = %v, want errInjected", err)
	}
}

// With no presence keys at all, OnlinePresenceUserIDs short-circuits after the
// SCAN and reports nobody online.
func TestOnlinePresenceUserIDs_EmptyKeyspace_RealRedis(t *testing.T) {
	c := newRealCache(t)
	plain := realRedisClient(t)
	ctx := context.Background()
	if err := plain.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	ids, err := c.OnlinePresenceUserIDs(ctx)
	if err != nil {
		t.Fatalf("OnlinePresenceUserIDs: %v", err)
	}
	if ids != nil {
		t.Errorf("ids = %v, want nil for an empty keyspace", ids)
	}
}

// SCAN's count (100) is a per-iteration hint over hash buckets — with 1000
// presence keys the keyspace cannot be walked in one page, so the cursor loop
// must iterate. A complete result proves every page was visited.
func TestOnlinePresenceUserIDs_MultiPageScan_RealRedis(t *testing.T) {
	c := newRealCache(t)
	plain := realRedisClient(t)
	ctx := context.Background()
	if err := plain.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	const n = 1000
	pipe := plain.Pipeline()
	for i := 0; i < n; i++ {
		pipe.Set(ctx, fmt.Sprintf("%suser-%04d", presenceKeyPrefix, i), 1, time.Minute)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		t.Fatalf("seed presence keys: %v", err)
	}
	ids, err := c.OnlinePresenceUserIDs(ctx)
	if err != nil {
		t.Fatalf("OnlinePresenceUserIDs: %v", err)
	}
	if len(ids) != n {
		t.Fatalf("got %d ids, want %d — a SCAN page was dropped", len(ids), n)
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		seen[id] = true
	}
	for i := 0; i < n; i++ {
		if id := fmt.Sprintf("user-%04d", i); !seen[id] {
			t.Fatalf("missing %s in result", id)
		}
	}
}

// An MGET failure after a successful SCAN surfaces as an error.
func TestOnlinePresenceUserIDs_MGetError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "mget")
	plain := realRedisClient(t)
	ctx := context.Background()
	// At least one presence key so the code reaches the MGET.
	if err := plain.Set(ctx, presenceKeyPrefix+"mget-fail", 1, time.Minute).Err(); err != nil {
		t.Fatalf("seed presence key: %v", err)
	}
	if _, err := c.OnlinePresenceUserIDs(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("OnlinePresenceUserIDs error = %v, want errInjected", err)
	}
}

// mgetRaceHook reproduces the real SCAN→MGET race: the moment the MGET is
// about to be sent, one of the keys SCAN just returned is deleted through a
// separate, un-hooked client. That slot of the MGET reply comes back nil and
// OnlinePresenceUserIDs must skip it rather than fabricate an online user.
type mgetRaceHook struct {
	plain *redis.Client
	key   string
}

func (h mgetRaceHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h mgetRaceHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if cmd.Name() == "mget" {
			if err := h.plain.Del(ctx, h.key).Err(); err != nil {
				return fmt.Errorf("race-delete %q: %w", h.key, err)
			}
		}
		return next(ctx, cmd)
	}
}

func (h mgetRaceHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}

// A presence key that expires (or is deleted) between the SCAN and the MGET
// yields a nil slot in the MGET reply; that user must be dropped from the
// result, not returned with a bogus count.
func TestOnlinePresenceUserIDs_KeyGoneBetweenScanAndMGet_RealRedis(t *testing.T) {
	plain := realRedisClient(t)
	ctx := context.Background()
	if err := plain.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	if err := plain.Set(ctx, presenceKeyPrefix+"race-gone", 1, time.Minute).Err(); err != nil {
		t.Fatalf("seed race-gone: %v", err)
	}
	if err := plain.Set(ctx, presenceKeyPrefix+"race-stays", 1, time.Minute).Err(); err != nil {
		t.Fatalf("seed race-stays: %v", err)
	}

	hooked := redis.NewClient(&redis.Options{Addr: cacheRedisAddr})
	hooked.AddHook(mgetRaceHook{plain: plain, key: presenceKeyPrefix + "race-gone"})
	t.Cleanup(func() { _ = hooked.Close() })
	c := &RedisCache{client: hooked}

	ids, err := c.OnlinePresenceUserIDs(ctx)
	if err != nil {
		t.Fatalf("OnlinePresenceUserIDs: %v", err)
	}
	if len(ids) != 1 || ids[0] != "race-stays" {
		t.Fatalf("ids = %v, want exactly [race-stays]", ids)
	}
}

// IncrementEmojiFrequency ZINCRBYs then refreshes the key's TTL; the EXPIRE
// failure arm must surface.
func TestIncrementEmojiFrequency_ExpireError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "expire")
	if err := c.IncrementEmojiFrequency(context.Background(), "emoji-expire-fail", "wave"); !errors.Is(err, errInjected) {
		t.Fatalf("IncrementEmojiFrequency error = %v, want errInjected", err)
	}
}
