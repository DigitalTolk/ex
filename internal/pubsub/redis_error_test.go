package pubsub

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

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

// The inbox fan-out entry point defends itself even when reached directly:
// without full durability wiring, or with a nil/ephemeral event, it must
// return without touching the resolver or inbox (or starting a goroutine).
func TestFanOutAsyncGuards(t *testing.T) {
	ctx := context.Background()
	evt, err := events.NewEvent(events.EventMessageNew, map[string]string{"text": "hi"})
	if err != nil {
		t.Fatalf("NewEvent: %v", err)
	}
	topics := []string{"chan:c1"}

	t.Run("no durability wiring", func(t *testing.T) {
		ps := &RedisPubSub{}                  // neither resolver nor inbox configured
		ps.fanOutAsync(ctx, topics, evt, nil) // must be a no-op, not a panic
		ps.WaitForInboxFanOut()
	})

	t.Run("resolver without inbox", func(t *testing.T) {
		ps := &RedisPubSub{resolver: &fakeResolver{m: map[string][]string{"chan:c1": {"u1"}}}}
		ps.fanOutAsync(ctx, topics, evt, nil)
		ps.WaitForInboxFanOut()
	})

	t.Run("nil event", func(t *testing.T) {
		inbox := &captureInbox{}
		ps := &RedisPubSub{
			resolver: &fakeResolver{m: map[string][]string{"chan:c1": {"u1"}}},
			inbox:    inbox,
		}
		ps.fanOutAsync(ctx, topics, nil, nil)
		ps.WaitForInboxFanOut()
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
		ps.fanOutAsync(ctx, topics, eph, nil)
		ps.WaitForInboxFanOut()
		if got := len(inbox.seen()); got != 0 {
			t.Errorf("inbox saw %d appends for an ephemeral event, want 0", got)
		}
	})
}

// The retry wait returns as soon as the context is done — and the wait
// error is what ends the retry loop, not another append attempt.
func TestSleepCtx(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := sleepCtx(ctx, time.Hour); !errors.Is(err, context.Canceled) {
		t.Fatalf("sleepCtx on a cancelled context = %v, want context.Canceled", err)
	}
	if err := sleepCtx(context.Background(), time.Nanosecond); err != nil {
		t.Fatalf("sleepCtx after the full wait = %v, want nil", err)
	}
}

// mustJSON passes through a successful marshal and panics on the
// impossible error arm instead of publishing a corrupt frame.
func TestMustJSON(t *testing.T) {
	if got := string(mustJSON([]byte(`{}`), nil)); got != `{}` {
		t.Fatalf("mustJSON = %q", got)
	}
	defer func() {
		if recover() == nil {
			t.Fatal("mustJSON must panic on a marshal error")
		}
	}()
	mustJSON(nil, errors.New("boom"))
}
