package agents

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
)

// Small helpers the agent tests share. They mirror the service package's
// test helpers of the same name (test code is not importable across
// packages).

func strPtr(s string) *string { return &s }

// waitFor polls cond until it holds, failing the test after 5s.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not reached in time")
}

// mockPublisher records every published event.
type mockPublisher struct {
	mu         sync.Mutex
	published  []publishedEvent
	publishErr error
}

type publishedEvent struct {
	channel string
	event   *events.Event
}

func newMockPublisher() *mockPublisher {
	return &mockPublisher{}
}

func (m *mockPublisher) Publish(_ context.Context, channel string, event *events.Event) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.published = append(m.published, publishedEvent{channel: channel, event: event})
	return m.publishErr
}
