package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// ---- helpers

// standupForm is MeetingMind's stand-up form: a note, a text field, a date
// and an optional select.
func standupForm() model.View {
	return model.View{
		Type: model.ViewModal, CallbackID: "standup", PrivateMetadata: "m_8f2c", ExternalID: "standup-u1",
		Title:  model.TextObject{Type: model.TextPlain, Text: "Stand-up"},
		Submit: plain("Send"),
		Blocks: model.Blocks{
			{Type: model.BlockSection, Text: md("What did you **do**?")},
			{Type: model.BlockInput, BlockID: "did", Label: plain("Yesterday"), Element: &model.BlockElement{Type: model.ElementPlainTextInput, ActionID: "text", Multiline: true, MinLength: 3, MaxLength: 20}},
			{Type: model.BlockInput, BlockID: "due", Label: plain("Due"), Element: &model.BlockElement{Type: model.ElementDatepicker}},
			{Type: model.BlockInput, BlockID: "mood", Label: plain("Mood"), Optional: true, Element: &model.BlockElement{Type: model.ElementStaticSelect, ActionID: "pick",
				Options: []model.SelectOption{{Text: *md("**Good**"), Value: "good"}, {Text: *plain("Meh"), Value: "meh"}}}},
		},
	}
}

// standupAnswers is a complete, valid submission of standupForm, as the
// browser sends it: each field's raw value under its block and action.
func standupAnswers() map[string]map[string]RawValue {
	return map[string]map[string]RawValue{"did": {"text": {"Shipped forms"}}, "due": {"value": {"2026-10-23"}}, "mood": {"pick": {"good"}}}
}

// triggerFrom clicks MeetingMind's card as userID from browser tab "tab-1"
// and returns the trigger_id the app was sent with the click.
func (f *ixFixture) triggerFrom(t *testing.T, userID string) string {
	t.Helper()
	ctx := WithClickID(context.Background(), "tab-1")
	if _, err := f.msgs.Act(ctx, userID, "ch1", ParentChannel, "m1", "b1", "use_date"); err != nil {
		t.Fatalf("click: %v", err)
	}
	trigger := f.app.got[len(f.app.got)-1].TriggerID
	if !strings.HasPrefix(trigger, "t_") {
		t.Fatalf("the click carried no trigger_id: %q", trigger)
	}
	return trigger
}

// openForm opens standupForm for userID the way an app does: a click, then
// views.open with the click's trigger_id.
func (f *ixFixture) openForm(t *testing.T, userID string) *model.View {
	t.Helper()
	v, err := f.svc.OpenView(context.Background(), f.wh, f.triggerFrom(t, userID), standupForm())
	if err != nil {
		t.Fatalf("open view: %v", err)
	}
	return v
}

// lastSubmission is the last view_submission the app received.
func (f *ixFixture) lastSubmission(t *testing.T) (viewSubmissionPayload, string) {
	t.Helper()
	raw := f.app.bodies[len(f.app.bodies)-1]
	var p viewSubmissionPayload
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatalf("submission body: %v", err)
	}
	return p, string(raw)
}

// viewEvents are the form events published, with where they went.
func (f *ixFixture) viewEvents(t *testing.T, eventType string) ([]ViewEvent, []string) {
	t.Helper()
	f.pub.mu.Lock()
	defer f.pub.mu.Unlock()
	var out []ViewEvent
	var channels []string
	for _, p := range f.pub.published {
		if p.event.Type != eventType {
			continue
		}
		var ev ViewEvent
		if err := json.Unmarshal(p.event.Data, &ev); err != nil {
			t.Fatalf("%s data: %v", eventType, err)
		}
		out = append(out, ev)
		channels = append(channels, p.channel)
	}
	return out, channels
}

// ---- views.open

