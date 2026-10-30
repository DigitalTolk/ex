//go:build integration

package app

import (
	"context"
	"testing"

	"github.com/redis/go-redis/v9"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/store"
)

// An app spends a burst of 60 calls at once; the next is refused with a
// wait, and another app's budget is its own.
func TestClickLimiterAppCallBurst(t *testing.T) {
	if !containersUp {
		t.Skip("skipping: Docker / Redis not available")
	}
	client := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer func() { _ = client.Close() }()
	limiter := clickLimiter{middleware.NewRedisRateLimiter(client)}
	ctx := context.Background()
	app := "wh-" + store.NewID()
	for i := 0; i < 60; i++ {
		if ok, _, err := limiter.AllowAppCall(ctx, app); !ok || err != nil {
			t.Fatalf("call %d refused: %v", i+1, err)
		}
	}
	ok, retry, err := limiter.AllowAppCall(ctx, app)
	if ok || err != nil || retry <= 0 {
		t.Fatalf("call 61: ok=%v retry=%v err=%v", ok, retry, err)
	}
	if ok, _, err := limiter.AllowAppCall(ctx, "wh-"+store.NewID()); !ok || err != nil {
		t.Fatalf("another app: ok=%v err=%v", ok, err)
	}
}
