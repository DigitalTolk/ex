//go:build integration

package pubsub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/redis/go-redis/v9"
)

func (c *captureInbox) appendBatches() [][]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([][]string(nil), c.batches...)
}

func (c *captureInbox) dropContextErrors() []error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]error(nil), c.dropCtxErrs...)
}

// One event published to several topics whose audiences overlap is ONE inbox
// fan-out: every recipient gets one entry, and the payload is handed to the
// inbox once — not once per topic (which stored a full copy per topic per
// recipient).
func TestRedisPubSub_FanOutAppendsOncePerRecipient(t *testing.T) {
	ps := setupTestPubSub(t)
	resolver := &fakeResolver{m: map[string][]string{
		"chan:a": {"u1", "u2"},
		"chan:b": {"u2", "u3"},
	}}
	inbox := &captureInbox{}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventChannelArchived, map[string]string{"channelID": "a"})
	if err := ps.PublishMany(context.Background(), []string{"chan:a", "chan:b"}, evt); err != nil {
		t.Fatalf("PublishMany: %v", err)
	}
	ps.WaitForInboxFanOut()

	batches := inbox.appendBatches()
	if len(batches) != 1 {
		t.Fatalf("inbox fan-outs = %v, want exactly one", batches)
	}
	got := append([]string(nil), batches[0]...)
	sort.Strings(got)
	if fmt.Sprint(got) != "[u1 u2 u3]" {
		t.Fatalf("recipients = %v, want [u1 u2 u3] (each once)", got)
	}
}

// A persistent event sent as a multicast keeps its durability: one inbox
// fan-out over the union of the topics' recipients — even when the live
// PUBLISH fails, so those recipients can still replay it on reconnect.
func TestRedisPubSub_PublishMulticastDurability(t *testing.T) {
	proxy := newRedisProxy(t)
	ps := newTestPubSubAt(t, proxy.Addr())
	resolver := &fakeResolver{m: map[string][]string{
		"chan:a": {"u1", "u2"},
		"conv:b": {"u2", "u3"},
	}}
	inbox := &captureInbox{}
	ps.SetDurability(resolver, inbox)
	ctx := context.Background()

	if err := ps.PublishMulticast(ctx, nil, nil); err != nil {
		t.Fatalf("an empty topic list must be a no-op, got %v", err)
	}
	bad := &events.Event{ID: "bad", Type: events.EventMessageNew, Data: json.RawMessage("{oops")}
	if err := ps.PublishMulticast(ctx, []string{"chan:a"}, bad); err == nil {
		t.Fatal("a malformed event must surface its marshal error")
	}

	evt, _ := events.NewEvent(events.EventMembersChanged, map[string]string{"channelID": "c9"})
	if err := ps.PublishMulticast(ctx, []string{"chan:a", "conv:b"}, evt); err != nil {
		t.Fatalf("PublishMulticast: %v", err)
	}
	ps.WaitForInboxFanOut()
	batches := inbox.appendBatches()
	if len(batches) != 1 {
		t.Fatalf("inbox fan-outs = %v, want one", batches)
	}
	got := append([]string(nil), batches[0]...)
	sort.Strings(got)
	if fmt.Sprint(got) != "[u1 u2 u3]" {
		t.Fatalf("recipients = %v, want [u1 u2 u3]", got)
	}

	proxy.Close() // the server dies: the live PUBLISH fails ...
	if err := ps.PublishMulticast(ctx, []string{"chan:a"}, evt); err == nil {
		t.Fatal("PublishMulticast against a dead server must return the publish error")
	}
	ps.WaitForInboxFanOut()
	if got := len(inbox.appendBatches()); got != 2 {
		t.Fatalf("... but the durable fan-out must still run: fan-outs = %d, want 2", got)
	}
}

// One topic failing to resolve does not cost the other topics' recipients
// their inbox entry.
func TestRedisPubSub_FanOutSurvivesOneUnresolvableTopic(t *testing.T) {
	ps := setupTestPubSub(t)
	inbox := &captureInbox{}
	ps.SetDurability(&flakyResolver{fail: "chan:broken", m: map[string][]string{"chan:ok": {"u1"}}}, inbox)

	evt, _ := events.NewEvent(events.EventChannelArchived, map[string]string{"channelID": "x"})
	if err := ps.PublishMany(context.Background(), []string{"chan:broken", "chan:ok"}, evt); err != nil {
		t.Fatalf("PublishMany: %v", err)
	}
	ps.WaitForInboxFanOut()
	if batches := inbox.appendBatches(); len(batches) != 1 || fmt.Sprint(batches[0]) != "[u1]" {
		t.Fatalf("inbox fan-outs = %v, want [[u1]]", batches)
	}
}

// flakyResolver fails exactly one topic.
type flakyResolver struct {
	fail string
	m    map[string][]string
}

func (f *flakyResolver) Resolve(_ context.Context, topic string) ([]string, error) {
	if topic == f.fail {
		return nil, errors.New("resolver down for " + topic)
	}
	return f.m[topic], nil
}