func TestOpenView_TheClickersTriggerOpensTheFormInTheTabThatClicked(t *testing.T) {
	f := newIxFixture(t)
	f.messages.messages["ch1#m1"].WebhookIconEmoji = "calendar"
	f.wh.ProfileImageURL = "https://img.ex.test/mm.png"

	v := f.openForm(t, "u-1")
	if !strings.HasPrefix(v.ID, "V") || v.Hash == "" || v.CallbackID != "standup" || v.ExternalID != "standup-u1" {
		t.Fatalf("view = %+v", v)
	}
	// The form is kept as ex normalized it: a default close label, the
	// note's markdown read as ex markdown, the date field named "value".
	if v.Close == nil || v.Close.Text != "Cancel" || v.Blocks[0].Text.Type != model.TextMarkdown || v.Blocks[2].Element.ActionID != "value" {
		t.Fatalf("normalized = %+v", v)
	}
	sv := f.state.views[v.ID]
	if sv == nil || sv.UserID != "u-1" || sv.WebhookID != "wh" || sv.ClickID != "tab-1" || sv.IconEmoji != "calendar" || sv.View.Hash != v.Hash {
		t.Fatalf("stored = %+v", sv)
	}
	if f.state.externals["wh:standup-u1"] != v.ID {
		t.Fatalf("external id not findable: %v", f.state.externals)
	}
	opened, channels := f.viewEvents(t, events.EventViewOpened)
	if len(opened) != 1 || channels[0] != pubsub.UserChannel("u-1") {
		t.Fatalf("view.opened sent to %v", channels)
	}
	if ev := opened[0]; ev.ClickID != "tab-1" || ev.View.ID != v.ID || ev.App != (ViewApp{Name: "MeetingMind", AvatarURL: "https://img.ex.test/mm.png", IconEmoji: "calendar"}) {
		t.Fatalf("view.opened = %+v", ev)
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionAPI || e.ActionID != "views.open" || e.UserID != "u-1" || e.Result != model.InteractionOK {
		t.Fatalf("history = %+v", e)
	}
}

func TestOpenView_ATriggerIsGoodOnceAndOnlyForTheAppClicked(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()

	trigger := f.triggerFrom(t, "u-1")
	if _, err := f.svc.OpenView(ctx, f.wh, trigger, standupForm()); err != nil {
		t.Fatalf("first use: %v", err)
	}
	if _, err := f.svc.OpenView(ctx, f.wh, trigger, standupForm()); !errors.Is(err, ErrTriggerExpired) {
		t.Fatalf("second use: %v", err)
	}
	other := &model.IncomingWebhook{ID: "wh2", Title: "Other", Kind: model.WebhookKindRich}
	f.hooks.items["wh2"] = other
	if _, err := f.svc.OpenView(ctx, other, f.triggerFrom(t, "u-1"), standupForm()); !errors.Is(err, ErrTriggerExpired) {
		t.Fatalf("another app's trigger: %v", err)
	}
	if e := f.state.lastEntry("wh2"); e.ActionID != "views.open" || e.Result != model.InteractionFailed || e.UserID != "" || !strings.Contains(e.Error, "expired") {
		t.Fatalf("history = %+v", e)
	}
	if _, err := f.svc.OpenView(ctx, f.wh, "t_made_up", standupForm()); !errors.Is(err, ErrTriggerExpired) {
		t.Fatalf("made-up trigger: %v", err)
	}
	if opened, _ := f.viewEvents(t, events.EventViewOpened); len(opened) != 1 {
		t.Fatalf("only the first use opens a form, got %d", len(opened))
	}
}

func TestOpenView_Refusals(t *testing.T) {
	ctx := context.Background()

	t.Run("a paused app opens nothing", func(t *testing.T) {
		f := newIxFixture(t)
		trigger := f.triggerFrom(t, "u-1")
		f.wh.AdminPaused = true
		if _, err := f.svc.OpenView(ctx, f.wh, trigger, standupForm()); !errors.Is(err, ErrAppUnavailable) {
			t.Fatalf("paused: %v", err)
		}
	})
	t.Run("an invalid form is refused and the trigger spent", func(t *testing.T) {
		f := newIxFixture(t)
		bad := standupForm()
		bad.Type = "home"
		if _, err := f.svc.OpenView(ctx, f.wh, f.triggerFrom(t, "u-1"), bad); !errors.Is(err, ErrInvalidView) {
			t.Fatalf("invalid: %v", err)
		}
		if len(f.state.views) != 0 {
			t.Fatalf("an invalid form was stored: %v", f.state.views)
		}
	})
	t.Run("state failures are errors, not expired triggers", func(t *testing.T) {
		f := newIxFixture(t)
		trigger := f.triggerFrom(t, "u-1")
		f.state.saveViewErr = errors.New("redis down")
		if _, err := f.svc.OpenView(ctx, f.wh, trigger, standupForm()); err == nil || errors.Is(err, ErrTriggerExpired) {
			t.Fatalf("save failure: %v", err)
		}
		if opened, _ := f.viewEvents(t, events.EventViewOpened); len(opened) != 0 {
			t.Fatal("an unsaved form must not open")
		}
		f.state.triggerErr = errors.New("redis down")
		if _, err := f.svc.OpenView(ctx, f.wh, "t_any", standupForm()); err == nil || errors.Is(err, ErrTriggerExpired) {
			t.Fatalf("trigger failure: %v", err)
		}
	})
}

func TestClick_WithoutTriggerStateTheClickStillGoesThrough(t *testing.T) {
	f := newIxFixture(t)
	f.state.triggerErr = errors.New("redis down")
	if _, err := f.click("u-1"); err != nil {
		t.Fatalf("click: %v", err)
	}
	if p := f.app.got[0]; p.TriggerID != "" || p.ResponseURL == "" {
		t.Fatalf("trigger %q, response url %q", p.TriggerID, p.ResponseURL)
	}
}

func TestClick_TriggerRemembersNoTabWhenTheClickNamedNone(t *testing.T) {
	f := newIxFixture(t)
	if _, err := f.click("u-1"); err != nil {
		t.Fatalf("click: %v", err)
	}
	v, err := f.svc.OpenView(context.Background(), f.wh, f.app.got[0].TriggerID, standupForm())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if sv := f.state.views[v.ID]; sv.ClickID != "" || sv.UserID != "u-1" {
		t.Fatalf("stored = %+v", sv)
	}
}

// ---- views.update

func TestUpdateView_ByIDOrExternalIDWithTheHashGuard(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	v := f.openForm(t, "u-1")

	next := standupForm()
	next.ExternalID = "" // keeps the form's external_id
	next.Title.Text = "Stand-up (2/2)"
	got, err := f.svc.UpdateView(ctx, f.wh, v.ID, "", v.Hash, next)
	if err != nil || got.ID != v.ID || got.Hash == v.Hash || got.Title.Text != "Stand-up (2/2)" || got.ExternalID != "standup-u1" {
		t.Fatalf("update: %+v %v", got, err)
	}
	if sv := f.state.views[v.ID]; sv.View.Hash != got.Hash || sv.UserID != "u-1" || sv.ClickID != "tab-1" {
		t.Fatalf("stored = %+v", sv)
	}
	updated, channels := f.viewEvents(t, events.EventViewUpdated)
	if len(updated) != 1 || channels[0] != pubsub.UserChannel("u-1") || updated[0].ClickID != "tab-1" || updated[0].View.Hash != got.Hash {
		t.Fatalf("view.updated = %+v to %v", updated, channels)
	}
	if e := f.state.lastEntry("wh"); e.ActionID != "views.update" || e.UserID != "u-1" || e.Result != model.InteractionOK {
		t.Fatalf("history = %+v", e)
	}

	// The first hash is stale now: two updates can't overwrite each other.
	if _, err := f.svc.UpdateView(ctx, f.wh, v.ID, "", v.Hash, next); !errors.Is(err, ErrHashConflict) {
		t.Fatalf("stale hash: %v", err)
	}
	if e := f.state.lastEntry("wh"); e.Result != model.InteractionFailed || e.UserID != "u-1" {
		t.Fatalf("history = %+v", e)
	}

	// By external_id, no hash; a new external_id replaces the old one.
	renamed := standupForm()
	renamed.ExternalID = "standup-u1-final"
	got, err = f.svc.UpdateView(ctx, f.wh, "", "standup-u1", "", renamed)
	if err != nil || got.ID != v.ID || got.ExternalID != "standup-u1-final" {
		t.Fatalf("by external id: %+v %v", got, err)
	}
	if _, old := f.state.externals["wh:standup-u1"]; old || f.state.externals["wh:standup-u1-final"] != v.ID {
		t.Fatalf("externals = %v", f.state.externals)
	}
	if _, err := f.svc.UpdateView(ctx, f.wh, "", "standup-u1", "", renamed); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("the old external id: %v", err)
	}
}

