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
	ps.fanOutAsync(ctx, []string{channel}, event, data)
	return nil
}

// PublishMany pipelines one event to many channels in a single round-trip,
// instead of a separate PUBLISH (and round-trip) per channel — used for
// fan-outs like member-list propagation to every member's personal topic.
// A persistent event gets ONE inbox fan-out over the union of the channels'
// recipients (detached).
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
	ps.fanOutAsync(ctx, channels, event, data)
	if execErr != nil {
		return fmt.Errorf("redis publish pipeline: %w", execErr)
	}
	return nil
}

// multicastEnvelope is the MulticastTopic frame: one event plus the topics
// whose subscribers it is for.
type multicastEnvelope struct {
	Topics []string        `json:"topics"`
	Event  json.RawMessage `json:"event"`
}

// PublishMulticast delivers ONE event to everyone subscribed to ANY of the
// topics, each connection receiving it once (events.MulticastPublisher).
// PublishMany would send a copy per topic, so a connection sharing k of them
// got k copies — a presence change reached a colleague once per shared
// channel. Here a single frame goes to MulticastTopic, which every broker
// instance listens on; each instance delivers the event to the union of its
// local subscribers of the listed topics. A persistent event gets one inbox
// fan-out over the union of the topics' recipients, run regardless of the
// live PUBLISH outcome (as in PublishMany).
func (ps *RedisPubSub) PublishMulticast(ctx context.Context, topics []string, event *events.Event) error {
	if len(topics) == 0 {
		return nil
	}
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	frame := mustJSON(json.Marshal(multicastEnvelope{Topics: topics, Event: data}))
	pubErr := ps.client.Publish(ctx, MulticastTopic(), frame).Err()
	ps.fanOutAsync(ctx, topics, event, data)
	if pubErr != nil {
		return fmt.Errorf("redis publish multicast: %w", pubErr)
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

// inboxFanOutTimeout bounds one detached inbox fan-out (resolve + appends +
// retry waits), so a wedged store cannot pin its goroutine indefinitely;
// running out is treated like a failed append (the streams are poisoned).
// inboxDropTimeout bounds the poison step, which runs on a fresh context so
// it still happens when the fan-out's own deadline is what ran out.
// inboxAppendRetryInterval / inboxAppendMaxRetries bound the retry. Vars so
// tests can shrink them; the fan-out runs on a detached goroutine, so the
// waits cost the request path nothing.
var (
	inboxFanOutTimeout       = 30 * time.Second
	inboxDropTimeout         = 5 * time.Second
	inboxAppendRetryInterval = 250 * time.Millisecond
	inboxAppendMaxRetries    = 2
)

// fanOutAsync starts the durable inbox fan-out of a persistent event published
// to topics — when durability is wired — on a goroutine detached from the
// request (it must outlive it) but bounded by inboxFanOutTimeout.
func (ps *RedisPubSub) fanOutAsync(ctx context.Context, topics []string, event *events.Event, payload []byte) {
	if ps.resolver == nil || ps.inbox == nil || event == nil || !events.IsPersistent(event.Type) {
		return
	}
	ps.fanOut.Add(1)
	go func() {
		defer ps.fanOut.Done()
		defer safe.Recover()
		fanOutCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), inboxFanOutTimeout)
		defer cancel()
		ps.appendToInboxes(fanOutCtx, topics, event, payload)
	}()
}

// appendToInboxes writes the serialized event to every recipient's per-user
// inbox stream ONCE: recipients are resolved from each topic and de-duplicated,
// so an event addressed to several topics with overlapping audiences is one
// AppendMany (one stored payload) rather than one per topic. Global/ephemeral
// topics resolve to nobody.
//
// Failure policy: a pipeline error may have written SOME recipients' streams
// and not others — a mid-stream hole the ULID replay cursor cannot detect,
// so a reconnecting client would get `replay.done` while silently missing an
// event. Retry the batch (appends are idempotent-enough: a duplicate entry
// is deduped client-side by event ID), and if it still fails — or the
// fan-out's deadline runs out — DROP the affected streams so every one of
// those clients takes the exhausted → full-refetch path on reconnect. Losing
// buffered replay beats losing an event.
func (ps *RedisPubSub) appendToInboxes(ctx context.Context, topics []string, event *events.Event, payload []byte) {
	recipients := ps.resolveRecipients(ctx, topics)
	if len(recipients) == 0 {
		return
	}
	// One pipelined fan-out instead of a goroutine + round-trip per recipient.
	err := ps.inbox.AppendMany(ctx, recipients, event.ID, payload)
	for attempt := 0; err != nil && attempt < inboxAppendMaxRetries; attempt++ {
		if waitErr := sleepCtx(ctx, inboxAppendRetryInterval); waitErr != nil {
			err = fmt.Errorf("%w (retry abandoned: %w)", err, waitErr)
			break
		}
		err = ps.inbox.AppendMany(ctx, recipients, event.ID, payload)
	}
	if err == nil {
		return
	}
	slog.ErrorContext(ctx, "pubsub: inbox append failed after retries", "topics", len(topics), "type", event.Type, "count", len(recipients), "error", err)
	if dropper, ok := ps.inbox.(inboxDropper); ok {
		dropCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), inboxDropTimeout)
		defer cancel()
		if derr := dropper.Drop(dropCtx, recipients); derr != nil {
			slog.ErrorContext(ctx, "pubsub: inbox poison failed — replay may silently skip an event for these recipients",
				"topics", len(topics), "count", len(recipients), "error", derr)
		}
	}
}

// resolveRecipients returns the de-duplicated union of the topics'
// recipients, in first-seen order. A topic that fails to resolve is logged
// and contributes nobody; the others still fan out.
func (ps *RedisPubSub) resolveRecipients(ctx context.Context, topics []string) []string {
	var recipients []string
	seen := make(map[string]bool)
	for _, topic := range topics {
		ids, err := ps.resolver.Resolve(ctx, topic)
		if err != nil {
			slog.ErrorContext(ctx, "pubsub: resolve recipients", "topic", topic, "error", err)
			continue
		}
		for _, id := range ids {
			if !seen[id] {
				seen[id] = true
				recipients = append(recipients, id)
			}
		}
	}
	return recipients
}

// sleepCtx waits d, or returns ctx's error as soon as ctx is done.
func sleepCtx(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
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

// MulticastTopic returns the broker-internal Redis channel that carries
// PublishMulticast frames. Every Broker subscribes to it for the lifetime of
// the instance; no client is ever subscribed to it directly.
func MulticastTopic() string { return "global:multicast" }

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
		ps.fanOutAsync(ctx, []string{it.Channel}, it.Event, payloads[i])
	}
	if execErr != nil {
		return fmt.Errorf("redis publish pipeline: %w", execErr)
	}
	return nil
}
