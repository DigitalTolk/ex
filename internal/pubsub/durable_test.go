package pubsub

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

// This file holds the in-memory durability fakes shared by the untagged
// guard tests and the integration-tagged durable fan-out suite (which runs
// against a real Redis container).

// fakeResolver lets each test wire a topic → recipients map without
// pulling in the eventlog package's full Resolver type.
type fakeResolver struct {
	m   map[string][]string
	err error
}

func (f *fakeResolver) Resolve(_ context.Context, topic string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.m[topic], nil
}

// captureInbox records each Append call so the test can assert which
// recipients got which payload. failTimes makes the first N AppendMany calls
// fail (transient-blip shape for the retry path); err makes every call fail.
// It also records Drop calls — the poison step after persistent failure.
type captureInbox struct {
	mu        sync.Mutex
	calls     []inboxCall
	err       error
	failTimes int32
	failed    atomic.Int32
	dropped   [][]string
	dropErr   error
}

func (c *captureInbox) Drop(_ context.Context, userIDs []string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.dropped = append(c.dropped, append([]string(nil), userIDs...))
	return c.dropErr
}

type inboxCall struct {
	userID  string
	eventID string
	payload []byte
}

func (c *captureInbox) Append(_ context.Context, userID, eventID string, payload []byte) error {
	if c.err != nil {
		c.failed.Add(1)
		return c.err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([]byte, len(payload))
	copy(cp, payload)
	c.calls = append(c.calls, inboxCall{userID: userID, eventID: eventID, payload: cp})
	return nil
}

func (c *captureInbox) AppendMany(_ context.Context, userIDs []string, eventID string, payload []byte) error {
	if c.err != nil {
		c.failed.Add(1)
		return c.err
	}
	if c.failTimes > 0 && c.failed.Add(1) <= c.failTimes {
		return errors.New("transient inbox failure")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, uid := range userIDs {
		cp := make([]byte, len(payload))
		copy(cp, payload)
		c.calls = append(c.calls, inboxCall{userID: uid, eventID: eventID, payload: cp})
	}
	return nil
}

func (c *captureInbox) seen() []inboxCall {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]inboxCall, len(c.calls))
	copy(out, c.calls)
	return out
}
