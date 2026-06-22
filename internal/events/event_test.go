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

// Every event must carry a non-empty ULID and millisecond timestamp.
// These are the cursor/dedup primitives the WS reconnect replay
// relies on; an unstamped event would silently break replay for any
// client that reaches it.
func TestNewEvent_StampsIDAndTimestamp(t *testing.T) {
	a, err := NewEvent(EventMessageNew, map[string]string{"k": "v"})
	if err != nil {
		t.Fatalf("NewEvent a: %v", err)
	}
	b, err := NewEvent(EventMessageNew, map[string]string{"k": "v"})
	if err != nil {
		t.Fatalf("NewEvent b: %v", err)
	}
	if a.ID == "" || b.ID == "" {
		t.Fatalf("expected non-empty IDs, got %q and %q", a.ID, b.ID)
	}
	if a.ID == b.ID {
		t.Fatalf("expected unique IDs, both = %q", a.ID)
	}
	// ULIDs sort lexicographically by time — back-to-back NewEvent
	// calls must produce strictly ordered IDs so client cursor
	// comparisons (id > since) work as expected.
	if a.ID >= b.ID {
		t.Errorf("expected b.ID > a.ID (time-ordered), got a=%q b=%q", a.ID, b.ID)
	}
	if a.Ts == 0 || b.Ts == 0 {
		t.Errorf("expected non-zero Ts on both events, got a=%d b=%d", a.Ts, b.Ts)
	}
	if b.Ts < a.Ts {
		t.Errorf("expected b.Ts >= a.Ts, got a=%d b=%d", a.Ts, b.Ts)
	}
}

// Persistent events go into the per-user inbox for replay on
// reconnect; ephemeral events (typing, ping, presence, etc.) skip
// the inbox because either they're superseded by the next live frame
// or they're one-shot signals.
func TestIsPersistent(t *testing.T) {
	cases := []struct {
		eventType string
		want      bool
	}{
		{EventMessageNew, true},
		{EventMessageEdited, true},
		{EventMembersChanged, true},
		// notification.new is ephemeral: a toast must not replay on reconnect.
		{EventNotificationNew, false},
		{EventDraftUpdated, true},
		{EventTyping, false},
		{EventPing, false},
		{EventPresenceChanged, false},
		{EventServerVersion, false},
		{EventForceLogout, false},
		{EventReplayDone, false},
		{EventReplayExhausted, false},
	}
	for _, tc := range cases {
		if got := IsPersistent(tc.eventType); got != tc.want {
			t.Errorf("IsPersistent(%q) = %v, want %v", tc.eventType, got, tc.want)
		}
	}
}
