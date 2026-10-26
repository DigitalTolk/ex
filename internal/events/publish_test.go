package events

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

type capturePublisher struct {
	calls atomic.Uint64
	mu    sync.Mutex
	last  *Event
	err   error
}

func (p *capturePublisher) Publish(_ context.Context, _ string, e *Event) error {
	p.calls.Add(1)
	// PublishMany invokes Publish from one goroutine per channel, so guard the
	// shared field against concurrent writes.
	p.mu.Lock()
	p.last = e
	p.mu.Unlock()
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

func TestPublishManySwallowsPublishErrors(t *testing.T) {
	p := &capturePublisher{err: errors.New("redis down")}
	channels := []string{"a", "b", "c"}
	// Errors are logged per channel, never propagated — every channel must
	// still be attempted and the call must return normally.
	PublishMany(context.Background(), p, channels, EventPing, nil)
	if got := p.calls.Load(); got != uint64(len(channels)) {
		t.Fatalf("calls = %d, want %d (a failing channel must not stop the fan-out)", got, len(channels))
	}
}

func TestPublishManyMarshalError(t *testing.T) {
	p := &capturePublisher{}
	PublishMany(context.Background(), p, []string{"a"}, "test", make(chan int))
	if got := p.calls.Load(); got != 0 {
		t.Fatalf("calls = %d, want 0 on marshal error", got)
	}
}

// manyCapturePublisher adds the pipelined ManyPublisher capability.
type manyCapturePublisher struct {
	capturePublisher
	manyCalls    atomic.Uint64
	manyChannels int
	manyErr      error
}

func (p *manyCapturePublisher) PublishMany(_ context.Context, channels []string, e *Event) error {
	p.manyCalls.Add(1)
	p.manyChannels = len(channels)
	p.mu.Lock()
	p.last = e
	p.mu.Unlock()
	return p.manyErr
}

// A capable publisher gets ONE pipelined PublishMany call, never the
// per-channel Publish loop.
func TestPublishManyUsesManyPublisherCapability(t *testing.T) {
	p := &manyCapturePublisher{}
	channels := []string{"a", "b", "c", "d"}
	PublishMany(context.Background(), p, channels, EventPing, map[string]int{"n": 1})
	if got := p.manyCalls.Load(); got != 1 {
		t.Fatalf("PublishMany calls = %d, want 1", got)
	}
	if p.manyChannels != len(channels) {
		t.Fatalf("channels forwarded = %d, want %d", p.manyChannels, len(channels))
	}
	if got := p.calls.Load(); got != 0 {
		t.Fatalf("per-channel Publish calls = %d, want 0 (must not double-publish)", got)
	}
	if p.last.Type != EventPing {
		t.Fatalf("event type = %q, want %q", p.last.Type, EventPing)
	}
}

// A pipelined fan-out failure is logged and swallowed, matching the
// per-channel arm's never-propagate contract.
func TestPublishManyCapabilityErrorSwallowed(t *testing.T) {
	p := &manyCapturePublisher{manyErr: errors.New("redis down")}
	PublishMany(context.Background(), p, []string{"a", "b"}, EventPing, nil)
	if got := p.manyCalls.Load(); got != 1 {
		t.Fatalf("PublishMany calls = %d, want 1", got)
	}
}

// multicastCapturePublisher adds the MulticastPublisher capability on top of
// the pipelined one, so a fall-through to PublishMany is visible.
type multicastCapturePublisher struct {
	manyCapturePublisher
	multicastTopics [][]string
	multicastErr    error
}

func (p *multicastCapturePublisher) PublishMulticast(_ context.Context, topics []string, e *Event) error {
	p.multicastTopics = append(p.multicastTopics, topics)
	p.mu.Lock()
	p.last = e
	p.mu.Unlock()
	return p.multicastErr
}

func TestPublishMulticast(t *testing.T) {
	topics := []string{"chan:a", "conv:b"}

	t.Run("nil publisher and empty topics are no-ops", func(t *testing.T) {
		PublishMulticast(context.Background(), nil, topics, EventPresenceChanged, nil)
		p := &multicastCapturePublisher{}
		PublishMulticast(context.Background(), p, nil, EventPresenceChanged, nil)
		if len(p.multicastTopics) != 0 || p.manyCalls.Load() != 0 || p.calls.Load() != 0 {
			t.Fatal("no topics must publish nothing")
		}
	})

	t.Run("marshal error publishes nothing", func(t *testing.T) {
		p := &multicastCapturePublisher{}
		PublishMulticast(context.Background(), p, topics, "test", make(chan int))
		if len(p.multicastTopics) != 0 {
			t.Fatalf("multicasts = %v, want none", p.multicastTopics)
		}
	})

	t.Run("capability path sends ONE multicast and nothing per topic", func(t *testing.T) {
		p := &multicastCapturePublisher{}
		PublishMulticast(context.Background(), p, topics, EventPresenceChanged, map[string]any{"online": true})
		if len(p.multicastTopics) != 1 || len(p.multicastTopics[0]) != 2 {
			t.Fatalf("multicasts = %v, want one over both topics", p.multicastTopics)
		}
		if p.manyCalls.Load() != 0 || p.calls.Load() != 0 {
			t.Fatal("a multicast must not also go out per topic")
		}
		if p.last.Type != EventPresenceChanged {
			t.Fatalf("event type = %q", p.last.Type)
		}
	})

	t.Run("capability error is logged, not propagated", func(t *testing.T) {
		p := &multicastCapturePublisher{multicastErr: errors.New("redis down")}
		PublishMulticast(context.Background(), p, topics, EventPresenceChanged, nil) // must not panic
		if len(p.multicastTopics) != 1 {
			t.Fatalf("multicasts = %d, want 1", len(p.multicastTopics))
		}
	})

	t.Run("falls back to PublishMany without the capability", func(t *testing.T) {
		p := &manyCapturePublisher{}
		PublishMulticast(context.Background(), p, topics, EventPresenceChanged, nil)
		if p.manyCalls.Load() != 1 || p.manyChannels != 2 {
			t.Fatalf("PublishMany calls = %d over %d channels, want 1 over 2", p.manyCalls.Load(), p.manyChannels)
		}
	})

	t.Run("falls back to a publish per topic on a plain publisher", func(t *testing.T) {
		p := &capturePublisher{}
		PublishMulticast(context.Background(), p, topics, EventPresenceChanged, nil)
		if got := p.calls.Load(); got != 2 {
			t.Fatalf("per-topic publishes = %d, want 2", got)
		}
	})
}

// plainRecorder only has Publish — handing it to PublishEach forces the
// sequential fallback loop.
type plainRecorder struct {
	published []PublishItem
	err       error
}

func (p *plainRecorder) Publish(_ context.Context, ch string, e *Event) error {
	if p.err != nil {
		return p.err
	}
	p.published = append(p.published, PublishItem{Channel: ch, Event: e})
	return nil
}

// recordingEachPublisher captures pipelined batches (the EachPublisher
// capability).
type recordingEachPublisher struct {
	plainRecorder
	batches [][]PublishItem
	err     error
}

func (p *recordingEachPublisher) PublishEach(_ context.Context, items []PublishItem) error {
	p.batches = append(p.batches, items)
	return p.err
}

func TestPublishEach(t *testing.T) {
	evt1, _ := NewEvent(EventNotificationNew, map[string]string{"n": "1"})
	evt2, _ := NewEvent(EventNotificationNew, map[string]string{"n": "2"})
	items := []PublishItem{{Channel: "user:a", Event: evt1}, {Channel: "user:b", Event: evt2}}

	t.Run("nil publisher and empty batch are no-ops", func(t *testing.T) {
		PublishEach(context.Background(), nil, items)
		p := &recordingEachPublisher{}
		PublishEach(context.Background(), p, nil)
		if len(p.batches) != 0 {
			t.Fatalf("empty batch must not publish, got %v", p.batches)
		}
	})

	t.Run("capability path pipelines the whole batch", func(t *testing.T) {
		p := &recordingEachPublisher{}
		PublishEach(context.Background(), p, items)
		if len(p.batches) != 1 || len(p.batches[0]) != 2 {
			t.Fatalf("batches = %v, want one batch of 2", p.batches)
		}
		if len(p.published) != 0 {
			t.Fatalf("capability path must not also publish per item")
		}
	})

	t.Run("capability error is logged, not propagated", func(t *testing.T) {
		p := &recordingEachPublisher{err: errors.New("pipeline down")}
		PublishEach(context.Background(), p, items) // must not panic
	})

	t.Run("fallback loops per item on a plain publisher", func(t *testing.T) {
		p := &plainRecorder{}
		PublishEach(context.Background(), p, items)
		if len(p.published) != 2 {
			t.Fatalf("fallback publishes = %d, want 2", len(p.published))
		}
	})

	t.Run("fallback per-item error is logged, not propagated", func(t *testing.T) {
		p := &plainRecorder{err: errors.New("publish down")}
		PublishEach(context.Background(), p, items) // must not panic
		if len(p.published) != 0 {
			t.Fatalf("failing publisher recorded %d publishes", len(p.published))
		}
	})
}
