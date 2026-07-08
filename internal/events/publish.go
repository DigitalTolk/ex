package events

import (
	"context"
	"log/slog"
	"sync"

	"github.com/DigitalTolk/ex/internal/safe"
)

// Publisher publishes real-time events to a Redis-backed pub/sub channel.
type Publisher interface {
	Publish(ctx context.Context, channel string, event *Event) error
}

// ManyPublisher is an optional capability: publish one event to many channels
// in a single round-trip (pipelined). Callers type-assert for it and fall back
// to a Publish loop when unavailable.
type ManyPublisher interface {
	PublishMany(ctx context.Context, channels []string, event *Event) error
}

// Member-action labels used as the "action" field on EventMembersChanged payloads.
const (
	MemberActionJoined  = "joined"
	MemberActionLeft    = "left"
	MemberActionAdded   = "added"
	MemberActionRemoved = "removed"
)

// Publish marshals data into an Event and publishes it to a single channel.
// A nil publisher is a no-op so callers can wire publishing optionally.
// Errors are logged but never propagated — event delivery must never break the
// underlying user action.
func Publish(ctx context.Context, p Publisher, channel, eventType string, data any) {
	if p == nil {
		return
	}
	evt, err := NewEvent(eventType, data)
	if err != nil {
		slog.Error("events: marshal", "type", eventType, "error", err)
		return
	}
	if err := p.Publish(ctx, channel, evt); err != nil {
		slog.Error("events: publish", "channel", channel, "type", eventType, "error", err)
	}
}

// PublishMany fans the same event out to many channels. The event is marshaled
// once and reused. Use this for member-list propagation (archive,
// remove-member, group-create, etc.) where one event must reach every member's
// personal channel without serializing N Redis round-trips. When the publisher
// supports it (RedisPubSub does) the fan-out is ONE pipelined round trip;
// otherwise it falls back to a concurrent per-channel publish.
func PublishMany(ctx context.Context, p Publisher, channels []string, eventType string, data any) {
	if p == nil || len(channels) == 0 {
		return
	}
	evt, err := NewEvent(eventType, data)
	if err != nil {
		slog.Error("events: marshal", "type", eventType, "error", err)
		return
	}
	if mp, ok := p.(ManyPublisher); ok {
		if err := mp.PublishMany(ctx, channels, evt); err != nil {
			slog.Error("events: publish many", "channels", len(channels), "type", eventType, "error", err)
		}
		return
	}
	var wg sync.WaitGroup
	wg.Add(len(channels))
	for _, ch := range channels {
		go func(ch string) {
			defer wg.Done()
			defer safe.Recover()
			if err := p.Publish(ctx, ch, evt); err != nil {
				slog.Error("events: publish", "channel", ch, "type", eventType, "error", err)
			}
		}(ch)
	}
	wg.Wait()
}
