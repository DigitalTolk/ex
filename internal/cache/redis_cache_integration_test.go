//go:build integration

package cache

import (
	"context"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
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

	first, err := c.IncrementPresence(ctx, "u1")
	if err != nil {
		t.Fatalf("IncrementPresence first: %v", err)
	}
	if !first {
		t.Fatal("first presence increment should report online transition")
	}
	first, err = c.IncrementPresence(ctx, "u1")
	if err != nil {
		t.Fatalf("IncrementPresence second: %v", err)
	}
	if first {
		t.Fatal("second presence increment should not report online transition")
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
	if err := c.RefreshPresence(ctx, "u1"); err != nil {
		t.Fatalf("RefreshPresence: %v", err)
	}

	last, err := c.DecrementPresence(ctx, "u1")
	if err != nil {
		t.Fatalf("DecrementPresence first: %v", err)
	}
	if last {
		t.Fatal("first decrement should not report offline transition while one connection remains")
	}
	last, err = c.DecrementPresence(ctx, "u1")
	if err != nil {
		t.Fatalf("DecrementPresence second: %v", err)
	}
	if !last {
		t.Fatal("last decrement should report offline transition")
	}
	online, err = c.IsPresenceOnline(ctx, "u1")
	if err != nil {
		t.Fatalf("IsPresenceOnline after disconnect: %v", err)
	}
	if online {
		t.Fatal("u1 should be offline after last decrement")
	}
	if err := c.RefreshPresence(ctx, "u1"); err != ErrCacheMiss {
		t.Fatalf("missing RefreshPresence error = %v, want ErrCacheMiss", err)
	}
}

func TestPresenceKeysExpire(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	if _, err := c.IncrementPresence(ctx, "u1"); err != nil {
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

	if _, err := c.IncrementPresence(ctx, "u1"); err == nil {
		t.Fatal("expected IncrementPresence error from closed redis")
	}
	if _, err := c.DecrementPresence(ctx, "u1"); err == nil {
		t.Fatal("expected DecrementPresence error from closed redis")
	}
	if err := c.RefreshPresence(ctx, "u1"); err == nil {
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
