//go:build integration

package pubsub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/redis/go-redis/v9"
)

// nextEvent returns the next event delivered to client within d, or "" if none.
func nextEvent(t *testing.T, client *events.Client, d time.Duration) string {
	t.Helper()
	select {
	case data := <-client.Events:
		var got events.Event
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("unmarshal %q: %v", data, err)
		}
		return got.Type
	case <-time.After(d):
		return ""
	}
}

// Two instances share one Redis, like production. A membership change made on
// instance A (the one that served the HTTP request) must reach the user's
// socket on instance B: before, B never subscribed, so the user got the
// notification (their own topic) but none of the new channel's messages until
// they reconnected — and after a removal kept receiving them.
func TestBroker_SubscriptionChangesReachEveryInstance(t *testing.T) {
	a, ps := setupTestBroker(t)
	b := NewBroker(newTestPubSubAt(t, pubsubRedisAddr))
	t.Cleanup(func() { _ = b.Close() })

	client := b.RegisterClient("carol")
	b.Subscribe("carol", []string{UserChannel("carol")})
	time.Sleep(100 * time.Millisecond) // let B's SUBSCRIBE land

	ctx := context.Background()
	publish := func() {
		evt, err := events.NewEvent(events.EventMessageNew, map[string]string{"body": "q4 numbers"})
		if err != nil {
			t.Fatalf("NewEvent: %v", err)
		}
		if err := ps.Publish(ctx, ChannelName("q4"), evt); err != nil {
			t.Fatalf("Publish: %v", err)
		}
	}

	a.PublishSubscription(ctx, "carol", []string{ChannelName("q4")}, true)
	time.Sleep(150 * time.Millisecond)
	publish()
	if got := nextEvent(t, client, time.Second); got != events.EventMessageNew {
		t.Fatalf("carol on instance B got %q, want the channel's message.new (the control frame itself must not be forwarded)", got)
	}

	a.PublishSubscription(ctx, "carol", []string{ChannelName("q4")}, false)
	time.Sleep(150 * time.Millisecond)
	publish()
	if got := nextEvent(t, client, 300*time.Millisecond); got != "" {
		t.Fatalf("after removal carol still got %q", got)
	}
}

func TestBroker_ApplyControlIgnoresOtherFrames(t *testing.T) {
	b, _ := setupTestBroker(t)
	frame := func(channel, payload string) *redis.Message {
		return &redis.Message{Channel: channel, Payload: payload}
	}
	for name, msg := range map[string]*redis.Message{
		"not a user topic":    frame(ChannelName("x"), `{"type":"broker.subscribe","data":{"topics":["a"]}}`),
		"ordinary user frame": frame(UserChannel("u"), `{"type":"notification.new","data":{}}`),
		"unparseable":         frame(UserChannel("u"), `{"type":"broker.`),
		"unknown broker type": frame(UserChannel("u"), `{"type":"broker.other","data":{}}`),
	} {
		if b.applyControl(msg) {
			t.Errorf("%s: treated as a control frame", name)
		}
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	if len(b.userSubs) != 0 {
		t.Fatalf("ignored frames changed subscriptions: %v", b.userSubs)
	}
}
