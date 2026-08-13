package service

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestBotReply_Empty(t *testing.T) {
	if !(BotReply{}).Empty() {
		t.Error("a zero reply must be empty")
	}
	if !(BotReply{Text: "   "}).Empty() {
		t.Error("whitespace-only text must be empty")
	}
	if (BotReply{Text: "hi"}).Empty() {
		t.Error("text is not empty")
	}
	// Attachments alone are a real reply: a card with no body is a normal thing for
	// an integration to post.
	if (BotReply{Attachments: []model.MessageAttachment{{Text: "card"}}}).Empty() {
		t.Error("attachments alone must count as a reply")
	}
}

// RegisterBot ignores an incomplete registration rather than installing a bot that
// can never fire (or that would panic on dispatch).
func TestRegisterBot_IgnoresIncompleteConfig(t *testing.T) {
	s := &MessageService{}
	s.RegisterBot(BotConfig{UserID: "bot_a", Handle: "a"}) // no handler
	s.RegisterBot(BotConfig{Handle: "a", Handler: stubBotHandler{}})
	s.RegisterBot(BotConfig{UserID: "bot_a", Handler: stubBotHandler{}})
	if len(s.bots) != 0 {
		t.Errorf("registered %d bots, want none", len(s.bots))
	}
}

func TestMatchTriggerWord_Edges(t *testing.T) {
	s := &MessageService{}

	// No index wired → never a match, and no panic on the send path.
	if id, _ := s.matchTriggerWord("deploy now"); id != "" {
		t.Errorf("match without an index = %q, want none", id)
	}

	s.SetBotTriggerIndex(startsWithIndex)
	if id, _ := s.matchTriggerWord("   "); id != "" {
		t.Errorf("match on blank text = %q, want none", id)
	}
	// A token that is nothing but punctuation trims to empty and is skipped rather
	// than looked up.
	if id, _ := s.matchTriggerWord("... deploy"); id != "" {
		t.Errorf("a starts-with trigger fired from position 1: %q", id)
	}

	// In contains mode the scan walks further, but a starts-with trigger found
	// mid-message still must not fire.
	s.SetBotTriggerIndex(fakeTriggerIndex{
		words: map[string]triggerEntry{
			"deploy": {botUserID: "bot_strict", when: model.BotTriggerWhenStartsWith},
			"status": {botUserID: "bot_loose", when: model.BotTriggerWhenContains},
		},
		hasContains: true,
	})
	id, word := s.matchTriggerWord("please deploy and report status")
	if id != "bot_loose" || word != "status" {
		t.Errorf("got (%q, %q), want the contains-trigger match only", id, word)
	}

	// The scan is bounded, so a pasted document can't put unbounded work on the
	// synchronous send path.
	long := strings.Repeat("filler ", botTriggerMaxWordsScanned+10) + "status"
	if id, _ := s.matchTriggerWord(long); id != "" {
		t.Error("a trigger past the scan limit must not fire")
	}
}

func TestClampRunes(t *testing.T) {
	if got := clampRunes("hello", 10); got != "hello" {
		t.Errorf("clampRunes = %q, want unchanged", got)
	}
	// Rune-aware, not byte-aware: truncating multi-byte text by bytes would emit
	// invalid UTF-8 into a message body.
	if got := clampRunes("åäöab", 3); got != "åäö" {
		t.Errorf("clampRunes = %q, want %q", got, "åäö")
	}
}

// --- webhookBotHandler arms ------------------------------------------------

func TestWebhookBotHandler_OwnsThreadIsAlwaysFalse(t *testing.T) {
	// Thread continuity is an in-process concept; a webhook bot fires only on an
	// explicit mention or trigger word.
	var h webhookBotHandler
	if h.OwnsThread(context.Background(), "root1") {
		t.Error("a webhook bot must not claim threads")
	}
}

func TestWebhookBotHandler_ErrorArms(t *testing.T) {
	useLoopbackWebhookClient(t)

	t.Run("an unbuildable request URL fails before dialing", func(t *testing.T) {
		h := webhookBotHandler{target: BotWebhookTarget{URL: "https://exa mple.com/\x7f"}}
		if _, err := h.Handle(context.Background(), BotEvent{}); err == nil {
			t.Fatal("want an error for a malformed URL")
		}
		mm := webhookBotHandler{target: BotWebhookTarget{
			URL: "https://exa mple.com/\x7f", Transport: model.BotTransportMattermost,
		}}
		if _, err := mm.Handle(context.Background(), BotEvent{}); err == nil {
			t.Fatal("want an error for a malformed URL on the MM transport too")
		}
	})

	t.Run("an unreachable endpoint is an error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		srv.Close() // closed → connection refused
		h := webhookBotHandler{target: BotWebhookTarget{URL: srv.URL}}
		if _, err := h.Handle(context.Background(), BotEvent{}); err == nil {
			t.Fatal("want a transport error")
		}
	})

	t.Run("a non-2xx status is an error", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		}))
		defer srv.Close()
		h := webhookBotHandler{target: BotWebhookTarget{URL: srv.URL}}
		if _, err := h.Handle(context.Background(), BotEvent{}); err == nil {
			t.Fatal("want an error for a non-2xx response")
		}
	})

	t.Run("an unsigned event is sent when no secret is configured", func(t *testing.T) {
		var sig string
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			sig = r.Header.Get("X-Ex-Signature")
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()
		h := webhookBotHandler{target: BotWebhookTarget{URL: srv.URL}}
		if _, err := h.Handle(context.Background(), BotEvent{Prompt: "hi"}); err != nil {
			t.Fatalf("Handle: %v", err)
		}
		if sig != "" {
			t.Errorf("X-Ex-Signature = %q, want none without a secret", sig)
		}
	})

	t.Run("an empty body is a valid do-nothing reply", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()
		h := webhookBotHandler{target: BotWebhookTarget{URL: srv.URL}}
		reply, err := h.Handle(context.Background(), BotEvent{Prompt: "hi"})
		if err != nil {
			t.Fatalf("Handle: %v", err)
		}
		if !reply.Empty() {
			t.Errorf("reply = %+v, want an empty reply", reply)
		}
	})
}

func TestValidateCallbackURL_Unparseable(t *testing.T) {
	if err := validateCallbackURL("https://%zz"); !errors.Is(err, ErrInvalidCallbackURL) {
		t.Fatalf("err = %v, want ErrInvalidCallbackURL", err)
	}
}

// A bracket mention of a HUMAN alongside a bot must not confuse the resolver: the
// loop skips non-bot ids and keeps looking.
func TestDetectBot_SkipsHumanBracketMentions(t *testing.T) {
	dir := fakeBotDir{known: map[string]BotWebhookTarget{
		"bot_ext": {URL: "https://bot.example/hook", Name: "Helper"},
	}}
	svc := newDispatchSvc(dir)
	d := svc.detectBot(&model.Message{
		Body:     "@[u-123|Alice] and @[bot_ext|Helper] please look",
		AuthorID: "u1",
	})
	if !d.dispatch || d.externalBotID != "bot_ext" {
		t.Fatalf("detection = %+v, want the bot resolved past the human mention", d)
	}
}
