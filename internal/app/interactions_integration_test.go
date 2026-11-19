//go:build integration

package app

import (
	"context"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/store"
)

// An app spends a burst of 60 calls at once; past it, calls are refused
// with a wait, and another app's budget is its own.
func TestClickLimiterAppCallBurst(t *testing.T) {
	if !containersUp {
		t.Skip("skipping: Docker / Redis not available")
	}
	client := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer func() { _ = client.Close() }()
	limiter := clickLimiter{middleware.NewRedisRateLimiter(client)}
	ctx := context.Background()
	app := "wh-" + store.NewID()
	start := time.Now()
	for i := 0; i < 60; i++ {
		if ok, _, err := limiter.AllowAppCall(ctx, app); !ok || err != nil {
			t.Fatalf("call %d refused: %v", i+1, err)
		}
	}
	// The budget refills a call every 200ms (300 a minute), so a slow
	// machine earns a few more while spending the burst. Count them rather
	// than assume the burst took no time.
	extra := 0
	for {
		ok, retry, err := limiter.AllowAppCall(ctx, app)
		if err != nil {
			t.Fatalf("call %d: %v", 61+extra, err)
		}
		if !ok {
			if retry <= 0 {
				t.Fatalf("refused call %d carries no wait (%v)", 61+extra, retry)
			}
			break
		}
		extra++
		if earned := int(time.Since(start)/(200*time.Millisecond)) + 1; extra > earned {
			t.Fatalf("%d calls past the burst allowed, only %d earned", extra, earned)
		}
	}
	if ok, _, err := limiter.AllowAppCall(ctx, "wh-"+store.NewID()); !ok || err != nil {
		t.Fatalf("another app: ok=%v err=%v", ok, err)
	}
}
