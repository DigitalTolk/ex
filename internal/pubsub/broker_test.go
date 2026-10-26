package pubsub

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/redis/go-redis/v9"
)

// fakeSubscriber stands in for the Redis subscriber connection. It applies
// SUBSCRIBE/UNSUBSCRIBE to `active` in the order they are issued — exactly
// what Redis would end up subscribed to — and can hold a SUBSCRIBE for a
// channel "on the wire" until the test releases it.
type fakeSubscriber struct {
	mu      sync.Mutex
	active  map[string]bool
	gates   map[string]chan struct{}
	entered chan string
	msgs    chan *redis.Message
}

func newFakeSubscriber() *fakeSubscriber {
	return &fakeSubscriber{
		active:  map[string]bool{},
		gates:   map[string]chan struct{}{},
		entered: make(chan string, 16),
		msgs:    make(chan *redis.Message),
	}
}

// hold makes the next SUBSCRIBE of channel block until the returned release
// func runs (idempotent).
func (f *fakeSubscriber) hold(channel string) (release func()) {
	gate := make(chan struct{})
	f.mu.Lock()
	f.gates[channel] = gate
	f.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { close(gate) }) }
}

func (f *fakeSubscriber) Subscribe(_ context.Context, channels ...string) error {
	for _, ch := range channels {
		f.mu.Lock()
		gate := f.gates[ch]
		f.mu.Unlock()
		if gate != nil {
			f.entered <- ch
			<-gate
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ch := range channels {
		f.active[ch] = true
	}
	return nil
}

func (f *fakeSubscriber) Unsubscribe(_ context.Context, channels ...string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ch := range channels {
		delete(f.active, ch)
	}
	return nil
}

func (f *fakeSubscriber) Channel(...redis.ChannelOption) <-chan *redis.Message { return f.msgs }

func (f *fakeSubscriber) Close() error { return nil }

func (f *fakeSubscriber) activeChannels() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.active))
	for ch := range f.active {
		out = append(out, ch)
	}
	sort.Strings(out)
	return out
}

func newUnitBroker(t *testing.T, sub *fakeSubscriber) *Broker {
	t.Helper()
	b := newBroker(nil, sub)
	t.Cleanup(func() { _ = b.Close() })
	return b
}

// A SUBSCRIBE round-trip to Redis (one user joining a channel, a connect on a
// slow network) must never stall live delivery to everyone else or the
// registration of other sockets: the broker used to hold its global lock
// across that network write.
func TestBroker_SubscribeIODoesNotBlockDelivery(t *testing.T) {
	sub := newFakeSubscriber()
	b := newUnitBroker(t, sub)

	reader := b.RegisterClient("reader")
	b.Subscribe("reader", []string{"chan:fast"})

	release := sub.hold("chan:slow")
	t.Cleanup(release)
	var joined sync.WaitGroup
	joined.Add(1)
	go func() {
		defer joined.Done()
		b.Subscribe("joiner", []string{"chan:slow"})
	}()
	select {
	case <-sub.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the SUBSCRIBE for chan:slow was never issued")
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		b.dispatch(&redis.Message{Channel: "chan:fast", Payload: `{"type":"message.new"}`})
		b.RegisterClient("newcomer")
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("live delivery and socket registration waited on another user's Redis SUBSCRIBE")
	}
	select {
	case got := <-reader.Events:
		if string(got) != `{"type":"message.new"}` {
			t.Fatalf("reader got %q", got)
		}
	default:
		t.Fatal("reader did not receive the event")
	}

	release()
	joined.Wait()
	if got := sub.activeChannels(); fmt.Sprint(got) != "[chan:fast chan:slow]" {
		t.Fatalf("redis subscriptions = %v, want [chan:fast chan:slow]", got)
	}
}

