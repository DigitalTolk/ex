//go:build integration

package cache

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
	"github.com/redis/go-redis/v9/maintnotifications"
)

// setupRealTestCache returns a RedisCache over the shared container plus a
// plain client for out-of-band state peeks and TTL manipulation. The DB is
// flushed first so every test starts from an empty keyspace (the cache tests
// run sequentially — none use t.Parallel — so a flush per test is safe).
func setupRealTestCache(t *testing.T) (*RedisCache, *redis.Client) {
	t.Helper()
	plain := realRedisClient(t) // skips when Docker / Redis is unavailable
	if err := plain.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	c := newRealCache(t)
	t.Cleanup(func() { _ = c.Client().Close() })
	return c, plain
}

// expireNow shortens key's TTL to 1ms through the plain client and waits for
// the real engine expiry to take effect (key gone), then returns. Follow-up
// assertions therefore exercise the post-TTL state through real Redis expiry
// semantics rather than a fake time-travelling clock.
func expireNow(t *testing.T, plain *redis.Client, key string) {
	t.Helper()
	ctx := context.Background()
	ok, err := plain.PExpire(ctx, key, time.Millisecond).Result()
	if err != nil || !ok {
		t.Fatalf("PExpire %q = %v, %v; want true, nil", key, ok, err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		n, err := plain.Exists(ctx, key).Result()
		if err != nil {
			t.Fatalf("Exists %q: %v", key, err)
		}
		if n == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("key %q still exists 2s after its TTL was shortened to 1ms", key)
}

// redisProxy is a TCP proxy in front of the shared Redis container. Closing
// it stops the listener AND severs every live connection, so a client built
// against the proxy behaves exactly like one whose server died mid-flight:
// the constructor's PING passes through while the proxy is up, and every
// command after Close fails with a real connection error.
type redisProxy struct {
	ln     net.Listener
	mu     sync.Mutex
	conns  []net.Conn
	closed bool
}

func newRedisProxy(t *testing.T) *redisProxy {
	t.Helper()
	if !cacheRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("proxy listen: %v", err)
	}
	p := &redisProxy{ln: ln}
	go p.acceptLoop()
	t.Cleanup(p.Close)
	return p
}

func (p *redisProxy) Addr() string { return p.ln.Addr().String() }

func (p *redisProxy) acceptLoop() {
	for {
		conn, err := p.ln.Accept()
		if err != nil {
			return
		}
		up, err := net.Dial("tcp", cacheRedisAddr)
		if err != nil {
			_ = conn.Close()
			continue
		}
		p.mu.Lock()
		if p.closed {
			p.mu.Unlock()
			_ = conn.Close()
			_ = up.Close()
			continue
		}
		p.conns = append(p.conns, conn, up)
		p.mu.Unlock()
		go func() { _, _ = io.Copy(up, conn) }()
		go func() { _, _ = io.Copy(conn, up) }()
	}
}

func (p *redisProxy) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	conns := p.conns
	p.conns = nil
	p.mu.Unlock()
	_ = p.ln.Close()
	for _, c := range conns {
		_ = c.Close()
	}
}

// newDeadCache builds a RedisCache through a live proxy (so the constructor's
// PING succeeds) and then kills the proxy — every subsequent command errors
// like a dead server.
func newDeadCache(t *testing.T) *RedisCache {
	t.Helper()
	proxy := newRedisProxy(t)
	c, err := NewRedisCache("redis://" + proxy.Addr())
	if err != nil {
		t.Fatalf("NewRedisCache via proxy: %v", err)
	}
	t.Cleanup(func() { _ = c.Client().Close() })
	proxy.Close()
	return c
}

func TestNewRedisCache_Success(t *testing.T) {
	c, _ := setupRealTestCache(t)
	if c == nil {
		t.Fatal("expected non-nil cache")
	}
}

func TestRedisCache_NameCache(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	// Miss before set.
	if _, ok := c.GetName(ctx, "chan:c1"); ok {
		t.Error("expected a miss for an unset name")
	}
	c.SetName(ctx, "chan:c1", "general")
	if v, ok := c.GetName(ctx, "chan:c1"); !ok || v != "general" {
		t.Errorf("GetName = %q,%v, want general,true", v, ok)
	}
}

