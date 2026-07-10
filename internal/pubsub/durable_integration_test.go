//go:build integration

package pubsub

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
)

// Persistent event on a chan: topic fans out to every resolved
// recipient's inbox AND publishes live. The inbox payload is the
// same JSON the live subscribers receive — that's what makes replay
// indistinguishable from live at the client.
func TestRedisPubSub_PublishFansOutToInboxes(t *testing.T) {
	ps := setupTestPubSub(t)
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
	ps.WaitForInboxFanOut() // fan-out is async; wait for it before asserting

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
	ps := setupTestPubSub(t)
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
	ps := setupTestPubSub(t)
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
func TestRedisPubSub_PublishMany(t *testing.T) {
	proxy := newRedisProxy(t)
	ps := newTestPubSubAt(t, proxy.Addr())
	resolver := &fakeResolver{m: map[string][]string{
		"chan:a": {"u1"},
		"chan:b": {"u2"},
	}}
	inbox := &captureInbox{}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventMessageNew, map[string]string{"x": "1"})
	if err := ps.PublishMany(context.Background(), []string{"chan:a", "chan:b"}, evt); err != nil {
		t.Fatalf("PublishMany: %v", err)
	}
	ps.WaitForInboxFanOut()
	// Persistent event → each channel's recipient gets one inbox append.
	if got := len(inbox.seen()); got != 2 {
		t.Errorf("inbox appends = %d, want 2", got)
	}

	// Empty channel list → no-op, no error.
	if err := ps.PublishMany(context.Background(), nil, evt); err != nil {
		t.Errorf("empty PublishMany should be a no-op, got %v", err)
	}

	// Pipeline Exec error surfaces (server gone) — BUT the durable inbox fan-out
	// must still run so the persistent event can be replayed on reconnect even
	// when the best-effort live PUBLISH failed.
	proxy.Close()
	before := len(inbox.seen())
	if err := ps.PublishMany(context.Background(), []string{"chan:a"}, evt); err == nil {
		t.Error("PublishMany against a dead server should return the pipeline error")
	}
	ps.WaitForInboxFanOut()
	if got := len(inbox.seen()); got != before+1 {
		t.Errorf("durable fan-out must run despite the live PUBLISH error: appends=%d, want %d", got, before+1)
	}
}

func (c *captureInbox) droppedBatches() [][]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([][]string(nil), c.dropped...)
}

// withFastInboxRetry shrinks the fan-out retry interval for the failure tests.
func withFastInboxRetry(t *testing.T) {
	t.Helper()
	orig := inboxAppendRetryInterval
	inboxAppendRetryInterval = time.Millisecond
	t.Cleanup(func() { inboxAppendRetryInterval = orig })
}

func TestRedisPubSub_PublishContinuesWhenInboxFails(t *testing.T) {
	withFastInboxRetry(t)
	ps := setupTestPubSub(t)
	resolver := &fakeResolver{m: map[string][]string{"chan:c1": {"u1", "u2"}}}
	inbox := &captureInbox{err: errors.New("write failed")}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventMessageNew, nil)
	if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
		t.Errorf("Publish must succeed even when inbox fails, got %v", err)
	}
	ps.WaitForInboxFanOut()
	// The batched fan-out is retried before giving up: initial + 2 retries.
	if got := inbox.failed.Load(); got != 3 {
		t.Errorf("inbox failed count = %d, want 3 (initial + 2 retries)", got)
	}
	// Persistent failure poisons the affected streams so those clients take
	// the exhausted → full-refetch path instead of replaying past a hole.
	dropped := inbox.droppedBatches()
	if len(dropped) != 1 || len(dropped[0]) != 2 {
		t.Fatalf("dropped batches = %v, want one batch of the 2 recipients", dropped)
	}
}

// A transient blip is absorbed by the retry: appends land on the second
// attempt, and nothing is poisoned.
func TestRedisPubSub_InboxRetryRecoversTransientFailure(t *testing.T) {
	withFastInboxRetry(t)
	ps := setupTestPubSub(t)
	resolver := &fakeResolver{m: map[string][]string{"chan:c1": {"u1", "u2"}}}
	inbox := &captureInbox{failTimes: 1}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventMessageNew, nil)
	if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	ps.WaitForInboxFanOut()
	if got := len(inbox.seen()); got != 2 {
		t.Fatalf("inbox appends = %d, want 2 (retry recovered the batch)", got)
	}
	if dropped := inbox.droppedBatches(); len(dropped) != 0 {
		t.Fatalf("nothing may be poisoned after a recovered retry, got %v", dropped)
	}
}

