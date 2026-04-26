package events

import (
	"encoding/json"
	"testing"
)

func TestNewEvent(t *testing.T) {
	type payload struct {
		ID   string `json:"id"`
		Text string `json:"text"`
	}

	data := payload{ID: "1", Text: "hello"}
	ev, err := NewEvent(EventMessageNew, data)
	if err != nil {
		t.Fatalf("NewEvent: %v", err)
	}

	if ev.Type != EventMessageNew {
		t.Errorf("Type = %q, want %q", ev.Type, EventMessageNew)
	}

	var got payload
	if err := json.Unmarshal(ev.Data, &got); err != nil {
		t.Fatalf("unmarshal event data: %v", err)
	}
	if got != data {
		t.Errorf("Data = %+v, want %+v", got, data)
	}
}

func TestNewEventMarshalError(t *testing.T) {
	_, err := NewEvent("test", make(chan int))
	if err == nil {
		t.Fatal("expected error for unmarshable data, got nil")
	}
}
