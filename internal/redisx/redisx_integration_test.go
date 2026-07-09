//go:build integration

package redisx

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/redis/go-redis/v9/maintnotifications"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// The helpers here exist because of two production incidents (2026-07-09):
// a boot abort from the maint-notifications handshake against a server that
// doesn't know the subcommand, and NOSCRIPT errors from a reworded EVALSHA
// failure that escaped go-redis's exact-match EVAL fallback. Both are
// validated against a real Redis container.
var (
	redisxAddr  string
	redisxReady bool
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
		log.Printf("redisx integration tests will skip: docker/redis unavailable: %v", err)
		os.Exit(m.Run())
	}
	if host, herr := c.Host(ctx); herr == nil {
		if port, perr := c.MappedPort(ctx, "6379"); perr == nil {
			redisxAddr = fmt.Sprintf("%s:%s", host, port.Port())
			redisxReady = true
		}
	}
	code := m.Run()
	_ = c.Terminate(ctx)
	os.Exit(code)
}

func newRealClient(t *testing.T) *redis.Client {
	t.Helper()
	if !redisxReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	opts, err := Options("redis://" + redisxAddr)
	if err != nil {
		t.Fatalf("Options: %v", err)
	}
	client := redis.NewClient(opts)
	t.Cleanup(func() { _ = client.Close() })
	if err := client.Ping(context.Background()).Err(); err != nil {
		t.Fatalf("ping real redis: %v", err)
	}
	return client
}

func TestOptions_DisablesMaintNotificationsHandshake(t *testing.T) {
	opts, err := Options("redis://example.test:6379/2")
	if err != nil {
		t.Fatalf("Options: %v", err)
	}
	if opts.Addr != "example.test:6379" || opts.DB != 2 {
		t.Fatalf("URL not parsed into options: %+v", opts)
	}
	if opts.MaintNotificationsConfig == nil || opts.MaintNotificationsConfig.Mode != maintnotifications.ModeDisabled {
		t.Fatalf("maint notifications must be disabled, got %+v", opts.MaintNotificationsConfig)
	}
}

func TestOptions_BadURL(t *testing.T) {
	if _, err := Options("://not-a-url"); err == nil || !strings.Contains(err.Error(), "parse redis url") {
		t.Fatalf("expected parse error, got %v", err)
	}
}

func TestRunScript_Executes(t *testing.T) {
	client := newRealClient(t)
	script := redis.NewScript(`return ARGV[1]`)
	got, err := RunScript(context.Background(), client, script, []string{"k"}, "hello").Text()
	if err != nil {
		t.Fatalf("RunScript: %v", err)
	}
	if got != "hello" {
		t.Fatalf("script result = %q, want %q", got, "hello")
	}
}

// stripRedisErrorHook re-creates every EVALSHA NOSCRIPT failure as a plain
// error, mimicking an instrumentation layer that loses the redis.Error
// interface — the production shape (2026-07-09, Datadog-instrumented build)
// that escaped both go-redis's EvalSha normalization and Script.Run's EVAL
// fallback, which engage only when errors.As still finds a redis.Error.
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

func TestRunScript_InterfaceStrippedNoScriptFallsBackToEval(t *testing.T) {
	client := newRealClient(t)
	ctx := context.Background()
	client.AddHook(stripRedisErrorHook{})
	script := redis.NewScript(`return redis.call('INCR', KEYS[1])`)

	// Documents WHY RunScript exists: the vendor fallback needs a redis.Error
	// via errors.As, so the interface-stripped error escapes it. If a
	// go-redis upgrade makes this pass, RunScript can be simplified.
	if err := script.Run(ctx, client, []string{"stripped:counter"}).Err(); err == nil {
		t.Fatal("vendor Script.Run now tolerates interface-stripped NOSCRIPT — RunScript's fallback may be redundant")
	}

	got, err := RunScript(ctx, client, script, []string{"stripped:counter"}).Int64()
	if err != nil {
		t.Fatalf("RunScript must fall back to EVAL on an interface-stripped NOSCRIPT: %v", err)
	}
	if got != 1 {
		t.Fatalf("counter = %d, want 1", got)
	}
}

func TestRunScript_SurvivesScriptFlush(t *testing.T) {
	client := newRealClient(t)
	ctx := context.Background()
	script := redis.NewScript(`return redis.call('INCR', KEYS[1])`)
	if _, err := RunScript(ctx, client, script, []string{"flush:counter"}).Int64(); err != nil {
		t.Fatalf("first run: %v", err)
	}
	// A restarted server / fresh failover node has an empty script cache.
	if err := client.ScriptFlush(ctx).Err(); err != nil {
		t.Fatalf("script flush: %v", err)
	}
	got, err := RunScript(ctx, client, script, []string{"flush:counter"}).Int64()
	if err != nil {
		t.Fatalf("run after flush: %v", err)
	}
	if got != 2 {
		t.Fatalf("counter = %d, want 2", got)
	}
}

func TestRunScript_NonNoScriptErrorPassesThrough(t *testing.T) {
	client := newRealClient(t)
	// INCR with extra arguments is a genuine script runtime error — RunScript
	// must surface it, not retry it.
	script := redis.NewScript(`return redis.call('INCR', KEYS[1], 'bogus')`)
	err := RunScript(context.Background(), client, script, []string{"err:counter"}).Err()
	if err == nil {
		t.Fatal("expected script runtime error")
	}
	if strings.Contains(err.Error(), "NOSCRIPT") {
		t.Fatalf("error should not be NOSCRIPT: %v", err)
	}
}