// Subscription changes race with each other (connects, disconnects,
// membership control frames). Whatever the interleaving, the channels Redis
// ends up subscribed to must equal the broker's own refcounted view — a
// SUBSCRIBE and an UNSUBSCRIBE for the same channel reaching Redis in the
// wrong order leaves a member deaf to it. Run with -race.
func TestBroker_SubscriptionRefcountUnderConcurrency(t *testing.T) {
	sub := newFakeSubscriber()
	b := newUnitBroker(t, sub)

	anchor := b.RegisterClient("anchor")
	b.Subscribe("anchor", []string{"chan:shared"})

	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			uid := fmt.Sprintf("u%d", i)
			for range 25 {
				c := b.RegisterClient(uid)
				b.Subscribe(uid, []string{"chan:shared", "chan:" + uid, "chan:hot"})
				b.Unsubscribe(uid, []string{"chan:hot"})
				// A membership change arriving from another instance.
				b.dispatch(&redis.Message{
					Channel: UserChannel(uid),
					Payload: `{"type":"broker.subscribe","data":{"topics":["chan:hot"]}}`,
				})
				b.UnregisterClient(uid, c)
			}
		}()
	}
	wg.Wait()

	b.mu.RLock()
	want := make([]string, 0, len(b.redisSubs))
	for ch := range b.redisSubs {
		want = append(want, ch)
	}
	b.mu.RUnlock()
	sort.Strings(want)
	if got := sub.activeChannels(); fmt.Sprint(got) != fmt.Sprint(want) || fmt.Sprint(got) != "[chan:shared]" {
		t.Fatalf("redis subscriptions = %v, broker view = %v, want both [chan:shared]", got, want)
	}

	b.UnregisterClient("anchor", anchor)
	if got := sub.activeChannels(); len(got) != 0 {
		t.Fatalf("redis subscriptions after the last user left = %v, want none", got)
	}
}

// One user cannot hold an unbounded number of sockets on an instance. Past
// the cap the OLDEST socket is closed: the newest one is the device the user
// just opened or reconnected, so refusing it would starve the screen they are
// looking at of alerts while a stale, possibly half-open socket kept its
// slot. The evicted tab reconnects (and replays) on its own.
func TestBroker_CapsSocketsPerUserByEvictingOldest(t *testing.T) {
	b := newUnitBroker(t, newFakeSubscriber())
	if b.maxClientsPerUser != DefaultMaxClientsPerUser {
		t.Fatalf("default cap = %d, want %d", b.maxClientsPerUser, DefaultMaxClientsPerUser)
	}
	b.maxClientsPerUser = 3

	other := b.RegisterClient("other")
	var socks []*events.Client
	for range 4 {
		socks = append(socks, b.RegisterClient("u"))
	}
	isClosed := func(c *events.Client) bool {
		select {
		case <-c.Done():
			return true
		default:
			return false
		}
	}
	if !isClosed(socks[0]) {
		t.Fatal("the oldest socket must be closed once the user exceeds the cap")
	}
	for i, c := range socks[1:] {
		if isClosed(c) {
			t.Fatalf("socket %d (within the cap) was closed", i+1)
		}
	}
	if isClosed(other) {
		t.Fatal("another user's socket was closed")
	}

	// The evicted socket's own teardown must not disturb the survivors.
	b.UnregisterClient("u", socks[0])
	b.mu.RLock()
	n := len(b.clients["u"])
	b.mu.RUnlock()
	if n != 3 {
		t.Fatalf("live sockets for u = %d, want 3", n)
	}

	// Delivery reaches every surviving socket.
	b.Subscribe("u", []string{UserChannel("u")})
	b.dispatch(&redis.Message{Channel: UserChannel("u"), Payload: `{"type":"notification.new"}`})
	for i, c := range socks[1:] {
		select {
		case <-c.Events:
		default:
			t.Fatalf("surviving socket %d missed the event", i+1)
		}
	}
}

