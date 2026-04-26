package handler

import "github.com/DigitalTolk/ex/internal/pubsub"

// brokerAdapter wraps a pubsub.Broker to implement the service.Broker
// interface, which passes a single channel string rather than a slice.
type brokerAdapter struct {
	b *pubsub.Broker
}

// NewBrokerAdapter returns a brokerAdapter that satisfies service.Broker.
func NewBrokerAdapter(b *pubsub.Broker) *brokerAdapter {
	return &brokerAdapter{b: b}
}

func (a *brokerAdapter) Subscribe(clientID, channel string) {
	a.b.Subscribe(clientID, []string{channel})
}

func (a *brokerAdapter) Unsubscribe(clientID, channel string) {
	a.b.Unsubscribe(clientID, []string{channel})
}
