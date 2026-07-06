//go:build integration

package service

import (
	"context"
	"fmt"
	"log"
	"os"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/wait"
)

// A couple of service tests intentionally use the real cache.RedisCache (not a
// mock) to prove JSON round-trip behavior through Redis — most importantly
// that AvatarKey, which the public model.User hides from JSON, survives the
// cache. They run against a real Redis container shared for the package.
var (
	serviceRedisAddr  string
	serviceRedisReady bool
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
		log.Printf("service redis integration tests will skip: docker/redis unavailable: %v", err)
		os.Exit(m.Run())
	}
	if host, herr := c.Host(ctx); herr == nil {
		if port, perr := c.MappedPort(ctx, "6379"); perr == nil {
			serviceRedisAddr = fmt.Sprintf("%s:%s", host, port.Port())
			serviceRedisReady = true
		}
	}
	code := m.Run()
	_ = c.Terminate(ctx)
	os.Exit(code)
}

// newServiceRedisCache returns a real RedisCache over the shared container
// with a flushed DB so each test starts from an empty keyspace (the service
// tests run sequentially — none use t.Parallel).
func newServiceRedisCache(t *testing.T) *cache.RedisCache {
	t.Helper()
	if !serviceRedisReady {
		t.Skip("skipping: Docker / Redis not available")
	}
	c, err := cache.NewRedisCache("redis://" + serviceRedisAddr)
	if err != nil {
		t.Fatalf("NewRedisCache against real Redis: %v", err)
	}
	t.Cleanup(func() { _ = c.Client().Close() })
	if err := c.Client().FlushDB(context.Background()).Err(); err != nil {
		t.Fatalf("flush redis: %v", err)
	}
	return c
}

// TestUserService_AvatarPersistsAcrossCacheRoundTrip is a regression test for
// the bug where avatars vanished on hard refresh. The public model.User hides
// AvatarKey from JSON, but the Redis cache marshals to JSON — so naive
// caching would strip the key, leaving resolveAvatar with nothing to sign.
// This test uses the real RedisCache (backed by a real Redis container) plus
// a real-shaped avatar signer to prove the full GetMe → cache hit →
// resolved-URL flow.
func TestUserService_AvatarPersistsAcrossCacheRoundTrip(t *testing.T) {
	c := newServiceRedisCache(t)

	users := newMockUserStore()
	users.users["u1"] = &model.User{
		ID:          "u1",
		Email:       "u1@x.com",
		DisplayName: "U1",
		AvatarKey:   "avatars/u1/abc",
		SystemRole:  model.SystemRoleMember,
	}

	svc := NewUserService(users, c, fakeAvatarSigner{}, nil)

	// First call: cache miss → loads from store → caches → resolves URL.
	first, err := svc.GetByID(context.Background(), "u1")
	if err != nil {
		t.Fatalf("first GetByID: %v", err)
	}
	if first.AvatarURL != "https://signed.example/avatars/u1/abc" {
		t.Fatalf("first AvatarURL = %q, want signed URL", first.AvatarURL)
	}

	// Second call: cache hit. Without the AvatarKey-preserving cache record,
	// resolveAvatar would have nothing to sign and AvatarURL would be empty.
	second, err := svc.GetByID(context.Background(), "u1")
	if err != nil {
		t.Fatalf("second GetByID: %v", err)
	}
	if second.AvatarKey != "avatars/u1/abc" {
		t.Errorf("AvatarKey lost across cache round-trip: got %q", second.AvatarKey)
	}
	if second.AvatarURL != "https://signed.example/avatars/u1/abc" {
		t.Errorf("AvatarURL not regenerated on cache hit: got %q", second.AvatarURL)
	}
}

// TestUserService_UpdateAvatarKey_RegeneratesURLAfterRefresh simulates the
// post-upload flow: PATCH /users/me with new avatarKey → cache invalidated →
// next GetByID hits store, caches, regenerates URL. Hard refresh should
// continue to show the avatar.
func TestUserService_UpdateAvatarKey_RegeneratesURLAfterRefresh(t *testing.T) {
	c := newServiceRedisCache(t)

	users := newMockUserStore()
	users.users["u1"] = &model.User{
		ID: "u1", Email: "u1@x.com", DisplayName: "U1", SystemRole: model.SystemRoleMember,
	}

	svc := NewUserService(users, c, fakeAvatarSigner{}, nil)

	// Upload sets the new key.
	newKey := "avatars/u1/new-upload"
	if _, err := svc.Update(context.Background(), "u1", nil, &newKey, nil); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// Simulate hard refresh: cache was invalidated by Update; first GetByID
	// reloads from store. Subsequent calls hit cache.
	for i := 0; i < 3; i++ {
		got, err := svc.GetByID(context.Background(), "u1")
		if err != nil {
			t.Fatalf("GetByID #%d: %v", i, err)
		}
		if got.AvatarKey != newKey {
			t.Errorf("call %d: AvatarKey = %q, want %q", i, got.AvatarKey, newKey)
		}
		if got.AvatarURL != "https://signed.example/"+newKey {
			t.Errorf("call %d: AvatarURL = %q, want signed URL with new key", i, got.AvatarURL)
		}
	}
}
