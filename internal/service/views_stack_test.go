package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// planForm is a form whose parts talk to the app as they change: an owner
// field (dispatch_action), a size picker beside a note, and a row with a
// link and a button. notify asks to hear when it is closed.
func planForm(notify bool) model.View {
	return model.View{
		Type: model.ViewModal, CallbackID: "plan", Title: *plain("Plan"), Submit: plain("Save"), NotifyOnClose: notify,
		Blocks: model.Blocks{
			{Type: model.BlockInput, BlockID: "owner", Label: plain("Owner"), DispatchAction: true, Element: &model.BlockElement{Type: model.ElementUsersSelect, ActionID: "who"}},
			{Type: model.BlockInput, BlockID: "note", Label: plain("Note"), Optional: true, Element: &model.BlockElement{Type: model.ElementPlainTextInput, ActionID: "text"}},
			{Type: model.BlockSection, BlockID: "size", Text: plain("Size"), Accessory: &model.BlockElement{Type: model.ElementStaticSelect, ActionID: "pick", Options: opts("s", "l")}},
			{Type: model.BlockActions, BlockID: "row", Elements: []model.BlockElement{
				{Type: model.ElementButton, ActionID: "docs", Text: plain("Docs"), URL: "https://docs.ex.test"},
				btn("more", "More"),
			}},
		},
	}
}

// openPlan opens planForm for userID after a click on the card.
func (f *ixFixture) openPlan(t *testing.T, userID string, notify bool) *model.View {
	t.Helper()
	pickerPeople(f)
	v, err := f.svc.OpenView(context.Background(), f.wh, f.triggerFrom(t, userID), planForm(notify))
	if err != nil {
		t.Fatalf("open view: %v", err)
	}
	return v
}

// formTriggerOf presses "More" in form viewID and returns the trigger_id
// the app was sent with it: one it may push a form with.
func (f *ixFixture) formTriggerOf(t *testing.T, userID, viewID string) string {
	t.Helper()
	if _, err := f.svc.ViewAction(context.Background(), userID, viewID, "row", "more", nil, nil); err != nil {
		t.Fatalf("press more: %v", err)
	}
	return f.app.got[len(f.app.got)-1].TriggerID
}

// closedBodies are the view_closed requests the app received.
func (f *ixFixture) closedBodies(t *testing.T) []viewSubmissionPayload {
	t.Helper()
	f.app.mu.Lock()
	defer f.app.mu.Unlock()
	var out []viewSubmissionPayload
	for _, raw := range f.app.bodies {
		var p viewSubmissionPayload
		if err := json.Unmarshal(raw, &p); err != nil {
			t.Fatalf("body: %v", err)
		}
		if p.Type == "view_closed" {
			out = append(out, p)
		}
	}
	return out
}

func inline(f *ixFixture) { f.svc.async = func(fn func()) { fn() } }

// ---- a change in a form (block_actions from a view)

