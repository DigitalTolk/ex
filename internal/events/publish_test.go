package events

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
)

type capturePublisher struct {
	calls atomic.Uint64
	last  *Event
	err   error
}

func (p *capturePublisher) Publish(_ context.Context, _ string, e *Event) error {
	p.calls.Add(1)
	p.last = e
	return p.err
}

func TestPublishNilPublisher(t *testing.T) {
	// Must not panic.
	Publish(context.Background(), nil, "ch", EventMessageNew, map[string]string{"x": "y"})
}

func TestPublish(t *testing.T) {
	p := &capturePublisher{}
	Publish(context.Background(), p, "ch", EventMessageNew, map[string]string{"x": "y"})
	if got := p.calls.Load(); got != 1 {
		t.Fatalf("calls = %d, want 1", got)
	}
	if p.last.Type != EventMessageNew {
		t.Errorf("type = %q, want %q", p.last.Type, EventMessageNew)
	}
}

func TestPublishMarshalError(t *testing.T) {
	p := &capturePublisher{}
	// Channels cannot be marshaled to JSON.
	Publish(context.Background(), p, "ch", "test", make(chan int))
	if got := p.calls.Load(); got != 0 {
		t.Fatalf("calls = %d, want 0 (publish should be skipped on marshal error)", got)
	}
}

func TestPublishSwallowsPublishError(t *testing.T) {
	p := &capturePublisher{err: errors.New("redis down")}
	// Errors are logged, not propagated.
	Publish(context.Background(), p, "ch", EventPing, nil)
	if got := p.calls.Load(); got != 1 {
		t.Fatalf("calls = %d, want 1", got)
	}
}

func TestPublishManyNilPublisher(t *testing.T) {
	PublishMany(context.Background(), nil, []string{"a", "b"}, EventPing, nil)
}

func TestPublishManyEmptyChannels(t *testing.T) {
	p := &capturePublisher{}
	PublishMany(context.Background(), p, nil, EventPing, nil)
	if got := p.calls.Load(); got != 0 {
		t.Fatalf("calls = %d, want 0 for empty channels", got)
	}
}

func TestPublishManyFansOut(t *testing.T) {
	p := &capturePublisher{}
	channels := []string{"a", "b", "c", "d", "e"}
	PublishMany(context.Background(), p, channels, EventPing, map[string]int{"n": 1})
	if got := p.calls.Load(); got != uint64(len(channels)) {
		t.Fatalf("calls = %d, want %d", got, len(channels))
	}
}

func TestPublishManyMarshalError(t *testing.T) {
	p := &capturePublisher{}
	PublishMany(context.Background(), p, []string{"a"}, "test", make(chan int))
	if got := p.calls.Load(); got != 0 {
		t.Fatalf("calls = %d, want 0 on marshal error", got)
	}
}
