package events

import (
	"sync"
	"sync/atomic"
)

const eventBufferSize = 256

// Client represents a connected real-time event client (WebSocket).
//
// Events is exposed for select-loop reads but is never closed; consumers must
// also select on Done() to detect disconnect.
type Client struct {
	UserID string
	Events chan []byte
	done   chan struct{}
	once   sync.Once
	drops  atomic.Uint64
}

// NewClient creates a new event client for the given user.
func NewClient(userID string) *Client {
	return &Client{
		UserID: userID,
		Events: make(chan []byte, eventBufferSize),
		done:   make(chan struct{}),
	}
}

// Send performs a non-blocking send of data to the client's event channel.
// If the client is already closed, the send is skipped. If the buffer is full
// the message is dropped and the drop counter incremented (read via DropCount).
func (c *Client) Send(data []byte) {
	select {
	case <-c.done:
		return
	default:
	}
	select {
	case c.Events <- data:
	default:
		c.drops.Add(1)
	}
}

// Close signals the client is disconnected. It is safe to call multiple times.
// The Events channel is intentionally not closed; readers must select on Done().
func (c *Client) Close() {
	c.once.Do(func() {
		close(c.done)
	})
}

// Done returns a channel that is closed when the client is disconnected.
func (c *Client) Done() <-chan struct{} {
	return c.done
}

// DropCount returns the number of events dropped due to a full buffer over
// the lifetime of this client.
func (c *Client) DropCount() uint64 {
	return c.drops.Load()
}
