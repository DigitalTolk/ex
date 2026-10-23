package pubsub

import (
	"context"
	"encoding/json"
	"iter"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"sync"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/redis/go-redis/v9"
)

// Broker manages real-time clients and their Redis pub/sub channel subscriptions.
// Multiple concurrent clients per user are supported so multiple tabs/devices
// don't flap presence on reconnect — redis subscriptions are torn down only
// when the user's last client disconnects.
//
// Locking: mu guards the maps and is only ever held for in-memory work, so
// live delivery (dispatch) and socket registration never wait on Redis.
// subMu serializes subscription CHANGES — the refcount update together with
// the SUBSCRIBE / UNSUBSCRIBE it implies — so those commands reach Redis in
// exactly the order the refcounts changed: a last member's UNSUBSCRIBE can
// never land after a new member's SUBSCRIBE of the same channel and leave
// them deaf to it, and a Subscribe returns only once its SUBSCRIBE (or the
// one it piggybacks on) has been issued. Lock order: subMu, then mu.
type Broker struct {
	clients   map[string][]*events.Client // userID → live clients, oldest first
	userSubs  map[string]map[string]bool  // userID → set of redis channels
	redisSubs map[string]map[string]bool  // redis channel → set of userIDs
	mu        sync.RWMutex
	subMu     sync.Mutex

	// maxClientsPerUser caps one user's concurrent sockets on this instance
	// (0 = no cap); see RegisterClient.
	maxClientsPerUser int

	pubsub     *RedisPubSub
	subscriber redisSubscriber
	ctx        context.Context
	cancel     context.CancelFunc
}

// DefaultMaxClientsPerUser is the per-user, per-instance socket cap: far above
// real multi-tab, multi-device use, low enough that one credential cannot pin
// an unbounded number of sockets (goroutines, buffers, subscriptions) on an
// instance.
const DefaultMaxClientsPerUser = 32

// redisSubscriber is the part of *redis.PubSub the broker drives, as an
// interface so a test can hold a SUBSCRIBE "on the wire".
type redisSubscriber interface {
	Subscribe(ctx context.Context, channels ...string) error
	Unsubscribe(ctx context.Context, channels ...string) error
	Channel(opts ...redis.ChannelOption) <-chan *redis.Message
	Close() error
}

// NewBroker creates a new Broker backed by the given RedisPubSub. Every broker
// listens on the instance-wide MulticastTopic from the start (go-redis
// re-subscribes it after a reconnect), so a PublishMulticast reaches every
// instance.
func NewBroker(redisPubSub *RedisPubSub) *Broker {
	return newBroker(redisPubSub, redisPubSub.Client().Subscribe(context.Background(), MulticastTopic()))
}

func newBroker(redisPubSub *RedisPubSub, sub redisSubscriber) *Broker {
	ctx, cancel := context.WithCancel(context.Background())
	b := &Broker{
		clients:           make(map[string][]*events.Client),
		userSubs:          make(map[string]map[string]bool),
		redisSubs:         make(map[string]map[string]bool),
		maxClientsPerUser: DefaultMaxClientsPerUser,
		pubsub:            redisPubSub,
		subscriber:        sub,
		ctx:               ctx,
		cancel:            cancel,
	}
	go b.listen()
	return b
}

// RegisterClient creates and tracks a new event client for the given user.
// Pass the returned client back to UnregisterClient to deregister it.
//
// Past maxClientsPerUser the user's OLDEST socket is closed: its connection
// loop ends and that tab reconnects (and replays) on its own. Refusing the new
// socket instead would starve the device the user just opened or reconnected —
// the one most likely in front of them — of alerts, while a stale or half-open
// socket kept its slot until the pong timeout. Either way the deferred mobile
// push still covers an alert no socket acknowledges.
func (b *Broker) RegisterClient(userID string) *events.Client {
	client := events.NewClient(userID)
	b.mu.Lock()
	set := append(b.clients[userID], client)
	var evicted []*events.Client
	limit := b.maxClientsPerUser
	if limit > 0 && len(set) > limit {
		evicted = set[:len(set)-limit]
		set = slices.Clone(set[len(set)-limit:])
	}
	b.clients[userID] = set
	b.mu.Unlock()
	for _, c := range evicted {
		slog.Warn("broker: per-user socket cap reached, closing the oldest socket", "userID", userID, "cap", limit)
		c.Close()
	}
	return client
}

