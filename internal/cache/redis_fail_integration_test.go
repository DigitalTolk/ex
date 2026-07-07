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

// With an empty online index, OnlinePresenceUserIDs short-circuits after the
// range read and reports nobody online.
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

// The snapshot must be complete at scale AND must not touch unrelated keys:
// 1000 online users listed out of a keyspace deliberately polluted with other
// key families (the old SCAN implementation walked those too — that is the
// production regression this index fixed).
func TestOnlinePresenceUserIDs_IndexScale_RealRedis(t *testing.T) {
	c := newRealCache(t)
	plain := realRedisClient(t)
	ctx := context.Background()
	if err := plain.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	const n = 1000
	future := float64(time.Now().Add(time.Minute).UnixMilli())
	pipe := plain.Pipeline()
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("user-%04d", i)
		pipe.Set(ctx, presenceKeyPrefix+id, 1, time.Minute)
		pipe.ZAdd(ctx, presenceIndexKey, redis.Z{Score: future, Member: id})
	}
	// Unrelated key families the snapshot must never depend on.
	for i := 0; i < 500; i++ {
		pipe.Set(ctx, fmt.Sprintf("unrelated:key:%04d", i), "x", time.Minute)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		t.Fatalf("seed: %v", err)
	}
	ids, err := c.OnlinePresenceUserIDs(ctx)
	if err != nil {
		t.Fatalf("OnlinePresenceUserIDs: %v", err)
	}
	if len(ids) != n {
		t.Fatalf("got %d ids, want %d — the index read is incomplete", len(ids), n)
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

// A member whose score (marker expiry) has passed is pruned by the snapshot
// read and never listed — the index cannot leak sessions that died without a
// decrement (killed instance, dead socket).
func TestOnlinePresenceUserIDs_PrunesExpiredIndexEntries_RealRedis(t *testing.T) {
	c := newRealCache(t)
	plain := realRedisClient(t)
	ctx := context.Background()
	if err := plain.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	past := float64(time.Now().Add(-time.Second).UnixMilli())
	if err := plain.ZAdd(ctx, presenceIndexKey, redis.Z{Score: past, Member: "u-stale"}).Err(); err != nil {
		t.Fatalf("seed stale member: %v", err)
	}
	ids, err := c.OnlinePresenceUserIDs(ctx)
	if err != nil {
		t.Fatalf("OnlinePresenceUserIDs: %v", err)
	}
	if ids != nil {
		t.Fatalf("ids = %v, want nil — the stale member must be pruned", ids)
	}
	if card, _ := plain.ZCard(ctx, presenceIndexKey).Result(); card != 0 {
		t.Fatalf("index cardinality = %d, want 0 after prune", card)
	}
}

// A live index entry whose per-user marker holds a non-positive or garbage
// count must not be reported online (the MGET verification arm).
func TestOnlinePresenceUserIDs_FiltersDeadMarkers_RealRedis(t *testing.T) {
	c := newRealCache(t)
	plain := realRedisClient(t)
	ctx := context.Background()
	if err := plain.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	future := float64(time.Now().Add(time.Minute).UnixMilli())
	for id, val := range map[string]string{"u-zero": "0", "u-junk": "not-a-number", "u-live": "2"} {
		if err := plain.ZAdd(ctx, presenceIndexKey, redis.Z{Score: future, Member: id}).Err(); err != nil {
			t.Fatalf("seed index: %v", err)
		}
		if err := plain.Set(ctx, presenceKeyPrefix+id, val, time.Minute).Err(); err != nil {
			t.Fatalf("seed marker: %v", err)
		}
	}
	ids, err := c.OnlinePresenceUserIDs(ctx)
	if err != nil {
		t.Fatalf("OnlinePresenceUserIDs: %v", err)
	}
	if len(ids) != 1 || ids[0] != "u-live" {
		t.Fatalf("ids = %v, want [u-live]", ids)
	}
}

// Fault arms for the two index commands on the snapshot path.
func TestOnlinePresenceUserIDs_IndexCommandErrors_RealRedis(t *testing.T) {
	ctx := context.Background()
	t.Run("prune fails", func(t *testing.T) {
		c := cacheFailingOn(t, "zremrangebyscore")
		if _, err := c.OnlinePresenceUserIDs(ctx); !errors.Is(err, errInjected) {
			t.Fatalf("error = %v, want errInjected", err)
		}
	})
	t.Run("range fails", func(t *testing.T) {
		// ZRangeArgs issues the modern ZRANGE (BYSCORE) form.
		c := cacheFailingOn(t, "zrange")
		if _, err := c.OnlinePresenceUserIDs(ctx); !errors.Is(err, errInjected) {
			t.Fatalf("error = %v, want errInjected", err)
		}
	})
}

// Fault arms for the index writes on the presence write paths.
func TestPresenceIndexWriteErrors_RealRedis(t *testing.T) {
	ctx := context.Background()
	t.Run("increment index add fails", func(t *testing.T) {
		c := cacheFailingOn(t, "zadd")
		if _, err := c.IncrementPresence(ctx, "u-zadd"); !errors.Is(err, errInjected) {
			t.Fatalf("IncrementPresence error = %v, want errInjected", err)
		}
	})
	t.Run("refresh index add fails", func(t *testing.T) {
		plain := realRedisClient(t)
		if err := plain.Set(ctx, presenceKeyPrefix+"u-refresh-zadd", 1, time.Minute).Err(); err != nil {
			t.Fatalf("seed marker: %v", err)
		}
		c := cacheFailingOn(t, "zadd")
		if err := c.RefreshPresence(ctx, "u-refresh-zadd"); !errors.Is(err, errInjected) {
			t.Fatalf("RefreshPresence error = %v, want errInjected", err)
		}
	})
	t.Run("decrement keepalive index add fails", func(t *testing.T) {
		plain := realRedisClient(t)
		if err := plain.Set(ctx, presenceKeyPrefix+"u-dec-zadd", 2, time.Minute).Err(); err != nil {
			t.Fatalf("seed marker: %v", err)
		}
		c := cacheFailingOn(t, "zadd")
		if _, err := c.DecrementPresence(ctx, "u-dec-zadd"); !errors.Is(err, errInjected) {
			t.Fatalf("DecrementPresence error = %v, want errInjected", err)
		}
	})
	t.Run("offline transition index removal fails", func(t *testing.T) {
		plain := realRedisClient(t)
		if err := plain.Set(ctx, presenceKeyPrefix+"u-dec-zrem", 1, time.Minute).Err(); err != nil {
			t.Fatalf("seed marker: %v", err)
		}
		c := cacheFailingOn(t, "zrem")
		if _, err := c.DecrementPresence(ctx, "u-dec-zrem"); !errors.Is(err, errInjected) {
			t.Fatalf("DecrementPresence error = %v, want errInjected", err)
		}
	})
}

// An MGET failure after a successful SCAN surfaces as an error.
func TestOnlinePresenceUserIDs_MGetError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "mget")
	plain := realRedisClient(t)
	ctx := context.Background()
	// A live index entry + marker so the code reaches the MGET.
	if err := plain.ZAdd(ctx, presenceIndexKey, redis.Z{
		Score: float64(time.Now().Add(time.Minute).UnixMilli()), Member: "mget-fail",
	}).Err(); err != nil {
		t.Fatalf("seed index: %v", err)
	}
	if err := plain.Set(ctx, presenceKeyPrefix+"mget-fail", 1, time.Minute).Err(); err != nil {
		t.Fatalf("seed presence key: %v", err)
	}
	if _, err := c.OnlinePresenceUserIDs(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("OnlinePresenceUserIDs error = %v, want errInjected", err)
	}
}

// mgetRaceHook reproduces the real index→MGET race: the moment the MGET is
// about to be sent, one of the markers the index just listed is deleted
// through a separate, un-hooked client. That slot of the MGET reply comes
// back nil and OnlinePresenceUserIDs must skip it rather than fabricate an
// online user.
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

// A presence marker that expires (or is deleted) between the index read and
// the MGET yields a nil slot in the MGET reply; that user must be dropped
// from the result, not returned with a bogus count.
func TestOnlinePresenceUserIDs_KeyGoneBetweenIndexAndMGet_RealRedis(t *testing.T) {
	plain := realRedisClient(t)
	ctx := context.Background()
	if err := plain.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	future := float64(time.Now().Add(time.Minute).UnixMilli())
	for _, id := range []string{"race-gone", "race-stays"} {
		if err := plain.ZAdd(ctx, presenceIndexKey, redis.Z{Score: future, Member: id}).Err(); err != nil {
			t.Fatalf("seed index %s: %v", id, err)
		}
		if err := plain.Set(ctx, presenceKeyPrefix+id, 1, time.Minute).Err(); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
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
