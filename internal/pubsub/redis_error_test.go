package pubsub

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/DigitalTolk/ex/internal/events"
)

// NewRedisPubSub parses fine but the Ping fails when the server is gone.
// Closing miniredis before connecting makes the dial refuse immediately,
// exercising the ping-error wrap-and-return branch.
func TestNewRedisPubSubPingError(t *testing.T) {
	mr := miniredis.RunT(t)
	addr := mr.Addr()
	mr.Close()

	if _, err := NewRedisPubSub("redis://" + addr); err == nil {
		t.Fatal("expected ping error after server closed")
	}
}

// Publish marshals the event before publishing; an Event whose Data is an
// invalid json.RawMessage makes json.Marshal fail, hitting the marshal
// error branch before any Redis call.
func TestPublishMarshalError(t *testing.T) {
	ps, _ := setupTestPubSub(t)

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
	ps, _ := setupDurable(t)
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
