package pubsub

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/redis/go-redis/v9"
)

// RecipientResolver resolves a pubsub topic to the set of userIDs
// that should receive the event in their durable inbox.
type RecipientResolver interface {
	Resolve(ctx context.Context, topic string) ([]string, error)
}

// InboxAppender writes a serialized event into users' durable inbox streams.
// AppendMany fans the event out to a batch of recipients in one round-trip.
type InboxAppender interface {
	Append(ctx context.Context, userID string, eventID string, payload []byte) error
	AppendMany(ctx context.Context, userIDs []string, eventID string, payload []byte) error
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
	fanOut   sync.WaitGroup
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
	opts, err := redisx.Options(redisURL)
	if err != nil {
		return nil, err
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
	// Live delivery is the primary contract, so PUBLISH first. The durable inbox
	// fan-out (a member resolve + one XADD per recipient) is a best-effort
	// recovery aid — run it off the publish path in a detached goroutine so a
	// large channel's fan-out never adds latency to every connected client's
	// delivery, nor blocks the message-send request that triggered it.
	if err := ps.client.Publish(ctx, channel, data).Err(); err != nil {
		return fmt.Errorf("redis publish: %w", err)
	}
	if ps.resolver != nil && ps.inbox != nil && event != nil && events.IsPersistent(event.Type) {
		ps.fanOut.Add(1)
		go func() {
			defer ps.fanOut.Done()
			defer safe.Recover()
			ps.appendToInboxes(context.WithoutCancel(ctx), channel, event, data)
		}()
	}
	return nil
}

// PublishMany pipelines one event to many channels in a single round-trip,
// instead of a separate PUBLISH (and round-trip) per channel — used for
// fan-outs like presence transitions that notify every shared-context topic.
// Persistent events still get their per-channel inbox fan-out (detached).
func (ps *RedisPubSub) PublishMany(ctx context.Context, channels []string, event *events.Event) error {
	if len(channels) == 0 {
		return nil
	}
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	pipe := ps.client.Pipeline()
	for _, ch := range channels {
		pipe.Publish(ctx, ch, data)
	}
	_, execErr := pipe.Exec(ctx)
	// Durability is independent of best-effort live delivery: a persistent event
	// must still fan out to every recipient's inbox even if some live PUBLISH in
	// the pipeline failed — otherwise those recipients couldn't replay it on
	// reconnect. So run the inbox fan-out regardless of execErr, then surface it.
	if ps.resolver != nil && ps.inbox != nil && event != nil && events.IsPersistent(event.Type) {
		for _, ch := range channels {
			ps.fanOut.Add(1)
			go func(ch string) {
				defer ps.fanOut.Done()
				defer safe.Recover()
				ps.appendToInboxes(context.WithoutCancel(ctx), ch, event, data)
			}(ch)
		}
	}
	if execErr != nil {
		return fmt.Errorf("redis publish pipeline: %w", execErr)
	}
	return nil
}

// WaitForInboxFanOut blocks until all in-flight inbox fan-outs complete. Used by
// tests (and graceful shutdown) to observe the async appends deterministically.
func (ps *RedisPubSub) WaitForInboxFanOut() { ps.fanOut.Wait() }

// inboxDropper is the optional poison capability of the inbox
// (eventlog.Stream has it): dropping a recipient's stream after a persistent
// append failure forces their next reconnect down the exhausted →
// full-refetch path, so a possible mid-stream hole can never masquerade as a
// complete replay.
type inboxDropper interface {
	Drop(ctx context.Context, userIDs []string) error
}

// inboxAppendRetryInterval / inboxAppendMaxRetries bound the fan-out retry.
// Vars so tests can shrink the interval; the fan-out runs on a detached
// goroutine so brief sleeps here cost the request path nothing.
var (
	inboxAppendRetryInterval = 250 * time.Millisecond
	inboxAppendMaxRetries    = 2
)

// appendToInboxes fans the serialized event out to every recipient's
// per-user inbox stream. Recipients are resolved from the topic; for
// global/ephemeral topics this is a no-op.
//
// Failure policy: a pipeline error may have written SOME recipients' streams
// and not others — a mid-stream hole the ULID replay cursor cannot detect,
// so a reconnecting client would get `replay.done` while silently missing an
// event. Retry the batch (appends are idempotent-enough: a duplicate entry
// is deduped client-side by event ID), and if it still fails, DROP the
// affected streams so every one of those clients takes the exhausted →
// full-refetch path on reconnect. Losing buffered replay beats losing an
// event.
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
	// One pipelined fan-out instead of a goroutine + round-trip per recipient.
	err = ps.inbox.AppendMany(ctx, recipients, event.ID, payload)
	for attempt := 0; err != nil && attempt < inboxAppendMaxRetries; attempt++ {
		time.Sleep(inboxAppendRetryInterval)
		err = ps.inbox.AppendMany(ctx, recipients, event.ID, payload)
	}
	if err == nil {
		return
	}
	slog.Error("pubsub: inbox append failed after retries", "topic", topic, "type", event.Type, "count", len(recipients), "error", err)
	if dropper, ok := ps.inbox.(inboxDropper); ok {
		if derr := dropper.Drop(ctx, recipients); derr != nil {
			slog.Error("pubsub: inbox poison failed — replay may silently skip an event for these recipients",
				"topic", topic, "count", len(recipients), "error", derr)
		}
	}
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

// PublishEach pipelines many DISTINCT events to their channels in a single
// round-trip — the per-recipient notification fan-out (each payload carries
// that recipient's unread count) used to pay one PUBLISH round-trip per
// member. Persistent events still get their detached inbox fan-out per
// channel; live delivery stays best-effort exactly like Publish/PublishMany.
func (ps *RedisPubSub) PublishEach(ctx context.Context, items []events.PublishItem) error {
	if len(items) == 0 {
		return nil
	}
	payloads := make([][]byte, len(items))
	pipe := ps.client.Pipeline()
	for i, it := range items {
		data, err := json.Marshal(it.Event)
		if err != nil {
			return fmt.Errorf("marshal event: %w", err)
		}
		payloads[i] = data
		pipe.Publish(ctx, it.Channel, data)
	}
	_, execErr := pipe.Exec(ctx)
	// Durability is independent of best-effort live delivery (same rationale
	// as PublishMany): persistent events fan out to inboxes regardless.
	for i, it := range items {
		if ps.resolver != nil && ps.inbox != nil && it.Event != nil && events.IsPersistent(it.Event.Type) {
			ps.fanOut.Add(1)
			go func(ch string, evt *events.Event, data []byte) {
				defer ps.fanOut.Done()
				defer safe.Recover()
				ps.appendToInboxes(context.WithoutCancel(ctx), ch, evt, data)
			}(it.Channel, it.Event, payloads[i])
		}
	}
	if execErr != nil {
		return fmt.Errorf("redis publish pipeline: %w", execErr)
	}
	return nil
}
