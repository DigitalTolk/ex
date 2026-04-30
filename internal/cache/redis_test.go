package cache

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/DigitalTolk/ex/internal/model"
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