func TestViewAction_AChangeReachesTheAppWithTheFormAsItStands(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	v := f.openPlan(t, "u-1", false)
	f.app.reply = `{"notice":"Owner noted"}`

	res, err := f.svc.ViewAction(ctx, "u-1", v.ID, "owner", "who", RawValue{"u-2"},
		map[string]map[string]RawValue{"owner": {"who": {"u-2"}}, "note": {"text": {"half a thought"}}})
	if err != nil || res.Notice != "Owner noted" || res.Failed {
		t.Fatalf("change: %+v %v", res, err)
	}
	p, raw := f.app.got[1], string(f.app.bodies[1])
	if p.Type != "block_actions" || p.User.ID != "u-1" || p.User.Name != "Virpal" || p.Container.Type != "view" || p.Container.ViewID != v.ID ||
		p.Channel != nil || p.Message != nil || p.ResponseURL != "" || p.View == nil || p.View.ID != v.ID || p.View.CallbackID != "plan" {
		t.Fatalf("payload = %+v", p)
	}
	if a := p.Actions[0]; a.Type != model.ElementUsersSelect || a.BlockID != "owner" || a.ActionID != "who" || a.SelectedUser == nil || *a.SelectedUser != "u-2" {
		t.Fatalf("action = %+v", a)
	}
	state := p.View.State["values"]
	if n := state["note"]["text"].Value; n == nil || *n != "half a thought" || *state["owner"]["who"].SelectedUser != "u-2" {
		t.Fatalf("state = %s", raw)
	}
	// Its trigger_id comes from this form: the app may push on it.
	if rec := f.state.triggers[responseTokenHash(p.TriggerID)]; rec.ViewID != v.ID || rec.UserID != "u-1" || rec.ClickID != "tab-1" {
		t.Fatalf("trigger = %+v", rec)
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionClick || e.ActionID != "who" || e.Result != model.InteractionOK {
		t.Fatalf("history = %+v", e)
	}

	// The picker beside a section, and a button in a row, send too; an
	// answer that isn't JSON is no notice.
	f.app.reply = "ok"
	if res, err := f.svc.ViewAction(ctx, "u-1", v.ID, "size", "pick", RawValue{"l"}, nil); err != nil || res.Notice != "" {
		t.Fatalf("picker: %+v %v", res, err)
	}
	if a := f.app.got[2].Actions[0]; a.SelectedOption == nil || a.SelectedOption.Text.Text != "L" {
		t.Fatalf("picker action = %+v", a)
	}
	if _, err := f.svc.ViewAction(ctx, "u-1", v.ID, "row", "more", nil, nil); err != nil {
		t.Fatalf("button: %v", err)
	}
	if a := f.app.got[3].Actions[0]; a.Type != model.ElementButton || a.ActionID != "more" || a.Text.Text != "More" {
		t.Fatalf("button action = %+v", a)
	}
}

func TestViewAction_Refusals(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	v := f.openPlan(t, "u-1", false)
	users := newCountingUsers(virpal(), &model.User{ID: "u-2", DisplayName: "Manisha"})
	f.svc.webhooks.SetUserResolver(users)
	change := func(userID, blockID, actionID string, value RawValue) error {
		_, err := f.svc.ViewAction(ctx, userID, v.ID, blockID, actionID, value, nil)
		return err
	}

	// Only the person's own form, and only the parts that send changes.
	if err := change("u-2", "owner", "who", RawValue{"u-2"}); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("someone else's form: %v", err)
	}
	for name, at := range map[string][2]string{
		"a field without dispatch_action": {"note", "text"},
		"another action in a field":       {"owner", "nope"},
		"a link":                          {"row", "docs"},
		"no such block":                   {"gone", "who"},
		"no such element":                 {"size", "nope"},
	} {
		if err := change("u-1", at[0], at[1], RawValue{"x"}); !errors.Is(err, apperr.ErrNotFound) {
			t.Errorf("%s: %v", name, err)
		}
	}
	// Over budget, or the app paused: refused before anyone is looked up.
	f.limiter.deny = true
	if err := change("u-1", "owner", "who", RawValue{"u-2"}); !errors.Is(err, ErrClickRateLimited) {
		t.Fatalf("over budget: %v", err)
	}
	f.limiter.deny = false
	f.wh.AdminPaused = true
	if err := change("u-1", "owner", "who", RawValue{"u-2"}); !errors.Is(err, ErrAppUnavailable) {
		t.Fatalf("paused: %v", err)
	}
	f.wh.AdminPaused = false
	if users.lookups() != 0 {
		t.Fatalf("refused changes cost %d lookups", users.lookups())
	}
	// A value the field can't hold, and a busy app.
	if err := change("u-1", "owner", "who", RawValue{"u-404"}); !errors.Is(err, apperr.ErrValidation) {
		t.Fatalf("unknown person: %v", err)
	}
	f.svc.inFlight["wh"] = maxAppClicksInFlight
	if err := change("u-1", "owner", "who", RawValue{"u-2"}); !errors.Is(err, ErrAppBusy) {
		t.Fatalf("busy: %v", err)
	}
	delete(f.svc.inFlight, "wh")
	// The form unreadable, or its app gone.
	f.state.getViewErr = errors.New("redis down")
	if err := change("u-1", "owner", "who", RawValue{"u-2"}); err == nil || errors.Is(err, ErrViewNotFound) {
		t.Fatalf("read failure: %v", err)
	}
	f.state.getViewErr = nil
	delete(f.hooks.items, "wh")
	if err := change("u-1", "owner", "who", RawValue{"u-2"}); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("app gone: %v", err)
	}
	if len(f.app.bodies) != 1 {
		t.Fatalf("app got %d requests, want only the click that opened the form", len(f.app.bodies))
	}
}

