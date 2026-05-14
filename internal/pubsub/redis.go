package pubsub

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/redis/go-redis/v9"
)

// RecipientResolver resolves a pubsub topic to the set of userIDs
// that should receive the event in their durable inbox.
type RecipientResolver interface {
	Resolve(ctx context.Context, topic string) ([]string, error)
}

// InboxAppender writes a serialized event into a single user's
// durable inbox stream.
type InboxAppender interface {
	Append(ctx context.Context, userID string, eventID string, payload []byte) error
}

// RedisPubSub wraps a Redis client for publishing real-time events to channels.
//
// When a Resolver + Inbox are configured, persistent events are also
// appended to each recipient's per-user inbox stream so they can be
// replayed on a WebSocket reconnect. The live pub/sub path is
// unchanged either way — durability is a parallel write, not a
// replacement.
type RedisPubSub struct {
	client   *redis.Client
	resolver RecipientResolver
	inbox    InboxAppender
}

// SetDurability wires the recipient resolver and inbox writer used to
// fan out persistent events into per-user durable streams. Either
// argument may be nil — without both, Publish degrades to the
// pre-replay behaviour (live pub/sub only).
func (ps *RedisPubSub) SetDurability(resolver RecipientResolver, inbox InboxAppender) {
	ps.resolver = resolver
	ps.inbox = inbox
}

// NewRedisPubSub parses the Redis URL, creates a client, and verifies connectivity.
func NewRedisPubSub(redisURL string) (*RedisPubSub, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}

	client := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	return &RedisPubSub{client: client}, nil
}

// Publish marshals the event to JSON and publishes it to the given Redis channel.
//
// When durability is configured and the event type is persistent, the
// same payload is also appended to each recipient's inbox stream
// (resolved from the topic). Inbox failures are logged but never fail
// the publish — live delivery is the primary contract; replay is a
// best-effort recovery aid layered on top.
func (ps *RedisPubSub) Publish(ctx context.Context, channel string, event *events.Event) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	ps.appendToInboxes(ctx, channel, event, data)
	if err := ps.client.Publish(ctx, channel, data).Err(); err != nil {
		return fmt.Errorf("redis publish: %w", err)
	}
	return nil
}

// appendToInboxes fans the serialized event out to every recipient's
// per-user inbox stream. Recipients are resolved from the topic; for
// global/ephemeral topics this is a no-op. Writes happen in parallel
// so a slow Redis on one entry doesn't serialize the whole fan-out;
// errors are logged but never propagated.
func (ps *RedisPubSub) appendToInboxes(ctx context.Context, topic string, event *events.Event, payload []byte) {
	if ps.resolver == nil || ps.inbox == nil {
		return
	}
	if event == nil || !events.IsPersistent(event.Type) {
		return
	}
	recipients, err := ps.resolver.Resolve(ctx, topic)
	if err != nil {
		slog.Error("pubsub: resolve recipients", "topic", topic, "error", err)
		return
	}
	if len(recipients) == 0 {
		return
	}
	var wg sync.WaitGroup
	wg.Add(len(recipients))
	for _, userID := range recipients {
		go func(uid string) {
			defer wg.Done()
			if err := ps.inbox.Append(ctx, uid, event.ID, payload); err != nil {
				slog.Error("pubsub: inbox append", "userID", uid, "topic", topic, "type", event.Type, "error", err)
			}
		}(userID)
	}
	wg.Wait()
}

// Inbox exposes the underlying inbox appender so handlers (e.g. the
// WebSocket replay path) can read from the same store the publisher
// writes to without re-plumbing dependencies.
func (ps *RedisPubSub) Inbox() InboxAppender { return ps.inbox }

// ChannelName returns the Redis pub/sub channel name for a chat channel.
func ChannelName(channelID string) string {
	return "chan:" + channelID
}

// ConversationName returns the Redis pub/sub channel name for a conversation.
func ConversationName(convID string) string {
	return "conv:" + convID
}

// UserChannel returns the Redis pub/sub channel name for a user's personal channel.
func UserChannel(userID string) string {
	return "user:" + userID
}

// GlobalChannelEvents returns the Redis pub/sub channel name for global channel
// events (e.g. channel.new) that all connected users should receive.
func GlobalChannelEvents() string { return "global:channels" }

// GlobalEmojiEvents returns the Redis pub/sub channel name for global emoji
// catalog updates (emoji added/removed) seen by all connected users.
func GlobalEmojiEvents() string { return "global:emojis" }

// PresenceEvents returns the Redis pub/sub channel name for online/offline
// presence broadcasts seen by all connected users.
func PresenceEvents() string { return "global:presence" }

// UserEvents returns the Redis pub/sub channel name for global user-profile
// updates (user.updated events).
func UserEvents() string { return "global:users" }

// Client returns the underlying Redis client.
func (ps *RedisPubSub) Client() *redis.Client {
	return ps.client
}