func TestRedisCache_DistributedLock(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()
	const key = "lock:job"

	// Free lock: the first acquire wins, a second (different token) loses.
	ok, err := c.AcquireLock(ctx, key, "tok-a", time.Minute)
	if err != nil || !ok {
		t.Fatalf("first AcquireLock = %v,%v; want true,nil", ok, err)
	}
	held, err := c.LockHeld(ctx, key)
	if err != nil || !held {
		t.Fatalf("LockHeld after acquire = %v,%v; want true,nil", held, err)
	}
	if ok, _ := c.AcquireLock(ctx, key, "tok-b", time.Minute); ok {
		t.Fatal("second AcquireLock should lose while the lock is held")
	}

	// Token-fenced release: a foreign token is a no-op; the owner's token frees it.
	if err := c.ReleaseLock(ctx, key, "tok-b"); err != nil {
		t.Fatalf("ReleaseLock(foreign): %v", err)
	}
	if held, _ := c.LockHeld(ctx, key); !held {
		t.Fatal("a foreign-token release must NOT drop the owner's lock")
	}
	if err := c.ReleaseLock(ctx, key, "tok-a"); err != nil {
		t.Fatalf("ReleaseLock(owner): %v", err)
	}
	if held, _ := c.LockHeld(ctx, key); held {
		t.Fatal("owner-token release should drop the lock")
	}

	// After release the lock is re-acquirable.
	if ok, _ := c.AcquireLock(ctx, key, "tok-c", time.Minute); !ok {
		t.Fatal("lock should be free after the owner released it")
	}

	// TTL expiry frees a lock whose holder never released it (crash path).
	expireNow(t, plain, key)
	if held, _ := c.LockHeld(ctx, key); held {
		t.Fatal("lock should expire once its TTL lapses")
	}
}

func TestRedisCache_LockErrorsSurface(t *testing.T) {
	// Every command errors at the client boundary (no dial-retry storm).
	c := cacheFailingOn(t)
	ctx := context.Background()

	if _, err := c.AcquireLock(ctx, "k", "t", time.Minute); err == nil {
		t.Error("AcquireLock should surface a Redis error")
	}
	if err := c.ReleaseLock(ctx, "k", "t"); err == nil {
		t.Error("ReleaseLock should surface a Redis error")
	}
	if _, err := c.LockHeld(ctx, "k"); err == nil {
		t.Error("LockHeld should surface a Redis error")
	}
}

func TestGetSet(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	type payload struct {
		Name  string `json:"name"`
		Value int    `json:"value"`
	}

	original := payload{Name: "test", Value: 42}

	if err := c.Set(ctx, "key1", original, 5*time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}

	var got payload
	if err := c.Get(ctx, "key1", &got); err != nil {
		t.Fatalf("Get: %v", err)
	}

	if got.Name != original.Name || got.Value != original.Value {
		t.Fatalf("roundtrip mismatch: got %+v, want %+v", got, original)
	}
}

func TestGetMiss(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	var dest map[string]string
	err := c.Get(ctx, "nonexistent", &dest)
	if err != ErrCacheMiss {
		t.Fatalf("expected ErrCacheMiss, got %v", err)
	}
}

func TestDelete(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	if err := c.Set(ctx, "delme", "hello", time.Minute); err != nil {
		t.Fatalf("Set: %v", err)
	}

	if err := c.Delete(ctx, "delme"); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	var dest string
	err := c.Get(ctx, "delme", &dest)
	if err != ErrCacheMiss {
		t.Fatalf("expected ErrCacheMiss after delete, got %v", err)
	}
}

func TestPresenceCounts(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	first, err := c.IncrementPresence(ctx, "u1", "conn-1")
	if err != nil {
		t.Fatalf("IncrementPresence first: %v", err)
	}
	if !first {
		t.Fatal("first presence connection should report online transition")
	}
	first, err = c.IncrementPresence(ctx, "u1", "conn-2")
	if err != nil {
		t.Fatalf("IncrementPresence second: %v", err)
	}
	if first {
		t.Fatal("second presence connection should not report online transition")
	}
	online, err := c.IsPresenceOnline(ctx, "u1")
	if err != nil {
		t.Fatalf("IsPresenceOnline: %v", err)
	}
	if !online {
		t.Fatal("u1 should be online")
	}
	ids, err := c.OnlinePresenceUserIDs(ctx)
	if err != nil {
		t.Fatalf("OnlinePresenceUserIDs: %v", err)
	}
	if len(ids) != 1 || ids[0] != "u1" {
		t.Fatalf("online IDs = %v, want [u1]", ids)
	}
	if err := c.RefreshPresence(ctx, "u1", "conn-1"); err != nil {
		t.Fatalf("RefreshPresence: %v", err)
	}

	last, err := c.DecrementPresence(ctx, "u1", "conn-2")
	if err != nil {
		t.Fatalf("DecrementPresence first: %v", err)
	}
	if last {
		t.Fatal("first disconnect should not report offline transition while one connection remains")
	}
	last, err = c.DecrementPresence(ctx, "u1", "conn-1")
	if err != nil {
		t.Fatalf("DecrementPresence second: %v", err)
	}
	if !last {
		t.Fatal("last disconnect should report offline transition")
	}
	online, err = c.IsPresenceOnline(ctx, "u1")
	if err != nil {
		t.Fatalf("IsPresenceOnline after disconnect: %v", err)
	}
	if online {
		t.Fatal("u1 should be offline after last disconnect")
	}
	// Refresh after everything lapsed self-heals (re-creates the entry) —
	// the old counter design returned ErrCacheMiss here and left a live
	// user offline until they physically reconnected.
	if err := c.RefreshPresence(ctx, "u1", "conn-1"); err != nil {
		t.Fatalf("RefreshPresence self-heal: %v", err)
	}
	if on, err := c.IsPresenceOnline(ctx, "u1"); err != nil || !on {
		t.Fatalf("refresh must self-heal the presence entry (on=%v err=%v)", on, err)
	}
}

