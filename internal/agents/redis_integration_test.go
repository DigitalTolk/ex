//go:build integration

package agents

import (
	"context"
	"fmt"
	"log"
	"os"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"

	"github.com/DigitalTolk/ex/internal/redisx"
)

// The cross-instance coordination tests run against a real Redis container
// shared for the package.
var (
	testRedisAddr  string
	testRedisReady bool
)

func TestMain(m *testing.M) {
	ctx := context.Background()
	c, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:        "redis:7-alpine",
			ExposedPorts: []string{"6379/tcp"},
			WaitingFor:   wait.ForListeningPort("6379/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	if err != nil {
		log.Printf("agents redis integration tests will skip: docker/redis unavailable: %v", err)
		os.Exit(m.Run())
	}
	if host, herr := c.Host(ctx); herr == nil {
		if port, perr := c.MappedPort(ctx, "6379"); perr == nil {
			testRedisAddr = fmt.Sprintf("%s:%s", host, port.Port())
			testRedisReady = true
		}
	}
	code := m.Run()
	_ = c.Terminate(ctx)
	os.Exit(code)
}

// newTestRedis returns a client over the shared container with a flushed DB,
// so each test starts from an empty keyspace (the tests run sequentially).
func newTestRedis(t *testing.T) *redis.Client {
	t.Helper()
	if !testRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	opts, err := redisx.Options("redis://" + testRedisAddr)
	if err != nil {
		t.Fatalf("redis options: %v", err)
	}
	rdb := redis.NewClient(opts)
	t.Cleanup(func() { _ = rdb.Close() })
	if err := rdb.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush: %v", err)
	}
	return rdb
}
