package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// stubBotHandler satisfies BotHandler for registration; detectBot never calls it.
type stubBotHandler struct{}

func (stubBotHandler) OwnsThread(context.Context, string) bool            { return false }
func (stubBotHandler) Handle(context.Context, BotEvent) (BotReply, error) { return BotReply{}, nil }

// fakeBotDir is a BotDirectory that knows a fixed set of external bots.
type fakeBotDir struct{ known map[string]BotWebhookTarget }

func (f fakeBotDir) WebhookBot(_ context.Context, id string) (BotWebhookTarget, bool) {
	t, ok := f.known[id]
	return t, ok
}

// fakeTriggerIndex is a BotTriggerIndex over a fixed word→bot map.
type fakeTriggerIndex struct {
	words       map[string]triggerEntry
	hasContains bool
}

func (f fakeTriggerIndex) TriggerBot(word string) (string, model.BotTriggerWhen, bool) {
	e, ok := f.words[word]
	return e.botUserID, e.when, ok
}

func (f fakeTriggerIndex) HasContainsTriggers() bool { return f.hasContains }

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

// newTriggerSvc returns a dispatch service with a trigger-word index wired.
func newTriggerSvc(dir BotDirectory, idx BotTriggerIndex) *MessageService {
	s := newDispatchSvc(dir)
	s.SetBotTriggerIndex(idx)
	return s
}

var (
	startsWithIndex = fakeTriggerIndex{words: map[string]triggerEntry{
		"deploy": {botUserID: "bot_ext", when: model.BotTriggerWhenStartsWith},
	}}
	containsIndex = fakeTriggerIndex{
		words:       map[string]triggerEntry{"deploy": {botUserID: "bot_ext", when: model.BotTriggerWhenContains}},
		hasContains: true,
	}
)

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
		triggerWord   string
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

		// --- Trigger words (Mattermost's outgoing-webhook trigger model) ---
		{
			name:          "a leading trigger word dispatches to its external bot",
			svc:           newTriggerSvc(dir, startsWithIndex),
			msg:           &model.Message{Body: "deploy web to prod", AuthorID: "u1"},
			dispatch:      true,
			externalBotID: "bot_ext",
			triggerWord:   "deploy",
		},
		{
			name:          "trailing punctuation still matches the trigger word",
			svc:           newTriggerSvc(dir, startsWithIndex),
			msg:           &model.Message{Body: "deploy: web", AuthorID: "u1"},
			dispatch:      true,
			externalBotID: "bot_ext",
			triggerWord:   "deploy",
		},
		{
			name:          "trigger matching is case-insensitive",
			svc:           newTriggerSvc(dir, startsWithIndex),
			msg:           &model.Message{Body: "Deploy web", AuthorID: "u1"},
			dispatch:      true,
			externalBotID: "bot_ext",
			triggerWord:   "deploy",
		},
		{
			// The default (and MM's) mode is start-of-message only, so an
			// incidental mid-sentence occurrence must not fire a bot.
			name: "a starts-with trigger does NOT fire mid-message",
			svc:  newTriggerSvc(dir, startsWithIndex),
			msg:  &model.Message{Body: "we should deploy web later", AuthorID: "u1"},
		},
		{
			name:          "a contains trigger fires mid-message",
			svc:           newTriggerSvc(dir, containsIndex),
			msg:           &model.Message{Body: "we should deploy web later", AuthorID: "u1"},
			dispatch:      true,
			externalBotID: "bot_ext",
			triggerWord:   "deploy",
		},
		{
			name: "a trigger word inside a code fence does not fire",
			svc:  newTriggerSvc(dir, startsWithIndex),
			msg:  &model.Message{Body: "```\ndeploy web\n```", AuthorID: "u1"},
		},
		{
			// An explicit mention is a direct address; a trigger word is incidental.
			// The mention must win so the prompt is the mention-stripped text.
			name:          "an @mention wins over a trigger word in the same message",
			svc:           newTriggerSvc(dir, containsIndex),
			msg:           &model.Message{Body: "@cliffy deploy web", AuthorID: "u1"},
			dispatch:      true,
			matchedStatic: true,
			staticUserID:  "bot_cliffy",
			staticPrompt:  "deploy web",
		},
		{
			name: "a bot's own message never fires a trigger word (no loops)",
			svc:  newTriggerSvc(dir, startsWithIndex),
			msg:  &model.Message{Body: "deploy web", AuthorID: "bot_ext"},
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
			if d.triggerWord != tc.triggerWord {
				t.Errorf("triggerWord = %q, want %q", d.triggerWord, tc.triggerWord)
			}
			if d.threadReply != tc.threadReply {
				t.Errorf("threadReply = %v, want %v", d.threadReply, tc.threadReply)
			}
		})
	}
}
