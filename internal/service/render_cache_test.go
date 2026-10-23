package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// Regression: the markdown body was re-parsed on every list/thread/pin read,
// and twice per send (the broadcast copy and the response). The hast is
// rendered once per (message, edit) and served from a bounded cache: a later
// read hands back the very tree the send produced.
func TestMessageService_RendersEachMessageVersionOnce(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	svc.SetMarkdownRenderer(NewMarkdownRenderer())
	ctx := context.Background()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}

	sent, err := svc.Send(ctx, "u1", "ch1", ParentChannel, "hello **world**", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	first := sent.Rendered // the fake store hands back the same struct, so keep the pointer
	if first == nil {
		t.Fatal("send returned no rendered body")
	}
	listed, _, err := svc.List(ctx, "u1", "ch1", ParentChannel, "", 10)
	if err != nil || len(listed) != 1 {
		t.Fatalf("List = %v, %v", listed, err)
	}
	if listed[0].Rendered != first {
		t.Fatal("List re-parsed a message the send already rendered")
	}
	if n := svc.renderCache.Len(); n != 1 {
		t.Fatalf("render cache entries = %d, want 1 (send + broadcast + list share one render)", n)
	}

	// An edit is a new version: rendered afresh, from the new body.
	edited, err := svc.Edit(ctx, "u1", "ch1", ParentChannel, sent.ID, "goodbye _world_", nil)
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	second := edited.Rendered
	if second == first || hastText(second) != "goodbye world" {
		t.Fatalf("edited render = %q (reused=%v), want a fresh render of the new body", hastText(second), second == first)
	}
	again, _, _ := svc.List(ctx, "u1", "ch1", ParentChannel, "", 10)
	if again[0].Rendered != second {
		t.Fatal("List re-parsed the edited message")
	}
}

// The cache never serves a tree for a different body, even under the same
// (id, edit) key — e.g. a row rewritten in place without an edit stamp.
func TestMessageService_RenderCacheChecksTheBody(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	svc.SetMarkdownRenderer(NewMarkdownRenderer())
	a := &model.Message{ID: "m1", Body: "first"}
	svc.attachRendered(context.Background(), a)
	b := &model.Message{ID: "m1", Body: "second"}
	svc.attachRendered(context.Background(), b)
	if b.Rendered == a.Rendered {
		t.Fatal("served the render of another body for the same key")
	}
	if got := hastText(b.Rendered); got != "second" {
		t.Fatalf("rendered text = %q, want %q", got, "second")
	}
}

func hastText(n *HastNode) string {
	if n == nil {
		return ""
	}
	out := n.Value
	for _, c := range n.Children {
		out += hastText(c)
	}
	return out
}