func TestViewAction_AFailingAppCostsANoticeAndStateFailuresDont(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	v := f.openPlan(t, "u-1", false)
	f.app.answer(http.StatusInternalServerError, "", 0)
	res, err := f.svc.ViewAction(ctx, "u-1", v.ID, "row", "more", nil, nil)
	if err != nil || !res.Failed || res.Notice != "MeetingMind didn't respond. Try again." {
		t.Fatalf("failing app: %+v %v", res, err)
	}
	if e := f.state.lastEntry("wh"); e.Result != model.InteractionFailed || e.Error != "answered 500" || f.state.failures["wh"] != 1 {
		t.Fatalf("history = %+v", e)
	}
	f.app.answer(http.StatusOK, `{"notice":"ok"}`, 0)
	f.state.stateErr = errors.New("redis down")
	if res, err := f.svc.ViewAction(ctx, "u-1", v.ID, "row", "more", nil, nil); err != nil || res.Failed || res.Notice != "ok" {
		t.Fatalf("state down: %+v %v", res, err)
	}
}

// ---- views.push

func TestPushView_StacksOnTheFormTheTriggerCameFrom(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	root := f.openPlan(t, "u-1", false)

	next := planForm(false)
	next.Title = *plain("Step 2")
	mid, err := f.svc.PushView(ctx, f.wh, f.formTriggerOf(t, "u-1", root.ID), next)
	if err != nil {
		t.Fatalf("push: %v", err)
	}
	if !strings.HasPrefix(mid.ID, "V") || mid.ID == root.ID || mid.PreviousViewID != root.ID || mid.RootViewID != root.ID || mid.Title.Text != "Step 2" {
		t.Fatalf("pushed = %+v", mid)
	}
	if sv := f.state.views[mid.ID]; sv == nil || sv.Depth != 1 || sv.UserID != "u-1" || sv.ClickID != "tab-1" || sv.WebhookID != "wh" {
		t.Fatalf("stored = %+v", sv)
	}
	if _, open := f.state.views[root.ID]; !open {
		t.Fatal("the form under it closed")
	}
	// The person's tab is told: it shows the new form on top.
	opened, channels := f.viewEvents(t, events.EventViewOpened)
	if len(opened) != 2 || opened[1].View.ID != mid.ID || opened[1].ClickID != "tab-1" || channels[1] != pubsub.UserChannel("u-1") {
		t.Fatalf("view.opened = %+v to %v", opened, channels)
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionAPI || e.ActionID != "views.push" || e.UserID != "u-1" || e.Result != model.InteractionOK {
		t.Fatalf("history = %+v", e)
	}

	// A third form keeps the first as its root; a fourth is too many.
	top, err := f.svc.PushView(ctx, f.wh, f.formTriggerOf(t, "u-1", mid.ID), planForm(false))
	if err != nil || top.PreviousViewID != mid.ID || top.RootViewID != root.ID || f.state.views[top.ID].Depth != 2 {
		t.Fatalf("third: %+v %v", top, err)
	}
	_, err = f.svc.PushView(ctx, f.wh, f.formTriggerOf(t, "u-1", top.ID), planForm(false))
	if !errors.Is(err, ErrPushNotAllowed) || !strings.Contains(err.Error(), "at most 3 deep") {
		t.Fatalf("fourth: %v", err)
	}
	if e := f.state.lastEntry("wh"); e.ActionID != "views.push" || e.Result != model.InteractionFailed {
		t.Fatalf("refused push history = %+v", e)
	}
}

func TestPushView_Refusals(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	open := planForm(false)
	open.ExternalID = "plan-u1"
	pickerPeople(f)
	v, err := f.svc.OpenView(ctx, f.wh, f.triggerFrom(t, "u-1"), open)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	push := func(trigger string, in model.View) error {
		_, err := f.svc.PushView(ctx, f.wh, trigger, in)
		return err
	}

	// A click on a message opens a form; it can't push one.
	if err := push(f.triggerFrom(t, "u-1"), planForm(false)); !errors.Is(err, ErrPushNotAllowed) || !strings.Contains(err.Error(), "views.open") {
		t.Fatalf("a message's trigger: %v", err)
	}
	// Unknown, used, or another app's trigger.
	if err := push("t_nope", planForm(false)); !errors.Is(err, ErrTriggerExpired) {
		t.Fatalf("unknown trigger: %v", err)
	}
	other := &model.IncomingWebhook{ID: "wh2", Title: "Other", Kind: model.WebhookKindRich}
	if _, err := f.svc.PushView(ctx, other, f.formTriggerOf(t, "u-1", v.ID), planForm(false)); !errors.Is(err, ErrTriggerExpired) {
		t.Fatalf("another app's trigger: %v", err)
	}
	// The form under it closed meanwhile.
	trigger := f.formTriggerOf(t, "u-1", v.ID)
	f.state.mu.Lock()
	under := *f.state.views[v.ID]
	delete(f.state.views, v.ID)
	f.state.mu.Unlock()
	if err := push(trigger, planForm(false)); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("closed parent: %v", err)
	}
	f.state.views[v.ID] = &under
	// A form that breaks a rule, or names an external_id another form has.
	if err := push(f.formTriggerOf(t, "u-1", v.ID), model.View{Type: model.ViewModal}); !errors.Is(err, ErrInvalidView) {
		t.Fatalf("bad form: %v", err)
	}
	dup := planForm(false)
	dup.ExternalID = "plan-u1"
	if err := push(f.formTriggerOf(t, "u-1", v.ID), dup); !errors.Is(err, ErrDuplicateExternalID) {
		t.Fatalf("duplicate external_id: %v", err)
	}
	// Redis failing to save it, or to read the trigger.
	trigger = f.formTriggerOf(t, "u-1", v.ID)
	f.state.saveViewErr = errors.New("redis down")
	if err := push(trigger, planForm(false)); err == nil || errors.Is(err, ErrPushNotAllowed) {
		t.Fatalf("save failure: %v", err)
	}
	f.state.saveViewErr = nil
	f.state.triggerErr = errors.New("redis down")
	if err := push("t_any", planForm(false)); err == nil || errors.Is(err, ErrTriggerExpired) {
		t.Fatalf("trigger read failure: %v", err)
	}
	f.state.triggerErr = nil
	// A paused app pushes nothing.
	trigger = f.formTriggerOf(t, "u-1", v.ID)
	f.wh.AdminPaused = true
	if err := push(trigger, planForm(false)); !errors.Is(err, ErrAppUnavailable) {
		t.Fatalf("paused: %v", err)
	}
	if len(f.state.views) != 1 {
		t.Fatalf("refused pushes stored forms: %d open", len(f.state.views))
	}
}