func TestPresenceKeysExpire(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	if _, err := c.IncrementPresence(ctx, "u1", "conn-1"); err != nil {
		t.Fatalf("IncrementPresence: %v", err)
	}
	expireNow(t, plain, presenceKeyPrefix+"u1")

	online, err := c.IsPresenceOnline(ctx, "u1")
	if err != nil {
		t.Fatalf("IsPresenceOnline: %v", err)
	}
	if online {
		t.Fatal("presence key should expire when websocket keepalive stops refreshing it")
	}
}

// A connection whose keep-alive stopped (crashed instance / dead socket)
// lapses by its own score even while the user's OTHER connection stays live —
// the instance-crash leak of the old per-instance counter cannot happen.
func TestPresenceLapsedConnectionAgesOut(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	if _, err := c.IncrementPresence(ctx, "u1", "conn-live"); err != nil {
		t.Fatalf("IncrementPresence live: %v", err)
	}
	if _, err := c.IncrementPresence(ctx, "u1", "conn-crashed"); err != nil {
		t.Fatalf("IncrementPresence crashed: %v", err)
	}
	// Simulate the crashed connection's keep-alive stopping: rewind its
	// expiry score into the past. The live conn keeps refreshing.
	if err := plain.ZAdd(ctx, presenceKeyPrefix+"u1", redis.Z{Score: float64(time.Now().Add(-time.Second).UnixMilli()), Member: "conn-crashed"}).Err(); err != nil {
		t.Fatalf("rewind: %v", err)
	}
	if err := c.RefreshPresence(ctx, "u1", "conn-live"); err != nil {
		t.Fatalf("RefreshPresence: %v", err)
	}
	if on, err := c.IsPresenceOnline(ctx, "u1"); err != nil || !on {
		t.Fatalf("user with one live conn must stay online (on=%v err=%v)", on, err)
	}
	// The live connection disconnecting is now the LAST one: the lapsed
	// member must not hold the user online (prune runs in the disconnect).
	last, err := c.DecrementPresence(ctx, "u1", "conn-live")
	if err != nil {
		t.Fatalf("DecrementPresence: %v", err)
	}
	if !last {
		t.Fatal("disconnecting the only live conn must report offline despite the lapsed leftover")
	}
}

func TestNotificationAck(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	if c.WasNotificationAcked(ctx, "u1", "m1") {
		t.Fatal("no ack recorded yet, want false")
	}
	if err := c.MarkNotificationAcked(ctx, "u1", "m1"); err != nil {
		t.Fatalf("MarkNotificationAcked: %v", err)
	}
	if !c.WasNotificationAcked(ctx, "u1", "m1") {
		t.Fatal("ack recorded, want true")
	}
	// Scoped per (user, message).
	if c.WasNotificationAcked(ctx, "u1", "m2") {
		t.Fatal("a different messageID must not read as acked")
	}
	if c.WasNotificationAcked(ctx, "u2", "m1") {
		t.Fatal("a different user must not read as acked")
	}
	// Empty args are no-ops / false (defensive).
	if err := c.MarkNotificationAcked(ctx, "", "m1"); err != nil {
		t.Fatalf("empty userID mark: %v", err)
	}
	if c.WasNotificationAcked(ctx, "", "m1") || c.WasNotificationAcked(ctx, "u1", "") {
		t.Fatal("empty args must read false")
	}
	// Expires after the TTL so a stale ack can't suppress a future push.
	expireNow(t, plain, notifAckKeyPrefix+"u1:m1")
	if c.WasNotificationAcked(ctx, "u1", "m1") {
		t.Fatal("ack should expire after notifAckTTL")
	}
}

func TestNotificationAckClientErrors(t *testing.T) {
	c := newDeadCache(t)
	ctx := context.Background()
	if err := c.MarkNotificationAcked(ctx, "u1", "m1"); err == nil {
		t.Fatal("MarkNotificationAcked should error when Redis is down")
	}
	// Fails toward "not acked" so a Redis blip makes the fallback push fire
	// rather than silently swallow an incident alert.
	if c.WasNotificationAcked(ctx, "u1", "m1") {
		t.Fatal("WasNotificationAcked must read false on Redis error (fail toward delivery)")
	}
}