// Even the poison step failing must not panic or block — it is logged as the
// last-resort ERROR (replay may then silently skip; the reconnect refetch
// remains the final safety net).
func TestRedisPubSub_InboxPoisonFailureIsContained(t *testing.T) {
	withFastInboxRetry(t)
	ps := setupTestPubSub(t)
	resolver := &fakeResolver{m: map[string][]string{"chan:c1": {"u1"}}}
	inbox := &captureInbox{err: errors.New("write failed"), dropErr: errors.New("del failed")}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventMessageNew, nil)
	if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
		t.Errorf("Publish must succeed, got %v", err)
	}
	ps.WaitForInboxFanOut()
	if dropped := inbox.droppedBatches(); len(dropped) != 1 {
		t.Fatalf("drop attempts = %d, want 1", len(dropped))
	}
}

// Resolver errors must not fail the publish either — same rationale.
func TestRedisPubSub_PublishContinuesWhenResolverFails(t *testing.T) {
	ps := setupTestPubSub(t)
	resolver := &fakeResolver{err: errors.New("resolver down")}
	inbox := &captureInbox{}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventMessageNew, nil)
	if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
		t.Errorf("Publish must succeed even when resolver fails, got %v", err)
	}
	ps.WaitForInboxFanOut()
	if got := len(inbox.seen()); got != 0 {
		t.Errorf("inbox saw %d appends when resolver failed, want 0", got)
	}
}

// Inbox() accessor exposes the configured appender for the WS handler
// wiring (replay reads from the same store the publisher writes to).
func TestRedisPubSub_InboxAccessor(t *testing.T) {
	ps := setupTestPubSub(t)
	if ps.Inbox() != nil {
		t.Error("Inbox() should be nil before SetDurability")
	}
	inbox := &captureInbox{}
	ps.SetDurability(&fakeResolver{}, inbox)
	if ps.Inbox() == nil {
		t.Error("Inbox() should expose configured appender")
	}
}

// PublishEach: many DISTINCT payloads in one pipelined round-trip (the
// per-recipient notification fan-out shape).
func TestRedisPubSub_PublishEach(t *testing.T) {
	proxy := newRedisProxy(t)
	ps := newTestPubSubAt(t, proxy.Addr())
	resolver := &fakeResolver{m: map[string][]string{
		"user:u1": {"u1"},
		"user:u2": {"u2"},
	}}
	inbox := &captureInbox{}
	ps.SetDurability(resolver, inbox)

	evt1, _ := events.NewEvent(events.EventMessageNew, map[string]string{"for": "u1"})
	evt2, _ := events.NewEvent(events.EventMessageNew, map[string]string{"for": "u2"})
	items := []events.PublishItem{
		{Channel: "user:u1", Event: evt1},
		{Channel: "user:u2", Event: evt2},
	}
	if err := ps.PublishEach(context.Background(), items); err != nil {
		t.Fatalf("PublishEach: %v", err)
	}
	ps.WaitForInboxFanOut()
	// Each recipient's inbox got ITS OWN event — not a shared payload.
	got := map[string]string{}
	for _, c := range inbox.seen() {
		var decoded events.Event
		if err := json.Unmarshal(c.payload, &decoded); err != nil {
			t.Fatalf("inbox payload: %v", err)
		}
		got[c.userID] = decoded.ID
	}
	if got["u1"] != evt1.ID || got["u2"] != evt2.ID {
		t.Fatalf("per-recipient payloads mixed up: %v (want u1=%s u2=%s)", got, evt1.ID, evt2.ID)
	}

	// Empty batch: no-op.
	if err := ps.PublishEach(context.Background(), nil); err != nil {
		t.Fatalf("empty PublishEach: %v", err)
	}

	// A malformed payload (invalid RawMessage) surfaces the marshal error.
	bad := &events.Event{ID: "bad", Type: events.EventMessageNew, Data: json.RawMessage("{not json")}
	if err := ps.PublishEach(context.Background(), []events.PublishItem{{Channel: "user:u1", Event: bad}}); err == nil {
		t.Fatal("malformed event must surface a marshal error")
	}

	// Pipeline error (server gone) surfaces — but the durable inbox fan-out
	// must still run so persistent events stay replayable (same contract as
	// PublishMany).
	proxy.Close()
	before := len(inbox.seen())
	if err := ps.PublishEach(context.Background(), items[:1]); err == nil {
		t.Error("PublishEach against a dead server should return the pipeline error")
	}
	ps.WaitForInboxFanOut()
	if got := len(inbox.seen()); got != before+1 {
		t.Errorf("durable fan-out must run despite the live PUBLISH error: appends=%d, want %d", got, before+1)
	}
}
