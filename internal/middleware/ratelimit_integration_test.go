//go:build integration

package middleware

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// The limiter is exercised against a real Redis: GCRA semantics, the
// per-name isolation of counters, and the EVALSHA fallback all live in Lua
// and in go-redis, which a fake would only restate.

var (
	rlRedisAddr  string
	rlRedisReady bool
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
		log.Printf("rate-limit integration tests will skip: docker/redis unavailable: %v", err)
		os.Exit(m.Run())
	}
	if host, herr := c.Host(ctx); herr == nil {
		if port, perr := c.MappedPort(ctx, "6379"); perr == nil {
			rlRedisAddr = fmt.Sprintf("%s:%s", host, port.Port())
			rlRedisReady = true
		}
	}
	code := m.Run()
	_ = c.Terminate(ctx)
	os.Exit(code)
}

func newRateLimitRedis(t *testing.T) *redis.Client {
	t.Helper()
	if !rlRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	opts, err := redisx.Options("redis://" + rlRedisAddr)
	if err != nil {
		t.Fatalf("options: %v", err)
	}
	client := redis.NewClient(opts)
	t.Cleanup(func() { _ = client.Close() })
	if err := client.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	return client
}

func TestRedisRateLimiter_BurstThenRefuses(t *testing.T) {
	l := NewRedisRateLimiter(newRateLimitRedis(t))
	ctx := context.Background()
	lim := PerMinute("burst", 2, 3)
	for i := 1; i <= 3; i++ {
		ok, _, err := l.Allow(ctx, "k", lim)
		if err != nil || !ok {
			t.Fatalf("request %d within the burst: ok=%v err=%v", i, ok, err)
		}
	}
	ok, retry, err := l.Allow(ctx, "k", lim)
	if err != nil || ok {
		t.Fatalf("request past the burst: ok=%v err=%v, want refused", ok, err)
	}
	if retry <= 0 || retry > time.Minute {
		t.Fatalf("retryAfter = %v, want a wait within the period", retry)
	}
	// Another key is untouched.
	if ok, _, err := l.Allow(ctx, "other", lim); err != nil || !ok {
		t.Fatalf("independent key refused: ok=%v err=%v", ok, err)
	}
}

func TestRedisRateLimiter_RedisErrorSurfaces(t *testing.T) {
	client := newRateLimitRedis(t)
	l := NewRedisRateLimiter(client)
	_ = client.Close()
	if _, _, err := l.Allow(context.Background(), "k", PerMinute("closed", 1, 1)); err == nil {
		t.Fatal("a closed client must surface an error (the middleware fails open on it)")
	}
}

// stripNoScript re-creates EVALSHA's NOSCRIPT failure as a plain error, the
// shape an error-wrapping instrumentation layer produces (see redisx).
type stripNoScript struct{}

func (stripNoScript) DialHook(next redis.DialHook) redis.DialHook { return next }
func (stripNoScript) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return next
}
func (stripNoScript) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
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

func TestRedisRateLimiter_SurvivesAnEmptyScriptCacheBehindInstrumentation(t *testing.T) {
	client := newRateLimitRedis(t)
	client.AddHook(stripNoScript{})
	if err := client.ScriptFlush(context.Background()).Err(); err != nil {
		t.Fatalf("script flush: %v", err)
	}
	l := NewRedisRateLimiter(client)
	if ok, _, err := l.Allow(context.Background(), "k", PerMinute("noscript", 5, 5)); err != nil || !ok {
		t.Fatalf("limiter after SCRIPT FLUSH: ok=%v err=%v, want allowed", ok, err)
	}
}

// Other EVALSHA failures pass through untouched.
func TestNoScriptTolerant_OtherErrorsUntouched(t *testing.T) {
	client := newRateLimitRedis(t)
	ctx := context.Background()
	sha, err := client.ScriptLoad(ctx, `return redis.error_reply('boom')`).Result()
	if err != nil {
		t.Fatalf("script load: %v", err)
	}
	cmd := noScriptTolerant{client}.EvalSha(ctx, sha, nil)
	if err := cmd.Err(); err == nil || errors.Is(err, redis.ErrNoScript) || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("script error = %v, want the script's own error", err)
	}
}