func TestPresenceClientErrors(t *testing.T) {
	c := newDeadCache(t)
	ctx := context.Background()

	if _, err := c.IncrementPresence(ctx, "u1", "c1"); err == nil {
		t.Fatal("expected IncrementPresence error from closed redis")
	}
	if _, err := c.DecrementPresence(ctx, "u1", "c1"); err == nil {
		t.Fatal("expected DecrementPresence error from closed redis")
	}
	if err := c.RefreshPresence(ctx, "u1", "c1"); err == nil {
		t.Fatal("expected RefreshPresence error from closed redis")
	}
	if _, err := c.IsPresenceOnline(ctx, "u1"); err == nil {
		t.Fatal("expected IsPresenceOnline error from closed redis")
	}
	if _, err := c.OnlinePresenceUserIDs(ctx); err == nil {
		t.Fatal("expected OnlinePresenceUserIDs error from closed redis")
	}
}

func TestGetUser(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	user := &model.User{
		ID:          "u123",
		Email:       "test@example.com",
		DisplayName: "Test User",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}

	if err := c.SetUser(ctx, user); err != nil {
		t.Fatalf("SetUser: %v", err)
	}

	got, err := c.GetUser(ctx, "u123")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}

	if got.ID != user.ID {
		t.Fatalf("ID mismatch: got %q, want %q", got.ID, user.ID)
	}
	if got.Email != user.Email {
		t.Fatalf("Email mismatch: got %q, want %q", got.Email, user.Email)
	}
	if got.DisplayName != user.DisplayName {
		t.Fatalf("DisplayName mismatch: got %q, want %q", got.DisplayName, user.DisplayName)
	}
	if got.SystemRole != user.SystemRole {
		t.Fatalf("SystemRole mismatch: got %q, want %q", got.SystemRole, user.SystemRole)
	}
}

func TestGetUserMiss(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	_, err := c.GetUser(ctx, "unknown-user")
	if err != ErrCacheMiss {
		t.Fatalf("expected ErrCacheMiss, got %v", err)
	}
}

