package handler

import (
	"testing"

	"github.com/alicebob/miniredis/v2"

	"github.com/DigitalTolk/ex/internal/pubsub"
)

func TestBrokerAdapter(t *testing.T) {
	mr := miniredis.RunT(t)

	redisPubSub, err := pubsub.NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}

	broker := pubsub.NewBroker(redisPubSub)
	t.Cleanup(func() { _ = broker.Close() })

	adapter := NewBrokerAdapter(broker)

	// Register a client first so subscriptions attach to someone.
	_ = broker.RegisterClient("test-user")

	// Subscribe should not panic.
	adapter.Subscribe("test-user", "chan:ch-1")

	// Unsubscribe should not panic.
	adapter.Unsubscribe("test-user", "chan:ch-1")
}
