package pubsub

import (
	"context"
	"log/slog"
	"sync"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/redis/go-redis/v9"
)

// Broker manages real-time clients and their Redis pub/sub channel subscriptions.
// It maintains a single Redis PubSub connection that dynamically subscribes
// and unsubscribes as clients connect/disconnect.
type Broker struct {
	// clients maps userID -> connected client
	clients map[string]*events.Client
	// userSubs maps userID -> set of Redis channel names
	userSubs map[string]map[string]bool
	// redisSubs maps Redis channel name -> set of userIDs
	redisSubs map[string]map[string]bool
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
		clients:   make(map[string]*events.Client),
		userSubs:  make(map[string]map[string]bool),
		redisSubs: make(map[string]map[string]bool),
		pubsub:    redisPubSub,
		subscriber: redisPubSub.Client().Subscribe(ctx),
		ctx:       ctx,
		cancel:    cancel,
	}
	go b.listen()
	return b
}

// RegisterClient creates and stores a client for the given user.
// If a client already exists for this user, it is closed and replaced.
func (b *Broker) RegisterClient(userID string) *events.Client {
	b.mu.Lock()
	defer b.mu.Unlock()

	if existing, ok := b.clients[userID]; ok {
		existing.Close()
	}

	client := events.NewClient(userID)
	b.clients[userID] = client
	return client
}

// UnregisterClient removes a client and cleans up its subscriptions.
func (b *Broker) UnregisterClient(userID string) {
	b.mu.Lock()
	defer b.mu.Unlock()

	client, ok := b.clients[userID]
	if !ok {
		return
	}
	client.Close()
	delete(b.clients, userID)

	// Clean up subscriptions for this user.
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
	b.mu.RLock()
	users, ok := b.redisSubs[msg.Channel]
	if !ok {
		b.mu.RUnlock()
		return
	}
	targets := make([]*events.Client, 0, len(users))
	for userID := range users {
		if client, exists := b.clients[userID]; exists {
			targets = append(targets, client)
		}
	}
	b.mu.RUnlock()

	data := []byte(msg.Payload)
	for _, client := range targets {
		client.Send(data)
	}
}

// Close shuts down the broker, closing the Redis subscriber and all clients.
func (b *Broker) Close() error {
	b.cancel()
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, client := range b.clients {
		client.Close()
	}
	return b.subscriber.Close()
}