// TestSetUserPreservesAvatarKey is a regression test: the public User type
// hides AvatarKey from JSON, but the cache must round-trip it so the avatar
// service can regenerate presigned URLs after a cache hit. Without this, an
// avatar disappears after the first cache hit.
func TestSetUserPreservesAvatarKey(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	user := &model.User{
		ID:          "u-avatar",
		Email:       "x@y.com",
		DisplayName: "Avatar User",
		AvatarKey:   "avatars/u-avatar/01HXY",
		AvatarURL:   "https://expired.example/old",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}

	if err := c.SetUser(ctx, user); err != nil {
		t.Fatalf("SetUser: %v", err)
	}
	got, err := c.GetUser(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if got.AvatarKey != user.AvatarKey {
		t.Fatalf("AvatarKey lost in cache round-trip: got %q, want %q", got.AvatarKey, user.AvatarKey)
	}
}

func TestClient(t *testing.T) {
	c, _ := setupRealTestCache(t)
	if c.Client() == nil {
		t.Fatal("Client() returned nil")
	}
}

func TestGetUnmarshalError(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()
	if err := plain.Set(ctx, "bad", "{not json", 0).Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	var dest map[string]string
	if err := c.Get(ctx, "bad", &dest); err == nil {
		t.Fatal("expected unmarshal error")
	}
}

// TestSetMarshalError covers the "cache marshal" failure path: a value
// that the JSON encoder cannot serialize must surface a wrapped error
// rather than write garbage to Redis.
func TestSetMarshalError(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()
	// Channels can't be marshaled by encoding/json.
	if err := c.Set(ctx, "k", make(chan int), time.Minute); err == nil {
		t.Fatal("expected marshal error")
	}
}

// TestSetClientError covers the "cache set" failure path. Killing the proxy
// in front of the real server forces the underlying client to error.
func TestSetClientError(t *testing.T) {
	c := newDeadCache(t)
	if err := c.Set(context.Background(), "k", "v", time.Minute); err == nil {
		t.Fatal("expected error from closed redis")
	}
}

// TestDeleteClientError exercises the wrap-and-return path on Delete.
func TestDeleteClientError(t *testing.T) {
	c := newDeadCache(t)
	if err := c.Delete(context.Background(), "k"); err == nil {
		t.Fatal("expected error from closed redis")
	}
}

// TestGetClientError exercises the non-cache-miss error branch on Get.
func TestGetClientError(t *testing.T) {
	c := newDeadCache(t)
	var dest string
	if err := c.Get(context.Background(), "k", &dest); err == nil {
		t.Fatal("expected error from closed redis")
	}
}

func TestSetUser(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	user := &model.User{
		ID:          "u456",
		Email:       "user@example.com",
		DisplayName: "Another User",
		SystemRole:  model.SystemRoleAdmin,
		Status:      "active",
	}

	if err := c.SetUser(ctx, user); err != nil {
		t.Fatalf("SetUser: %v", err)
	}

	// Verify the key uses the correct prefix.
	if n, err := plain.Exists(ctx, "user:u456").Result(); err != nil || n != 1 {
		t.Fatalf("Exists(user:u456) = %d, %v; want key to exist in Redis", n, err)
	}
}

// stripRedisErrorHook re-creates every EVALSHA NOSCRIPT failure as a plain
// error, mimicking an instrumentation layer that loses the redis.Error
// interface — the production shape (2026-07-09, Datadog-instrumented build)
// that escaped go-redis's own NOSCRIPT handling and made
// IncrementEmojiFrequency fail persistently after a Redis restart. The
// redisx.RunScript message-text fallback must absorb it.
type stripRedisErrorHook struct{}

func (stripRedisErrorHook) DialHook(next redis.DialHook) redis.DialHook { return next }
func (stripRedisErrorHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func (stripRedisErrorHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		err := next(ctx, cmd)
		if cmd.Name() == "evalsha" && err != nil && strings.Contains(err.Error(), "NOSCRIPT") {
			stripped := errors.New(err.Error())
			cmd.SetErr(stripped)
			return stripped
		}
		return err
	}
}

func TestIncrementEmojiFrequency_SurvivesFlushedScripts(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	// Cache the script server-side, then simulate a restarted/failed-over
	// server (empty script cache) behind instrumentation that strips the
	// redis.Error interface from the NOSCRIPT reply.
	if err := c.IncrementEmojiFrequency(ctx, "u-flush", ":tada:"); err != nil {
		t.Fatalf("seed increment: %v", err)
	}
	if err := plain.ScriptFlush(ctx).Err(); err != nil {
		t.Fatalf("script flush: %v", err)
	}
	c.Client().AddHook(stripRedisErrorHook{})

	if err := c.IncrementEmojiFrequency(ctx, "u-flush", ":tada:"); err != nil {
		t.Fatalf("increment must survive a flushed script cache: %v", err)
	}
	got, err := c.FrequentEmojis(ctx, "u-flush", 5)
	if err != nil || len(got) != 1 || got[0] != ":tada:" {
		t.Fatalf("FrequentEmojis after flush = %v, %v; want [:tada:]", got, err)
	}
}

func TestNewRedisCache_DisablesMaintNotificationsHandshake(t *testing.T) {
	// Regression (2026-07-09): go-redis's default "auto" mode sends CLIENT
	// MAINT_NOTIFICATIONS during the handshake; a server that rejects the
	// subcommand aborted boot via the constructor PING. The built client must
	// carry the disabled mode so the handshake is never attempted.
	c := newRealCache(t)
	t.Cleanup(func() { _ = c.Client().Close() })
	cfg := c.Client().Options().MaintNotificationsConfig
	if cfg == nil || cfg.Mode != maintnotifications.ModeDisabled {
		t.Fatalf("maint notifications must be disabled, got %+v", cfg)
	}
}

func TestEmojiFrequency(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	// No history yet → empty list.
	got, err := c.FrequentEmojis(ctx, "u1", 10)
	if err != nil {
		t.Fatalf("FrequentEmojis empty: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected empty, got %v", got)
	}

	// Record uses: :tada: x3, :smile: x2, :wave: x1.
	for _, sc := range []string{":tada:", ":smile:", ":tada:", ":wave:", ":smile:", ":tada:"} {
		if err := c.IncrementEmojiFrequency(ctx, "u1", sc); err != nil {
			t.Fatalf("IncrementEmojiFrequency: %v", err)
		}
	}

	got, err = c.FrequentEmojis(ctx, "u1", 10)
	if err != nil {
		t.Fatalf("FrequentEmojis: %v", err)
	}
	want := []string{":tada:", ":smile:", ":wave:"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("rank[%d]=%q, want %q (full=%v)", i, got[i], want[i], got)
		}
	}

	// Limit slices to the top N.
	top, err := c.FrequentEmojis(ctx, "u1", 2)
	if err != nil {
		t.Fatalf("FrequentEmojis limit: %v", err)
	}
	if len(top) != 2 || top[0] != ":tada:" || top[1] != ":smile:" {
		t.Fatalf("limited list = %v, want [:tada: :smile:]", top)
	}

	// A non-positive limit yields an empty list without touching Redis.
	if zero, err := c.FrequentEmojis(ctx, "u1", 0); err != nil || len(zero) != 0 {
		t.Fatalf("FrequentEmojis(0) = %v, %v", zero, err)
	}

	// Recording refreshes the TTL window.
	if ttl, err := plain.TTL(ctx, emojiFreqKeyPrefix+"u1").Result(); err != nil || ttl <= 0 {
		t.Fatalf("expected a positive TTL, got %v (err=%v)", ttl, err)
	}

	// CONTINUOUS reordering (regression: the shelf must never freeze): using
	// the currently-lowest emoji more flips it to the top of the list.
	for i := 0; i < 4; i++ {
		if err := c.IncrementEmojiFrequency(ctx, "u1", ":wave:"); err != nil {
			t.Fatalf("IncrementEmojiFrequency(:wave:): %v", err)
		}
	}
	got, err = c.FrequentEmojis(ctx, "u1", 10)
	if err != nil {
		t.Fatalf("FrequentEmojis after reorder: %v", err)
	}
	if len(got) == 0 || got[0] != ":wave:" {
		t.Fatalf("continued use must reorder the shelf; got %v, want :wave: first", got)
	}
}