func TestUpdateView_Refusals(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	v := f.openForm(t, "u-1")

	other := &model.IncomingWebhook{ID: "wh2", Title: "Other", Kind: model.WebhookKindRich}
	if _, err := f.svc.UpdateView(ctx, other, v.ID, "", "", standupForm()); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("another app's form: %v", err)
	}
	if _, err := f.svc.UpdateView(ctx, other, "", "standup-u1", "", standupForm()); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("another app's external id: %v", err)
	}
	if _, err := f.svc.UpdateView(ctx, f.wh, "", "", "", standupForm()); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("no id at all: %v", err)
	}
	if _, err := f.svc.UpdateView(ctx, f.wh, "Vgone", "", "", standupForm()); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("closed form: %v", err)
	}
	if _, err := f.svc.UpdateView(ctx, f.wh, v.ID, "", "", model.View{Type: model.ViewModal}); !errors.Is(err, ErrInvalidView) {
		t.Fatalf("invalid form: %v", err)
	}
	if sv := f.state.views[v.ID]; sv.View.Hash != v.Hash {
		t.Fatal("a refused update changed the form")
	}

	f.state.viewErr = errors.New("redis down")
	for name, call := range map[string]func() error{
		"by id":          func() error { _, err := f.svc.UpdateView(ctx, f.wh, v.ID, "", "", standupForm()); return err },
		"by external id": func() error { _, err := f.svc.UpdateView(ctx, f.wh, "", "standup-u1", "", standupForm()); return err },
	} {
		if err := call(); err == nil || errors.Is(err, ErrViewNotFound) {
			t.Errorf("%s with redis down: %v", name, err)
		}
	}
	f.state.viewErr = nil

	// A failed save leaves the form exactly as it was — still open, still
	// found by its external_id — so the person's next submit still works.
	before := *f.state.views[v.ID]
	renamed := standupForm()
	renamed.ExternalID = "standup-renamed"
	f.state.saveViewErr = errors.New("redis down")
	if _, err := f.svc.UpdateView(ctx, f.wh, v.ID, "", "", renamed); err == nil {
		t.Fatal("save failure")
	}
	f.state.saveViewErr = nil
	if sv := f.state.views[v.ID]; sv.View.Hash != before.View.Hash || f.state.externals["wh:standup-u1"] != v.ID {
		t.Fatalf("a failed save lost the form: %+v %v", sv, f.state.externals)
	}
	if updated, _ := f.viewEvents(t, events.EventViewUpdated); len(updated) != 0 {
		t.Fatalf("a failed update reached the person: %+v", updated)
	}
}

// ---- view_submission

func TestSubmitView_AValidFormReachesTheAppSignedInSlacksShape(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	f.messages.messages["ch1#m1"].WebhookIconEmoji = "calendar"
	v := f.openForm(t, "u-1")
	answers := standupAnswers()
	answers["ghost"] = map[string]RawValue{"x": {"not a field"}} // ignored: not in the stored form

	res, err := f.svc.SubmitView(ctx, "u-1", v.ID, answers)
	if err != nil || res.Action != ViewClose || res.Failed || res.Notice != "" {
		t.Fatalf("submit: %+v %v", res, err)
	}
	p, raw := f.lastSubmission(t)
	if p.Type != "view_submission" || !strings.HasPrefix(p.InteractionID, "i_") || p.User.ID != "u-1" || p.User.Name != "Virpal" || p.User.Email != "" {
		t.Fatalf("payload = %+v", p)
	}
	if p.View.ID != v.ID || p.View.Hash != v.Hash || p.View.CallbackID != "standup" || p.View.PrivateMetadata != "m_8f2c" || p.View.ExternalID != "standup-u1" {
		t.Fatalf("view = %+v", p.View)
	}
	// Slack's shape: value for text, selected_date for a date, and the
	// select's option as ex stored it (its markdown made plain), never as the
	// browser might describe it.
	for _, want := range []string{
		`"did":{"text":{"type":"plain_text_input","value":"Shipped forms"}}`,
		`"due":{"value":{"type":"datepicker","selected_date":"2026-10-23"}}`,
		`"mood":{"pick":{"type":"static_select","selected_option":{"text":{"type":"plain_text","text":"**Good**"},"value":"good"}}}`,
	} {
		if !strings.Contains(raw, want) {
			t.Errorf("payload lacks %s:\n%s", want, raw)
		}
	}
	if strings.Contains(raw, "ghost") {
		t.Fatalf("a value for no field reached the app: %s", raw)
	}
	if _, open := f.state.views[v.ID]; open {
		t.Fatal("a closed form is still stored")
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionSubmission || e.ActionID != "standup" || e.UserID != "u-1" || e.Result != model.InteractionOK || e.Status != http.StatusOK {
		t.Fatalf("history = %+v", e)
	}

	// The submission's trigger_id lets the app open the next form, in the
	// same tab, with the same face.
	next, err := f.svc.OpenView(ctx, f.wh, p.TriggerID, standupForm())
	if err != nil {
		t.Fatalf("open from the submission's trigger: %v", err)
	}
	if sv := f.state.views[next.ID]; sv.UserID != "u-1" || sv.ClickID != "tab-1" || sv.IconEmoji != "calendar" {
		t.Fatalf("next form = %+v", sv)
	}
}

func TestSubmitView_AnOptionalFieldLeftEmptyGoesWithoutAValue(t *testing.T) {
	f := newIxFixture(t)
	v := f.openForm(t, "u-1")
	answers := standupAnswers()
	delete(answers, "mood")
	if res, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, answers); err != nil || res.Action != ViewClose {
		t.Fatalf("submit: %+v %v", res, err)
	}
	if _, raw := f.lastSubmission(t); !strings.Contains(raw, `"mood":{"pick":{"type":"static_select"}}`) {
		t.Fatalf("empty optional field: %s", raw)
	}
}

