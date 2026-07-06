//go:build integration

package pubsub

import (
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// Unsubscribing a user's only channel empties its userSubs map, taking
// the len(subs)==0 branch that deletes the user entry entirely.
func TestBrokerUnsubscribeLastChannelDeletesUser(t *testing.T) {
	b, _ := setupTestBroker(t)

	b.RegisterClient("u-solo")
	b.Subscribe("u-solo", []string{"chan:only"})
	b.Unsubscribe("u-solo", []string{"chan:only"})

	b.mu.RLock()
	_, stillThere := b.userSubs["u-solo"]
	b.mu.RUnlock()
	if stillThere {
		t.Fatal("expected userSubs entry to be deleted after last channel unsubscribed")
	}
}

// dispatch for a redis channel with no local subscribers takes the
// early return — no panic, no delivery.
func TestBrokerDispatchUnknownChannel(t *testing.T) {
	b, _ := setupTestBroker(t)
	// No subscriptions registered for this channel.
	b.dispatch(&redis.Message{Channel: "chan:nobody", Payload: "x"})
}

// Subscribe logs (and swallows) a redis error when the underlying
// subscriber command fails. Closing the subscriber makes the Subscribe
// call return "client is closed" deterministically (independent of
// network timing or cover mode), exercising the error branch.
func TestBrokerSubscribeRedisError(t *testing.T) {
	ps := setupTestPubSub(t)
	b := NewBroker(ps)
	defer func() { _ = b.Close() }()

	_ = b.subscriber.Close() // closed subscriber → Subscribe errors deterministically
	b.RegisterClient("u-err")
	// Must not panic; the error is logged and swallowed.
	b.Subscribe("u-err", []string{"chan:err"})
}

// Unsubscribe logs (and swallows) a redis error when the underlying
// subscriber Unsubscribe fails. Subscribe first (while live), then close
// the subscriber so the Unsubscribe command errors deterministically.
func TestBrokerUnsubscribeRedisError(t *testing.T) {
	ps := setupTestPubSub(t)
	b := NewBroker(ps)
	defer func() { _ = b.Close() }()

	b.RegisterClient("u-err")
	b.Subscribe("u-err", []string{"chan:err"})
	_ = b.subscriber.Close() // closed subscriber → Unsubscribe errors deterministically
	b.Unsubscribe("u-err", []string{"chan:err"})
}

// Closing the underlying subscriber (without cancelling the broker's
// context) closes the message channel the listen loop reads from,
// driving the `msg, ok := <-ch; !ok { return }` branch — the path the
// graceful Close() doesn't take because it cancels ctx first.
func TestBrokerListenChannelClosed(t *testing.T) {
	ps := setupTestPubSub(t)
	b := NewBroker(ps)

	// Close the subscriber directly. go-redis's Channel() consumer
	// goroutine then closes the delivery channel, so listen reads !ok
	// and returns — all while b.ctx is still alive.
	if err := b.subscriber.Close(); err != nil {
		t.Fatalf("subscriber close: %v", err)
	}
	// Give the listen goroutine time to observe the closed channel.
	time.Sleep(100 * time.Millisecond)

	b.cancel()
}

// UnregisterClient logs (and swallows) a redis error when tearing down a
// departing user's last subscription against a dead server.
func TestBrokerUnregisterRedisError(t *testing.T) {
	ps := setupTestPubSub(t)
	b := NewBroker(ps)
	defer func() { _ = b.Close() }()

	c := b.RegisterClient("u-err")
	b.Subscribe("u-err", []string{"chan:err"})
	_ = b.subscriber.Close() // closed subscriber → unsubscribe-on-last-client errors deterministically
	b.UnregisterClient("u-err", c)
}
