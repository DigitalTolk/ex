package model

import (
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
