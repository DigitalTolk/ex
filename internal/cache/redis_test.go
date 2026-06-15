package cache

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/alicebob/miniredis/v2"
)

func setupTestCache(t *testing.T) (*RedisCache, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	cache, err := NewRedisCache("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}
	return cache, mr
}

func TestNewRedisCache(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		c, _ := setupTestCache(t)
		if c == nil {
			t.Fatal("expected non-nil cache")
		}
	})

	t.Run("bad URL", func(t *testing.T) {
		_, err := NewRedisCache("not-a-valid-url")
		if err == nil {
			t.Fatal("expected error for bad URL")
		}
	})
}

func TestGetSet(t *testing.T) {
	c, _ := setupTestCache(t)
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
	c, _ := setupTestCache(t)
	ctx := context.Background()

	var dest map[string]string
	err := c.Get(ctx, "nonexistent", &dest)
	if err != ErrCacheMiss {
		t.Fatalf("expected ErrCacheMiss, got %v", err)
	}
}

func TestDelete(t *testing.T) {
	c, _ := setupTestCache(t)
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
	c, _ := setupTestCache(t)
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
	c, mr := setupTestCache(t)
	ctx := context.Background()

	if _, err := c.IncrementPresence(ctx, "u1"); err != nil {
		t.Fatalf("IncrementPresence: %v", err)
	}
	mr.FastForward(presenceTTL + time.Second)

	online, err := c.IsPresenceOnline(ctx, "u1")
	if err != nil {
		t.Fatalf("IsPresenceOnline: %v", err)
	}
	if online {
		t.Fatal("presence key should expire when websocket keepalive stops refreshing it")
	}
}

func TestPresenceClientErrors(t *testing.T) {
	c, mr := setupTestCache(t)
	mr.Close()
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
	c, _ := setupTestCache(t)
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
	c, _ := setupTestCache(t)
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
	c, _ := setupTestCache(t)
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
	c, _ := setupTestCache(t)
	if c.Client() == nil {
		t.Fatal("Client() returned nil")
	}
}

func TestGetUnmarshalError(t *testing.T) {
	c, mr := setupTestCache(t)
	ctx := context.Background()
	if err := mr.Set("bad", "{not json"); err != nil {
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
	c, _ := setupTestCache(t)
	ctx := context.Background()
	// Channels can't be marshaled by encoding/json.
	if err := c.Set(ctx, "k", make(chan int), time.Minute); err == nil {
		t.Fatal("expected marshal error")
	}
}

// TestSetClientError covers the "cache set" failure path. Closing the
// miniredis instance forces the underlying client to error.
func TestSetClientError(t *testing.T) {
	c, mr := setupTestCache(t)
	mr.Close()
	if err := c.Set(context.Background(), "k", "v", time.Minute); err == nil {
		t.Fatal("expected error from closed redis")
	}
}

// TestDeleteClientError exercises the wrap-and-return path on Delete.
func TestDeleteClientError(t *testing.T) {
	c, mr := setupTestCache(t)
	mr.Close()
	if err := c.Delete(context.Background(), "k"); err == nil {
		t.Fatal("expected error from closed redis")
	}
}

// TestGetClientError exercises the non-cache-miss error branch on Get.
func TestGetClientError(t *testing.T) {
	c, mr := setupTestCache(t)
	mr.Close()
	var dest string
	if err := c.Get(context.Background(), "k", &dest); err == nil {
		t.Fatal("expected error from closed redis")
	}
}

func TestSetUser(t *testing.T) {
	c, mr := setupTestCache(t)
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
	if !mr.Exists("user:u456") {
		t.Fatal("expected key 'user:u456' to exist in Redis")
	}
}

func TestEmojiFrequency(t *testing.T) {
	c, mr := setupTestCache(t)
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
	if ttl := mr.TTL(emojiFreqKeyPrefix + "u1"); ttl <= 0 {
		t.Fatalf("expected a positive TTL, got %v", ttl)
	}
}

func TestEmojiFrequencyClientErrors(t *testing.T) {
	c, mr := setupTestCache(t)
	mr.Close()
	ctx := context.Background()

	if err := c.IncrementEmojiFrequency(ctx, "u1", ":x:"); err == nil {
		t.Fatal("expected IncrementEmojiFrequency error from closed redis")
	}
	if _, err := c.FrequentEmojis(ctx, "u1", 5); err == nil {
		t.Fatal("expected FrequentEmojis error from closed redis")
	}
}
