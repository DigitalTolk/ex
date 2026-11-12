package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

// refusingImages is an image proxy that refuses every address naming
// "refused", as the real one refuses an image it can't fetch.
type refusingImages struct{}

func (refusingImages) ProxyImageURL(_ context.Context, raw string) string {
	if strings.Contains(raw, "refused") {
		return ""
	}
	return "/api/v1/media/proxied/" + raw
}

func (refusingImages) ProxyImageWithSize(ctx context.Context, raw string) (string, int, int) {
	if u := (refusingImages{}).ProxyImageURL(ctx, raw); u != "" {
		return u, 640, 480
	}
	return "", 0, 0
}

// pickerPeople is the fixture's directory with someone deactivated.
func pickerPeople(f *ixFixture) {
	f.svc.webhooks.SetUserResolver(fakeWebhookUsers{users: []*model.User{
		{ID: "u-1", DisplayName: "Virpal", Email: "virpal@ex.test"},
		{ID: "u-2", DisplayName: "Manisha", Email: "manisha@ex.test"},
		{ID: "u-gone", DisplayName: "Left", Status: "deactivated"},
	}})
}

func TestPickers_AUsersSelectOnACardReachesTheAppAsTheSelectedUser(t *testing.T) {
	f := newIxFixture(t)
	pickerPeople(f)
	ctx := context.Background()
	token, hash := newBotToken()
	f.wh.BotTokenHash = hash
	owner := model.BlockElement{Type: model.ElementUsersSelect, ActionID: "owner", Placeholder: plain("Assign")}
	card := IncomingWebhookPayload{Text: "A3 needs an owner", Blocks: model.Blocks{
		{Type: model.BlockSection, BlockID: "a3", Text: plain("A3: ship forms"), Accessory: &owner},
	}}

	// A picker calls the app, so the webhook URL alone can't post one.
	if _, err := f.svc.webhooks.ExecuteMessage(ctx, "wh", card); !errors.Is(err, ErrBotTokenRequired) {
		t.Fatalf("a picker without the bot token: %v", err)
	}
	card.BotToken = token
	msg, err := f.svc.webhooks.ExecuteMessage(ctx, "wh", card)
	if err != nil || !f.messages.messages["ch1#"+msg.ID].AppButtons {
		t.Fatalf("with the bot token: %+v %v", msg, err)
	}

	// u-1 picks Manisha: the app gets her ID as selected_user.
	res, err := f.msgs.ActWithValue(ctx, "u-1", "ch1", ParentChannel, msg.ID, "a3", "owner", RawValue{"u-2"})
	if err != nil || res.Failed {
		t.Fatalf("pick: %+v %v", res, err)
	}
	if len(f.app.bodies) != 1 {
		t.Fatalf("app got %d requests", len(f.app.bodies))
	}
	p, raw := f.app.got[0], string(f.app.bodies[0])
	if p.Type != "block_actions" || p.User.ID != "u-1" || p.Container.MessageID != msg.ID || p.Container.ViewID != "" || p.Channel == nil || p.Channel.ID != "ch1" || p.Message == nil || p.View != nil {
		t.Fatalf("payload = %+v", p)
	}
	if a := p.Actions[0]; a.Type != model.ElementUsersSelect || a.ActionID != "owner" || a.BlockID != "a3" || a.SelectedUser == nil || *a.SelectedUser != "u-2" || a.Value != "" || a.Text != nil {
		t.Fatalf("action = %+v", a)
	}
	if !strings.Contains(raw, `"selected_user":"u-2"`) || strings.Contains(raw, `"view"`) {
		t.Fatalf("body = %s", raw)
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionClick || e.ActionID != "owner" || e.Result != model.InteractionOK {
		t.Fatalf("history = %+v", e)
	}

	// Someone deactivated, someone unknown, or nobody: refused before the
	// app hears of it.
	for name, pick := range map[string]RawValue{"deactivated": {"u-gone"}, "unknown": {"u-404"}, "nobody": nil, "two people": {"u-1", "u-2"}} {
		_, err := f.msgs.ActWithValue(ctx, "u-1", "ch1", ParentChannel, msg.ID, "a3", "owner", pick)
		if !errors.Is(err, apperr.ErrValidation) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if len(f.app.bodies) != 1 {
		t.Fatalf("a refused pick reached the app: %d requests", len(f.app.bodies))
	}
	_, err = f.msgs.ActWithValue(ctx, "u-1", "ch1", ParentChannel, msg.ID, "a3", "owner", nil)
	if msg, _ := apperr.Message(err, apperr.ErrValidation); msg != "Please choose one." {
		t.Fatalf("an empty single choice: %v", err)
	}
}

func TestPickers_OptionsAreTheStoredElementsNeverTheBrowsers(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	labels := model.BlockElement{Type: model.ElementMultiStaticSelect, ActionID: "labels", Options: opts("bug", "ux", "infra")}
	checks := model.BlockElement{Type: model.ElementCheckboxes, ActionID: "done", Options: opts("tests", "docs")}
	when := model.BlockElement{Type: model.ElementTimepicker, ActionID: "when"}
	menu := model.BlockElement{Type: model.ElementOverflow, ActionID: "more", Options: opts("snooze", "close")}
	m := appMessage()
	m.Blocks = append(m.Blocks, model.Block{Type: model.BlockActions, BlockID: "triage", Elements: []model.BlockElement{labels, checks, when, menu}})
	f.messages.messages["ch1#m1"] = m
	act := func(action string, v RawValue) error {
		_, err := f.msgs.ActWithValue(ctx, "u-1", "ch1", ParentChannel, "m1", "triage", action, v)
		return err
	}

	// A value the stored element doesn't offer is refused.
	if err := act("labels", RawValue{"bug", "security"}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("an option not offered: %v", err)
	}
	if err := act("more", RawValue{"delete"}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("an overflow option not offered: %v", err)
	}
	if err := act("when", RawValue{"9am"}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("not a time: %v", err)
	}
	if len(f.app.bodies) != 0 {
		t.Fatalf("refused picks reached the app: %d", len(f.app.bodies))
	}

	// Picks go with the stored options' own text.
	if err := act("labels", RawValue{"infra", "bug"}); err != nil {
		t.Fatalf("labels: %v", err)
	}
	if a := f.app.got[0].Actions[0]; a.Type != model.ElementMultiStaticSelect || len(a.SelectedOptions) != 2 || a.SelectedOptions[0].Text.Text != "INFRA" || a.SelectedOptions[1].Value != "bug" {
		t.Fatalf("labels action = %+v", a)
	}
	// Unticking every box is a change the app hears of: an empty list.
	if err := act("done", RawValue{}); err != nil {
		t.Fatalf("all unticked: %v", err)
	}
	if a := f.app.got[1].Actions[0]; a.Type != model.ElementCheckboxes || a.SelectedOptions != nil || !strings.Contains(string(f.app.bodies[1]), `"action_id":"done"`) {
		t.Fatalf("unticked action = %+v", a)
	}
	if err := act("when", RawValue{"16:30"}); err != nil {
		t.Fatalf("time: %v", err)
	}
	if a := f.app.got[2].Actions[0]; a.SelectedTime == nil || *a.SelectedTime != "16:30" {
		t.Fatalf("time action = %+v", a)
	}
	if err := act("more", RawValue{"snooze"}); err != nil {
		t.Fatalf("overflow: %v", err)
	}
	if a := f.app.got[3].Actions[0]; a.Type != model.ElementOverflow || a.SelectedOption == nil || a.SelectedOption.Text.Text != "SNOOZE" {
		t.Fatalf("overflow action = %+v", a)
	}
}

func TestPickers_ATextFieldPickIsSentAsItsValue(t *testing.T) {
	// Only forms hold text fields, but the click path reads any value
	// element: a value is sent as "value".
	f := newIxFixture(t)
	action, err := f.svc.actionFor(context.Background(), model.BlockElement{Type: model.ElementEmailInput, ActionID: "mail"}, "b", RawValue{"virpal@ex.test"}, f.svc.pickableUser(context.Background()))
	if err != nil || action.Value != "virpal@ex.test" || action.Type != model.ElementEmailInput || action.BlockID != "b" {
		t.Fatalf("action = %+v %v", action, err)
	}
}

func TestAct_AnImageIsNothingToClick(t *testing.T) {
	f := newIxFixture(t)
	m := appMessage()
	m.Blocks = append(m.Blocks, model.Block{Type: model.BlockSection, BlockID: "pic", Text: plain("chart"),
		Accessory: &model.BlockElement{Type: model.ElementImage, ImageURL: "/api/v1/media/proxied/x", AltText: "chart"}})
	f.messages.messages["ch1#m1"] = m
	_, err := f.msgs.Act(context.Background(), "u-1", "ch1", ParentChannel, "m1", "pic", "")
	if msg, _ := apperr.Message(err, apperr.ErrValidation); msg != "an image isn't something to click" {
		t.Fatalf("image click: %v", err)
	}
	if len(f.app.bodies) != 0 {
		t.Fatal("an image click reached the app")
	}
}

func TestButtonAt_FindsPickersButNotTexts(t *testing.T) {
	sel := model.BlockElement{Type: model.ElementStaticSelect, ActionID: "s", Options: opts("a")}
	m := &model.Message{Blocks: model.Blocks{{Type: model.BlockActions, BlockID: "r", Elements: []model.BlockElement{
		{Type: model.TextPlain, ActionID: "t"}, sel,
	}}}}
	if e, ok := ButtonAt(m, "r", "s"); !ok || e.Type != model.ElementStaticSelect {
		t.Fatalf("picker: %+v %v", e, ok)
	}
	if _, ok := ButtonAt(m, "r", "t"); ok {
		t.Fatal("a text element was found as something to click")
	}
}

func TestHasAppButtons_CountsPickers(t *testing.T) {
	link := model.BlockElement{Type: model.ElementButton, URL: "https://ex.test"}
	img := model.BlockElement{Type: model.ElementImage, ImageURL: "https://img.ex.test/a.png"}
	sel := model.BlockElement{Type: model.ElementStaticSelect}
	for name, tc := range map[string]struct {
		blocks model.Blocks
		want   bool
	}{
		"a link":             {model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{link}}}, false},
		"an image accessory": {model.Blocks{{Type: model.BlockSection, Accessory: &img}}, false},
		"a picker accessory": {model.Blocks{{Type: model.BlockSection, Accessory: &sel}}, true},
		"a picker in a row":  {model.Blocks{{Type: model.BlockActions, Elements: []model.BlockElement{link, sel}}}, true},
	} {
		if got := hasAppButtons(tc.blocks, nil); got != tc.want {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
	}
}

// ---- images

func TestIncomingWebhook_ImagesGoThroughTheProxyAndRefusedOnesAreDropped(t *testing.T) {
	svc, messages := blocksWebhookFixture(nil)
	svc.images = refusingImages{}
	img := func(u string) *model.BlockElement {
		return &model.BlockElement{Type: model.ElementImage, ImageURL: u, AltText: "pic"}
	}
	_, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{
		Blocks: model.Blocks{
			{Type: model.BlockImage, BlockID: "chart", ImageURL: "https://img.ex.test/chart.png", AltText: "Burn-down"},
			{Type: model.BlockImage, BlockID: "gone", ImageURL: "https://img.ex.test/refused.png", AltText: "Lost"},
			{Type: model.BlockSection, BlockID: "s-ok", Text: plain("with a picture"), Accessory: img("https://img.ex.test/thumb.png")},
			{Type: model.BlockSection, BlockID: "s-lost", Text: plain("its picture refused"), Accessory: img("https://img.ex.test/refused-thumb.png")},
			{Type: model.BlockContext, BlockID: "c-mixed", Elements: []model.BlockElement{*img("https://img.ex.test/refused-avatar.png"), *img("https://img.ex.test/avatar.png"), {Type: model.TextPlain, Content: "by Virpal"}}},
			{Type: model.BlockContext, BlockID: "c-lost", Elements: []model.BlockElement{*img("https://img.ex.test/refused-only.png")}},
		},
		Attachments: []model.MessageAttachment{
			{Text: "a card whose only block is lost", Blocks: model.Blocks{{Type: model.BlockImage, BlockID: "card-gone", ImageURL: "https://img.ex.test/refused-card.png", AltText: "x"}}},
			{Text: "a card without blocks"},
			{Blocks: model.Blocks{{Type: model.BlockImage, BlockID: "card-ok", ImageURL: "https://img.ex.test/card.png", AltText: "y"}}},
		},
	})
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	m := onlyStoredMessage(t, messages)
	var ids []string
	for _, b := range m.Blocks {
		ids = append(ids, b.BlockID)
	}
	if strings.Join(ids, ",") != "chart,s-ok,s-lost,c-mixed" {
		t.Fatalf("blocks kept = %v", ids)
	}
	// An image block is measured, so the client can size it before it loads.
	if b := m.Blocks[0]; b.ImageURL != "/api/v1/media/proxied/https://img.ex.test/chart.png" || b.ImageWidth != 640 || b.ImageHeight != 480 {
		t.Fatalf("image block = %+v", b)
	}
	if acc := m.Blocks[1].Accessory; acc == nil || acc.ImageURL != "/api/v1/media/proxied/https://img.ex.test/thumb.png" {
		t.Fatalf("accessory = %+v", acc)
	}
	if m.Blocks[2].Accessory != nil || m.Blocks[2].Text.Text != "its picture refused" {
		t.Fatalf("a refused accessory must go, the section stays: %+v", m.Blocks[2])
	}
	if els := m.Blocks[3].Elements; len(els) != 2 || els[0].ImageURL != "/api/v1/media/proxied/https://img.ex.test/avatar.png" || els[1].Content != "by Virpal" {
		t.Fatalf("context = %+v", els)
	}
	cards := m.MessageAttachments
	if len(cards) != 3 || cards[0].Blocks != nil || cards[1].Blocks != nil || len(cards[2].Blocks) != 1 || cards[2].Blocks[0].ImageURL != "/api/v1/media/proxied/https://img.ex.test/card.png" {
		t.Fatalf("cards = %+v", cards)
	}
	if m.Body != "with a picture\nits picture refused\nby Virpal" {
		t.Fatalf("fallback body = %q", m.Body)
	}
}