// ---- preview

func TestPreviewView_ShowsTheFormAsExDrawsItWithoutOpeningOrFetching(t *testing.T) {
	f := newIxFixture(t)
	pics := &countingImages{}
	f.svc.webhooks.images = pics
	in := planForm(false)
	in.Blocks = append(in.Blocks, model.Block{Type: model.BlockImage, ImageURL: "https://img.ex.test/chart.png", AltText: "chart"})
	v, err := f.svc.PreviewView(context.Background(), member("u-1"), in)
	if err != nil || v.ID != "preview" || v.Hash != "preview" || v.Close.Text != "Cancel" || v.Blocks[1].Element.ActionID != "text" {
		t.Fatalf("preview: %+v %v", v, err)
	}
	if b := v.Blocks[4]; b.ImageURL != "https://img.ex.test/chart.png" {
		t.Fatalf("image = %+v", b)
	}
	if pics.total() != 0 || len(f.state.views) != 0 || len(f.app.bodies) != 0 {
		t.Fatalf("a preview fetched %d images, stored %d forms, called the app %d times", pics.total(), len(f.state.views), len(f.app.bodies))
	}
	if _, err := f.svc.PreviewView(context.Background(), WebhookActor{ID: "u-g", Role: model.SystemRoleGuest}, in); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("guest: %v", err)
	}
	if _, err := f.svc.PreviewView(context.Background(), member("u-1"), model.View{Type: model.ViewModal}); !errors.Is(err, ErrInvalidView) {
		t.Fatalf("bad form: %v", err)
	}
}