func TestSubmitView_FieldsThatNeedFixingComeBackWithoutCallingTheApp(t *testing.T) {
	f := newIxFixture(t)
	v := f.openForm(t, "u-1")
	clicks := len(f.app.bodies)
	res, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, map[string]map[string]RawValue{
		"did": {"text": {"  "}}, "due": {"value": {"Friday"}}, "mood": {"pick": {"ecstatic"}},
	})
	if err != nil || res.Action != ViewErrors {
		t.Fatalf("submit: %+v %v", res, err)
	}
	want := map[string]string{"did": "Please fill this in.", "due": "That isn't a date.", "mood": "Please choose one of the options."}
	if len(res.Errors) != len(want) {
		t.Fatalf("errors = %v", res.Errors)
	}
	for id, msg := range want {
		if res.Errors[id] != msg {
			t.Errorf("%s: %q, want %q", id, res.Errors[id], msg)
		}
	}
	if len(f.app.bodies) != clicks {
		t.Fatal("the app was sent a form ex refused")
	}
	if _, open := f.state.views[v.ID]; !open {
		t.Fatal("the form must stay open for the person to fix")
	}
}

func TestSubmitView_EachAnswerOfTheApp(t *testing.T) {
	long := strings.Repeat("é", maxFieldErrorChars+50)
	for _, tc := range []struct {
		name     string
		reply    string
		action   string
		errors   map[string]string
		notice   string
		failed   bool
		entryErr string
		stays    bool // the form is still stored afterwards
	}{
		{name: "no answer closes", reply: "", action: ViewClose},
		{name: "null closes", reply: "null", action: ViewClose},
		{name: "clear closes with a notice", reply: `{"response_action":"clear","notice":"  Saved  "}`, action: ViewClose, notice: "Saved"},
		{name: "errors under the fields the form has", action: ViewErrors, stays: true,
			reply:  `{"response_action":"errors","errors":{"did":"  Too vague  ","due":"   ","ghost":"no such field"}}`,
			errors: map[string]string{"did": "Too vague"}},
		{name: "a long error is cut", action: ViewErrors, stays: true,
			reply:  `{"response_action":"errors","errors":{"did":"` + long + `"}}`,
			errors: map[string]string{"did": strings.Repeat("é", maxFieldErrorChars-1) + "…"}},
		{name: "errors naming no field can't be shown", action: ViewKeep, failed: true, stays: true,
			reply:    `{"response_action":"errors","errors":{"zeta":"x","alpha":"y"}}`,
			notice:   "MeetingMind's answer couldn't be shown.",
			entryErr: "errors name no field of the form with a message: alpha, zeta"},
		{name: "update without a view", reply: `{"response_action":"update"}`, action: ViewKeep, failed: true, stays: true,
			notice: "MeetingMind's answer couldn't be shown.", entryErr: "update without a view"},
		{name: "push of an invalid view", reply: `{"response_action":"push","view":{"type":"modal"}}`, action: ViewKeep, failed: true, stays: true,
			notice: "MeetingMind's answer couldn't be shown.", entryErr: "a form needs a title"},
		{name: "not JSON", reply: "thanks!", action: ViewKeep, failed: true, stays: true,
			notice: "MeetingMind's answer couldn't be shown.", entryErr: "the reply isn't a JSON answer"},
		{name: "an unknown response_action", reply: `{"response_action":"open"}`, action: ViewKeep, failed: true, stays: true,
			notice: "MeetingMind's answer couldn't be shown.", entryErr: "unknown response_action open"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newIxFixture(t)
			v := f.openForm(t, "u-1")
			f.app.reply = tc.reply
			res, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, standupAnswers())
			if err != nil || res.Action != tc.action || res.Notice != tc.notice || res.Failed != tc.failed || res.View != nil {
				t.Fatalf("result = %+v, err %v", res, err)
			}
			if len(res.Errors) != len(tc.errors) {
				t.Fatalf("errors = %v, want %v", res.Errors, tc.errors)
			}
			for id, msg := range tc.errors {
				if res.Errors[id] != msg {
					t.Fatalf("errors[%s] = %q, want %q", id, res.Errors[id], msg)
				}
			}
			if _, open := f.state.views[v.ID]; open != tc.stays {
				t.Fatalf("form stored = %v, want %v", open, tc.stays)
			}
			if e := f.state.lastEntry("wh"); e.Result != model.InteractionOK || !strings.Contains(e.Error, tc.entryErr) || (tc.entryErr == "" && e.Error != "") {
				t.Fatalf("history = %+v", e)
			}
			if tc.stays {
				// Kept as it was — findable by its external_id — and it can
				// be submitted again.
				if sv := f.state.views[v.ID]; sv.View.Hash != v.Hash || f.state.externals["wh:standup-u1"] != v.ID {
					t.Fatalf("kept form = %+v, externals %v", sv, f.state.externals)
				}
				f.app.answer(http.StatusOK, "", 0)
				if res, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, standupAnswers()); err != nil || res.Action != ViewClose {
					t.Fatalf("submitting again: %+v %v", res, err)
				}
			}
		})
	}
}