func TestEmojiFrequencyFavoriteStaysDurable(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	// Eight uses of one emoji build a score (~5.7, converging toward 1/(1-decay))
	// that sits far above a single use of another: one pick decays the favourite
	// by a single factor (~5.1) but can't overtake it. Dislodging an entrenched
	// favourite takes sustained use of a rival — covered by
	// TestEmojiFrequencyRecencyDecay.
	for i := 0; i < 8; i++ {
		if err := c.IncrementEmojiFrequency(ctx, "u9", ":favorite:"); err != nil {
			t.Fatalf("IncrementEmojiFrequency(:favorite:): %v", err)
		}
	}
	if err := c.IncrementEmojiFrequency(ctx, "u9", ":newcomer:"); err != nil {
		t.Fatalf("IncrementEmojiFrequency(:newcomer:): %v", err)
	}
	got, err := c.FrequentEmojis(ctx, "u9", 10)
	if err != nil {
		t.Fatalf("FrequentEmojis: %v", err)
	}
	if len(got) != 2 || got[0] != ":favorite:" {
		t.Fatalf("the established favourite must stay on top, got %v", got)
	}
}

func TestEmojiFrequencyReadRefreshesTTL(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	// Reading the shelf (opening the picker / rendering the quick-bar) must
	// refresh the TTL so an active user never ages out their favourites.
	if err := c.IncrementEmojiFrequency(ctx, "u1", ":tada:"); err != nil {
		t.Fatalf("IncrementEmojiFrequency: %v", err)
	}
	key := emojiFreqKeyPrefix + "u1"
	// Shrink the window, then a READ must push it back out toward the full TTL.
	if err := plain.Expire(ctx, key, 30*time.Second).Err(); err != nil {
		t.Fatalf("shrink TTL: %v", err)
	}
	if _, err := c.FrequentEmojis(ctx, "u1", 10); err != nil {
		t.Fatalf("FrequentEmojis: %v", err)
	}
	ttl, err := plain.TTL(ctx, key).Result()
	if err != nil {
		t.Fatalf("TTL: %v", err)
	}
	if ttl <= time.Hour {
		t.Fatalf("read must refresh the TTL back toward %v, got %v", emojiFreqTTL, ttl)
	}
}

func TestEmojiFrequencyRecencyDecay(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()

	// Decay is PER-EVENT, not per wall-clock time: every pick rescales all
	// existing scores by emojiFreqDecay before the picked emoji gains +1. So it
	// is *using other emojis* — not the passage of time — that pushes a stale
	// favourite down. This is the fix for the "stuck emojis" report: a shelf
	// that never moved in a session because almost no real time elapsed.

	// An established favourite: 8 uses build a score of ~5.7.
	for i := 0; i < 8; i++ {
		if err := c.IncrementEmojiFrequency(ctx, "u1", ":favorite:"); err != nil {
			t.Fatalf("increment favorite: %v", err)
		}
	}

	// GENTLE: a single rival pick must NOT bury the favourite. It decays the
	// favourite once (~5.1) while the newcomer only reaches 1 — the exact
	// "losing favourites" guard the earlier aggressive schemes failed.
	if err := c.IncrementEmojiFrequency(ctx, "u1", ":newcomer:"); err != nil {
		t.Fatalf("increment newcomer: %v", err)
	}
	got, err := c.FrequentEmojis(ctx, "u1", 10)
	if err != nil {
		t.Fatalf("FrequentEmojis: %v", err)
	}
	if len(got) != 2 || got[0] != ":favorite:" {
		t.Fatalf("one rival pick must not bury an established favourite; got %v", got)
	}

	// RECENCY WINS: sustained use of the newcomer (a handful more picks) climbs
	// it past the now-repeatedly-decayed favourite — the shelf follows current
	// habits, and a genuinely stuck emoji WILL be dislodged by using others.
	for i := 0; i < 9; i++ {
		if err := c.IncrementEmojiFrequency(ctx, "u1", ":newcomer:"); err != nil {
			t.Fatalf("increment newcomer burst %d: %v", i, err)
		}
	}
	got, err = c.FrequentEmojis(ctx, "u1", 10)
	if err != nil {
		t.Fatalf("FrequentEmojis after burst: %v", err)
	}
	if len(got) == 0 || got[0] != ":newcomer:" {
		t.Fatalf("sustained recent use must climb to the top; got %v", got)
	}
}

