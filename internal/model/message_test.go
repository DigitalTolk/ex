package model

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestMessage_Tombstone(t *testing.T) {
	now := time.Now()
	m := &Message{
		ID:              "m1",
		ParentID:        "ch1",
		ParentMessageID: "root", // a reply — must stay linked to its thread
		AuthorID:        "u1",
		Body:            "secret",
		AttachmentIDs:   []string{"a1", "a2"},
		Reactions:       map[string][]string{"👍": {"u1"}},
		Pinned:          true,
		PinnedAt:        &now,
		PinnedBy:        "u2",
	}

	m.Tombstone()

	if !m.Deleted {
		t.Error("Deleted should be set")
	}
	if m.Body != "" {
		t.Errorf("Body = %q, want empty", m.Body)
	}
	if m.AttachmentIDs != nil {
		t.Errorf("AttachmentIDs = %v, want nil", m.AttachmentIDs)
	}
	if m.Reactions != nil {
		t.Errorf("Reactions = %v, want nil", m.Reactions)
	}
	if m.Pinned || m.PinnedAt != nil || m.PinnedBy != "" {
		t.Errorf("pin state not cleared: pinned=%v at=%v by=%q", m.Pinned, m.PinnedAt, m.PinnedBy)
	}
	// Identity + thread linkage are preserved so replies still resolve their
	// root and the tombstone renders in place.
	if m.ID != "m1" || m.ParentID != "ch1" || m.ParentMessageID != "root" || m.AuthorID != "u1" {
		t.Errorf("identity/linkage not preserved: %+v", m)
	}
}

// MessageAction is asymmetric on purpose: inbound JSON populates the integration
// (the posting integration supplies it), but the `json:"-"` tag means it is never
// emitted — the URL and context are server-side config that must not reach a
// client. This pins both directions.
func TestMessageActionUnmarshalJSON(t *testing.T) {
	const raw = `{
		"id":"a1","name":"Approve","type":"button","style":"primary","disabled":true,
		"options":[{"text":"Yes","value":"y"}],
		"integration":{"url":"https://hooks.example.com/act","context":{"task":"T-1"}}
	}`
	var action MessageAction
	if err := json.Unmarshal([]byte(raw), &action); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if action.ID != "a1" || action.Name != "Approve" || action.Type != MessageActionTypeButton ||
		action.Style != "primary" || !action.Disabled {
		t.Errorf("action = %+v, want every scalar field read", action)
	}
	if len(action.Options) != 1 || action.Options[0].Value != "y" {
		t.Errorf("options = %+v", action.Options)
	}
	if action.Integration == nil || action.Integration.URL != "https://hooks.example.com/act" ||
		action.Integration.Context["task"] != "T-1" {
		t.Fatalf("integration = %+v, want it read from inbound JSON", action.Integration)
	}

	out, err := json.Marshal(action)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	for _, leaked := range []string{"integration", "hooks.example.com", "T-1"} {
		if strings.Contains(string(out), leaked) {
			t.Errorf("serialized action leaks %q: %s", leaked, out)
		}
	}
}

func TestMessageActionUnmarshalJSON_Malformed(t *testing.T) {
	var action MessageAction
	if err := json.Unmarshal([]byte(`{"id":`), &action); err == nil {
		t.Fatal("want an error for malformed JSON")
	}
	// A wrong type for a known field is also a decode failure, not a silent zero.
	if err := json.Unmarshal([]byte(`{"disabled":"yes"}`), &action); err == nil {
		t.Fatal("want an error for a mistyped field")
	}
}
