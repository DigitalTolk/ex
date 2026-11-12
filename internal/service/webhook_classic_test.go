package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// A classic webhook — every webhook made before rich ones existed — must post
// exactly what it always posted. Rich messages (blocks, app buttons, bot
// tokens, email mentions) belong to rich webhooks alone.

func classicWebhookFixture(users WebhookUserResolver) (*IncomingWebhookService, *mockMessageStore, *fakeWebhookStore) {
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	messages := newMockMessageStore()
	msgSvc := NewMessageService(messages, nil, nil, newMockPublisher(), nil)
	hooks := &fakeWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", ChannelID: ch.ID, Username: "alerts", BotTokenHash: hashBotToken("tok")},
	}}
	svc := NewIncomingWebhookService(hooks,
		fakeWebhookChannels{byID: map[string]*model.Channel{ch.ID: ch}, bySlug: map[string]*model.Channel{ch.Slug: ch}},
		msgSvc, fakeWebhookImageProxy{}, "")
	if users != nil {
		svc.SetUserResolver(users)
	}
	return svc, messages, hooks
}

// Slack-style senders often send blocks next to their text — buttons too.
// A classic webhook posts the text and cards and ignores the blocks: it never
// refuses the post for a button that would call an app.
func TestClassicWebhook_IgnoresBlocksInsteadOfRefusingThePost(t *testing.T) {
	svc, messages, _ := classicWebhookFixture(nil)
	approve := btn("approve", "Approve") // calls an app: a rich webhook would need a bot token
	msg, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
		Text:   "Deploy finished",
		Blocks: model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{approve}}},
		Attachments: []model.MessageAttachment{{
			Title:  "build #42",
			Blocks: model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{approve}}},
		}},
	})
	if err != nil {
		t.Fatalf("classic post with blocks was refused: %v", err)
	}
	stored := onlyStoredMessage(t, messages)
	for _, m := range []*model.Message{msg, stored} {
		if m.Body != "Deploy finished" || len(m.Blocks) != 0 || m.AppButtons {
			t.Fatalf("classic message = body %q, %d blocks, appButtons %v; want the text alone", m.Body, len(m.Blocks), m.AppButtons)
		}
		if len(m.MessageAttachments) != 1 || m.MessageAttachments[0].Title != "build #42" || len(m.MessageAttachments[0].Blocks) != 0 {
			t.Fatalf("classic card = %+v; want the card without its blocks", m.MessageAttachments)
		}
	}
}

// An Authorization header means nothing to a classic webhook: a sender that
// happens to send one (its own token for some other service) still posts.
func TestClassicWebhook_IgnoresAnyBotToken(t *testing.T) {
	svc, messages, _ := classicWebhookFixture(nil)
	for _, token := range []string{"tok", "someone-elses-token"} {
		if _, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{Text: "hi", BotToken: token}); err != nil {
			t.Fatalf("classic post with token %q refused: %v", token, err)
		}
	}
	for _, m := range messages.messages {
		if m.AppButtons {
			t.Fatal("a classic webhook's post must never reach an app")
		}
	}
}

// Blocks alone are not content for a classic webhook — the same refusal as
// before rich webhooks existed.
func TestClassicWebhook_BlocksAloneAreAnEmptyPayload(t *testing.T) {
	svc, _, _ := classicWebhookFixture(nil)
	_, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
		Blocks: model.Blocks{{Type: model.BlockSection, Text: md("only blocks")}},
	})
	if !errors.Is(err, apperr.ErrValidation) || !strings.Contains(err.Error(), "text or attachments required") {
		t.Fatalf("err = %v, want the classic empty-payload refusal", err)
	}
}

// Mentions by email are a rich webhook's; a classic webhook's text reads as it
// always did.
func TestClassicWebhook_HasNoEmailMentions(t *testing.T) {
	users := fakeWebhookUsers{users: []*model.User{{ID: "u-2", Email: "manisha@ex.test"}}, err: errors.New("no name search")}
	text := "ping @manisha@ex.test"

	classic, messages, _ := classicWebhookFixture(users)
	if _, err := classic.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{Text: text}); err != nil {
		t.Fatalf("classic post: %v", err)
	}
	if got := onlyStoredMessage(t, messages).Body; got != text {
		t.Fatalf("classic body = %q, want it as typed", got)
	}

	rich, richMessages := blocksWebhookFixture(users)
	if _, err := rich.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{Text: text}); err != nil {
		t.Fatalf("rich post: %v", err)
	}
	if got := onlyStoredMessage(t, richMessages).Body; got != "ping @[u-2|manisha@ex.test]" {
		t.Fatalf("rich body = %q, want the email mention", got)
	}
}