func TestEmojiFrequencyNeverPurges(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	if err := c.IncrementEmojiFrequency(ctx, "u2", ":old:"); err != nil {
		t.Fatalf("increment old: %v", err)
	}
	// Hammering a newcomer 40 times decays :old: down toward zero (0.9^40 ≈
	// 0.015) — but it is NEVER removed, only ranked below the newcomer. The
	// shelf stays full from history; nothing the user ever used is purged.
	for i := 0; i < 40; i++ {
		if err := c.IncrementEmojiFrequency(ctx, "u2", ":new:"); err != nil {
			t.Fatalf("increment new %d: %v", i, err)
		}
	}
	got, err := c.FrequentEmojis(ctx, "u2", 10)
	if err != nil {
		t.Fatalf("FrequentEmojis: %v", err)
	}
	if len(got) != 2 || got[0] != ":new:" || got[1] != ":old:" {
		t.Fatalf("the old emoji must survive (ranked below the newcomer); got %v", got)
	}
	// Both members remain in the set — decay rescales, it never deletes.
	n, err := plain.ZCard(ctx, emojiFreqKeyPrefix+"u2").Result()
	if err != nil {
		t.Fatalf("ZCard: %v", err)
	}
	if n != 2 {
		t.Fatalf("decay must not purge members, set size = %d, want 2", n)
	}
}

func TestEmojiFrequencyClientErrors(t *testing.T) {
	c := newDeadCache(t)
	ctx := context.Background()

	if err := c.IncrementEmojiFrequency(ctx, "u1", ":x:"); err == nil {
		t.Fatal("expected IncrementEmojiFrequency error from closed redis")
	}
	if _, err := c.FrequentEmojis(ctx, "u1", 5); err == nil {
		t.Fatal("expected FrequentEmojis error from closed redis")
	}
}

func TestAllowRequest_FixedWindow(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	// First two within limit=2; third exceeds.
	for i, want := range []bool{true, true, false} {
		got, err := c.AllowRequest(ctx, "k1", 2, time.Minute)
		if err != nil {
			t.Fatalf("AllowRequest #%d: %v", i, err)
		}
		if got != want {
			t.Errorf("AllowRequest #%d = %v, want %v", i, got, want)
		}
	}

	// A distinct key has its own window.
	if ok, err := c.AllowRequest(ctx, "k2", 2, time.Minute); err != nil || !ok {
		t.Fatalf("distinct key should be allowed: ok=%v err=%v", ok, err)
	}

	// After the window elapses the counter resets.
	expireNow(t, plain, "ratelimit:k1")
	if ok, err := c.AllowRequest(ctx, "k1", 2, time.Minute); err != nil || !ok {
		t.Fatalf("after window reset should be allowed: ok=%v err=%v", ok, err)
	}
}

func TestAllowRequest_ClientError(t *testing.T) {
	c := newDeadCache(t) // force a connection error
	if _, err := c.AllowRequest(context.Background(), "k", 1, time.Minute); err == nil {
		t.Fatal("expected error when Redis is unreachable")
	}
}

