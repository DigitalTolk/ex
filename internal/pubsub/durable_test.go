package pubsub

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/DigitalTolk/ex/internal/events"
)

// fakeResolver lets each test wire a topic → recipients map without
// pulling in the eventlog package's full Resolver type.
type fakeResolver struct {
	m   map[string][]string
	err error
}

func (f *fakeResolver) Resolve(_ context.Context, topic string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.m[topic], nil
}

// captureInbox records each Append call so the test can assert which
// recipients got which payload.
type captureInbox struct {
	mu     sync.Mutex
	calls  []inboxCall
	err    error
	failed atomic.Int32
}

type inboxCall struct {
	userID  string
	eventID string
	payload []byte
}

func (c *captureInbox) Append(_ context.Context, userID, eventID string, payload []byte) error {
	if c.err != nil {
		c.failed.Add(1)
		return c.err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([]byte, len(payload))
	copy(cp, payload)
	c.calls = append(c.calls, inboxCall{userID: userID, eventID: eventID, payload: cp})
	return nil
}

func (c *captureInbox) seen() []inboxCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]inboxCall, len(c.calls))
	copy(out, c.calls)
	return out
}

func setupDurable(t *testing.T) (*RedisPubSub, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	ps, err := NewRedisPubSub("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisPubSub: %v", err)
	}
	return ps, mr
}

// Persistent event on a chan: topic fans out to every resolved
// recipient's inbox AND publishes live. The inbox payload is the
// same JSON the live subscribers receive — that's what makes replay
// indistinguishable from live at the client.
func TestRedisPubSub_PublishFansOutToInboxes(t *testing.T) {
	ps, _ := setupDurable(t)
	resolver := &fakeResolver{m: map[string][]string{"chan:c1": {"u1", "u2", "u3"}}}
	inbox := &captureInbox{}
	ps.SetDurability(resolver, inbox)

	evt, err := events.NewEvent(events.EventMessageNew, map[string]string{"text": "hi"})
	if err != nil {
		t.Fatalf("NewEvent: %v", err)
	}
	if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	calls := inbox.seen()
	if len(calls) != 3 {
		t.Fatalf("inbox appends = %d, want 3", len(calls))
	}
	got := map[string]bool{}
	for _, c := range calls {
		got[c.userID] = true
		if c.eventID != evt.ID {
			t.Errorf("inbox eventID = %q, want %q", c.eventID, evt.ID)
		}
		var decoded events.Event
		if err := json.Unmarshal(c.payload, &decoded); err != nil {
			t.Errorf("inbox payload not a valid event: %v", err)
		}
		if decoded.ID != evt.ID {
			t.Errorf("payload ID = %q, want %q", decoded.ID, evt.ID)
		}
	}
	for _, want := range []string{"u1", "u2", "u3"} {
		if !got[want] {
			t.Errorf("recipient %q missing", want)
		}
	}
}

// Ephemeral events (typing, ping, presence, …) must NOT touch the
// inbox — they would just consume MAXLEN budget and be discarded by
// the client on replay anyway.
func TestRedisPubSub_PublishSkipsInboxForEphemeral(t *testing.T) {
	ps, _ := setupDurable(t)
	resolver := &fakeResolver{m: map[string][]string{"chan:c1": {"u1"}}}
	inbox := &captureInbox{}
	ps.SetDurability(resolver, inbox)

	for _, eventType := range []string{events.EventTyping, events.EventPing, events.EventPresenceChanged, events.EventServerVersion, events.EventForceLogout} {
		evt, err := events.NewEvent(eventType, map[string]string{})
		if err != nil {
			t.Fatalf("NewEvent %s: %v", eventType, err)
		}
		if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
			t.Fatalf("Publish %s: %v", eventType, err)
		}
	}
	if got := len(inbox.seen()); got != 0 {
		t.Errorf("inbox saw %d appends for ephemeral types, want 0", got)
	}
}

// Without SetDurability the publisher behaves exactly as before —
// pre-replay code paths must still work (e.g. local dev that hasn't
// wired the resolver/inbox yet).
func TestRedisPubSub_PublishWithoutDurabilityLiveOnly(t *testing.T) {
	ps, _ := setupDurable(t)
	inbox := &captureInbox{}
	// Intentionally do NOT call SetDurability.

	evt, _ := events.NewEvent(events.EventMessageNew, nil)
	if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if len(inbox.seen()) != 0 {
		t.Errorf("inbox should not have been called with no durability wired")
	}
}

// Inbox write failures must NOT fail the publish — live delivery is
// the contract; durability is best-effort. The error gets logged
// (verified separately via slog) but Publish returns nil for live.
func TestRedisPubSub_PublishContinuesWhenInboxFails(t *testing.T) {
	ps, _ := setupDurable(t)
	resolver := &fakeResolver{m: map[string][]string{"chan:c1": {"u1", "u2"}}}
	inbox := &captureInbox{err: errors.New("write failed")}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventMessageNew, nil)
	if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
		t.Errorf("Publish must succeed even when inbox fails, got %v", err)
	}
	if got := inbox.failed.Load(); got != 2 {
		t.Errorf("inbox failed count = %d, want 2", got)
	}
}

// Resolver errors must not fail the publish either — same rationale.
func TestRedisPubSub_PublishContinuesWhenResolverFails(t *testing.T) {
	ps, _ := setupDurable(t)
	resolver := &fakeResolver{err: errors.New("resolver down")}
	inbox := &captureInbox{}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventMessageNew, nil)
	if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
		t.Errorf("Publish must succeed even when resolver fails, got %v", err)
	}
	if got := len(inbox.seen()); got != 0 {
		t.Errorf("inbox saw %d appends when resolver failed, want 0", got)
	}
}

// Inbox() accessor exposes the configured appender for the WS handler
// wiring (replay reads from the same store the publisher writes to).
func TestRedisPubSub_InboxAccessor(t *testing.T) {
	ps, _ := setupDurable(t)
	if ps.Inbox() != nil {
		t.Error("Inbox() should be nil before SetDurability")
	}
	inbox := &captureInbox{}
	ps.SetDurability(&fakeResolver{}, inbox)
	if ps.Inbox() == nil {
		t.Error("Inbox() should expose configured appender")
	}
}