func TestWebhookCreate_KindIsClassicOrRich(t *testing.T) {
	ctx := context.Background()
	ch := &model.Channel{ID: "ch-1", Name: "General", Slug: "general", Type: model.ChannelTypePublic}
	msgSvc := NewMessageService(newMockMessageStore(), nil, nil, newMockPublisher(), nil)
	svc := NewIncomingWebhookService(&fakeWebhookStore{},
		fakeWebhookChannels{byID: map[string]*model.Channel{ch.ID: ch}, bySlug: map[string]*model.Channel{ch.Slug: ch}},
		msgSvc, fakeWebhookImageProxy{}, "")

	classic, err := svc.Create(ctx, asAdmin("admin-1"), &model.IncomingWebhook{Title: "CI", ChannelID: ch.ID})
	if err != nil || classic.IsRich() {
		t.Fatalf("default create = %+v, %v; want a classic webhook", classic, err)
	}
	rich, err := svc.Create(ctx, asAdmin("admin-1"), &model.IncomingWebhook{Title: "App", ChannelID: ch.ID, Kind: model.WebhookKindRich})
	if err != nil || !rich.IsRich() {
		t.Fatalf("rich create = %+v, %v; want a rich webhook", rich, err)
	}
	if _, err := svc.Create(ctx, asAdmin("admin-1"), &model.IncomingWebhook{Title: "X", ChannelID: ch.ID, Kind: "fancy"}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("unknown kind: err = %v, want invalid", err)
	}
	// The kind never changes: an edit can't turn a webhook into the other.
	edited, err := svc.Update(ctx, asAdmin("admin-1"), rich.ID, &model.IncomingWebhook{Title: "App 2", ChannelID: ch.ID})
	if err != nil || !edited.IsRich() {
		t.Fatalf("edited rich webhook = %+v, %v; want it still rich", edited, err)
	}
	edited, err = svc.Update(ctx, asAdmin("admin-1"), classic.ID, &model.IncomingWebhook{Title: "CI 2", ChannelID: ch.ID, Kind: model.WebhookKindRich})
	if err != nil || edited.IsRich() {
		t.Fatalf("edited classic webhook = %+v, %v; want it still classic", edited, err)
	}
}

// A classic webhook has no interactivity to set up, and even a token left on
// one (from before kinds) never authenticates as an app.
func TestClassicWebhook_HasNoInteractivity(t *testing.T) {
	f := newIxFixture(t)
	f.wh.Kind = ""
	actor := asAdmin("u-1")
	if _, err := f.svc.Status(context.Background(), actor, "wh"); !errors.Is(err, ErrNotRichWebhook) {
		t.Fatalf("status on classic: err = %v, want ErrNotRichWebhook", err)
	}
	if _, _, err := f.svc.RotateBotToken(context.Background(), actor, "wh", false); !errors.Is(err, ErrNotRichWebhook) {
		t.Fatalf("bot token on classic: err = %v, want ErrNotRichWebhook", err)
	}
	f.wh.BotTokenHash, f.wh.SecretVersion = hashBotToken("leftover"), 1
	f.wh.UpdatedAt = time.Now()
	if _, err := f.svc.AuthenticateApp(context.Background(), "leftover"); !errors.Is(err, ErrInvalidAuth) {
		t.Fatalf("classic token authenticated as an app: err = %v", err)
	}
}

// A rich webhook reads the fields a classic one never touches, and refuses
// them — as an invalid payload — when they don't have the shape ex reads.
func TestRichWebhook_ReadsRichOnlyFieldsAndRefusesBadOnes(t *testing.T) {
	decode := func(t *testing.T, body string) IncomingWebhookPayload {
		t.Helper()
		var p IncomingWebhookPayload
		if err := json.Unmarshal([]byte(body), &p); err != nil {
			t.Fatalf("decode %s: %v", body, err)
		}
		return p
	}
	for _, tc := range []struct{ name, body, want string }{
		{"blocks", `{"text":"x","blocks":"nope"}`, "webhook: blocks:"},
		{"card blocks", `{"text":"x","attachments":[{"title":"t","blocks":"nope"}]}`, "attachments[0].blocks"},
		{"template", `{"text":"x","template":5}`, "webhook: template:"},
		{"data", `{"text":"x","template":"t","data":"nope"}`, "webhook: data:"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _ := blocksWebhookFixture(nil)
			_, err := svc.ExecuteMessage(context.Background(), "wh", decode(t, tc.body))
			if !errors.Is(err, ErrInvalidPayload) || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want an invalid payload naming %q", err, tc.want)
			}
		})
	}
	t.Run("well-formed fields are read", func(t *testing.T) {
		svc, messages := blocksWebhookFixture(nil)
		p := decode(t, `{"text":"x","blocks":[{"type":"divider"}],"attachments":[{"title":"t","blocks":[{"type":"divider"}]},{"title":"no blocks"}]}`)
		if _, err := svc.ExecuteMessage(context.Background(), "wh", p); err != nil {
			t.Fatalf("post: %v", err)
		}
		m := onlyStoredMessage(t, messages)
		if len(m.Blocks) != 1 || len(m.MessageAttachments[0].Blocks) != 1 || len(m.MessageAttachments[1].Blocks) != 0 {
			t.Fatalf("message = %+v", m)
		}
	})
	t.Run("a payload built in code keeps its values", func(t *testing.T) {
		p := IncomingWebhookPayload{Template: "t", Data: map[string]any{"a": "b"}}
		if err := p.readRich(); err != nil || p.Template != "t" || p.Data["a"] != "b" {
			t.Fatalf("readRich = %v, %+v", err, p)
		}
	})
}

