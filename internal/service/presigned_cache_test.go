package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
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
	if got := presignedTTL(20 * time.Hour); got != presignedURLCacheTTL {
		t.Fatalf("ttl = %s, want capped %s", got, presignedURLCacheTTL)
	}
	if got := presignedTTL(time.Minute); got != time.Minute {
		t.Fatalf("ttl = %s, want the requested 1m", got)
	}
}

func TestPresignedCache_UsesDefaultSafetyTTLForInvalidTTL(t *testing.T) {
	if got := presignedTTL(0); got != presignedURLCacheTTL {
		t.Fatalf("ttl = %s, want safety default %s", got, presignedURLCacheTTL)
	}
}

// An expired entry is signed afresh. Wait for that re-sign, never for a
// fixed time.
func TestPresignedCache_ExpiredEntryResigned(t *testing.T) {
	c := newSizedPresignedURLCache(16, 20*time.Millisecond)
	var calls atomic.Int32
	sign := func(context.Context) (string, error) {
		return fmt.Sprintf("url-%d", calls.Add(1)), nil
	}
	k := presignedKey{op: "get", key: "obj-1"}
	first, err := c.getOrSign(context.Background(), k, sign)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := c.getOrSign(context.Background(), k, sign)
		if err != nil {
			t.Fatal(err)
		}
		if got != first {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("url = %q, never re-signed after the TTL", got)
		}
	}
	if got := calls.Load(); got != 2 {
		t.Fatalf("sign calls = %d, want 2 (one per TTL window)", got)
	}
}

// The cache and its invalidation index are bounded: filling past the cap
// evicts the least recently used variant, never the one just read.
func TestPresignedCache_BoundedLRU(t *testing.T) {
	c := newSizedPresignedURLCache(2, time.Hour)
	var calls atomic.Int32
	sign := func(context.Context) (string, error) {
		calls.Add(1)
		return "u", nil
	}
	get := func(key string) {
		t.Helper()
		if _, err := c.getOrSign(context.Background(), presignedKey{op: "get", key: key}, sign); err != nil {
			t.Fatal(err)
		}
	}
	get("a")
	get("b")
	get("a") // a is now the most recently used
	get("c") // evicts b
	if got := c.urls.Len(); got != 2 {
		t.Fatalf("cache holds %d entries, want the cap of 2", got)
	}
	c.mu.Lock()
	_, bIndexed := c.variants["b"]
	indexed := len(c.variants)
	c.mu.Unlock()
	if bIndexed || indexed != 2 {
		t.Fatalf("variant index = %d keys (b indexed: %v), want 2 without b", indexed, bIndexed)
	}
	get("a")
	if got := calls.Load(); got != 3 {
		t.Fatalf("sign calls = %d, want 3 (a stayed cached)", got)
	}
	get("b")
	if got := calls.Load(); got != 4 {
		t.Fatalf("sign calls = %d, want 4 (b was evicted)", got)
	}
}

// Concurrent misses for one variant share ONE sign instead of stampeding
// the signer.
func TestPresignedCache_ConcurrentMissesShareOneSign(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c := newSizedPresignedURLCache(16, 0)
		var calls atomic.Int32
		release := make(chan struct{})
		sign := func(context.Context) (string, error) {
			calls.Add(1)
			<-release
			return "u", nil
		}
		k := presignedKey{op: "get", key: "hot"}
		var wg sync.WaitGroup
		for range 10 {
			wg.Go(func() {
				if got, err := c.getOrSign(context.Background(), k, sign); err != nil || got != "u" {
					t.Errorf("getOrSign = %q, %v", got, err)
				}
			})
		}
		synctest.Wait() // every caller is parked: one signing, the rest waiting on it
		close(release)
		wg.Wait()
		if got := calls.Load(); got != 1 {
			t.Fatalf("sign calls = %d, want 1 shared sign", got)
		}
	})
}

// The shared sign doesn't inherit the first caller's cancellation, so that
// caller giving up can't fail everyone waiting on it.
func TestPresignedCache_SharedSignIgnoresCallerCancellation(t *testing.T) {
	c := newSizedPresignedURLCache(16, time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, err := c.getOrSign(ctx, presignedKey{op: "get", key: "x"}, func(ctx context.Context) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		return "u", nil
	})
	if err != nil || got != "u" {
		t.Fatalf("getOrSign = %q, %v; want the URL despite the cancelled caller", got, err)
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
	if c.urls.Len() != 0 {
		t.Fatal("error result should not be cached")
	}
}

func TestPresignedCache_InvalidateDropsAllVariants(t *testing.T) {
	c := newPresignedURLCache(time.Hour)
	for _, k := range []presignedKey{{op: "get", key: "obj"}, {op: "download", key: "obj", extra: "a.pdf"}, {op: "get", key: "other"}} {
		_, _ = c.getOrSign(context.Background(), k, func(context.Context) (string, error) {
			return "u", nil
		})
	}
	if c.urls.Len() != 3 {
		t.Fatalf("expected 3 entries, got %d", c.urls.Len())
	}
	c.invalidate("obj")
	if c.urls.Len() != 1 {
		t.Fatalf("expected only the other key left, got %d entries", c.urls.Len())
	}
	if _, ok := c.urls.Get(presignedKey{op: "get", key: "other"}); !ok {
		t.Fatal("invalidating obj dropped another key's URL")
	}
	c.mu.Lock()
	_, objIndexed := c.variants["obj"]
	c.mu.Unlock()
	if objIndexed {
		t.Fatal("invalidated key still in the variant index")
	}
}
