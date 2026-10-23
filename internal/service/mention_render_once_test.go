package service

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// broadcastPillNames decodes every message frame the publisher saw and returns,
// per message ID, the data-name of its first user-mention pill ("" = no pill).
func broadcastPillNames(t *testing.T, p *mockPublisher) map[string]string {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[string]string{}
	for _, pe := range p.published {
		if pe.event.Type != events.EventMessageNew && pe.event.Type != events.EventMessageEdited {
			continue
		}
		var m model.Message
		if err := json.Unmarshal(pe.event.Data, &m); err != nil {
			t.Fatalf("decode %s frame: %v", pe.event.Type, err)
		}
		name := ""
		if pill := findFirstByTag(m.Rendered, "ex-mention-user"); pill != nil {
			name, _ = pill.Properties["data-name"].(string)
		}
		out[m.ID] = name
	}
	return out
}

// Every write that broadcasts a message and returns it resolves the message's
// mention pills ONCE: the broadcast copy reuses the tree the response carries.
// The broadcast used to render its own copy, so each of these paid for two
// resolver round-trips (and a thread reply three: reply twice, root once).
func TestMessageWritesResolveMentionPillsOnce(t *testing.T) {
	ctx := context.Background()
	const body = "ping @[u-bob|Alice]"
	type write func(t *testing.T, svc *MessageService) *model.Message
	cases := map[string]write{
		"send": func(t *testing.T, svc *MessageService) *model.Message {
			m, err := svc.Send(ctx, "u-alice", "ch-1", ParentChannel, body, "")
			if err != nil {
				t.Fatalf("Send: %v", err)
			}
			return m
		},
		"thread reply": func(t *testing.T, svc *MessageService) *model.Message {
			m, err := svc.Send(ctx, "u-alice", "ch-1", ParentChannel, body, "root")
			if err != nil {
				t.Fatalf("Send reply: %v", err)
			}
			return m
		},
		"webhook": func(t *testing.T, svc *MessageService) *model.Message {
			m, err := svc.SendWebhook(ctx, WebhookMessageInput{ParentID: "ch-1", ParentType: ParentChannel, Body: body})
			if err != nil {
				t.Fatalf("SendWebhook: %v", err)
			}
			return m
		},
		"edit": func(t *testing.T, svc *MessageService) *model.Message {
			m, err := svc.Edit(ctx, "u-alice", "ch-1", ParentChannel, "old", body+" edited", nil)
			if err != nil {
				t.Fatalf("Edit: %v", err)
			}
			return m
		},
		"reaction": func(t *testing.T, svc *MessageService) *model.Message {
			m, err := svc.ToggleReaction(ctx, "u-alice", "ch-1", ParentChannel, "old", "👍")
			if err != nil {
				t.Fatalf("ToggleReaction: %v", err)
			}
			return m
		},
		"pin": func(t *testing.T, svc *MessageService) *model.Message {
			m, err := svc.SetPinned(ctx, "u-alice", "ch-1", ParentChannel, "old", true)
			if err != nil {
				t.Fatalf("SetPinned: %v", err)
			}
			return m
		},
		"dismiss preview": func(t *testing.T, svc *MessageService) *model.Message {
			m, err := svc.SetNoUnfurl(ctx, "u-alice", "ch-1", ParentChannel, "old", true)
			if err != nil {
				t.Fatalf("SetNoUnfurl: %v", err)
			}
			return m
		},
		"agent rewrite": func(t *testing.T, svc *MessageService) *model.Message {
			m, err := svc.RewriteAgentMessage(ctx, "agent-1", "ch-1", ParentChannel, "agent-msg", body+" rewritten")
			if err != nil {
				t.Fatalf("RewriteAgentMessage: %v", err)
			}
			return m
		},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			svc, messages, memberships, _, publisher := setupMessageService()
			svc.SetMarkdownRenderer(NewMarkdownRenderer())
			r := &fakeMentionResolver{names: bobAndGeneral}
			svc.SetMentionResolver(r)
			memberships.memberships["ch-1#u-alice"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-alice", Role: model.ChannelRoleMember}
			messages.messages["ch-1#old"] = &model.Message{ID: "old", ParentID: "ch-1", AuthorID: "u-alice", Body: body}
			messages.messages["ch-1#root"] = &model.Message{ID: "root", ParentID: "ch-1", AuthorID: "u-carol", Body: "root"}
			messages.messages["ch-1#agent-msg"] = &model.Message{ID: "agent-msg", ParentID: "ch-1", AuthorID: "agent-1", AgentInvokerID: "u-alice", Body: "working"}

			got := run(t, svc)

			if r.calls != 1 {
				t.Errorf("resolver calls = %d, want 1", r.calls)
			}
			if got.Rendered == nil {
				t.Fatal("response carries no rendered tree")
			}
			if pill := findFirstByTag(got.Rendered, "ex-mention-user"); pill == nil || pill.Properties["data-name"] != "Bob" {
				t.Errorf("response pill = %+v, want resolved to Bob", pill)
			}
			if name := broadcastPillNames(t, publisher)[got.ID]; name != "Bob" {
				t.Errorf("broadcast pill name = %q, want Bob", name)
			}
		})
	}
}
