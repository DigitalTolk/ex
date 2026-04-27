package pubsub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/DigitalTolk/ex/internal/events"
)

func setupTestBroker(t *testing.T) (*Broker, *RedisPubSub, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	ps, err := NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}
	broker := NewBroker(ps)
	t.Cleanup(func() {
		_ = broker.Close()
	})
	return broker, ps, mr
}

func TestBrokerRegisterUnregister(t *testing.T) {
	b, _, _ := setupTestBroker(t)

	client := b.RegisterClient("user1")
	if client == nil {
		t.Fatal("expected non-nil client")
	}
	if client.UserID != "user1" {
		t.Fatalf("UserID mismatch: got %q, want %q", client.UserID, "user1")
	}

	b.mu.RLock()
	_, exists := b.clients["user1"]
	b.mu.RUnlock()
	if !exists {
		t.Fatal("expected user1 to be registered")
	}

	b.UnregisterClient("user1", client)

	b.mu.RLock()
	_, exists = b.clients["user1"]
	b.mu.RUnlock()
	if exists {
		t.Fatal("expected user1 to be unregistered")
	}
}

// Concurrent clients per user must coexist — closing one tab/connection
// does not deregister the others, and a fast reconnect doesn't briefly
// flap presence offline. Both legs of this guarantee live in the
// broker; the WS handler relies on it for OnConnect/OnDisconnect order.
func TestBrokerMultipleClientsPerUser(t *testing.T) {
	b, _, _ := setupTestBroker(t)

	a := b.RegisterClient("user1")
	c := b.RegisterClient("user1")
	if a == c {
		t.Fatal("expected two distinct clients")
	}

	b.mu.RLock()
	count := len(b.clients["user1"])
	b.mu.RUnlock()
	if count != 2 {
		t.Fatalf("expected 2 active clients for user1, got %d", count)
	}

	// Removing one leaves the other active.
	b.UnregisterClient("user1", a)
	b.mu.RLock()
	_, stillRegistered := b.clients["user1"]
	count = len(b.clients["user1"])
	b.mu.RUnlock()
	if !stillRegistered || count != 1 {
		t.Fatalf("expected 1 remaining client, got registered=%v count=%d", stillRegistered, count)
	}

	// Removing the second drops the user entirely.
	b.UnregisterClient("user1", c)
	b.mu.RLock()
	_, stillRegistered = b.clients["user1"]
	b.mu.RUnlock()
	if stillRegistered {
		t.Fatal("expected user1 to be fully unregistered")
	}
}

func TestBrokerSubscribe(t *testing.T) {
	b, _, _ := setupTestBroker(t)

	b.RegisterClient("user1")
	b.Subscribe("user1", []string{"chan:c1", "chan:c2"})

	b.mu.RLock()
	defer b.mu.RUnlock()

	// Verify userSubs.
	subs, ok := b.userSubs["user1"]
	if !ok {
		t.Fatal("expected userSubs entry for user1")
	}
	if !subs["chan:c1"] || !subs["chan:c2"] {
		t.Fatalf("expected both channels in userSubs, got %v", subs)
	}

	// Verify redisSubs.
	if users, ok := b.redisSubs["chan:c1"]; !ok || !users["user1"] {
		t.Fatal("expected user1 in redisSubs for chan:c1")
	}
	if users, ok := b.redisSubs["chan:c2"]; !ok || !users["user1"] {
		t.Fatal("expected user1 in redisSubs for chan:c2")
	}
}

func TestBrokerUnsubscribe(t *testing.T) {
	b, _, _ := setupTestBroker(t)

	b.RegisterClient("user1")
	b.Subscribe("user1", []string{"chan:c1", "chan:c2"})
	b.Unsubscribe("user1", []string{"chan:c1"})

	b.mu.RLock()
	defer b.mu.RUnlock()

	// chan:c1 should be removed from userSubs and redisSubs.
	subs := b.userSubs["user1"]
	if subs["chan:c1"] {
		t.Fatal("expected chan:c1 to be removed from userSubs")
	}
	if !subs["chan:c2"] {
		t.Fatal("expected chan:c2 to remain in userSubs")
	}

	if _, ok := b.redisSubs["chan:c1"]; ok {
		t.Fatal("expected chan:c1 to be removed from redisSubs")
	}
}

