package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

// templateFixture is a rich webhook "wh" its owner (an admin) manages.
func templateFixture(t *testing.T) (*IncomingWebhookService, *mockMessageStore, *fakeWebhookStore) {
	t.Helper()
	svc, messages := blocksWebhookFixture(nil)
	return svc, messages, svc.store.(*fakeWebhookStore)
}

func saveTpl(t *testing.T, svc *IncomingWebhookService, key, payload string) {
	t.Helper()
	if _, err := svc.SaveTemplate(context.Background(), asAdmin("u-1"), "wh", key, json.RawMessage(payload)); err != nil {
		t.Fatalf("save %s: %v", key, err)
	}
}

func TestTemplates_SaveReplaceAndDelete(t *testing.T) {
	svc, _, hooks := templateFixture(t)
	ctx := context.Background()
	saveTpl(t, svc, "deploy", `{"text": "Deployed {{version}}"}`)
	wh, err := svc.SaveTemplate(ctx, asAdmin("u-1"), "wh", "deploy", json.RawMessage(`{ "text" : "Shipped {{version}}" }`))
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	if len(wh.Templates) != 1 || string(wh.Templates[0].Payload) != `{"text":"Shipped {{version}}"}` || wh.Templates[0].UpdatedAt.IsZero() {
		t.Fatalf("templates = %+v, want the one template replaced (stored compact)", wh.Templates)
	}
	saveTpl(t, svc, "incident", `{"text": "x"}`)
	wh, err = svc.DeleteTemplate(ctx, asAdmin("u-1"), "wh", "deploy")
	if err != nil || len(wh.Templates) != 1 || wh.Templates[0].Key != "incident" {
		t.Fatalf("after delete: %+v, %v", wh.Templates, err)
	}
	if len(hooks.items["wh"].Templates) != 1 {
		t.Fatalf("stored templates = %+v", hooks.items["wh"].Templates)
	}
	if _, err := svc.DeleteTemplate(ctx, asAdmin("u-1"), "wh", "deploy"); !errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("delete missing: err = %v, want not found", err)
	}
}

