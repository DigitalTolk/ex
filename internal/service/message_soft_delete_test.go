package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Deleting a message is a soft delete: the row keeps what it said, who
// deleted it and when, for the root and every reply the cascade closes —
// while readers get only the bare tombstone.
func TestMessageService_DeleteKeepsWhatTheMessageSaid(t *testing.T) {
	svc, messages, memberships, _, pub := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch1#u-admin"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-admin", Role: model.ChannelRoleAdmin}
	messages.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "user-1", Body: "root text", ReplyCount: 1}
	messages.messages["ch1#r1"] = &model.Message{ID: "r1", ParentID: "ch1", AuthorID: "user-2", ParentMessageID: "root", Body: "reply text"}

	before := time.Now()
	if err := svc.Delete(ctx, "u-admin", "ch1", ParentChannel, "root"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	for id, body := range map[string]string{"root": "root text", "r1": "reply text"} {
		m := messages.messages["ch1#"+id]
		if !m.Deleted || m.Body != "" {
			t.Errorf("%s: deleted=%v body=%q, want a bare tombstone", id, m.Deleted, m.Body)
		}
		if m.DeletedContent == nil || m.DeletedContent.Body != body {
			t.Errorf("%s: DeletedContent = %+v, want body %q kept", id, m.DeletedContent, body)
		}
		if m.DeletedBy != "u-admin" || m.DeletedAt == nil || m.DeletedAt.Before(before) {
			t.Errorf("%s: deleted by %q at %v, want u-admin just now", id, m.DeletedBy, m.DeletedAt)
		}
		if m.AuthorID == "" {
			t.Errorf("%s: the author must be kept", id)
		}
	}
	for _, p := range pub.published {
		if strings.Contains(string(p.event.Data), "root text") || strings.Contains(string(p.event.Data), "reply text") {
			t.Errorf("%s event carries the deleted text: %s", p.event.Type, p.event.Data)
		}
	}
}