// UnregisterClient removes a specific client. The user's redis subscriptions
// are torn down only when the LAST client for that user disconnects, so
// a refreshing tab doesn't briefly drop the user's whole subscription set.
func (b *Broker) UnregisterClient(userID string, client *events.Client) {
	b.mu.Lock()
	set, known := b.clients[userID]
	if i := slices.Index(set, client); i >= 0 {
		client.Close()
		set = slices.Delete(set, i, i+1)
	}
	if len(set) > 0 {
		b.clients[userID] = set
		b.mu.Unlock()
		return
	}
	delete(b.clients, userID)
	b.mu.Unlock()
	if known {
		b.dropUserSubscriptions(userID)
	}
}

// dropUserSubscriptions tears down the subscriptions of a user whose last
// socket just left — unless a new socket of theirs registered in the
// meantime, which keeps them.
func (b *Broker) dropUserSubscriptions(userID string) {
	b.subMu.Lock()
	defer b.subMu.Unlock()
	b.mu.Lock()
	if len(b.clients[userID]) > 0 {
		b.mu.Unlock()
		return
	}
	channels := b.userSubs[userID]
	delete(b.userSubs, userID)
	toUnsub := b.releaseLocked(userID, maps.Keys(channels))
	b.mu.Unlock()
	b.redisUnsubscribe(toUnsub)
}

// Subscribe adds Redis channel subscriptions for the given user. New Redis
// subscriptions are created only for channels that have no local subscribers yet.
func (b *Broker) Subscribe(userID string, channels []string) {
	b.subMu.Lock()
	defer b.subMu.Unlock()

	b.mu.Lock()
	if _, ok := b.userSubs[userID]; !ok {
		b.userSubs[userID] = make(map[string]bool)
	}
	var toSub []string
	for _, ch := range channels {
		b.userSubs[userID][ch] = true

		if _, exists := b.redisSubs[ch]; !exists {
			b.redisSubs[ch] = make(map[string]bool)
			toSub = append(toSub, ch)
		}
		b.redisSubs[ch][userID] = true
	}
	b.mu.Unlock()

	if len(toSub) > 0 {
		if err := b.subscriber.Subscribe(b.ctx, toSub...); err != nil {
			slog.Error("redis subscribe", "error", err, "channels", toSub)
		}
	}
}

// Unsubscribe removes Redis channel subscriptions for the given user.
// Redis channels with no remaining local subscribers are unsubscribed.
func (b *Broker) Unsubscribe(userID string, channels []string) {
	b.subMu.Lock()
	defer b.subMu.Unlock()

	b.mu.Lock()
	subs, ok := b.userSubs[userID]
	if !ok {
		b.mu.Unlock()
		return
	}
	for _, ch := range channels {
		delete(subs, ch)
	}
	if len(subs) == 0 {
		delete(b.userSubs, userID)
	}
	toUnsub := b.releaseLocked(userID, slices.Values(channels))
	b.mu.Unlock()

	b.redisUnsubscribe(toUnsub)
}

// releaseLocked drops userID from each channel's local subscriber set and
// returns the channels nobody on this instance listens to any more. Caller
// holds mu (and subMu, to issue the UNSUBSCRIBE in order).
func (b *Broker) releaseLocked(userID string, channels iter.Seq[string]) []string {
	var gone []string
	for ch := range channels {
		if users, exists := b.redisSubs[ch]; exists {
			delete(users, userID)
			if len(users) == 0 {
				delete(b.redisSubs, ch)
				gone = append(gone, ch)
			}
		}
	}
	return gone
}

// redisUnsubscribe issues the UNSUBSCRIBE for channels that lost their last
// local subscriber. Caller holds subMu but NOT mu.
func (b *Broker) redisUnsubscribe(channels []string) {
	if len(channels) == 0 {
		return
	}
	if err := b.subscriber.Unsubscribe(b.ctx, channels...); err != nil {
		slog.Error("redis unsubscribe", "error", err, "channels", channels)
	}
}

