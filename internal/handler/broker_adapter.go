package handler

import (
	"context"
	"time"

	"github.com/DigitalTolk/ex/internal/pubsub"
)

// brokerPublishTimeout bounds the control-frame publish a membership change
// makes; the caller's request context may already be gone.
const brokerPublishTimeout = 5 * time.Second

// brokerAdapter wraps a pubsub.Broker to implement the service.Broker
// interface, which passes a single channel string rather than a slice. Every
// change goes to all instances (PublishSubscription): a service call happens
// on whichever instance served the request, not necessarily the one holding
// the user's socket.
type brokerAdapter struct {
	b *pubsub.Broker
}

// NewBrokerAdapter returns a brokerAdapter that satisfies service.Broker.
func NewBrokerAdapter(b *pubsub.Broker) *brokerAdapter {
	return &brokerAdapter{b: b}
}

func (a *brokerAdapter) Subscribe(clientID, channel string) {
	a.publish(clientID, channel, true)
}

func (a *brokerAdapter) Unsubscribe(clientID, channel string) {
	a.publish(clientID, channel, false)
}

func (a *brokerAdapter) publish(clientID, channel string, subscribe bool) {
	ctx, cancel := context.WithTimeout(context.Background(), brokerPublishTimeout)
	defer cancel()
	a.b.PublishSubscription(ctx, clientID, []string{channel}, subscribe)
}