func TestWSTickets(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()
	deadline := time.Now().Add(16 * time.Minute).Truncate(time.Millisecond)

	if err := c.MintWSTicket(ctx, "tick-1", "u-9", deadline); err != nil {
		t.Fatalf("MintWSTicket: %v", err)
	}
	uid, got, err := c.ConsumeWSTicket(ctx, "tick-1")
	if err != nil || uid != "u-9" || !got.Equal(deadline) {
		t.Fatalf("ConsumeWSTicket = (%q, %v, %v), want (u-9, %v, nil)", uid, got, err, deadline)
	}
	// Single-use: the second redemption finds nothing (GETDEL).
	uid, _, err = c.ConsumeWSTicket(ctx, "tick-1")
	if err != nil || uid != "" {
		t.Fatalf("second redemption = (%q, %v), want empty", uid, err)
	}
	// Unknown ticket and empty ticket both read as not-found, not errors.
	if uid, _, err := c.ConsumeWSTicket(ctx, "never-minted"); err != nil || uid != "" {
		t.Fatalf("unknown ticket = (%q, %v), want empty", uid, err)
	}
	if uid, _, err := c.ConsumeWSTicket(ctx, ""); err != nil || uid != "" {
		t.Fatalf("empty ticket = (%q, %v), want empty", uid, err)
	}
	// Expired ticket is gone.
	if err := c.MintWSTicket(ctx, "tick-exp", "u-9", deadline); err != nil {
		t.Fatalf("MintWSTicket: %v", err)
	}
	expireNow(t, plain, wsTicketKeyPrefix+"tick-exp")
	if uid, _, err := c.ConsumeWSTicket(ctx, "tick-exp"); err != nil || uid != "" {
		t.Fatalf("expired ticket = (%q, %v), want empty", uid, err)
	}
	// Corrupt stored values read as not-found (defensive, never a panic).
	for i, raw := range []string{"no-separator", "|123", "u|not-a-number"} {
		key := fmt.Sprintf("tick-bad-%d", i)
		if err := plain.Set(ctx, wsTicketKeyPrefix+key, raw, time.Minute).Err(); err != nil {
			t.Fatalf("seed corrupt: %v", err)
		}
		if uid, _, err := c.ConsumeWSTicket(ctx, key); err != nil || uid != "" {
			t.Fatalf("corrupt %q = (%q, %v), want empty", raw, uid, err)
		}
	}
	// Guard arms: empty inputs at mint.
	if err := c.MintWSTicket(ctx, "", "u-9", deadline); err == nil {
		t.Fatal("empty ticket mint must error")
	}
	if err := c.MintWSTicket(ctx, "tick-2", "", deadline); err == nil {
		t.Fatal("empty user mint must error")
	}
	// Redis-error arms.
	dead := newDeadCache(t)
	if err := dead.MintWSTicket(ctx, "t", "u", deadline); err == nil {
		t.Fatal("mint against dead redis must error")
	}
	if _, _, err := dead.ConsumeWSTicket(ctx, "t"); err == nil {
		t.Fatal("consume against dead redis must error")
	}
}

func TestPasswordResetTickets(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	if err := c.MintPasswordResetTicket(ctx, "hash-1", "u-guest", time.Hour); err != nil {
		t.Fatalf("MintPasswordResetTicket: %v", err)
	}
	uid, err := c.ConsumePasswordResetTicket(ctx, "hash-1")
	if err != nil || uid != "u-guest" {
		t.Fatalf("ConsumePasswordResetTicket = (%q, %v), want (u-guest, nil)", uid, err)
	}
	// Single-use: a redeemed reset link can never be replayed (GETDEL).
	if uid, err := c.ConsumePasswordResetTicket(ctx, "hash-1"); err != nil || uid != "" {
		t.Fatalf("second redemption = (%q, %v), want empty", uid, err)
	}
	// Unknown and empty tokens read as not-found, not errors — the caller
	// answers with the same generic "invalid or expired link" either way.
	if uid, err := c.ConsumePasswordResetTicket(ctx, "never-minted"); err != nil || uid != "" {
		t.Fatalf("unknown token = (%q, %v), want empty", uid, err)
	}
	if uid, err := c.ConsumePasswordResetTicket(ctx, ""); err != nil || uid != "" {
		t.Fatalf("empty token = (%q, %v), want empty", uid, err)
	}
	// An expired ticket is gone: the TTL bounds how long a leaked link lives.
	if err := c.MintPasswordResetTicket(ctx, "hash-exp", "u-guest", time.Hour); err != nil {
		t.Fatalf("MintPasswordResetTicket: %v", err)
	}
	expireNow(t, plain, pwResetKeyPrefix+"hash-exp")
	if uid, err := c.ConsumePasswordResetTicket(ctx, "hash-exp"); err != nil || uid != "" {
		t.Fatalf("expired token = (%q, %v), want empty", uid, err)
	}
	// Guard arms: empty inputs at mint.
	if err := c.MintPasswordResetTicket(ctx, "", "u-guest", time.Hour); err == nil {
		t.Fatal("empty token mint must error")
	}
	if err := c.MintPasswordResetTicket(ctx, "hash-2", "", time.Hour); err == nil {
		t.Fatal("empty user mint must error")
	}
	// Redis-error arms.
	dead := newDeadCache(t)
	if err := dead.MintPasswordResetTicket(ctx, "h", "u", time.Hour); err == nil {
		t.Fatal("mint against dead redis must error")
	}
	if _, err := dead.ConsumePasswordResetTicket(ctx, "h"); err == nil {
		t.Fatal("consume against dead redis must error")
	}
}
