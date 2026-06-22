//go:build integration

package cache

import (
	"context"
	"fmt"
	"log"
	"os"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// The rate limiter (RedisCache.AllowRequest) is INCR + EXPIRE on real Redis.
// Unit tests run it against miniredis; this runs it against a real Redis
// container, including a genuine TTL expiry (miniredis fakes that with
// FastForward) so the window-reset behaviour is validated against the engine.
var (
	cacheRedisAddr  string
	cacheRedisReady bool
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	req := testcontainers.ContainerRequest{
		Image:        "redis:7-alpine",
		ExposedPorts: []string{"6379/tcp"},
		WaitingFor:   wait.ForListeningPort("6379/tcp").WithStartupTimeout(60 * time.Second),
	}
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{ContainerRequest: req, Started: true})
	if err != nil {
		log.Printf("cache integration tests will skip: docker/redis unavailable: %v", err)
		os.Exit(m.Run())
	}
	if host, herr := c.Host(ctx); herr == nil {
		if port, perr := c.MappedPort(ctx, "6379"); perr == nil {
			cacheRedisAddr = fmt.Sprintf("%s:%s", host, port.Port())
			cacheRedisReady = true
		}
	}
	code := m.Run()
	_ = c.Terminate(ctx)
	os.Exit(code)
}

func newRealCache(t *testing.T) *RedisCache {
	t.Helper()
	if !cacheRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	c, err := NewRedisCache("redis://" + cacheRedisAddr)
	if err != nil {
		t.Fatalf("NewRedisCache against real Redis: %v", err)
	}
	return c
}

func TestAllowRequest_RealRedis_FixedWindow(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()

	for i, want := range []bool{true, true, false} {
		got, err := c.AllowRequest(ctx, "fixed-window", 2, time.Minute)
		if err != nil {
			t.Fatalf("AllowRequest #%d: %v", i, err)
		}
		if got != want {
			t.Errorf("AllowRequest #%d = %v, want %v", i, got, want)
		}
	}

	// A distinct key has its own independent budget.
	if ok, err := c.AllowRequest(ctx, "other-key", 2, time.Minute); err != nil || !ok {
		t.Fatalf("distinct key should be allowed: ok=%v err=%v", ok, err)
	}
}

func TestAllowRequest_RealRedis_WindowExpires(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()

	// limit 1 in a 1s window: first allowed, second blocked.
	if ok, err := c.AllowRequest(ctx, "expiring", 1, time.Second); err != nil || !ok {
		t.Fatalf("first request should pass: ok=%v err=%v", ok, err)
	}
	if ok, _ := c.AllowRequest(ctx, "expiring", 1, time.Second); ok {
		t.Fatal("second request in the same window must be blocked")
	}

	// After the real Redis key TTL elapses, the window resets and requests flow
	// again — validates the EXPIRE that miniredis only simulates.
	time.Sleep(1200 * time.Millisecond)
	if ok, err := c.AllowRequest(ctx, "expiring", 1, time.Second); err != nil || !ok {
		t.Fatalf("after the window expired the request should pass again: ok=%v err=%v", ok, err)
	}
}
