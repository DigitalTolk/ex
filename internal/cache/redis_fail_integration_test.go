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

// keyedFailHook fails a named command only when one of its arguments contains
// keyPart — for pipelines where the same command name appears against
// different keys (e.g. the conns-key ZREM vs. the index ZREM).
type keyedFailHook struct {
	cmd     string
	keyPart string
}

func (h keyedFailHook) matches(cmd redis.Cmder) bool {
	if cmd.Name() != h.cmd {
		return false
	}
	for _, arg := range cmd.Args() {
		if s, ok := arg.(string); ok && s == h.keyPart {
			return true
		}
	}
	return false
}

func (h keyedFailHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h keyedFailHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if h.matches(cmd) {
			return errInjected
		}
		return next(ctx, cmd)
	}
}

func (h keyedFailHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		for _, cmd := range cmds {
			if h.matches(cmd) {
				return errInjected
			}
		}
		return next(ctx, cmds)
	}
}

// cacheFailingOnKey returns a RedisCache where `cmd` fails only when it
// targets a key equal to keyPart.
func cacheFailingOnKey(t *testing.T, cmd, keyPart string) *RedisCache {
	t.Helper()
	if !cacheRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	client := redis.NewClient(&redis.Options{Addr: cacheRedisAddr})
	client.AddHook(keyedFailHook{cmd: cmd, keyPart: keyPart})
	t.Cleanup(func() { _ = client.Close() })
	return &RedisCache{client: client}
}

// AllowRequest runs as one atomic MULTI/EXEC transaction (INCR + PEXPIRE NX);
// a failing transaction must surface — the limiter cannot pretend the
// increment happened or leak a TTL-less counter on a half-applied window.
func TestAllowRequest_ExpireError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "pexpire")
	if _, err := c.AllowRequest(context.Background(), "expire-fail", 5, time.Minute); !errors.Is(err, errInjected) {
		t.Fatalf("AllowRequest error = %v, want errInjected", err)
	}
}

// The INCR half of the transaction failing must surface identically.
func TestAllowRequest_IncrError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "incr")
	if _, err := c.AllowRequest(context.Background(), "incr-fail", 5, time.Minute); !errors.Is(err, errInjected) {
		t.Fatalf("AllowRequest error = %v, want errInjected", err)
	}
}

// IncrementPresence runs prune+ZADD+ZCARD+EXPIRE+index in one pipeline; a
// failing pipeline must surface rather than report a healthy online transition.
func TestIncrementPresence_PipelineError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "zcard")
	if _, err := c.IncrementPresence(context.Background(), "presence-pipe-fail", "c1"); !errors.Is(err, errInjected) {
		t.Fatalf("IncrementPresence error = %v, want errInjected", err)
	}
}

// The removal pipeline (ZREM + prune + ZCARD) failing must surface instead of
// claiming a clean offline transition.
func TestDecrementPresence_RemoveError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "zrem")
	if _, err := c.DecrementPresence(context.Background(), "presence-del-fail", "c1"); !errors.Is(err, errInjected) {
		t.Fatalf("DecrementPresence error = %v, want errInjected", err)
	}
}

// The zero-connections cleanup pipeline (index ZREM) failing must surface.
// Key-filtered so the first pipeline's conns-key ZREM still succeeds.
func TestDecrementPresence_CleanupError_RealRedis(t *testing.T) {
	plain := realRedisClient(t)
	ctx := context.Background()
	future := float64(time.Now().Add(time.Minute).UnixMilli())
	if err := plain.ZAdd(ctx, presenceKeyPrefix+"presence-cleanup-fail", redis.Z{Score: future, Member: "c1"}).Err(); err != nil {
		t.Fatalf("seed conn: %v", err)
	}
	c := cacheFailingOnKey(t, "zrem", presenceIndexKey)
	if _, err := c.DecrementPresence(ctx, "presence-cleanup-fail", "c1"); !errors.Is(err, errInjected) {
		t.Fatalf("DecrementPresence error = %v, want errInjected", err)
	}
}