func TestBrokerDispatch(t *testing.T) {
	b, ps, _ := setupTestBroker(t)

	client := b.RegisterClient("user1")
	b.Subscribe("user1", []string{"chan:dispatch-test"})

	// Allow time for the Redis subscription to be established.
	time.Sleep(50 * time.Millisecond)

	event, err := events.NewEvent(events.EventMessageNew, map[string]string{"text": "hello"})
	if err != nil {
		t.Fatalf("NewEvent: %v", err)
	}

	if err := ps.Publish(context.Background(), "chan:dispatch-test", event); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Wait for the goroutine to process the message.
	time.Sleep(100 * time.Millisecond)

	select {
	case data := <-client.Events:
		// Verify it is raw JSON.
		var got events.Event
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("unmarshal dispatched data: %v (raw: %q)", err, string(data))
		}
		if got.Type != events.EventMessageNew {
			t.Fatalf("event type mismatch: got %q, want %q", got.Type, events.EventMessageNew)
		}
	default:
		t.Fatal("expected an event on the client's Events channel")
	}
}

func TestBrokerClose(t *testing.T) {
	mr := miniredis.RunT(t)
	ps, err := NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}

	broker := NewBroker(ps)
	broker.RegisterClient("user1")
	broker.Subscribe("user1", []string{"chan:c1"})

	// Close should not panic.
	if err := broker.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

// Verify that dispatched data is valid JSON with correct content,
// ensuring the full publish-subscribe-dispatch pipeline works.
func TestBrokerDispatchContent(t *testing.T) {
	b, ps, _ := setupTestBroker(t)

	client := b.RegisterClient("userX")
	b.Subscribe("userX", []string{"chan:content"})

	time.Sleep(50 * time.Millisecond)

	payload := map[string]string{"key": "value"}
	event, err := events.NewEvent(events.EventPing, payload)
	if err != nil {
		t.Fatalf("NewEvent: %v", err)
	}

	if err := ps.Publish(context.Background(), "chan:content", event); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	select {
	case data := <-client.Events:
		// Verify it is raw JSON with the correct type and payload.
		var got events.Event
		if err := json.Unmarshal(data, &got); err != nil {
			t.Fatalf("unmarshal dispatched data: %v (raw: %q)", err, string(data))
		}
		if got.Type != events.EventPing {
			t.Fatalf("event type mismatch: got %q, want %q", got.Type, events.EventPing)
		}
		var m map[string]string
		if err := json.Unmarshal(got.Data, &m); err != nil {
			t.Fatalf("unmarshal event data: %v", err)
		}
		if m["key"] != "value" {
			t.Fatalf("payload mismatch: got %v", m)
		}
	default:
		t.Fatal("expected an event on the client's Events channel")
	}
}


// TestBroker_UnregisterCleansUpSubscriptions covers the branch where a
// disconnected user's last subscription is removed and the Redis channel is
// unsubscribed.
func TestBroker_UnregisterCleansUpSubscriptions(t *testing.T) {
	mr, _ := miniredis.RunT(t), (*Broker)(nil)
	defer mr.Close()
	ps, err := NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}
	b := NewBroker(ps)
	defer func() { _ = b.Close() }()

	c := b.RegisterClient("u-clean")
	b.Subscribe("u-clean", []string{"chan:only"})
	b.UnregisterClient("u-clean", c)

	// Re-register and re-subscribe should work without error.
	_ = b.RegisterClient("u-clean")
	b.Subscribe("u-clean", []string{"chan:only"})
}

func TestBroker_UnregisterMissing(t *testing.T) {
	mr, _ := miniredis.RunT(t), (*Broker)(nil)
	defer mr.Close()
	ps, err := NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}
	b := NewBroker(ps)
	defer func() { _ = b.Close() }()
	// no-op: should not panic.
	b.UnregisterClient("never-registered", nil)
}

// Concurrent registers for the same user must NOT close prior clients
// — multi-tab presence and a fast tab refresh both rely on the old
// connection living until its own defer fires.
func TestBroker_RegisterPreservesExisting(t *testing.T) {
	mr, _ := miniredis.RunT(t), (*Broker)(nil)
	defer mr.Close()
	ps, err := NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}
	b := NewBroker(ps)
	defer func() { _ = b.Close() }()

	first := b.RegisterClient("u")
	second := b.RegisterClient("u")
	if first == second {
		t.Error("re-registering should produce a fresh client")
	}
	select {
	case <-first.Done():
		t.Error("first client should NOT be closed when a second registers")
	default:
		// expected: both alive
	}
}

func TestBroker_UnsubscribeUnknownUser(t *testing.T) {
	mr, _ := miniredis.RunT(t), (*Broker)(nil)
	defer mr.Close()
	ps, err := NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}
	b := NewBroker(ps)
	defer func() { _ = b.Close() }()
	b.Unsubscribe("never-subscribed", []string{"chan:x"})
}
