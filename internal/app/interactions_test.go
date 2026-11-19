package app

import (
	"bytes"
	"context"
	"testing"

	"github.com/redis/go-redis/v9"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/middleware"
)

func TestInteractivitySigningKey(t *testing.T) {
	own := interactivitySigningKey(&config.Config{InteractivitySigningKey: "own-key", JWTSecret: "jwt"})
	if string(own) != "own-key" {
		t.Fatalf("own key = %q", own)
	}
	derived := interactivitySigningKey(&config.Config{JWTSecret: "jwt"})
	if len(derived) != 32 || bytes.Equal(derived, []byte("jwt")) {
		t.Fatalf("derived key = %x", derived)
	}
	if !bytes.Equal(derived, interactivitySigningKey(&config.Config{JWTSecret: "jwt"})) {
		t.Fatal("the derived key must be stable")
	}
}

func TestClickLimiterReportsTheLimitersAnswer(t *testing.T) {
	// No Redis behind it: the limiter's error comes through, and the click is
	// not counted as allowed.
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	defer func() { _ = client.Close() }()
	ok, err := clickLimiter{middleware.NewRedisRateLimiter(client)}.AllowClick(context.Background(), "click:wh:u")
	if ok || err == nil {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
}

func TestClickLimiterAppCallReportsTheLimitersError(t *testing.T) {
	// No Redis behind it: the error comes through and the call is refused.
	client := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	defer func() { _ = client.Close() }()
	ok, _, err := clickLimiter{middleware.NewRedisRateLimiter(client)}.AllowAppCall(context.Background(), "wh")
	if ok || err == nil {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
}