func TestIncomingWebhook_AMessageOfOnlyLostImagesKeepsItsText(t *testing.T) {
	svc, messages := blocksWebhookFixture(nil)
	svc.images = refusingImages{}
	if _, err := svc.ExecuteMessage(context.Background(), "wh", IncomingWebhookPayload{Text: "see chart", Blocks: model.Blocks{
		{Type: model.BlockImage, ImageURL: "https://img.ex.test/refused.png", AltText: "chart"},
	}}); err != nil {
		t.Fatalf("post: %v", err)
	}
	if m := onlyStoredMessage(t, messages); m.Blocks != nil || m.Body != "see chart" {
		t.Fatalf("message = %+v", m)
	}
}

func TestClick_AnAnswersImagesGoThroughTheProxy(t *testing.T) {
	f := newIxFixture(t)
	f.svc.webhooks.images = refusingImages{}
	f.app.reply = `{"replace_original":true,"text":"Chart","blocks":[` +
		`{"type":"image","block_id":"ok","image_url":"https://img.ex.test/chart.png","alt_text":"chart"},` +
		`{"type":"image","block_id":"lost","image_url":"https://img.ex.test/refused.png","alt_text":"lost"}]}`
	res, err := f.click("u-1")
	if err != nil || res.Failed {
		t.Fatalf("click: %+v %v", res, err)
	}
	if b := res.Message.Blocks; len(b) != 1 || b[0].BlockID != "ok" || b[0].ImageURL != "/api/v1/media/proxied/https://img.ex.test/chart.png" || b[0].ImageWidth != 640 {
		t.Fatalf("blocks = %+v", b)
	}
}
