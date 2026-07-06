package pubsub

import (
	"context"
	"net"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
)

// deadRedisAddr returns an address that refuses connections (a listener bound
// and immediately closed) — a Redis that is already gone before the first op.
// No server is involved, so this test can run untagged.
func deadRedisAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

// NewRedisPubSub parses fine but the Ping fails when the server is gone.
// Dialing an address whose listener has already closed refuses immediately,
// exercising the ping-error wrap-and-return branch.
func TestNewRedisPubSubPingError(t *testing.T) {
	if _, err := NewRedisPubSub("redis://" + deadRedisAddr(t)); err == nil {
		t.Fatal("expected ping error after server closed")
	}
}

// appendToInboxes defends itself even when reached directly: without full
// durability wiring, or with a nil/ephemeral event, it must return without
// touching the resolver or inbox (Publish pre-filters these today, but the
// guards keep the fan-out safe if a future caller doesn't).
func TestAppendToInboxesGuards(t *testing.T) {
	ctx := context.Background()
	evt, err := events.NewEvent(events.EventMessageNew, map[string]string{"text": "hi"})
	if err != nil {
		t.Fatalf("NewEvent: %v", err)
	}

	t.Run("no durability wiring", func(t *testing.T) {
		ps := &RedisPubSub{}                         // neither resolver nor inbox configured
		ps.appendToInboxes(ctx, "chan:c1", evt, nil) // must be a no-op, not a panic
	})

	t.Run("resolver without inbox", func(t *testing.T) {
		ps := &RedisPubSub{resolver: &fakeResolver{m: map[string][]string{"chan:c1": {"u1"}}}}
		ps.appendToInboxes(ctx, "chan:c1", evt, nil)
	})

	t.Run("nil event", func(t *testing.T) {
		inbox := &captureInbox{}
		ps := &RedisPubSub{
			resolver: &fakeResolver{m: map[string][]string{"chan:c1": {"u1"}}},
			inbox:    inbox,
		}
		ps.appendToInboxes(ctx, "chan:c1", nil, nil)
		if got := len(inbox.seen()); got != 0 {
			t.Errorf("inbox saw %d appends for a nil event, want 0", got)
		}
	})

	t.Run("ephemeral event", func(t *testing.T) {
		inbox := &captureInbox{}
		ps := &RedisPubSub{
			resolver: &fakeResolver{m: map[string][]string{"chan:c1": {"u1"}}},
			inbox:    inbox,
		}
		eph, err := events.NewEvent(events.EventNotificationNew, map[string]string{"x": "y"})
		if err != nil {
			t.Fatalf("NewEvent: %v", err)
		}
		ps.appendToInboxes(ctx, "chan:c1", eph, nil)
		if got := len(inbox.seen()); got != 0 {
			t.Errorf("inbox saw %d appends for an ephemeral event, want 0", got)
		}
	})
}
