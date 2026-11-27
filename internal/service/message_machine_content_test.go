package service

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// The size guard: when the mentions would push the stored blocks past their
// cap, the blocks and cards stay as typed and the body still converts.
func TestMessageService_GroupMentionsKeepBlocksWithinTheStoredCap(t *testing.T) {
	svc := NewMessageService(newMockMessageStore(), nil, nil, newMockPublisher(), nil)
	svc.SetUserGroups(&stubUserGroupMentions{})
	blocks := model.Blocks{{Type: model.BlockSection, BlockID: "b1", Text: &model.TextObject{Type: model.TextMarkdown, Text: "@oncall "}}}
	raw, _ := json.Marshal(blocks)
	blocks[0].Text.Text += strings.Repeat("a", maxStoredBlocksBytes-10-len(raw))
	typed := blocks[0].Text.Text
	if err := checkStoredBlocksSize(blocks, nil); err != nil {
		t.Fatalf("setup: the typed blocks must fit: %v", err)
	}

	body := svc.canonicalizeMachineContent(context.Background(), WebhookAuthorID, "@oncall body", blocks, nil)
	if body != "@[group-oncall|oncall] body" {
		t.Fatalf("body = %q, want it converted", body)
	}
	if blocks[0].Text.Text != typed {
		t.Fatal("blocks converted past the stored cap, want them as typed")
	}

	// A body the mention would push past its own cap stays as typed.
	long := strings.Repeat("a", MaxMessageBodyChars-len(" @oncall")) + " @oncall"
	if got := svc.canonicalizeMachineContent(context.Background(), WebhookAuthorID, long, nil, nil); got != long {
		t.Fatal("conversion pushed the body past its cap")
	}
}

// Card text has no cap of its own: a card repeating a handle would grow
// several times over and could no longer be stored. Such cards stay as
// typed, and the post goes through.
func TestIncomingWebhook_CardTextTheMentionsWouldPushPastTheCapStaysAsTyped(t *testing.T) {
	f := newGroupWebhookFixture(t)
	text := strings.Repeat("@oncall ", maxStoredBlocksBytes/len("@oncall ")/2)
	if _, err := f.svc.ExecuteClassic(context.Background(), "classic", IncomingWebhookPayload{
		Text:        "@oncall alert",
		Attachments: []model.MessageAttachment{{Text: text}},
	}); err != nil {
		t.Fatalf("ExecuteClassic: %v", err)
	}
	m := onlyStoredMessage(t, f.messages)
	if m.MessageAttachments[0].Text != text {
		t.Fatal("card text converted past the stored cap, want it as typed")
	}
	if m.Body != f.token+" alert" {
		t.Fatalf("body = %q, want it converted", m.Body)
	}
}
