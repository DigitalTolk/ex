package pubsub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/DigitalTolk/ex/internal/events"
)

func setupTestPubSub(t *testing.T) (*RedisPubSub, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	ps, err := NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}
	return ps, mr
}

func TestNewRedisPubSub(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		ps, _ := setupTestPubSub(t)
		if ps == nil {
			t.Fatal("expected non-nil RedisPubSub")
		}
	})

	t.Run("bad URL", func(t *testing.T) {
		_, err := NewRedisPubSub("not-a-valid-url")
		if err == nil {
			t.Fatal("expected error for bad URL")
		}
	})
}

func TestPublish(t *testing.T) {
	ps, _ := setupTestPubSub(t)
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
// gone). The marshal step happens before the publish so we test it via
// a closed miniredis.
func TestPublishClientError(t *testing.T) {
	ps, mr := setupTestPubSub(t)
	mr.Close()
	event, err := events.NewEvent(events.EventMessageNew, map[string]string{"text": "hi"})
	if err != nil {
		t.Fatalf("NewEvent: %v", err)
	}
	if err := ps.Publish(context.Background(), "ch", event); err == nil {
		t.Fatal("expected error after redis closed")
	}
}

func TestChannelName(t *testing.T) {
	got := ChannelName("abc123")
	want := "chan:abc123"
	if got != want {
		t.Fatalf("ChannelName: got %q, want %q", got, want)
	}
}

func TestConversationName(t *testing.T) {
	got := ConversationName("conv456")
	want := "conv:conv456"
	if got != want {
		t.Fatalf("ConversationName: got %q, want %q", got, want)
	}
}
