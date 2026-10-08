package pubsub

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"sync"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/redis/go-redis/v9"
)

// Broker manages real-time clients and their Redis pub/sub channel subscriptions.
// Multiple concurrent clients per user are supported so multiple tabs/devices
// don't flap presence on reconnect — redis subscriptions are torn down only
// when the user's last client disconnects.
type Broker struct {
	clients   map[string]map[*events.Client]struct{} // userID → set of clients
	userSubs  map[string]map[string]bool             // userID → set of redis channels
	redisSubs map[string]map[string]bool             // redis channel → set of userIDs
	mu        sync.RWMutex

	pubsub     *RedisPubSub
	subscriber *redis.PubSub
	ctx        context.Context
	cancel     context.CancelFunc
}

// NewBroker creates a new Broker backed by the given RedisPubSub.
func NewBroker(redisPubSub *RedisPubSub) *Broker {
	ctx, cancel := context.WithCancel(context.Background())
	b := &Broker{
		clients:    make(map[string]map[*events.Client]struct{}),
		userSubs:   make(map[string]map[string]bool),
		redisSubs:  make(map[string]map[string]bool),
		pubsub:     redisPubSub,
		subscriber: redisPubSub.Client().Subscribe(ctx),
		ctx:        ctx,
		cancel:     cancel,
	}
	go b.listen()
	return b
}

// RegisterClient creates and tracks a new event client for the given user.
// Pass the returned client back to UnregisterClient to deregister it.
func (b *Broker) RegisterClient(userID string) *events.Client {
	b.mu.Lock()
	defer b.mu.Unlock()

	client := events.NewClient(userID)
	if b.clients[userID] == nil {
		b.clients[userID] = make(map[*events.Client]struct{})
	}
	b.clients[userID][client] = struct{}{}
	return client
}

// UnregisterClient removes a specific client. The user's redis subscriptions
// are torn down only when the LAST client for that user disconnects, so
// a refreshing tab doesn't briefly drop the user's whole subscription set.
func (b *Broker) UnregisterClient(userID string, client *events.Client) {
	b.mu.Lock()
	defer b.mu.Unlock()

	set, ok := b.clients[userID]
	if !ok {
		return
	}
	if _, present := set[client]; present {
		client.Close()
		delete(set, client)
	}
	if len(set) > 0 {
		return
	}
	delete(b.clients, userID)

	channels := b.userSubs[userID]
	delete(b.userSubs, userID)

	var toUnsub []string
	for ch := range channels {
		if users, exists := b.redisSubs[ch]; exists {
			delete(users, userID)
			if len(users) == 0 {
				delete(b.redisSubs, ch)
				toUnsub = append(toUnsub, ch)
			}
		}
	}

	if len(toUnsub) > 0 {
		if err := b.subscriber.Unsubscribe(b.ctx, toUnsub...); err != nil {
			slog.Error("redis unsubscribe", "error", err, "channels", toUnsub)
		}
	}
}

// Subscribe adds Redis channel subscriptions for the given user. New Redis
// subscriptions are created only for channels that have no local subscribers yet.
func (b *Broker) Subscribe(userID string, channels []string) {
	b.mu.Lock()
	defer b.mu.Unlock()

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

	if len(toSub) > 0 {
		if err := b.subscriber.Subscribe(b.ctx, toSub...); err != nil {
			slog.Error("redis subscribe", "error", err, "channels", toSub)
		}
	}
}

// Unsubscribe removes Redis channel subscriptions for the given user.
// Redis channels with no remaining local subscribers are unsubscribed.
func (b *Broker) Unsubscribe(userID string, channels []string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	subs, ok := b.userSubs[userID]
	if !ok {
		return
	}

	var toUnsub []string
	for _, ch := range channels {
		delete(subs, ch)

		if users, exists := b.redisSubs[ch]; exists {
			delete(users, userID)
			if len(users) == 0 {
				delete(b.redisSubs, ch)
				toUnsub = append(toUnsub, ch)
			}
		}
	}

	if len(subs) == 0 {
		delete(b.userSubs, userID)
	}

	if len(toUnsub) > 0 {
		if err := b.subscriber.Unsubscribe(b.ctx, toUnsub...); err != nil {
			slog.Error("redis unsubscribe", "error", err, "channels", toUnsub)
		}
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
		for client := range b.clients[userID] {
			targets = append(targets, client)
		}
	}
	b.mu.RUnlock()

	data := []byte(msg.Payload)
	for _, client := range targets {
		client.Send(data)
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
	defer b.mu.Unlock()

	for _, set := range b.clients {
		for client := range set {
			client.Close()
		}
	}
	return b.subscriber.Close()
}