// The fan-out runs on a detached context with its own deadline, and the
// retry wait honours it: a wedged inbox can no longer pin the goroutine for
// a fixed sleep regardless of the context. The poison step still runs — on
// a fresh, live context — so the affected clients resync instead of
// replaying past a possible hole.
func TestRedisPubSub_InboxRetryWaitEndsAtFanOutDeadline(t *testing.T) {
	ps := setupTestPubSub(t)
	origInterval, origTimeout := inboxAppendRetryInterval, inboxFanOutTimeout
	inboxAppendRetryInterval = time.Hour // only the context can cut this wait short
	inboxFanOutTimeout = 50 * time.Millisecond
	t.Cleanup(func() { inboxAppendRetryInterval, inboxFanOutTimeout = origInterval, origTimeout })

	resolver := &fakeResolver{m: map[string][]string{"chan:c1": {"u1", "u2"}}}
	inbox := &captureInbox{err: errors.New("write failed")}
	ps.SetDurability(resolver, inbox)

	evt, _ := events.NewEvent(events.EventMessageNew, nil)
	if err := ps.Publish(context.Background(), "chan:c1", evt); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	done := make(chan struct{})
	go func() {
		ps.WaitForInboxFanOut()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the inbox retry wait ignored the fan-out's context")
	}
	if dropped := inbox.droppedBatches(); len(dropped) != 1 || len(dropped[0]) != 2 {
		t.Fatalf("dropped batches = %v, want one batch of the 2 recipients", dropped)
	}
	for _, err := range inbox.dropContextErrors() {
		if err != nil {
			t.Fatalf("the poison step ran on a dead context: %v", err)
		}
	}
}

// waitSubscribed blocks until Redis reports at least want[ch] subscribers on
// every channel — subscriptions are confirmed asynchronously, so a test must
// wait for that state rather than for an arbitrary amount of time.
func waitSubscribed(t *testing.T, client *redis.Client, want map[string]int64) {
	t.Helper()
	channels := make([]string, 0, len(want))
	for ch := range want {
		channels = append(channels, ch)
	}
	deadline := time.After(5 * time.Second)
	poll := time.NewTicker(5 * time.Millisecond)
	defer poll.Stop()
	for {
		counts, err := client.PubSubNumSub(context.Background(), channels...).Result()
		if err != nil {
			t.Fatalf("PUBSUB NUMSUB: %v", err)
		}
		ready := true
		for ch, n := range want {
			if counts[ch] < n {
				ready = false
			}
		}
		if ready {
			return
		}
		select {
		case <-poll.C:
		case <-deadline:
			t.Fatalf("subscriptions never became active: have %v, want %v", counts, want)
		}
	}
}

// countUntilSentinel reads a client's events until the sentinel of the given
// topic arrives and returns how many events of eventType came before it. Redis
// delivers a subscriber connection's messages in publish order, so once the
// sentinel (published after the fan-out) is seen, every copy of the fan-out
// that connection was ever going to receive has arrived.
func countUntilSentinel(t *testing.T, client *events.Client, eventType, sentinelTopic string) int {
	t.Helper()
	n := 0
	for {
		select {
		case data := <-client.Events:
			var evt struct {
				Type string `json:"type"`
				Data struct {
					Topic string `json:"topic"`
				} `json:"data"`
			}
			if err := json.Unmarshal(data, &evt); err != nil {
				t.Fatalf("decode %q: %v", data, err)
			}
			switch {
			case evt.Type == "test.sentinel" && evt.Data.Topic == sentinelTopic:
				return n
			case evt.Type == eventType:
				n++
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s: sentinel on %s never arrived", client.UserID, sentinelTopic)
		}
	}
}

func publishSentinel(t *testing.T, ps *RedisPubSub, topic string) {
	t.Helper()
	evt, _ := events.NewEvent("test.sentinel", map[string]string{"topic": topic})
	if err := ps.Publish(context.Background(), topic, evt); err != nil {
		t.Fatalf("publish sentinel: %v", err)
	}
}

// A presence change is sent to every channel and DM the subject is in. A
// connection sharing several of them with the subject must still receive it
// ONCE — on every instance — instead of one copy per shared topic.
func TestBroker_PresenceFanOutReachesEachConnectionOnce(t *testing.T) {
	a, ps := setupTestBroker(t)
	b := NewBroker(newTestPubSubAt(t, pubsubRedisAddr))
	t.Cleanup(func() { _ = b.Close() })

	both := a.RegisterClient("shares-two") // instance A
	a.Subscribe("shares-two", []string{"chan:mc-1", "chan:mc-2"})
	secondTab := a.RegisterClient("shares-two")
	one := b.RegisterClient("shares-one") // instance B
	b.Subscribe("shares-one", []string{"chan:mc-2"})
	none := b.RegisterClient("shares-none")
	b.Subscribe("shares-none", []string{"chan:mc-other"})
	waitSubscribed(t, ps.Client(), map[string]int64{"chan:mc-1": 1, "chan:mc-2": 2, "chan:mc-other": 1})

	events.PublishMulticast(context.Background(), ps, []string{"chan:mc-1", "chan:mc-2"},
		events.EventPresenceChanged, map[string]any{"userID": "subject", "online": true})
	publishSentinel(t, ps, "chan:mc-1")
	publishSentinel(t, ps, "chan:mc-2")
	publishSentinel(t, ps, "chan:mc-other")

	for _, tc := range []struct {
		name     string
		client   *events.Client
		sentinel string
		want     int
	}{
		{"connection sharing two topics", both, "chan:mc-1", 1},
		{"second tab of the same user", secondTab, "chan:mc-1", 1},
		{"connection on another instance sharing one topic", one, "chan:mc-2", 1},
		{"connection sharing nothing", none, "chan:mc-other", 0},
	} {
		if got := countUntilSentinel(t, tc.client, events.EventPresenceChanged, tc.sentinel); got != tc.want {
			t.Errorf("%s: received %d presence.changed copies, want %d", tc.name, got, tc.want)
		}
	}
}