// With more than one live connection, DecrementPresence keeps the set and
// refreshes its TTL; the EXPIRE failure on that non-zero path must surface.
func TestDecrementPresence_ExpireError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "expire")
	plain := realRedisClient(t)
	ctx := context.Background()
	// Seed two connections via the plain client — the hooked cache's own
	// IncrementPresence would trip on its EXPIRE before we got here.
	future := float64(time.Now().Add(time.Minute).UnixMilli())
	if err := plain.ZAdd(ctx, presenceKeyPrefix+"presence-expire2",
		redis.Z{Score: future, Member: "c1"}, redis.Z{Score: future, Member: "c2"}).Err(); err != nil {
		t.Fatalf("seed presence conns: %v", err)
	}
	if _, err := c.DecrementPresence(ctx, "presence-expire2", "c1"); !errors.Is(err, errInjected) {
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
		pipe.ZAdd(ctx, presenceKeyPrefix+id, redis.Z{Score: future, Member: "c1"})
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

// A live index entry whose per-user set holds no LIVE member (absent set, or
// only lapsed connections) must not be reported online (the verify arm).
func TestOnlinePresenceUserIDs_FiltersDeadMarkers_RealRedis(t *testing.T) {
	c := newRealCache(t)
	plain := realRedisClient(t)
	ctx := context.Background()
	if err := plain.FlushDB(ctx).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	future := float64(time.Now().Add(time.Minute).UnixMilli())
	past := float64(time.Now().Add(-time.Second).UnixMilli())
	for _, id := range []string{"u-empty", "u-lapsed", "u-live"} {
		if err := plain.ZAdd(ctx, presenceIndexKey, redis.Z{Score: future, Member: id}).Err(); err != nil {
			t.Fatalf("seed index: %v", err)
		}
	}
	if err := plain.ZAdd(ctx, presenceKeyPrefix+"u-lapsed", redis.Z{Score: past, Member: "c-dead"}).Err(); err != nil {
		t.Fatalf("seed lapsed: %v", err)
	}
	if err := plain.ZAdd(ctx, presenceKeyPrefix+"u-live", redis.Z{Score: future, Member: "c-live"}).Err(); err != nil {
		t.Fatalf("seed live: %v", err)
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
		if _, err := c.IncrementPresence(ctx, "u-zadd", "c1"); !errors.Is(err, errInjected) {
			t.Fatalf("IncrementPresence error = %v, want errInjected", err)
		}
	})
	t.Run("refresh add fails", func(t *testing.T) {
		c := cacheFailingOn(t, "zadd")
		if err := c.RefreshPresence(ctx, "u-refresh-zadd", "c1"); !errors.Is(err, errInjected) {
			t.Fatalf("RefreshPresence error = %v, want errInjected", err)
		}
	})
	t.Run("decrement keepalive index add fails", func(t *testing.T) {
		plain := realRedisClient(t)
		future := float64(time.Now().Add(time.Minute).UnixMilli())
		if err := plain.ZAdd(ctx, presenceKeyPrefix+"u-dec-zadd",
			redis.Z{Score: future, Member: "c1"}, redis.Z{Score: future, Member: "c2"}).Err(); err != nil {
			t.Fatalf("seed conns: %v", err)
		}
		c := cacheFailingOnKey(t, "zadd", presenceIndexKey)
		if _, err := c.DecrementPresence(ctx, "u-dec-zadd", "c1"); !errors.Is(err, errInjected) {
			t.Fatalf("DecrementPresence error = %v, want errInjected", err)
		}
	})
}

// A verify (ZCOUNT) failure after a successful index read surfaces as an error.
func TestOnlinePresenceUserIDs_VerifyError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "zcount")
	plain := realRedisClient(t)
	ctx := context.Background()
	// A live index entry so the code reaches the verify pipeline.
	if err := plain.ZAdd(ctx, presenceIndexKey, redis.Z{
		Score: float64(time.Now().Add(time.Minute).UnixMilli()), Member: "verify-fail",
	}).Err(); err != nil {
		t.Fatalf("seed index: %v", err)
	}
	if _, err := c.OnlinePresenceUserIDs(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("OnlinePresenceUserIDs error = %v, want errInjected", err)
	}
}

// verifyRaceHook reproduces the real index→verify race: the moment the verify
// pipeline (ZCOUNTs) is about to be sent, one of the sets the index just
// listed is deleted through a separate, un-hooked client. That user counts
// zero live members and OnlinePresenceUserIDs must skip them rather than
// fabricate an online user.
type verifyRaceHook struct {
	plain *redis.Client
	key   string
}

func (h verifyRaceHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h verifyRaceHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook { return next }

func (h verifyRaceHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		for _, cmd := range cmds {
			if cmd.Name() == "zcount" {
				if err := h.plain.Del(ctx, h.key).Err(); err != nil {
					return fmt.Errorf("race-delete %q: %w", h.key, err)
				}
				break
			}
		}
		return next(ctx, cmds)
	}
}

// A presence set that expires (or is deleted) between the index read and
// the verify pipeline counts zero live members; that user must be dropped
// from the result, not returned as a fabricated online user.
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
		if err := plain.ZAdd(ctx, presenceKeyPrefix+id, redis.Z{Score: future, Member: "c1"}).Err(); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}

	hooked := redis.NewClient(&redis.Options{Addr: cacheRedisAddr})
	hooked.AddHook(verifyRaceHook{plain: plain, key: presenceKeyPrefix + "race-gone"})
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

// IncrementEmojiFrequency runs as one atomic Lua script (recency decay +
// ZINCRBY + TTL refresh), so the whole increment fails as an EVAL/EVALSHA
// error — the failure must surface.
func TestIncrementEmojiFrequency_ScriptError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "evalsha", "eval")
	if err := c.IncrementEmojiFrequency(context.Background(), "emoji-script-fail", "wave"); !errors.Is(err, errInjected) {
		t.Fatalf("IncrementEmojiFrequency error = %v, want errInjected", err)
	}
}

// FrequentEmojis reads then refreshes both keys' TTL in one pipeline; the
// EXPIRE failure arm must surface.
func TestFrequentEmojis_ExpireError_RealRedis(t *testing.T) {
	c := cacheFailingOn(t, "expire")
	if _, err := c.FrequentEmojis(context.Background(), "emoji-read-expire-fail", 5); !errors.Is(err, errInjected) {
		t.Fatalf("FrequentEmojis error = %v, want errInjected", err)
	}
}
