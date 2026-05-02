package service

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestPresignedCache_HitWithinTTL(t *testing.T) {
	c := newPresignedURLCache(time.Hour)
	calls := 0
	sign := func(context.Context) (string, error) {
		calls++
		return "https://signed.example/x", nil
	}
	k := presignedKey{op: "get", key: "obj-1"}
	for i := 0; i < 3; i++ {
		got, err := c.getOrSign(context.Background(), k, sign)
		if err != nil {
			t.Fatal(err)
		}
		if got != "https://signed.example/x" {
			t.Fatalf("unexpected url: %q", got)
		}
	}
	if calls != 1 {
		t.Fatalf("expected one sign call, got %d", calls)
	}
}

func TestPresignedCache_CapsRequestedHourScaleTTL(t *testing.T) {
	c := newPresignedURLCache(20 * time.Hour)
	if c.ttl != presignedURLCacheTTL {
		t.Fatalf("ttl = %s, want capped %s", c.ttl, presignedURLCacheTTL)
	}
}

func TestPresignedCache_UsesDefaultSafetyTTLForInvalidTTL(t *testing.T) {
	c := newPresignedURLCache(0)
	if c.ttl != presignedURLCacheTTL {
		t.Fatalf("ttl = %s, want safety default %s", c.ttl, presignedURLCacheTTL)
	}
}

func TestPresignedCache_ExpiredEntryEvictedOnRead(t *testing.T) {
	c := newPresignedURLCache(time.Nanosecond)
	calls := 0
	sign := func(context.Context) (string, error) {
		calls++
		return "url", nil
	}
	k := presignedKey{op: "get", key: "obj-1"}
	if _, err := c.getOrSign(context.Background(), k, sign); err != nil {
		t.Fatal(err)
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := c.getOrSign(context.Background(), k, sign); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("expected expired entry to be re-signed, got calls=%d", calls)
	}
}

func TestPresignedCache_BoundedSize(t *testing.T) {
	c := &presignedURLCache{ttl: time.Hour, maxSize: 3, items: map[presignedKey]presignedEntry{}}
	for i := 0; i < 10; i++ {
		k := presignedKey{op: "get", key: string(rune('a' + i))}
		if _, err := c.getOrSign(context.Background(), k, func(context.Context) (string, error) {
			return "u", nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if len(c.items) > 3 {
		t.Fatalf("cache exceeded max size: %d", len(c.items))
	}
}

func TestPresignedCache_EvictsExpiredFirst(t *testing.T) {
	c := &presignedURLCache{ttl: time.Hour, maxSize: 2, items: map[presignedKey]presignedEntry{}}
	now := time.Now()
	c.items[presignedKey{op: "get", key: "old"}] = presignedEntry{url: "u-old", expiresAt: now.Add(-time.Minute)}
	c.items[presignedKey{op: "get", key: "fresh"}] = presignedEntry{url: "u-fresh", expiresAt: now.Add(time.Hour)}
	if _, err := c.getOrSign(context.Background(), presignedKey{op: "get", key: "new"}, func(context.Context) (string, error) {
		return "u-new", nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, ok := c.items[presignedKey{op: "get", key: "old"}]; ok {
		t.Fatal("expected expired entry to be evicted first")
	}
	if _, ok := c.items[presignedKey{op: "get", key: "fresh"}]; !ok {
		t.Fatal("expected fresh entry to be retained")
	}
}

func TestPresignedCache_NilCacheBypasses(t *testing.T) {
	var c *presignedURLCache
	got, err := c.getOrSign(context.Background(), presignedKey{op: "get", key: "x"}, func(context.Context) (string, error) {
		return "passthrough", nil
	})
	if err != nil || got != "passthrough" {
		t.Fatalf("nil cache should bypass: got=%q err=%v", got, err)
	}
	c.invalidate("x") // must not panic
}

func TestPresignedCache_SignErrorNotCached(t *testing.T) {
	c := newPresignedURLCache(time.Hour)
	want := errors.New("boom")
	if _, err := c.getOrSign(context.Background(), presignedKey{op: "get", key: "x"}, func(context.Context) (string, error) {
		return "", want
	}); !errors.Is(err, want) {
		t.Fatalf("expected sign error: got %v", err)
	}
	if len(c.items) != 0 {
		t.Fatal("error result should not be cached")
	}
}

func TestPresignedCache_InvalidateDropsAllVariants(t *testing.T) {
	c := newPresignedURLCache(time.Hour)
	for _, op := range []string{"get", "download"} {
		_, _ = c.getOrSign(context.Background(), presignedKey{op: op, key: "obj"}, func(context.Context) (string, error) {
			return "u", nil
		})
	}
	if len(c.items) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(c.items))
	}
	c.invalidate("obj")
	if len(c.items) != 0 {
		t.Fatalf("expected all variants dropped, got %d", len(c.items))
	}
}