const thanksForm = `{"type":"modal","title":{"type":"plain_text","text":"Thanks"},"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"All **done**"}}]}`

func TestSubmitView_UpdateSwapsInTheNextForm(t *testing.T) {
	f := newIxFixture(t)
	v := f.openForm(t, "u-1")
	f.app.reply = `{"response_action":"update","notice":"Step 2","view":` + thanksForm + `}`
	res, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, standupAnswers())
	if err != nil || res.Action != ViewUpdate || res.Notice != "Step 2" || res.Failed {
		t.Fatalf("result = %+v, err %v", res, err)
	}
	if res.View.ID != v.ID || res.View.Hash == v.Hash || res.View.Title.Text != "Thanks" || res.View.ExternalID != "standup-u1" || res.View.Submit != nil {
		t.Fatalf("next form = %+v", res.View)
	}
	if sv := f.state.views[v.ID]; sv == nil || sv.View.Hash != res.View.Hash || sv.UserID != "u-1" {
		t.Fatalf("stored = %+v", sv)
	}
}

func TestSubmitView_PushStacksTheNextFormOnTop(t *testing.T) {
	f := newIxFixture(t)
	v := f.openForm(t, "u-1")
	f.app.reply = `{"response_action":"push","notice":"Step 2","view":` + thanksForm + `}`
	res, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, standupAnswers())
	if err != nil || res.Action != ViewPush || res.Notice != "Step 2" || res.Failed {
		t.Fatalf("result = %+v, err %v", res, err)
	}
	// A new form, on top of the one submitted, which stays open under it.
	if res.View.ID == v.ID || res.View.Title.Text != "Thanks" || res.View.PreviousViewID != v.ID || res.View.RootViewID != v.ID || res.View.ExternalID != "" {
		t.Fatalf("pushed form = %+v", res.View)
	}
	if sv := f.state.views[res.View.ID]; sv == nil || sv.Depth != 1 || sv.UserID != "u-1" || sv.ClickID != "tab-1" {
		t.Fatalf("stored = %+v", sv)
	}
	if under := f.state.views[v.ID]; under == nil || under.View.Hash != v.Hash {
		t.Fatalf("the form under it = %+v", under)
	}
	// The tab gets the pushed form in the submission's answer, not as an event.
	if opened, _ := f.viewEvents(t, events.EventViewOpened); len(opened) != 1 {
		t.Fatalf("view.opened events = %d, want only the first form's", len(opened))
	}
}

func TestSubmitView_AnAppThatDoesntAnswerKeepsTheFormOpen(t *testing.T) {
	f := newIxFixture(t)
	v := f.openForm(t, "u-1")
	f.app.delay = 600 * time.Millisecond
	res, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, standupAnswers())
	if err != nil || res.Action != ViewKeep || !res.Failed || res.Notice != "MeetingMind didn't respond. Try again." {
		t.Fatalf("slow app: %+v %v", res, err)
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionSubmission || e.Result != model.InteractionTimeout {
		t.Fatalf("history = %+v", e)
	}
	if _, open := f.state.views[v.ID]; !open {
		t.Fatal("the person's form must stay open to try again")
	}
	f.app.answer(http.StatusInternalServerError, "", 0)
	if res, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, standupAnswers()); err != nil || res.Action != ViewKeep || !res.Failed {
		t.Fatalf("failing app: %+v %v", res, err)
	}
	if e := f.state.lastEntry("wh"); e.Result != model.InteractionFailed || e.Error != "answered 500" || f.state.failures["wh"] != 2 {
		t.Fatalf("history = %+v, failures %d", e, f.state.failures["wh"])
	}
}

func TestSubmitView_Refusals(t *testing.T) {
	ctx := context.Background()
	f := newIxFixture(t)
	v := f.openForm(t, "u-1")

	for name, id := range map[string]string{"no id": "", "closed": "Vgone"} {
		if _, err := f.svc.SubmitView(ctx, "u-1", id, standupAnswers()); !errors.Is(err, ErrViewNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := f.svc.SubmitView(ctx, "u-2", v.ID, standupAnswers()); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("someone else's form: %v", err)
	}

	f.limiter.deny = true
	if _, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers()); !errors.Is(err, ErrClickRateLimited) {
		t.Fatalf("rate limit: %v", err)
	}
	f.limiter.deny = false

	f.svc.inFlight["wh"] = maxAppClicksInFlight
	if _, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers()); !errors.Is(err, ErrAppBusy) {
		t.Fatalf("busy: %v", err)
	}
	f.svc.release("wh")

	f.wh.AdminPaused = true
	if _, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers()); !errors.Is(err, ErrAppUnavailable) {
		t.Fatalf("paused: %v", err)
	}
	f.wh.AdminPaused = false

	delete(f.hooks.items, "wh")
	if _, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers()); !errors.Is(err, ErrViewNotFound) || !strings.Contains(err.Error(), "app is gone") {
		t.Fatalf("app gone: %v", err)
	}
	f.hooks.items["wh"] = f.wh

	f.state.viewErr = errors.New("redis down")
	if _, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers()); err == nil || errors.Is(err, ErrViewNotFound) {
		t.Fatalf("redis down: %v", err)
	}
	f.state.viewErr = nil
	// None of the refusals reached the app.
	if len(f.app.bodies) != 1 {
		t.Fatalf("app got %d requests, want only the click", len(f.app.bodies))
	}
}

