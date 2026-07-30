package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// stubBotHandler satisfies BotHandler for registration; detectBot never calls it.
type stubBotHandler struct{}

func (stubBotHandler) OwnsThread(context.Context, string) bool          { return false }
func (stubBotHandler) Handle(context.Context, BotEvent) (string, error) { return "", nil }

// fakeBotDir is a BotDirectory that knows a fixed set of external bots.
type fakeBotDir struct{ known map[string]BotWebhookTarget }

func (f fakeBotDir) WebhookBot(_ context.Context, id string) (BotWebhookTarget, bool) {
	t, ok := f.known[id]
	return t, ok
}

// newDispatchSvc returns a MessageService with an in-process bot "@cliffy"
// registered, and optionally an external-bot directory.
func newDispatchSvc(dir BotDirectory) *MessageService {
	s := &MessageService{}
	s.RegisterBot(BotConfig{UserID: "bot_cliffy", Handle: "cliffy", Username: "Cliffy", Handler: stubBotHandler{}})
	if dir != nil {
		s.SetBotDirectory(dir)
	}
	return s
}

func TestDetectBot(t *testing.T) {
	dir := fakeBotDir{known: map[string]BotWebhookTarget{
		"bot_ext": {URL: "https://bot.example/hook", Name: "Helper"},
	}}

	tests := []struct {
		name string
		svc  *MessageService
		msg  *model.Message
		// expectations
		dispatch      bool
		matchedStatic bool
		staticUserID  string
		staticPrompt  string
		externalBotID string
		threadReply   bool
	}{
		{
			name: "no bots and no directory registered → never dispatch",
			svc:  &MessageService{},
			msg:  &model.Message{Body: "@cliffy hi", AuthorID: "u1"},
		},
		{
			name: "system message is ignored",
			svc:  newDispatchSvc(nil),
			msg:  &model.Message{Body: "@cliffy hi", AuthorID: "u1", System: true},
		},
		{
			name: "a bot's own message never re-dispatches (no loops)",
			svc:  newDispatchSvc(nil),
			msg:  &model.Message{Body: "@cliffy hi", AuthorID: "bot_other"},
		},
		{
			name: "the webhook sentinel is ignored",
			svc:  newDispatchSvc(nil),
			msg:  &model.Message{Body: "@cliffy hi", AuthorID: WebhookAuthorID},
		},
		{
			name: "plain human message with no @ and no thread → early-out",
			svc:  newDispatchSvc(nil),
			msg:  &model.Message{Body: "hello team", AuthorID: "u1"},
		},
		{
			name:          "@cliffy mention dispatches to the in-process bot, mention stripped",
			svc:           newDispatchSvc(nil),
			msg:           &model.Message{Body: "@cliffy make a task", AuthorID: "u1"},
			dispatch:      true,
			matchedStatic: true,
			staticUserID:  "bot_cliffy",
			staticPrompt:  "make a task",
		},
		{
			// The composer emits the rich-mention form; an in-process bot must
			// still dispatch (regression: previously only external webhook bots
			// were resolved from the bracket form, so Cliffy never answered).
			name:          "bracket mention of the in-process bot dispatches (composer form)",
			svc:           newDispatchSvc(nil),
			msg:           &model.Message{Body: "@[bot_cliffy|Cliffy] make a task", AuthorID: "u1"},
			dispatch:      true,
			matchedStatic: true,
			staticUserID:  "bot_cliffy",
			staticPrompt:  "make a task",
		},
		{
			name: "a stray @ that is not a bot mention does not dispatch",
			svc:  newDispatchSvc(nil),
			msg:  &model.Message{Body: "email me @ noon", AuthorID: "u1"},
		},
		{
			name: "a mention inside a code fence is not a mention",
			svc:  newDispatchSvc(nil),
			msg:  &model.Message{Body: "```\n@cliffy\n```", AuthorID: "u1"},
		},
		{
			name:        "a thread reply with no mention still dispatches (ownership resolved later)",
			svc:         newDispatchSvc(nil),
			msg:         &model.Message{ID: "m2", Body: "yes, do it", AuthorID: "u1", ParentMessageID: "root1"},
			dispatch:    true,
			threadReply: true,
		},
		{
			name:          "an external bracket mention dispatches when a directory knows the bot",
			svc:           newDispatchSvc(dir),
			msg:           &model.Message{Body: "@[bot_ext|Helper] status?", AuthorID: "u1"},
			dispatch:      true,
			externalBotID: "bot_ext",
		},
		{
			name: "an external bracket mention does NOT dispatch without a directory",
			svc:  newDispatchSvc(nil),
			msg:  &model.Message{Body: "@[bot_ext|Helper] status?", AuthorID: "u1"},
		},
		{
			// Webhook-only deployment (a directory but no in-process bots):
			// webhook bots don't own threads, so a plain thread reply must NOT
			// spawn a turn — the thread-reply branch is gated on len(bots) > 0.
			name: "a thread reply does NOT dispatch in a webhook-only deployment",
			svc: func() *MessageService {
				s := &MessageService{}
				s.SetBotDirectory(dir)
				return s
			}(),
			msg: &model.Message{ID: "m3", Body: "yes, go", AuthorID: "u1", ParentMessageID: "root9"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := tc.svc.detectBot(tc.msg)
			if d.dispatch != tc.dispatch {
				t.Fatalf("dispatch = %v, want %v", d.dispatch, tc.dispatch)
			}
			if d.matchedStatic != tc.matchedStatic {
				t.Errorf("matchedStatic = %v, want %v", d.matchedStatic, tc.matchedStatic)
			}
			if tc.staticUserID != "" && d.static.UserID != tc.staticUserID {
				t.Errorf("static.UserID = %q, want %q", d.static.UserID, tc.staticUserID)
			}
			if tc.staticPrompt != "" && d.staticPrompt != tc.staticPrompt {
				t.Errorf("staticPrompt = %q, want %q", d.staticPrompt, tc.staticPrompt)
			}
			if d.externalBotID != tc.externalBotID {
				t.Errorf("externalBotID = %q, want %q", d.externalBotID, tc.externalBotID)
			}
			if d.threadReply != tc.threadReply {
				t.Errorf("threadReply = %v, want %v", d.threadReply, tc.threadReply)
			}
		})
	}
}