// A refreshing tab: the old socket's teardown (last socket gone → drop the
// user's subscriptions) races the new socket's registration. When the new
// socket registers first, the teardown must leave the subscriptions alone —
// the new socket depends on them.
func TestBroker_TeardownKeepsSubscriptionsOfAReconnectedUser(t *testing.T) {
	sub := newFakeSubscriber()
	b := newUnitBroker(t, sub)

	old := b.RegisterClient("u")
	b.Subscribe("u", []string{"chan:u-room"})

	// Another user's SUBSCRIBE is on the wire, so the teardown below has to
	// wait its turn for the subscription lock.
	release := sub.hold("chan:other")
	t.Cleanup(release)
	var other sync.WaitGroup
	other.Add(1)
	go func() {
		defer other.Done()
		b.Subscribe("someone", []string{"chan:other"})
	}()
	select {
	case <-sub.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the held SUBSCRIBE was never issued")
	}

	var teardown sync.WaitGroup
	teardown.Add(1)
	go func() {
		defer teardown.Done()
		b.UnregisterClient("u", old)
	}()
	// The old socket is gone (it is closed as it leaves the set) ...
	select {
	case <-old.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("the old socket was never unregistered")
	}
	// ... and the new one registers before the teardown gets the lock.
	fresh := b.RegisterClient("u")
	release()
	other.Wait()
	teardown.Wait()

	b.mu.RLock()
	kept := b.userSubs["u"]["chan:u-room"] && b.redisSubs["chan:u-room"]["u"]
	b.mu.RUnlock()
	if !kept {
		t.Fatal("the teardown of the old socket dropped the reconnected user's subscriptions")
	}
	if got := sub.activeChannels(); fmt.Sprint(got) != "[chan:other chan:u-room]" {
		t.Fatalf("redis subscriptions = %v, want [chan:other chan:u-room]", got)
	}
	b.dispatch(&redis.Message{Channel: "chan:u-room", Payload: `{"type":"message.new"}`})
	select {
	case <-fresh.Events:
	default:
		t.Fatal("the reconnected socket missed its channel's event")
	}
}

// A multicast frame reaches every local socket subscribed to any of its
// topics exactly once, and nobody else.
func TestBroker_DispatchMulticastDeliversOncePerSocket(t *testing.T) {
	b := newUnitBroker(t, newFakeSubscriber())
	tab1 := b.RegisterClient("both")
	tab2 := b.RegisterClient("both")
	b.Subscribe("both", []string{"chan:a", "chan:b"})
	one := b.RegisterClient("one")
	b.Subscribe("one", []string{"chan:b"})
	none := b.RegisterClient("none")
	b.Subscribe("none", []string{"chan:c"})

	b.dispatch(&redis.Message{
		Channel: MulticastTopic(),
		Payload: `{"topics":["chan:a","chan:b","chan:unknown"],"event":{"id":"01X","type":"presence.changed","data":{}}}`,
	})
	for name, c := range map[string]*events.Client{"tab1": tab1, "tab2": tab2, "one": one} {
		if got := len(c.Events); got != 1 {
			t.Errorf("%s received %d copies, want 1", name, got)
			continue
		}
		if got := string(<-c.Events); got != `{"id":"01X","type":"presence.changed","data":{}}` {
			t.Errorf("%s received %q, want the bare event", name, got)
		}
	}
	if got := len(none.Events); got != 0 {
		t.Errorf("a socket on none of the topics received %d copies", got)
	}
}

// A malformed multicast frame (not JSON, or no event) is dropped, never
// forwarded to a client as-is.
func TestBroker_DispatchMulticastDropsMalformedFrames(t *testing.T) {
	b := newUnitBroker(t, newFakeSubscriber())
	c := b.RegisterClient("u")
	b.Subscribe("u", []string{"chan:a"})
	for _, payload := range []string{`not json`, `{"topics":["chan:a"]}`} {
		b.dispatch(&redis.Message{Channel: MulticastTopic(), Payload: payload})
	}
	if got := len(c.Events); got != 0 {
		t.Fatalf("malformed multicast frames delivered %d events", got)
	}
}
