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

// One real Redis container for the package's integration tests, so cache
// behaviour (TTLs, transactions, scripts) is validated against the engine.
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
