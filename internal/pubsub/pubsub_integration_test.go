//go:build integration

package pubsub

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/redis/go-redis/v9/maintnotifications"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// The pub/sub layer is the live half of real-time delivery (the durable inbox
// in internal/eventlog is the replay half). These tests run it against REAL
// Redis via testcontainers so PUBLISH/SUBSCRIBE fan-out, pipelined publishes,
// and dead-server error arms are validated against the engine production uses.
var (
	pubsubRedisAddr  string
	pubsubRedisReady bool
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
		log.Printf("pubsub integration tests will skip: docker/redis unavailable: %v", err)
		os.Exit(m.Run())
	}
	if host, herr := c.Host(ctx); herr == nil {
		if port, perr := c.MappedPort(ctx, "6379"); perr == nil {
			pubsubRedisAddr = fmt.Sprintf("%s:%s", host, port.Port())
			pubsubRedisReady = true
		}
	}
	code := m.Run()
	_ = c.Terminate(ctx)
	os.Exit(code)
}

// flushPubSubRedis clears the shared container's DB between tests. Live
// pub/sub channels don't persist and the tests run sequentially, so the only
// state this guards against is durable keys (evt:* inbox streams) a test may
// leave behind.
func flushPubSubRedis(t *testing.T) {
	t.Helper()
	client := redis.NewClient(&redis.Options{Addr: pubsubRedisAddr})
	defer func() { _ = client.Close() }()
	if err := client.FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
}

// newTestPubSubAt builds a RedisPubSub against the given address (the shared
// container, or a redisProxy in front of it) and closes its client on cleanup.
func newTestPubSubAt(t *testing.T, addr string) *RedisPubSub {
	t.Helper()
	ps, err := NewRedisPubSub("redis://" + addr)
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}
	t.Cleanup(func() { _ = ps.Client().Close() })
	return ps
}

func TestNewRedisPubSub_DisablesMaintNotificationsHandshake(t *testing.T) {
	// Regression (2026-07-09): go-redis's default "auto" mode sends CLIENT
	// MAINT_NOTIFICATIONS during the handshake; a server that rejects the
	// subcommand aborted boot via the constructor PING (main.go could not
	// start). The built client must carry the disabled mode so the handshake
	// is never attempted.
	ps := setupTestPubSub(t)
	cfg := ps.Client().Options().MaintNotificationsConfig
	if cfg == nil || cfg.Mode != maintnotifications.ModeDisabled {
		t.Fatalf("maint notifications must be disabled, got %+v", cfg)
	}
}

// setupTestPubSub returns a RedisPubSub over the shared real-Redis container
// with a clean database per test.
func setupTestPubSub(t *testing.T) *RedisPubSub {
	t.Helper()
	if !pubsubRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	flushPubSubRedis(t)
	return newTestPubSubAt(t, pubsubRedisAddr)
}

// setupTestBroker returns a Broker over the shared container; the broker (and
// the pubsub client behind it) are torn down on cleanup.
func setupTestBroker(t *testing.T) (*Broker, *RedisPubSub) {
	t.Helper()
	ps := setupTestPubSub(t)
	broker := NewBroker(ps)
	t.Cleanup(func() {
		_ = broker.Close()
	})
	return broker, ps
}

// redisProxy is a TCP proxy in front of the shared Redis container. Closing it
// tears down the listener and severs every proxied connection, so a client
// built against Addr() experiences the server dying mid-test — subsequent
// commands and the subscriber connection fail exactly like a killed Redis,
// without touching the shared container itself.
type redisProxy struct {
	ln     net.Listener
	mu     sync.Mutex
	closed bool
	conns  []net.Conn
}

func newRedisProxy(t *testing.T) *redisProxy {
	t.Helper()
	if !pubsubRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("proxy listen: %v", err)
	}
	p := &redisProxy{ln: ln}
	go p.accept()
	t.Cleanup(p.Close)
	return p
}

func (p *redisProxy) Addr() string { return p.ln.Addr().String() }

func (p *redisProxy) accept() {
	for {
		conn, err := p.ln.Accept()
		if err != nil {
			return
		}
		backend, err := net.Dial("tcp", pubsubRedisAddr)
		if err != nil {
			_ = conn.Close()
			continue
		}
		if !p.track(conn, backend) {
			_ = conn.Close()
			_ = backend.Close()
			continue
		}
		go func() { _, _ = io.Copy(backend, conn); _ = backend.Close(); _ = conn.Close() }()
		go func() { _, _ = io.Copy(conn, backend); _ = conn.Close(); _ = backend.Close() }()
	}
}

func (p *redisProxy) track(conn, backend net.Conn) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false
	}
	p.conns = append(p.conns, conn, backend)
	return true
}

// Close stops accepting and severs every open connection. Idempotent — tests
// close it mid-flight and the t.Cleanup closes it again.
func (p *redisProxy) Close() {
	_ = p.ln.Close()
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	for _, c := range p.conns {
		_ = c.Close()
	}
	p.conns = nil
}