func TestSubmitView_StateFailuresDontLoseTheAnswer(t *testing.T) {
	f := newIxFixture(t)
	v := f.openForm(t, "u-1")
	f.state.stateErr = errors.New("redis down")
	f.state.triggerErr = errors.New("redis down")
	f.state.deleteViewErr = errors.New("redis down")
	f.app.reply = `{"response_action":"clear","notice":"Saved"}`
	res, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, standupAnswers())
	if err != nil || res.Action != ViewClose || res.Notice != "Saved" {
		t.Fatalf("submit: %+v %v", res, err)
	}
	if p, _ := f.lastSubmission(t); p.TriggerID != "" {
		t.Fatalf("trigger without state = %q", p.TriggerID)
	}
}

// ---- closing

func TestCloseView_OnlyThePersonsOwnAndClosingTwiceIsFine(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	v := f.openForm(t, "u-1")

	if err := f.svc.CloseView(ctx, "u-2", v.ID, false, nil); err != nil {
		t.Fatalf("someone else's form reads as closed: %v", err)
	}
	if _, open := f.state.views[v.ID]; !open {
		t.Fatal("someone else closed the form")
	}
	f.state.takeViewErr = errors.New("redis down")
	if err := f.svc.CloseView(ctx, "u-1", v.ID, false, nil); err == nil {
		t.Fatal("delete failure")
	}
	f.state.takeViewErr = nil
	f.state.viewErr = errors.New("redis down")
	if err := f.svc.CloseView(ctx, "u-1", v.ID, false, nil); err == nil || errors.Is(err, ErrViewNotFound) {
		t.Fatalf("read failure: %v", err)
	}
	f.state.viewErr = nil
	if err := f.svc.CloseView(ctx, "u-1", v.ID, false, nil); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, open := f.state.views[v.ID]; open || f.state.externals["wh:standup-u1"] != "" {
		t.Fatalf("form still stored: %v %v", f.state.views, f.state.externals)
	}
	if err := f.svc.CloseView(ctx, "u-1", v.ID, false, nil); err != nil {
		t.Fatalf("closing again: %v", err)
	}
	if _, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers()); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("submitting a closed form: %v", err)
	}
}

// ---- messages.update

