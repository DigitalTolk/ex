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
		ID:                 "m1",
		ParentID:           "ch1",
		ParentMessageID:    "root", // a reply — must stay linked to its thread
		AuthorID:           "u1",
		Body:               "secret",
		AttachmentIDs:      []string{"a1", "a2"},
		Reactions:          map[string][]string{"👍": {"u1"}},
		Pinned:             true,
		PinnedAt:           &now,
		PinnedBy:           "u2",
		MessageAttachments: []MessageAttachment{{Title: "Build failed"}},
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
	if m.MessageAttachments != nil {
		t.Errorf("MessageAttachments = %v, want nil", m.MessageAttachments)
	}
	// Identity + thread linkage are preserved so replies still resolve their
	// root and the tombstone renders in place.
	if m.ID != "m1" || m.ParentID != "ch1" || m.ParentMessageID != "root" || m.AuthorID != "u1" {
		t.Errorf("identity/linkage not preserved: %+v", m)
	}
	// A soft delete: what the message said stays in the row, out of view.
	kept := m.DeletedContent
	if kept == nil || kept.Body != "secret" || len(kept.AttachmentIDs) != 2 || len(kept.MessageAttachments) != 1 {
		t.Fatalf("DeletedContent = %+v, want the body, attachments and webhook attachments kept", kept)
	}

	// Tombstoning again keeps what the first delete kept.
	m.Tombstone()
	if m.DeletedContent != kept || m.DeletedContent.Body != "secret" {
		t.Errorf("a second tombstone replaced the kept content: %+v", m.DeletedContent)
	}
}

func TestMessage_TombstoneOfAnEmptyMessageKeepsNothing(t *testing.T) {
	m := &Message{ID: "m1"}
	m.Tombstone()
	if !m.Deleted || m.DeletedContent != nil {
		t.Errorf("deleted=%v content=%+v, want deleted with nothing kept", m.Deleted, m.DeletedContent)
	}
}

// The kept content never reaches a client: the API serializes messages as
// JSON, and none of the soft-delete record is in it.
func TestMessage_DeletedContentIsNeverSerialized(t *testing.T) {
	now := time.Now()
	m := &Message{ID: "m1", Body: "secret", AttachmentIDs: []string{"a1"}, MessageAttachments: []MessageAttachment{{Text: "secret too"}}}
	m.Tombstone()
	m.DeletedAt, m.DeletedBy = &now, "u-admin"
	out, err := json.Marshal(m)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, leak := range []string{"secret", "a1", "u-admin", "deletedContent", "deletedAt", "deletedBy"} {
		if strings.Contains(string(out), leak) {
			t.Errorf("JSON %s carries %q", out, leak)
		}
	}
}
