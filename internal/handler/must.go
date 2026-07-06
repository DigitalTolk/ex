package handler

import (
	"fmt"

	"github.com/DigitalTolk/ex/internal/events"
)

// mustEvent unwraps events.NewEvent for payloads composed solely of scalar
// maps (map[string]string / map[string]int) — a marshal failure there would
// be a programmer error, mirroring the must-helpers in store and service.
func mustEvent(evt *events.Event, err error) *events.Event {
	if err != nil {
		panic(fmt.Sprintf("handler: event with a scalar payload failed to build: %v", err))
	}
	return evt
}

// mustJSON unwraps json.Marshal of values that cannot fail (scalar-field
// structs with pre-validated raw payloads).
func mustJSON(b []byte, err error) []byte {
	if err != nil {
		panic(fmt.Sprintf("handler: static value failed to marshal to JSON: %v", err))
	}
	return b
}