// ---- closing, and telling the app

func TestCloseView_ANotifyOnCloseFormTellsTheAppWhatWasEntered(t *testing.T) {
	f := newIxFixture(t)
	inline(f)
	ctx := context.Background()
	v := f.openPlan(t, "u-1", true)
	raw := map[string]map[string]RawValue{"note": {"text": {"draft"}}, "owner": {"who": {"u-404"}}}
	if err := f.svc.CloseView(ctx, "u-1", v.ID, false, raw); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, open := f.state.views[v.ID]; open {
		t.Fatal("form still open")
	}
	closed := f.closedBodies(t)
	if len(closed) != 1 {
		t.Fatalf("view_closed sent %d times", len(closed))
	}
	p := closed[0]
	if p.User.ID != "u-1" || p.User.Name != "Virpal" || p.View.ID != v.ID || p.IsCleared == nil || *p.IsCleared || p.TriggerID != "" {
		t.Fatalf("view_closed = %+v", p)
	}
	// What was entered so far goes; a value that isn't valid is left out.
	values := p.View.State["values"]
	if n := values["note"]["text"].Value; n == nil || *n != "draft" {
		t.Fatalf("note = %+v", values["note"])
	}
	if _, ok := values["owner"]; ok {
		t.Fatalf("an unknown person reached the app: %+v", values["owner"])
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionClosed || e.ActionID != "plan" || e.UserID != "u-1" || e.Result != model.InteractionOK {
		t.Fatalf("history = %+v", e)
	}

	// A form that didn't ask is closed without a word; a failing app's
	// answer is recorded as a failure.
	quiet := f.openPlan(t, "u-1", false)
	if err := f.svc.CloseView(ctx, "u-1", quiet.ID, false, nil); err != nil || len(f.closedBodies(t)) != 1 {
		t.Fatalf("quiet close: %v, %d view_closed", err, len(f.closedBodies(t)))
	}
	loud := f.openPlan(t, "u-1", true)
	f.app.answer(http.StatusBadGateway, "", 0)
	if err := f.svc.CloseView(ctx, "u-1", loud.ID, false, nil); err != nil {
		t.Fatalf("close: %v", err)
	}
	if e := f.state.lastEntry("wh"); e.Kind != model.InteractionClosed || e.Result != model.InteractionFailed || e.Error != "answered 502" {
		t.Fatalf("history = %+v", e)
	}
}

// pushedStack opens planForm (notify) for u-1 and pushes two more on it;
// it returns them bottom first.
func (f *ixFixture) pushedStack(t *testing.T) []*model.View {
	t.Helper()
	root := f.openPlan(t, "u-1", true)
	stack := []*model.View{root}
	for range 2 {
		next, err := f.svc.PushView(context.Background(), f.wh, f.formTriggerOf(t, "u-1", stack[len(stack)-1].ID), planForm(true))
		if err != nil {
			t.Fatalf("push: %v", err)
		}
		stack = append(stack, next)
	}
	return stack
}

func TestCloseView_AllClosesTheStackAndOnlyTheTopCarriesWhatWasEntered(t *testing.T) {
	f := newIxFixture(t)
	inline(f)
	ctx := context.Background()
	stack := f.pushedStack(t)
	raw := map[string]map[string]RawValue{"note": {"text": {"top's note"}}}
	if err := f.svc.CloseView(ctx, "u-1", stack[2].ID, true, raw); err != nil {
		t.Fatalf("close all: %v", err)
	}
	if len(f.state.views) != 0 {
		t.Fatalf("forms left open: %d", len(f.state.views))
	}
	closed := f.closedBodies(t)
	if len(closed) != 3 {
		t.Fatalf("view_closed sent %d times", len(closed))
	}
	for i, p := range closed {
		if want := stack[2-i].ID; p.View.ID != want || p.IsCleared == nil || !*p.IsCleared {
			t.Fatalf("view_closed %d = %+v, want %s cleared", i, p, want)
		}
		note := p.View.State["values"]["note"]["text"].Value
		if (i == 0) != (note != nil) || (note != nil && *note != "top's note") {
			t.Fatalf("view_closed %d note = %v", i, note)
		}
	}
}

func TestCloseView_OneClosesOnlyTheTopAndTheOneUnderShowsAgain(t *testing.T) {
	f := newIxFixture(t)
	inline(f)
	stack := f.pushedStack(t)
	if err := f.svc.CloseView(context.Background(), "u-1", stack[2].ID, false, nil); err != nil {
		t.Fatalf("close: %v", err)
	}
	if _, open := f.state.views[stack[2].ID]; open || len(f.state.views) != 2 {
		t.Fatalf("open after closing the top: %d", len(f.state.views))
	}
	if closed := f.closedBodies(t); len(closed) != 1 || closed[0].View.ID != stack[2].ID || *closed[0].IsCleared {
		t.Fatalf("view_closed = %+v", closed)
	}
}

func TestCloseView_AllStopsWhereTheStackCantBeFollowed(t *testing.T) {
	for name, breakIt := range map[string]func(f *ixFixture, under string){
		"the form under it is gone":    func(f *ixFixture, under string) { delete(f.state.views, under) },
		"the form under it unreadable": func(f *ixFixture, under string) { f.state.getViewErrID = under },
		"the form under it is someone else's": func(f *ixFixture, under string) {
			f.state.views[under].UserID = "u-2"
		},
	} {
		t.Run(name, func(t *testing.T) {
			f := newIxFixture(t)
			inline(f)
			stack := f.pushedStack(t)
			breakIt(f, stack[1].ID)
			if err := f.svc.CloseView(context.Background(), "u-1", stack[2].ID, true, nil); err != nil {
				t.Fatalf("close all: %v", err)
			}
			if _, open := f.state.views[stack[2].ID]; open {
				t.Fatal("the top form stayed open")
			}
			if _, open := f.state.views[stack[0].ID]; !open {
				t.Fatal("a form past the break was closed")
			}
			if closed := f.closedBodies(t); len(closed) != 1 || closed[0].View.ID != stack[2].ID {
				t.Fatalf("view_closed = %+v", closed)
			}
		})
	}
}

func TestCloseView_TwoClosesAtOnceTellTheAppOnce(t *testing.T) {
	f := newIxFixture(t)
	inline(f)
	v := f.openPlan(t, "u-1", true)
	// Both closes read the form before either takes it: the race is real.
	var read sync.WaitGroup
	read.Add(2)
	f.state.onGetView = func() { read.Done(); read.Wait() }
	errs := make(chan error, 2)
	for range 2 {
		go func() { errs <- f.svc.CloseView(context.Background(), "u-1", v.ID, false, nil) }()
	}
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("close: %v", err)
		}
	}
	f.state.onGetView = nil
	if f.state.takes != 2 {
		t.Fatalf("takes = %d, want both closes to try", f.state.takes)
	}
	if closed := f.closedBodies(t); len(closed) != 1 {
		t.Fatalf("view_closed sent %d times, want once", len(closed))
	}
}