// listen reads messages from the Redis subscriber and dispatches them to
// the appropriate connected clients.
func (b *Broker) listen() {
	ch := b.subscriber.Channel()
	for {
		select {
		case <-b.ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			b.dispatch(msg)
		}
	}
}

// dispatch sends a Redis pub/sub message to all clients subscribed to the channel.
// We snapshot the subscriber list under the read lock and release before
// fanning out, so the per-client Send (atomic ops) cannot stall concurrent
// Register/Subscribe calls when many clients are subscribed.
func (b *Broker) dispatch(msg *redis.Message) {
	if msg.Channel == MulticastTopic() {
		b.dispatchMulticast(msg.Payload)
		return
	}
	if b.applyControl(msg) {
		return
	}
	b.mu.RLock()
	users, ok := b.redisSubs[msg.Channel]
	if !ok {
		b.mu.RUnlock()
		return
	}
	targets := make([]*events.Client, 0, len(users))
	for userID := range users {
		targets = append(targets, b.clients[userID]...)
	}
	b.mu.RUnlock()

	data := []byte(msg.Payload)
	for _, client := range targets {
		client.Send(data)
	}
}

// dispatchMulticast delivers a PublishMulticast frame: every local socket
// subscribed to ANY of its topics receives the event exactly once, however
// many of those topics it shares.
func (b *Broker) dispatchMulticast(payload string) {
	var env multicastEnvelope
	if err := json.Unmarshal([]byte(payload), &env); err != nil || len(env.Event) == 0 {
		slog.Error("broker: dropping malformed multicast frame", "error", err)
		return
	}
	b.mu.RLock()
	seen := make(map[string]bool)
	var targets []*events.Client
	for _, topic := range env.Topics {
		for userID := range b.redisSubs[topic] {
			if !seen[userID] {
				seen[userID] = true
				targets = append(targets, b.clients[userID]...)
			}
		}
	}
	b.mu.RUnlock()

	for _, client := range targets {
		client.Send(env.Event)
	}
}

// brokerControl is the payload of a subscribe/unsubscribe control frame.
type brokerControl struct {
	Type string `json:"type"`
	Data struct {
		Topics []string `json:"topics"`
	} `json:"data"`
}

// applyControl handles a subscribe/unsubscribe control frame published on a
// user's own topic (see PublishSubscription) and reports whether msg was one.
// Subscriptions are per instance — each Broker holds only its own sockets — so
// a membership change made on one instance reaches the user's sockets on the
// others this way; without it they kept receiving notifications (user topic)
// but none of the new parent's messages until they reconnected.
func (b *Broker) applyControl(msg *redis.Message) bool {
	userID, ok := strings.CutPrefix(msg.Channel, UserChannel(""))
	if !ok || !strings.Contains(msg.Payload, `"broker.`) {
		return false
	}
	var ctl brokerControl
	if json.Unmarshal([]byte(msg.Payload), &ctl) != nil {
		return false
	}
	switch ctl.Type {
	case events.EventBrokerSubscribe:
		b.Subscribe(userID, ctl.Data.Topics)
	case events.EventBrokerUnsubscribe:
		b.Unsubscribe(userID, ctl.Data.Topics)
	default:
		return false
	}
	return true
}

// PublishSubscription subscribes (or unsubscribes) userID to topics on EVERY
// instance holding one of their sockets: it applies the change here and
// publishes a control frame on the user's own topic for the other instances.
func (b *Broker) PublishSubscription(ctx context.Context, userID string, topics []string, subscribe bool) {
	eventType := events.EventBrokerUnsubscribe
	if subscribe {
		b.Subscribe(userID, topics)
		eventType = events.EventBrokerSubscribe
	} else {
		b.Unsubscribe(userID, topics)
	}
	events.Publish(ctx, b.pubsub, UserChannel(userID), eventType, map[string]any{"topics": topics})
}

// Close shuts down the broker, closing the Redis subscriber and all clients.
func (b *Broker) Close() error {
	b.cancel()
	b.mu.Lock()
	for _, set := range b.clients {
		for _, client := range set {
			client.Close()
		}
	}
	b.mu.Unlock()
	return b.subscriber.Close()
}