func TestUpdateMessage_ReplacesTheAppsOwnMessageLive(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	msg, err := f.svc.UpdateMessage(ctx, f.wh, MessageUpdate{ChannelID: "ch1", MessageID: "m1", Text: "A3 moved to Mon"})
	if err != nil || msg.Body != "A3 moved to Mon" || msg.Version != 1 || msg.EditedAt != nil {
		t.Fatalf("update: %+v %v", msg, err)
	}
	if stored := f.messages.messages["ch1#m1"]; stored.Body != "A3 moved to Mon" {
		t.Fatalf("stored = %q", stored.Body)
	}
	if !f.publishedTo(pubsub.ChannelName("ch1"), events.EventMessageEdited) {
		t.Fatal("no message.edited to the channel")
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionAPI || e.ActionID != "messages.update" || e.Result != model.InteractionOK {
		t.Fatalf("history = %+v", e)
	}
	stale := 0
	if _, err := f.svc.UpdateMessage(ctx, f.wh, MessageUpdate{ChannelID: "ch1", MessageID: "m1", Text: "x", IfVersion: &stale}); !errors.Is(err, ErrAppVersionConflict) {
		t.Fatalf("stale if_version: %v", err)
	}
	if e := f.state.lastEntry("wh"); e.Result != model.InteractionFailed || !strings.Contains(e.Error, "version 1, not 0") {
		t.Fatalf("history = %+v", e)
	}
}

func TestUpdateMessage_InADirectConversation(t *testing.T) {
	f := newIxFixture(t)
	dm := appMessage()
	dm.ID, dm.ParentID = "m2", "dm-1"
	f.messages.messages["dm-1#m2"] = dm
	if _, err := f.svc.UpdateMessage(context.Background(), f.wh, MessageUpdate{ChannelID: "dm-1", MessageID: "m2", Text: "Moved"}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if !f.publishedTo(pubsub.ConversationName("dm-1"), events.EventMessageEdited) {
		t.Fatal("no message.edited to the conversation")
	}
}

// failingChannels can't look channels up at all (its store is down).
type failingChannels struct{ fakeWebhookChannels }

func (failingChannels) GetByID(context.Context, string) (*model.Channel, error) {
	return nil, errors.New("dynamo down")
}

func TestUpdateMessage_AChannelLookupFailureIsAnErrorNotADM(t *testing.T) {
	f := newIxFixture(t)
	f.svc.webhooks.channels = failingChannels{}
	_, err := f.svc.UpdateMessage(context.Background(), f.wh, MessageUpdate{ChannelID: "ch1", MessageID: "m1", Text: "new"})
	if err == nil || errors.Is(err, apperr.ErrNotFound) {
		t.Fatalf("lookup failure: %v", err)
	}
	if f.publishedTo(pubsub.ConversationName("ch1"), events.EventMessageEdited) {
		t.Fatal("the edit went to a DM topic nobody watches")
	}
}

func TestOpenView_AnExternalIDNamesOneOpenForm(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	first := f.openForm(t, "u-1") // external_id "standup-u1"

	// A second open form can't take it while the first is open…
	if _, err := f.svc.OpenView(ctx, f.wh, f.triggerFrom(t, "u-1"), standupForm()); !errors.Is(err, ErrDuplicateExternalID) {
		t.Fatalf("duplicate external_id: %v", err)
	}
	// …nor can an update rename another form onto it.
	other := standupForm()
	other.ExternalID = "standup-u2"
	second, err := f.svc.OpenView(ctx, f.wh, f.triggerFrom(t, "u-1"), other)
	if err != nil {
		t.Fatalf("a free external_id: %v", err)
	}
	if _, err := f.svc.UpdateView(ctx, f.wh, second.ID, "", "", standupForm()); !errors.Is(err, ErrDuplicateExternalID) {
		t.Fatalf("rename onto a held external_id: %v", err)
	}
	// Once the first form closes, its external_id is free again — and
	// closing it never touches an external_id another form holds.
	if err := f.svc.CloseView(ctx, "u-1", first.ID, false, nil); err != nil {
		t.Fatalf("close: %v", err)
	}
	renamed, err := f.svc.UpdateView(ctx, f.wh, second.ID, "", "", standupForm())
	if err != nil || renamed.ExternalID != "standup-u1" || f.state.externals["wh:standup-u1"] != second.ID {
		t.Fatalf("rename after close: %+v %v %v", renamed, err, f.state.externals)
	}
	if _, held := f.state.externals["wh:standup-u2"]; held {
		t.Fatal("the old external_id still points at the renamed form")
	}

	// A mapping left behind by a form that expired doesn't block a new one.
	f.state.externals["wh:stale"] = "Vexpired"
	stale := standupForm()
	stale.ExternalID = "stale"
	if _, err := f.svc.OpenView(ctx, f.wh, f.triggerFrom(t, "u-1"), stale); err != nil {
		t.Fatalf("an expired form's external_id: %v", err)
	}
	// Forms without an external_id never clash.
	for i := 0; i < 2; i++ {
		anon := standupForm()
		anon.ExternalID = ""
		if _, err := f.svc.OpenView(ctx, f.wh, f.triggerFrom(t, "u-1"), anon); err != nil {
			t.Fatalf("form without external_id #%d: %v", i, err)
		}
	}
}

func TestOpenView_ExternalIDCheckFailures(t *testing.T) {
	ctx := context.Background()
	t.Run("lookup fails", func(t *testing.T) {
		f := newIxFixture(t)
		trigger := f.triggerFrom(t, "u-1")
		f.state.viewErr = errors.New("redis down")
		if _, err := f.svc.OpenView(ctx, f.wh, trigger, standupForm()); err == nil || errors.Is(err, ErrDuplicateExternalID) {
			t.Fatalf("lookup failure: %v", err)
		}
	})
	t.Run("reading the holder fails", func(t *testing.T) {
		f := newIxFixture(t)
		f.state.externals["wh:standup-u1"] = "Vother"
		trigger := f.triggerFrom(t, "u-1")
		f.state.getViewErr = errors.New("redis down")
		if _, err := f.svc.OpenView(ctx, f.wh, trigger, standupForm()); err == nil || errors.Is(err, ErrDuplicateExternalID) {
			t.Fatalf("holder read failure: %v", err)
		}
	})
	t.Run("dropping the old mapping fails after a rename", func(t *testing.T) {
		f := newIxFixture(t)
		v := f.openForm(t, "u-1")
		f.state.dropErr = errors.New("redis down")
		renamed := standupForm()
		renamed.ExternalID = "standup-renamed"
		// The form is saved under its new name; the stale mapping is only
		// logged, and a later open of that name finds no live form behind it.
		if got, err := f.svc.UpdateView(ctx, f.wh, v.ID, "", "", renamed); err != nil || got.ExternalID != "standup-renamed" {
			t.Fatalf("rename with a failing drop: %+v %v", got, err)
		}
	})
}

func TestUpdateMessage_OnlyTheAppsOwnLiveMessage(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	person := &model.Message{ID: "m3", ParentID: "ch1", AuthorID: "u-1", Body: "mine"}
	other := appMessage()
	other.ID, other.WebhookID = "m4", "wh2"
	gone := appMessage()
	gone.ID, gone.Deleted = "m5", true
	for _, m := range []*model.Message{person, other, gone} {
		f.messages.messages["ch1#"+m.ID] = m
	}
	for _, tc := range []struct {
		name string
		in   MessageUpdate
		want error
	}{
		{"no channel", MessageUpdate{MessageID: "m1", Text: "x"}, apperr.ErrValidation},
		{"no message", MessageUpdate{ChannelID: "ch1", Text: "x"}, apperr.ErrValidation},
		{"unknown", MessageUpdate{ChannelID: "ch1", MessageID: "nope", Text: "x"}, apperr.ErrNotFound},
		{"deleted", MessageUpdate{ChannelID: "ch1", MessageID: "m5", Text: "x"}, apperr.ErrNotFound},
		{"a person's", MessageUpdate{ChannelID: "ch1", MessageID: "m3", Text: "x"}, ErrCantUpdateMessage},
		{"another app's", MessageUpdate{ChannelID: "ch1", MessageID: "m4", Text: "x"}, ErrCantUpdateMessage},
	} {
		if _, err := f.svc.UpdateMessage(ctx, f.wh, tc.in); !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", tc.name, err, tc.want)
		}
	}
	if person.Body != "mine" || other.Body != "Platform sync" {
		t.Fatal("a refused update changed a message")
	}
}

func (f *ixFixture) publishedTo(channel, eventType string) bool {
	f.pub.mu.Lock()
	defer f.pub.mu.Unlock()
	for _, p := range f.pub.published {
		if p.channel == channel && p.event.Type == eventType {
			return true
		}
	}
	return false
}

// ---- the app's credentials and budget

func TestAuthenticateApp_ByBotTokenWithinTheAppsBudget(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	now := time.Date(2026, 10, 30, 12, 0, 0, 0, time.UTC)
	f.svc.now = func() time.Time { return now }
	token, hash := newBotToken()
	prev, prevHash := newBotToken()
	until := now.Add(time.Hour)
	f.wh.BotTokenHash, f.wh.PrevBotTokenHash, f.wh.PrevBotTokenUntil = hash, prevHash, &until
	f.hooks.items["wh2"] = &model.IncomingWebhook{ID: "wh2", Title: "No token", Kind: model.WebhookKindRich}

	for name, tok := range map[string]string{"current": token, "previous, during the overlap": prev} {
		if wh, err := f.svc.AuthenticateApp(ctx, tok); err != nil || wh.ID != "wh" {
			t.Errorf("%s token: %+v %v", name, wh, err)
		}
	}
	for name, tok := range map[string]string{"none": "", "unknown": "exb_unknown"} {
		if _, err := f.svc.AuthenticateApp(ctx, tok); !errors.Is(err, ErrInvalidAuth) {
			t.Errorf("%s token: %v", name, err)
		}
	}

	f.limiter.denyApp = true
	_, err := f.svc.AuthenticateApp(ctx, token)
	var limited *RateLimitedError
	if !errors.As(err, &limited) || !errors.Is(err, ErrAppRateLimited) || limited.RetryAfter != 1500*time.Millisecond || err.Error() != "too many calls, slow down" {
		t.Fatalf("over budget: %v", err)
	}
	// A limiter that's down admits the call rather than lock every app out.
	f.limiter.appErr = errors.New("redis down")
	if wh, err := f.svc.AuthenticateApp(ctx, token); err != nil || wh.ID != "wh" {
		t.Fatalf("limiter down: %+v %v", wh, err)
	}

	f.hooks.listErr = errors.New("dynamo down")
	if _, err := f.svc.AuthenticateApp(ctx, token); err == nil || errors.Is(err, ErrInvalidAuth) {
		t.Fatalf("store failure: %v", err)
	}
}

func TestIdempotent_ARetryGetsTheFirstAnswer(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	calls := 0
	run := func() (any, error) {
		calls++
		return map[string]int{"call": calls}, nil
	}

	first, err := f.svc.Idempotent(ctx, f.wh, "views.open", "k1", run)
	if err != nil || string(first) != `{"call":1}` {
		t.Fatalf("first: %s %v", first, err)
	}
	again, err := f.svc.Idempotent(ctx, f.wh, "views.open", "k1", run)
	if err != nil || string(again) != `{"call":1}` || calls != 1 {
		t.Fatalf("retry: %s %v (ran %d times)", again, err, calls)
	}
	// The key is the app's, per method.
	if out, _ := f.svc.Idempotent(ctx, f.wh, "views.update", "k1", run); string(out) != `{"call":2}` {
		t.Fatalf("another method: %s", out)
	}
	other := &model.IncomingWebhook{ID: "wh2", Kind: model.WebhookKindRich}
	if out, _ := f.svc.Idempotent(ctx, other, "views.open", "k1", run); string(out) != `{"call":3}` {
		t.Fatalf("another app: %s", out)
	}

	// No key: every call runs.
	for want := 4; want <= 5; want++ {
		if out, err := f.svc.Idempotent(ctx, f.wh, "views.open", "", run); err != nil || calls != want || len(out) == 0 {
			t.Fatalf("no key: %s %v", out, err)
		}
	}
}

func TestIdempotent_AFailedCallReleasesItsKey(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	boom := errors.New("trigger expired")
	if out, err := f.svc.Idempotent(ctx, f.wh, "views.open", "k1", func() (any, error) { return nil, boom }); !errors.Is(err, boom) || out != nil {
		t.Fatalf("failure: %s %v", out, err)
	}
	if out, err := f.svc.Idempotent(ctx, f.wh, "views.open", "k1", func() (any, error) { return "ok", nil }); err != nil || string(out) != `"ok"` {
		t.Fatalf("retry after a failure runs for real: %s %v", out, err)
	}
	if _, err := f.svc.Idempotent(ctx, f.wh, "views.open", "", func() (any, error) { return nil, boom }); !errors.Is(err, boom) {
		t.Fatalf("failure without a key: %v", err)
	}
}

func TestIdempotent_ARetryWhileTheFirstRunsIsRefused(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	var inner error
	out, err := f.svc.Idempotent(ctx, f.wh, "views.open", "k1", func() (any, error) {
		_, inner = f.svc.Idempotent(ctx, f.wh, "views.open", "k1", func() (any, error) {
			t.Fatal("a retry ran while the first call was still running")
			return nil, nil
		})
		return "first", nil
	})
	if err != nil || string(out) != `"first"` || !errors.Is(inner, ErrIdempotencyInProgress) {
		t.Fatalf("first %s %v, retry %v", out, err, inner)
	}
}

func TestIdempotent_AnAnswerThatCantBeSentIsAnErrorAndFreesTheKey(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	unencodable := func() (any, error) { return func() {}, nil }
	if _, err := f.svc.Idempotent(ctx, f.wh, "views.open", "k-bad", unencodable); err == nil {
		t.Fatal("an answer that can't be encoded must be an error, not an empty success")
	}
	if _, err := f.svc.Idempotent(ctx, f.wh, "views.open", "k-bad", func() (any, error) { return true, nil }); err != nil {
		t.Fatalf("the key stayed held after a failed call: %v", err)
	}
}

func TestIdempotent_KeyLimitAndRedisDown(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	run := func() (any, error) { return true, nil }
	if _, err := f.svc.Idempotent(ctx, f.wh, "views.open", strings.Repeat("é", maxIdempotencyKey+1), run); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("long key: %v", err)
	}
	if _, err := f.svc.Idempotent(ctx, f.wh, "views.open", strings.Repeat("é", maxIdempotencyKey), run); err != nil {
		t.Fatalf("key at the limit (counted in characters): %v", err)
	}
	// Redis down: the call runs every time rather than being refused.
	f.state.idemErr = errors.New("redis down")
	calls := 0
	for i := 0; i < 2; i++ {
		if _, err := f.svc.Idempotent(ctx, f.wh, "views.open", "k2", func() (any, error) { calls++; return calls, nil }); err != nil {
			t.Fatalf("redis down: %v", err)
		}
	}
	if calls != 2 {
		t.Fatalf("ran %d times", calls)
	}
}