func TestCloseView_AnAppThatCantTakeItHearsNothing(t *testing.T) {
	for name, tc := range map[string]struct {
		set, reset func(f *ixFixture)
	}{
		"paused for failing": {func(f *ixFixture) { f.state.paused["wh"] = time.Minute }, func(f *ixFixture) { delete(f.state.paused, "wh") }},
		"paused by an admin": {func(f *ixFixture) { f.wh.AdminPaused = true }, func(f *ixFixture) { f.wh.AdminPaused = false }},
		"busy":               {func(f *ixFixture) { f.svc.inFlight["wh"] = maxAppClicksInFlight }, func(f *ixFixture) { delete(f.svc.inFlight, "wh") }},
		"gone":               {func(f *ixFixture) { delete(f.hooks.items, "wh") }, func(f *ixFixture) { f.hooks.items["wh"] = f.wh }},
		"no request URL":     {func(f *ixFixture) { f.wh.InteractivityURL = "" }, func(f *ixFixture) { f.wh.InteractivityURL = f.server.URL }},
	} {
		t.Run(name, func(t *testing.T) {
			f := newIxFixture(t)
			inline(f)
			v := f.openPlan(t, "u-1", true)
			tc.set(f)
			if err := f.svc.CloseView(context.Background(), "u-1", v.ID, false, nil); err != nil {
				t.Fatalf("close: %v", err)
			}
			tc.reset(f)
			if _, open := f.state.views[v.ID]; open {
				t.Fatal("the form stayed open")
			}
			if closed := f.closedBodies(t); len(closed) != 0 {
				t.Fatalf("view_closed sent %d times", len(closed))
			}
			if e := f.state.lastEntry("wh"); e.Kind == model.InteractionClosed {
				t.Fatalf("history = %+v", e)
			}
		})
	}
}