// A card's icon is a rich webhook's: a classic one posts the card without it,
// exactly as before icons existed.
func TestClassicWebhook_IgnoresCardIcons(t *testing.T) {
	svc, messages, _ := classicWebhookFixture(nil)
	if _, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
		Attachments: []model.MessageAttachment{{Title: "build #42", Icon: "<b>"}},
	}); err != nil {
		t.Fatalf("classic post with a card icon was refused: %v", err)
	}
	if a := onlyStoredMessage(t, messages).MessageAttachments[0]; a.Title != "build #42" || a.Icon != "" {
		t.Fatalf("classic card = %+v; want it without its icon", a)
	}
}

// A rich card's icon is an emoji or an emoji's name; anything else is
// refused, naming the card.
func TestRichWebhook_CardIcons(t *testing.T) {
	for icon, want := range map[string]string{
		"🚀":                  "🚀",
		" 👩🏽‍💻 ":             "👩🏽‍💻",
		"🇸🇪":                 "🇸🇪",
		":Police_Car_Light:": "police_car_light",
		"":                   "",
	} {
		svc, messages := blocksWebhookFixture(nil)
		if _, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
			Attachments: []model.MessageAttachment{{Title: "t", Icon: icon}},
		}); err != nil {
			t.Fatalf("icon %q: %v", icon, err)
		}
		if got := onlyStoredMessage(t, messages).MessageAttachments[0].Icon; got != want {
			t.Errorf("icon %q stored as %q, want %q", icon, got, want)
		}
	}
	for _, icon := range []string{"^", "not an emoji", "🚀 go", "\u202e🚀", "🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀"} {
		svc, _ := blocksWebhookFixture(nil)
		_, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
			Attachments: []model.MessageAttachment{{Title: "t"}, {Title: "t", Icon: icon}},
		})
		if !errors.Is(err, ErrInvalidBlocks) || !strings.Contains(err.Error(), "attachments[1].icon") {
			t.Errorf("icon %q: err = %v, want it refused naming attachments[1].icon", icon, err)
		}
	}
}

// Each kind posts at its own URL — classic /hooks/{id}, rich /hooks/v2/{id}
// — and is refused at the other's, so the classic URL only ever runs the
// classic path.
func TestWebhookURLs_EachKindExecutesOnlyAtItsOwn(t *testing.T) {
	ctx := context.Background()
	classic, classicMessages, _ := classicWebhookFixture(nil)
	rich, richMessages := blocksWebhookFixture(nil)
	payload := IncomingWebhookPayload{Text: "deployed"}

	if _, err := classic.ExecuteClassic(ctx, "wh", payload); err != nil {
		t.Fatalf("classic at its URL: %v", err)
	}
	if _, err := rich.ExecuteRich(ctx, "wh", payload); err != nil {
		t.Fatalf("rich at its URL: %v", err)
	}
	if _, err := rich.ExecuteClassic(ctx, "wh", payload); !errors.Is(err, ErrWrongWebhookURL) || !strings.Contains(err.Error(), "/hooks/v2/") {
		t.Fatalf("rich at the classic URL: err = %v", err)
	}
	if _, err := classic.ExecuteRich(ctx, "wh", payload); !errors.Is(err, ErrWrongWebhookURL) || !strings.Contains(err.Error(), "classic webhook") {
		t.Fatalf("classic at the rich URL: err = %v", err)
	}
	if _, err := classic.ExecuteRich(ctx, "missing", payload); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown webhook: err = %v", err)
	}
	if n, m := len(classicMessages.messages), len(richMessages.messages); n != 1 || m != 1 {
		t.Fatalf("posted %d classic and %d rich messages, want one each", n, m)
	}
}

func TestWebhookURL_RichHasItsOwn(t *testing.T) {
	svc := NewIncomingWebhookService(&fakeWebhookStore{}, fakeWebhookChannels{}, nil, nil, "https://chat.example")
	if got := svc.URL(&model.IncomingWebhook{ID: "c"}); got != "https://chat.example/hooks/c" {
		t.Fatalf("classic URL = %q", got)
	}
	if got := svc.URL(&model.IncomingWebhook{ID: "r", Kind: model.WebhookKindRich}); got != "https://chat.example/hooks/v2/r" {
		t.Fatalf("rich URL = %q", got)
	}
}

// A preview reads the payload as a rich webhook does, so a malformed rich
// field is refused there too.
func TestPreviewMessage_RefusesMalformedRichFields(t *testing.T) {
	svc, _ := blocksWebhookFixture(nil)
	var p IncomingWebhookPayload
	if err := json.Unmarshal([]byte(`{"text":"x","blocks":"nope"}`), &p); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.PreviewMessage(context.Background(), WebhookActor{ID: "u-1", Role: model.SystemRoleMember}, p); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("err = %v, want an invalid payload", err)
	}
}