func TestTemplates_SaveRefusals(t *testing.T) {
	ctx := context.Background()
	svc, _, hooks := templateFixture(t)
	for _, tc := range []struct {
		name, key, payload, want string
	}{
		{"key", "Deploy!", `{"text":"x"}`, "lowercase letters, digits"},
		{"size", "big", `{"text":"` + strings.Repeat("x", maxTemplateBytes) + `"}`, "at most 16 KB"},
		{"array", "arr", `[1]`, "a JSON object"},
		{"null", "nul", `null`, "a JSON object"},
		{"broken", "bad", `{"text":`, "a JSON object"},
		{"placeholders", "many", `{"text":"` + strings.Repeat("{{a}}", maxTemplatePlaceholds+1) + `"}`, "at most 200 placeholders"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.SaveTemplate(ctx, asAdmin("u-1"), "wh", tc.key, json.RawMessage(tc.payload))
			if !errors.Is(err, apperr.ErrValidation) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
	t.Run("too many", func(t *testing.T) {
		svc, _, _ := templateFixture(t)
		for i := 0; i < maxTemplates; i++ {
			saveTpl(t, svc, fmt.Sprintf("t%d", i), `{"text":"x"}`)
		}
		_, err := svc.SaveTemplate(ctx, asAdmin("u-1"), "wh", "one-more", json.RawMessage(`{"text":"x"}`))
		if !errors.Is(err, apperr.ErrValidation) || !strings.Contains(err.Error(), "at most 10 templates") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("classic webhook", func(t *testing.T) {
		svc, _, _ := classicWebhookFixture(nil)
		_, err := svc.SaveTemplate(ctx, asAdmin("u-1"), "wh", "deploy", json.RawMessage(`{"text":"x"}`))
		if !errors.Is(err, ErrNotRichWebhook) {
			t.Fatalf("err = %v, want not_rich_webhook", err)
		}
		if _, err := svc.DeleteTemplate(ctx, asAdmin("u-1"), "wh", "deploy"); !errors.Is(err, ErrNotRichWebhook) {
			t.Fatalf("delete on classic: err = %v", err)
		}
	})
	t.Run("not the owner", func(t *testing.T) {
		hooks.items["wh"].CreatedBy = "u-owner"
		_, err := svc.SaveTemplate(ctx, asMember("u-other"), "wh", "deploy", json.RawMessage(`{"text":"x"}`))
		if err == nil {
			t.Fatal("a member saved a template on someone else's webhook")
		}
		hooks.items["wh"].CreatedBy = ""
	})
	t.Run("no actor", func(t *testing.T) {
		if _, err := svc.SaveTemplate(ctx, WebhookActor{}, "wh", "deploy", json.RawMessage(`{"text":"x"}`)); err == nil {
			t.Fatal("saved with no actor")
		}
	})
	t.Run("store error", func(t *testing.T) {
		hooks.updateErr = errors.New("dynamo down")
		defer func() { hooks.updateErr = nil }()
		_, err := svc.SaveTemplate(ctx, asAdmin("u-1"), "wh", "deploy", json.RawMessage(`{"text":"x"}`))
		if err == nil || !strings.Contains(err.Error(), "save templates") {
			t.Fatalf("err = %v", err)
		}
	})
}

// A post that names a template is the template, filled from data: values go
// into strings the template holds (never new JSON), a lone "{{x}}" keeps the
// value's type, and the request still says where the post goes.
func TestTemplates_FillOnPost(t *testing.T) {
	svc, messages, _ := templateFixture(t)
	saveTpl(t, svc, "deploy", `{
		"username": "Release bot",
		"text": "{{service}} {{version}} is live ({{tests}} tests, flaky: {{flaky}})",
		"blocks": [
			{"type": "rich_text", "content": [{"type": "paragraph", "spans": [
				{"text": "{{service}}", "bold": true},
				{"type": "date", "timestamp": "{{at}}", "fallback": "today"}
			]}]},
			{"type": "actions", "elements": [{"type": "button", "action_id": "rollback", "text": {"type": "plain_text", "text": "Roll back {{version}}"}}]}
		]
	}`)
	payload := IncomingWebhookPayload{Template: "deploy", Channel: "#general", Data: map[string]any{
		"service": `api", "x": "injected`, "version": "1.42", "tests": float64(1204), "flaky": false, "at": float64(1767254400),
	}}
	// Its buttons call the app, so the filled post needs the bot token.
	if _, err := svc.ExecuteMessage(context.Background(), "wh", payload); !errors.Is(err, ErrBotTokenRequired) {
		t.Fatalf("without token: err = %v, want token_required", err)
	}
	tok := issueToken(t, svc)
	payload.BotToken = tok
	msg, err := svc.ExecuteMessage(context.Background(), "wh", payload)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	if msg.Body != `api", "x": "injected 1.42 is live (1204 tests, flaky: false)` {
		t.Fatalf("body = %q, want the data as text, quotes and all", msg.Body)
	}
	if msg.WebhookUsername != "Release bot" || !msg.AppButtons {
		t.Fatalf("message = %+v", msg)
	}
	spans := msg.Blocks[0].Content[0].Spans
	if spans[0].Text != `api", "x": "injected` || spans[1].Timestamp != 1767254400 {
		t.Fatalf("spans = %+v, want the text filled and the timestamp a number", spans)
	}
	if got := msg.Blocks[1].Elements[0].Text.Text; got != "Roll back 1.42" {
		t.Fatalf("button = %q", got)
	}
	if len(messages.messages) != 1 {
		t.Fatalf("stored %d messages", len(messages.messages))
	}
}

// The request's channel and thread win over the template's.
func TestTemplates_RequestPicksWhereItGoes(t *testing.T) {
	svc, _, _ := templateFixture(t)
	saveTpl(t, svc, "note", `{"text": "{{t}}", "channel": "#elsewhere", "root_id": "r-template"}`)
	filled, err := fillTemplate(svc.store.(*fakeWebhookStore).items["wh"], IncomingWebhookPayload{
		Template: "note", Channel: "#general", RootID: "r-request", BotToken: "tok", Data: map[string]any{"t": "hi"},
	})
	if err != nil {
		t.Fatalf("fill: %v", err)
	}
	if filled.Channel != "#general" || filled.RootID != "r-request" || filled.BotToken != "tok" || filled.Template != "" || filled.Data != nil {
		t.Fatalf("filled = %+v", filled)
	}
	kept, _ := fillTemplate(svc.store.(*fakeWebhookStore).items["wh"], IncomingWebhookPayload{Template: "note", Data: map[string]any{"t": "hi"}})
	if kept.Channel != "#elsewhere" || kept.RootID != "r-template" {
		t.Fatalf("template's own target = %+v", kept)
	}
}

func TestTemplates_FillRefusals(t *testing.T) {
	svc, _, _ := templateFixture(t)
	saveTpl(t, svc, "t", `{"text": "{{a}} and {{b}}"}`)
	saveTpl(t, svc, "whole", `{"text": "x", "blocks": [{"type": "header", "text": {"type": "plain_text", "text": "{{title}}"}}]}`)
	saveTpl(t, svc, "typed", `{"text": "{{n}}"}`)
	saveTpl(t, svc, "list", `{"text": "x", "attachments": [{"title": "{{gone}}"}]}`)
	// 200 placeholders × 4,000 characters of "<", each escaped to six bytes
	// in JSON: far over the 1 MB a filled template may reach.
	saveTpl(t, svc, "huge", `{"text": "`+strings.Repeat("{{v}}", maxTemplatePlaceholds)+`"}`)
	many := map[string]any{}
	for i := 0; i <= maxTemplateData; i++ {
		many[fmt.Sprintf("k%d", i)] = "v"
	}
	for _, tc := range []struct {
		name string
		in   IncomingWebhookPayload
		want string
	}{
		{"unknown", IncomingWebhookPayload{Template: "nope"}, `no template named "nope"`},
		{"too much data", IncomingWebhookPayload{Template: "t", Data: many}, "at most 50 values"},
		{"data name", IncomingWebhookPayload{Template: "t", Data: map[string]any{"a-b": "x"}}, "data names are letters"},
		{"long value", IncomingWebhookPayload{Template: "t", Data: map[string]any{"a": strings.Repeat("x", maxTemplateValueChars+1)}}, "data.a is longer"},
		{"object value", IncomingWebhookPayload{Template: "t", Data: map[string]any{"a": map[string]any{"x": 1}}}, "data.a must be text, a number"},
		{"missing inline", IncomingWebhookPayload{Template: "t", Data: map[string]any{"a": "x"}}, `template "t" needs data.b`},
		{"missing whole", IncomingWebhookPayload{Template: "whole"}, `needs data.title`},
		{"missing in a list", IncomingWebhookPayload{Template: "list"}, `needs data.gone`},
		{"wrong type", IncomingWebhookPayload{Template: "typed", Data: map[string]any{"n": float64(5)}}, `filled isn't a valid message`},
		{"too big", IncomingWebhookPayload{Template: "huge", Data: map[string]any{"v": strings.Repeat("<", maxTemplateValueChars)}}, "filled is over 1 MB"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := svc.ExecuteMessage(context.Background(), "wh", tc.in)
			if !errors.Is(err, apperr.ErrValidation) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

// A classic webhook has no templates: the fields are ignored like blocks.
func TestTemplates_ClassicIgnoresThem(t *testing.T) {
	svc, messages, _ := classicWebhookFixture(nil)
	if _, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{Text: "plain", Template: "deploy", Data: map[string]any{"a": "b"}}); err != nil {
		t.Fatalf("post: %v", err)
	}
	if got := onlyStoredMessage(t, messages).Body; got != "plain" {
		t.Fatalf("body = %q", got)
	}
}

// issueToken gives the fixture's webhook a bot token and returns it.
func issueToken(t *testing.T, svc *IncomingWebhookService) string {
	t.Helper()
	token, hash := newBotToken()
	svc.store.(*fakeWebhookStore).items["wh"].BotTokenHash = hash
	return token
}

var _ = model.MessageTemplate{}