func TestCloseView_TellingTheAppDoesntHoldUpTheClose(t *testing.T) {
	// By default what nobody waits for runs on its own goroutine.
	f := newIxFixture(t)
	returned := make(chan struct{})
	ranAfter := make(chan bool, 1)
	f.svc.async(func() {
		select {
		case <-returned:
			ranAfter <- true
		case <-time.After(5 * time.Second):
			ranAfter <- false
		}
	})
	close(returned)
	if !<-ranAfter {
		t.Fatal("async ran inline, holding up its caller")
	}
}

// ---- a submission claims its form

// raceOnRead makes the next two form reads wait for each other, so two
// requests both find the form before either acts on it.
func (f *ixFixture) raceOnRead() {
	var read sync.WaitGroup
	read.Add(2)
	f.state.onGetView = func() { read.Done(); read.Wait() }
}

func (f *ixFixture) submissions(t *testing.T) int {
	t.Helper()
	f.app.mu.Lock()
	defer f.app.mu.Unlock()
	n := 0
	for _, raw := range f.app.bodies {
		if strings.Contains(string(raw), `"type":"view_submission"`) {
			n++
		}
	}
	return n
}

func TestSubmitView_ADoubleSubmitReachesTheAppOnce(t *testing.T) {
	f := newIxFixture(t)
	v := f.openForm(t, "u-1")
	f.raceOnRead()
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			_, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, standupAnswers())
			errs <- err
		}()
	}
	var lost int
	for range 2 {
		if err := <-errs; errors.Is(err, ErrViewNotFound) {
			lost++
		} else if err != nil {
			t.Fatalf("submit: %v", err)
		}
	}
	f.state.onGetView = nil
	if n := f.submissions(t); n != 1 || lost != 1 {
		t.Fatalf("view_submission sent %d times, %d submits told the form closed", n, lost)
	}
	if _, open := f.state.views[v.ID]; open {
		t.Fatal("the submitted form stayed open")
	}
}

func TestSubmitView_ASubmitRacingACloseIsOneOrTheOther(t *testing.T) {
	f := newIxFixture(t)
	inline(f)
	form := standupForm()
	form.NotifyOnClose = true
	v, err := f.svc.OpenView(context.Background(), f.wh, f.triggerFrom(t, "u-1"), form)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	f.raceOnRead()
	submitErr, closeErr := make(chan error, 1), make(chan error, 1)
	go func() {
		_, err := f.svc.SubmitView(context.Background(), "u-1", v.ID, standupAnswers())
		submitErr <- err
	}()
	go func() { closeErr <- f.svc.CloseView(context.Background(), "u-1", v.ID, false, nil) }()
	sErr, cErr := <-submitErr, <-closeErr
	f.state.onGetView = nil
	if cErr != nil || (sErr != nil && !errors.Is(sErr, ErrViewNotFound)) {
		t.Fatalf("submit %v, close %v", sErr, cErr)
	}
	submitted, closed := f.submissions(t), len(f.closedBodies(t))
	if submitted+closed != 1 || (sErr == nil) != (submitted == 1) {
		t.Fatalf("app got %d view_submission and %d view_closed (submit err %v)", submitted, closed, sErr)
	}
}

