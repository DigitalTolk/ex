package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
)

func TestPresenceService_Connect_FirstReturnsTrue(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	if !svc.OnConnect(context.Background(), "u1") {
		t.Error("first connect should return true")
	}
	if !svc.IsOnline("u1") {
		t.Error("u1 should be online")
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected 1 publish, got %d", len(pub.published))
	}
	if pub.published[0].event.Type != events.EventPresenceChanged {
		t.Errorf("event type=%q want %q", pub.published[0].event.Type, events.EventPresenceChanged)
	}
}

func TestPresenceService_Connect_SecondReturnsFalse(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	svc.OnConnect(context.Background(), "u1")
	if svc.OnConnect(context.Background(), "u1") {
		t.Error("second connect should return false (still online)")
	}
	if len(pub.published) != 1 {
		t.Errorf("only first connect should publish, got %d", len(pub.published))
	}
}

func TestPresenceService_Disconnect_LastReturnsTrue(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	svc.OnConnect(context.Background(), "u1")
	if !svc.OnDisconnect(context.Background(), "u1") {
		t.Error("only-connection disconnect should return true")
	}
	if svc.IsOnline("u1") {
		t.Error("u1 should be offline after disconnect")
	}
	if len(pub.published) != 2 {
		t.Errorf("expected 2 publishes (connect+disconnect), got %d", len(pub.published))
	}
}

func TestPresenceService_Disconnect_OneOfManyReturnsFalse(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	svc.OnConnect(context.Background(), "u1")
	svc.OnConnect(context.Background(), "u1")
	if svc.OnDisconnect(context.Background(), "u1") {
		t.Error("disconnect with remaining connections should return false")
	}
	if !svc.IsOnline("u1") {
		t.Error("u1 should still be online")
	}
	if len(pub.published) != 1 {
		t.Errorf("only first connect should publish, got %d", len(pub.published))
	}
}

func TestPresenceService_Disconnect_NeverConnectedReturnsFalse(t *testing.T) {
	svc := NewPresenceService(nil, newMockPublisher())
	if svc.OnDisconnect(context.Background(), "ghost") {
		t.Error("disconnect of never-connected user should return false")
	}
}

func TestPresenceService_OnlineUserIDs(t *testing.T) {
	svc := NewPresenceService(nil, newMockPublisher())

	if got := svc.OnlineUserIDs(); len(got) != 0 {
		t.Errorf("empty initial online list, got %v", got)
	}

	svc.OnConnect(context.Background(), "u1")
	svc.OnConnect(context.Background(), "u2")

	got := svc.OnlineUserIDs()
	if len(got) != 2 {
		t.Errorf("expected 2 online, got %d (%v)", len(got), got)
	}
}

func TestPresenceService_NilPublisher(t *testing.T) {
	// Should not panic.
	svc := NewPresenceService(nil, nil)
	svc.OnConnect(context.Background(), "u1")
	svc.OnDisconnect(context.Background(), "u1")
}
