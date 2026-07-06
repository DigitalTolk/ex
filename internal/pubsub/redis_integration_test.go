//go:build integration

package pubsub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
)

func TestNewRedisPubSub(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		ps := setupTestPubSub(t)
		if ps == nil {
			t.Fatal("expected non-nil RedisPubSub")
		}
	})
}

func TestPublish(t *testing.T) {
	ps := setupTestPubSub(t)
	ctx := context.Background()

	// Use a go-redis subscriber to observe messages on the channel.
	redisSub := ps.Client().Subscribe(ctx, "test-channel")
	defer func() { _ = redisSub.Close() }()

	// Wait for the subscription to be confirmed.
	_, err := redisSub.Receive(ctx)
	if err != nil {
		t.Fatalf("subscribe receive: %v", err)
	}

	event, err := events.NewEvent(events.EventMessageNew, map[string]string{"text": "hello"})
	if err != nil {
		t.Fatalf("NewEvent: %v", err)
	}

	if err := ps.Publish(ctx, "test-channel", event); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Read the message from the go-redis subscriber channel.
	ch := redisSub.Channel()
	select {
	case msg := <-ch:
		var got events.Event
		if err := json.Unmarshal([]byte(msg.Payload), &got); err != nil {
			t.Fatalf("unmarshal published message: %v", err)
		}
		if got.Type != events.EventMessageNew {
			t.Fatalf("event type mismatch: got %q, want %q", got.Type, events.EventMessageNew)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for published message")
	}
}

// TestPublishClientError covers the wrap-and-return path inside Publish
// when the underlying Redis client returns an error (e.g. the server is
// gone). The marshal step happens before the publish so we test it by
// killing the proxied server after the constructor's ping succeeded.
func TestPublishClientError(t *testing.T) {
	proxy := newRedisProxy(t)
	ps := newTestPubSubAt(t, proxy.Addr())
	proxy.Close() // the server dies out from under the client
	event, err := events.NewEvent(events.EventMessageNew, map[string]string{"text": "hi"})
	if err != nil {
		t.Fatalf("NewEvent: %v", err)
	}
	if err := ps.Publish(context.Background(), "ch", event); err == nil {
		t.Fatal("expected error after redis closed")
	}
}

// Publish marshals the event before publishing; an Event whose Data is an
// invalid json.RawMessage makes json.Marshal fail, hitting the marshal
// error branch before any Redis call.
func TestPublishMarshalError(t *testing.T) {
	ps := setupTestPubSub(t)

	bad := &events.Event{
		Type: events.EventMessageNew,
		Data: json.RawMessage("not valid json"),
	}
	if err := ps.Publish(context.Background(), "ch", bad); err == nil {
		t.Fatal("expected marshal error for invalid RawMessage payload")
	}
}

// A persistent event whose topic resolves to zero recipients takes the
// early len(recipients)==0 return in appendToInboxes — no inbox writes,
// publish still succeeds.
func TestPublishNoRecipients(t *testing.T) {
	ps := setupTestPubSub(t)
	resolver := &fakeResolver{m: map[string][]string{}} // topic resolves to nil/empty
	inbox := &captureInbox{}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventMessageNew, map[string]string{"text": "hi"})
	if err := ps.Publish(context.Background(), "chan:none", evt); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if got := len(inbox.seen()); got != 0 {
		t.Errorf("inbox saw %d appends with no recipients, want 0", got)
	}
}

// PublishMany marshals the event once before pipelining; an Event whose Data
// is an invalid json.RawMessage makes json.Marshal fail, hitting the marshal
// error branch before any Redis round-trip.
func TestPublishManyMarshalError(t *testing.T) {
	ps := setupTestPubSub(t)

	bad := &events.Event{
		Type: events.EventMessageNew,
		Data: json.RawMessage("{oops"),
	}
	if err := ps.PublishMany(context.Background(), []string{"a", "b"}, bad); err == nil {
		t.Fatal("expected marshal error for invalid RawMessage payload")
	}
}
