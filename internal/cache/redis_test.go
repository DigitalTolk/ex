package cache

import (
	"net"
	"testing"
)

// The RedisCache behavior tests live in the integration-tagged files next to
// this one and run against a real Redis container (see redis_integration_test.go
// for the shared harness). Only the constructor failure paths below need no
// server at all, so they stay untagged.
func TestNewRedisCache(t *testing.T) {
	t.Run("bad URL", func(t *testing.T) {
		_, err := NewRedisCache("not-a-valid-url")
		if err == nil {
			t.Fatal("expected error for bad URL")
		}
	})

	// The constructor verifies connectivity with a PING; pointing it at a
	// port that nothing listens on makes the dial fail and surfaces the ping
	// error. Bind an ephemeral port and close it so the address is known-dead.
	t.Run("ping error", func(t *testing.T) {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		addr := l.Addr().String()
		_ = l.Close()
		if _, err := NewRedisCache("redis://" + addr); err == nil {
			t.Fatal("expected ping error against a closed server")
		}
	})
}