func TestSubmitView_TheClaimIsMadeOnlyOnceTheAppCanTakeIt(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	v := f.openForm(t, "u-1")
	// A busy app: the form isn't taken, so it can be sent later.
	f.svc.inFlight["wh"] = maxAppClicksInFlight
	if _, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers()); !errors.Is(err, ErrAppBusy) {
		t.Fatalf("busy: %v", err)
	}
	delete(f.svc.inFlight, "wh")
	if _, open := f.state.views[v.ID]; !open || f.state.takes != 0 {
		t.Fatalf("a busy app's form was taken (%d takes)", f.state.takes)
	}
	// Redis failing to claim it: nothing goes to the app.
	f.state.takeViewErr = errors.New("redis down")
	if _, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers()); err == nil || errors.Is(err, ErrViewNotFound) {
		t.Fatalf("claim failure: %v", err)
	}
	f.state.takeViewErr = nil
	if n := f.submissions(t); n != 0 {
		t.Fatalf("app got %d submissions", n)
	}
}

func TestSubmitView_AFormThatCantBePutBackIsGone(t *testing.T) {
	f := newIxFixture(t)
	ctx := context.Background()
	v := f.openForm(t, "u-1")
	f.app.reply = `{"response_action":"errors","errors":{"did":"Too vague"}}`
	f.state.saveViewErr = errors.New("redis down")
	res, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers())
	if err != nil || res.Action != ViewErrors || res.Errors["did"] != "Too vague" {
		t.Fatalf("errors: %+v %v", res, err)
	}
	f.state.saveViewErr = nil
	// The app's answer still shows; sending again says the form has closed.
	if _, err := f.svc.SubmitView(ctx, "u-1", v.ID, standupAnswers()); !errors.Is(err, ErrViewNotFound) {
		t.Fatalf("again: %v", err)
	}
}

func TestSubmitView_ClosingTheTopFormOfAStack(t *testing.T) {
	for name, tc := range map[string]struct {
		reply string
		left  int
	}{
		"no answer closes it alone": {"", 2},
		"clear closes them all":     {`{"response_action":"clear"}`, 0},
	} {
		t.Run(name, func(t *testing.T) {
			f := newIxFixture(t)
			inline(f)
			stack := f.pushedStack(t)
			f.app.reply = tc.reply
			raw := map[string]map[string]RawValue{"owner": {"who": {"u-2"}}}
			res, err := f.svc.SubmitView(context.Background(), "u-1", stack[2].ID, raw)
			if err != nil || res.Action != ViewClose {
				t.Fatalf("submit: %+v %v", res, err)
			}
			if len(f.state.views) != tc.left {
				t.Fatalf("%d forms open, want %d", len(f.state.views), tc.left)
			}
			if _, open := f.state.views[stack[2].ID]; open {
				t.Fatal("the submitted form stayed open")
			}
			// Submitted, not closed: the app hears no view_closed.
			if closed := f.closedBodies(t); len(closed) != 0 {
				t.Fatalf("view_closed = %+v", closed)
			}
		})
	}
}

func TestSubmitView_ClearingAStackWhoseFormsCantBeDeletedStillCloses(t *testing.T) {
	f := newIxFixture(t)
	stack := f.pushedStack(t)
	f.app.reply = `{"response_action":"clear","notice":"Saved"}`
	f.state.deleteViewErr = errors.New("redis down")
	res, err := f.svc.SubmitView(context.Background(), "u-1", stack[2].ID, map[string]map[string]RawValue{"owner": {"who": {"u-2"}}})
	if err != nil || res.Action != ViewClose || !res.Cleared || res.Notice != "Saved" {
		t.Fatalf("submit: %+v %v", res, err)
	}
	// The submitted form is taken; the ones under it outlive the failure
	// only until their TTL.
	if _, open := f.state.views[stack[2].ID]; open || len(f.state.views) != 2 {
		t.Fatalf("%d forms open", len(f.state.views))
	}
}
