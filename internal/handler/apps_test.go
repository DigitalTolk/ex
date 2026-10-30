package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// appAnswer is an /api/v1/apps/<method> answer, in Slack's shape.
type appAnswer struct {
	OK        bool       `json:"ok"`
	Error     string     `json:"error"`
	Message   string     `json:"message"`
	View      model.View `json:"view"`
	ChannelID string     `json:"channel_id"`
	MessageID string     `json:"message_id"`
	Version   int        `json:"version"`
}

func decodeAppAnswer(t *testing.T, rec *httptest.ResponseRecorder) appAnswer {
	t.Helper()
	var a appAnswer
	if err := json.Unmarshal(rec.Body.Bytes(), &a); err != nil {
		t.Fatalf("answer isn't JSON: %d %q", rec.Code, rec.Body.String())
	}
	return a
}

// appCallRequest is an app's call to ex: its bot token, a body of the given
// content type, and any extra headers (name, value, …).
func appCallRequest(fn http.HandlerFunc, token, contentType, body string, headers ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/apps/x", strings.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set("Content-Type", contentType)
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	rec := httptest.NewRecorder()
	fn(rec, req)
	return rec
}

func appJSON(fn http.HandlerFunc, token, body string, headers ...string) *httptest.ResponseRecorder {
	return appCallRequest(fn, token, "application/json", body, headers...)
}

func appForm(fn http.HandlerFunc, token string, form url.Values) *httptest.ResponseRecorder {
	return appCallRequest(fn, token, "application/x-www-form-urlencoded", form.Encode())
}

// expectAppError checks an app call failed with status and Slack error code.
func expectAppError(t *testing.T, what string, rec *httptest.ResponseRecorder, status int, code string) appAnswer {
	t.Helper()
	a := decodeAppAnswer(t, rec)
	if rec.Code != status || a.OK || a.Error != code || a.Message == "" {
		t.Errorf("%s: %d %s, want %d %s", what, rec.Code, rec.Body.String(), status, code)
	}
	return a
}

// botToken issues the app's bot token the way its owner does.
func (e *ixHandlerEnv) botToken(t *testing.T) string {
	t.Helper()
	rec := e.call(t, e.h.RotateBotToken, http.MethodPost, `{"revokeNow":false}`, model.SystemRoleMember)
	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil || out.Token == "" {
		t.Fatalf("bot token: %d %v", rec.Code, err)
	}
	return out.Token
}

// appButton puts an app button on the env's card.
func (e *ixHandlerEnv) appButton() {
	e.messages.messages["ch-1#m1"].Blocks = model.Blocks{{Type: model.BlockActions, BlockID: "b1", Elements: []model.BlockElement{
		{Type: model.ElementButton, ActionID: "review", Text: &model.TextObject{Type: model.TextPlain, Text: "Review"}},
	}}}
}

// triggerFor clicks the card's app button from browser tab clickID and
// returns the trigger_id the app got with the click.
func (e *ixHandlerEnv) triggerFor(t *testing.T, clickID string) string {
	t.Helper()
	var trigger string
	app := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		var p struct {
			TriggerID string `json:"trigger_id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&p)
		trigger = p.TriggerID
	}))
	defer app.Close()
	e.hooks.items["wh"].InteractivityURL = app.URL
	e.appButton()
	button, _ := service.ButtonAt(e.messages.messages["ch-1#m1"], "b1", "review")
	ctx := service.WithClickID(context.Background(), clickID)
	if _, err := e.svc.Click(ctx, e.messages.messages["ch-1#m1"], service.ParentChannel, button, "b1", "u-1"); err != nil || trigger == "" {
		t.Fatalf("click for a trigger: %v %q", err, trigger)
	}
	return trigger
}

// reviewForm is a form with one field of each kind.
const reviewForm = `{"type":"modal","callback_id":"review","external_id":"ext-1","private_metadata":"m1",
	"title":{"type":"plain_text","text":"Review"},"submit":{"type":"plain_text","text":"Save"},
	"blocks":[
		{"type":"input","block_id":"notes","label":{"type":"plain_text","text":"Notes"},"element":{"type":"plain_text_input","action_id":"text","multiline":true}},
		{"type":"input","block_id":"due","label":{"type":"plain_text","text":"Due"},"element":{"type":"datepicker","action_id":"date"}},
		{"type":"input","block_id":"day","label":{"type":"plain_text","text":"Day"},"element":{"type":"static_select","action_id":"pick","options":[
			{"text":{"type":"plain_text","text":"Monday"},"value":"mon"},{"text":{"type":"plain_text","text":"Friday"},"value":"fri"}]}}
	]}`

func submitView(h *InteractionHandler, userID, viewID, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/views/"+viewID+"/submit", strings.NewReader(body))
	req.SetPathValue("id", viewID)
	rec := httptest.NewRecorder()
	h.SubmitView(rec, asUser(req, userID, model.SystemRoleMember))
	return rec
}

func closeView(h *InteractionHandler, userID, viewID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/views/"+viewID+"/close", nil)
	req.SetPathValue("id", viewID)
	rec := httptest.NewRecorder()
	h.CloseView(rec, asUser(req, userID, model.SystemRoleMember))
	return rec
}

// The whole round: a person clicks the card's button in one browser tab;
// the app, answering the click, opens a form with the click's trigger_id;
// the person submits it, the app asks for a fix, they submit again, and
// the app closes it.
func TestAppsFlow_ClickOpensFormSubmitFixClose(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	e.appButton()

	type submission struct {
		View struct {
			ID         string                                             `json:"id"`
			CallbackID string                                             `json:"callback_id"`
			State      map[string]map[string]map[string]service.ViewValue `json:"state"`
		} `json:"view"`
	}
	var (
		mu          sync.Mutex
		opened      *httptest.ResponseRecorder
		submissions []submission
	)
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var p struct {
			Type      string `json:"type"`
			TriggerID string `json:"trigger_id"`
		}
		_ = json.Unmarshal(raw, &p)
		mu.Lock()
		defer mu.Unlock()
		switch p.Type {
		case "block_actions":
			// The app opens its form while answering the click.
			opened = appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+p.TriggerID+`","view":`+reviewForm+`}`)
		case "view_submission":
			var s submission
			_ = json.Unmarshal(raw, &s)
			submissions = append(submissions, s)
			if len(submissions) == 1 {
				_, _ = w.Write([]byte(`{"response_action":"errors","errors":{"notes":"Say a little more"}}`))
			}
		}
	}))
	defer app.Close()
	e.hooks.items["wh"].InteractivityURL = app.URL

	memberships := newDataMembershipStore()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1", Role: model.ChannelRoleMember}
	msgSvc := service.NewMessageService(e.messages, memberships, nil, nil, nil)
	msgSvc.SetAppClicker(e.svc)
	channels := NewChannelHandler(nil, msgSvc)

	rec := httptest.NewRecorder()
	channels.Act(rec, clickRequest(t, "ch-1", "m1", `{"blockID":"b1","actionID":"review","clickID":"tab-7"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("click: %d %s", rec.Code, rec.Body.String())
	}
	if opened == nil {
		t.Fatal("the app never got the click")
	}
	form := decodeAppAnswer(t, opened)
	if opened.Code != http.StatusOK || !form.OK || form.View.ID == "" || form.View.Hash == "" || form.View.Title.Text != "Review" {
		t.Fatalf("views.open: %d %s", opened.Code, opened.Body.String())
	}
	stored := e.state.views[form.View.ID]
	if stored == nil || stored.UserID != "u-1" || stored.WebhookID != "wh" || stored.ClickID != "tab-7" {
		t.Fatalf("stored form: %+v", stored)
	}

	// Someone else can't submit this person's form.
	if rec := submitView(e.h, "u-2", form.View.ID, `{"values":{}}`); rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"view_not_found"`) {
		t.Fatalf("another person's submit: %d %s", rec.Code, rec.Body.String())
	}
	// A required field left empty never reaches the app.
	rec = submitView(e.h, "u-1", form.View.ID, `{"values":{"notes":{"text":"ok"},"due":{"date":"2026-11-02"}}}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"action":"errors"`) || !strings.Contains(rec.Body.String(), `"day":"Please choose one."`) || len(submissions) != 0 {
		t.Fatalf("incomplete submit: %d %s (app saw %d)", rec.Code, rec.Body.String(), len(submissions))
	}

	values := `{"values":{"notes":{"text":"ok"},"due":{"date":"2026-11-02"},"day":{"pick":"fri"}}}`
	rec = submitView(e.h, "u-1", form.View.ID, values)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"action":"errors"`) || !strings.Contains(rec.Body.String(), `"notes":"Say a little more"`) {
		t.Fatalf("first submit: %d %s", rec.Code, rec.Body.String())
	}
	if len(submissions) != 1 {
		t.Fatalf("the app got %d submissions", len(submissions))
	}
	got := submissions[0].View
	if got.ID != form.View.ID || got.CallbackID != "review" {
		t.Fatalf("submitted view: %+v", got)
	}
	vals := got.State["values"]
	if v := vals["notes"]["text"].Value; v == nil || *v != "ok" {
		t.Errorf("notes = %v", v)
	}
	if d := vals["due"]["date"].SelectedDate; d == nil || *d != "2026-11-02" {
		t.Errorf("due = %v", d)
	}
	// The option comes from the stored form: its label too.
	if o := vals["day"]["pick"].SelectedOption; o == nil || o.Value != "fri" || o.Text.Text != "Friday" {
		t.Errorf("day = %+v", o)
	}
	if e.state.views[form.View.ID] == nil {
		t.Fatal("a form with errors must stay open")
	}

	rec = submitView(e.h, "u-1", form.View.ID, strings.Replace(values, `"ok"`, `"ok, ship it"`, 1))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"action":"close"`) {
		t.Fatalf("second submit: %d %s", rec.Code, rec.Body.String())
	}
	if e.state.views[form.View.ID] != nil {
		t.Fatal("a closed form must be forgotten")
	}
	// Submitting it again: it has closed.
	if rec := submitView(e.h, "u-1", form.View.ID, values); rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"view_not_found"`) {
		t.Fatalf("submit after close: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAct_ClickIDMustBePlain(t *testing.T) {
	env := setupChannelHandlerFull(t)
	for _, id := range []string{"has space", "tab/1", strings.Repeat("a", 65)} {
		rec := httptest.NewRecorder()
		env.handler.Act(rec, clickRequest(t, "ch-a", "m1", `{"blockID":"row","actionID":"ack","clickID":"`+id+`"}`))
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "clickID") {
			t.Errorf("clickID %q: %d %s", id, rec.Code, rec.Body.String())
		}
	}
	for _, id := range []string{"a", "tab-7_X", strings.Repeat("a", 64)} {
		if !clickIDPattern.MatchString(id) {
			t.Errorf("clickID %q should be accepted", id)
		}
	}
}

func TestViewsOpen(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)

	trigger := e.triggerFor(t, "")
	rec := appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+trigger+`","view":`+reviewForm+`}`)
	if a := decodeAppAnswer(t, rec); rec.Code != http.StatusOK || !a.OK || a.View.ID == "" || a.View.ExternalID != "ext-1" {
		t.Fatalf("open: %d %s", rec.Code, rec.Body.String())
	}
	// A trigger_id is good once.
	expectAppError(t, "reused trigger", appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+trigger+`","view":`+reviewForm+`}`), http.StatusBadRequest, "expired_trigger_id")
	expectAppError(t, "unknown trigger", appJSON(e.h.ViewsOpen, token, `{"trigger_id":"t_nope","view":`+reviewForm+`}`), http.StatusBadRequest, "expired_trigger_id")
	expectAppError(t, "not a view", appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+e.triggerFor(t, "")+`","view":{"type":"home","title":{"type":"plain_text","text":"x"}}}`), http.StatusBadRequest, "invalid_view")
	expectAppError(t, "malformed body", appJSON(e.h.ViewsOpen, token, `{"view":[1]}`), http.StatusBadRequest, "invalid_arguments")

	// While that form is open, its external_id names it alone.
	expectAppError(t, "duplicate external_id", appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+e.triggerFor(t, "")+`","view":`+reviewForm+`}`), http.StatusConflict, "duplicate_external_id")

	// Slack's form encoding: the view is JSON text.
	rec = appForm(e.h.ViewsOpen, token, url.Values{"trigger_id": {e.triggerFor(t, "tab-2")}, "view": {strings.Replace(reviewForm, "ext-1", "ext-2", 1)}})
	if a := decodeAppAnswer(t, rec); rec.Code != http.StatusOK || !a.OK || len(a.View.Blocks) != 3 {
		t.Fatalf("form-encoded open: %d %s", rec.Code, rec.Body.String())
	}

	// An app an admin paused can't open forms.
	trigger = e.triggerFor(t, "")
	e.hooks.items["wh"].AdminPaused = true
	expectAppError(t, "paused app", appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+trigger+`","view":`+reviewForm+`}`), http.StatusConflict, "app_unavailable")
}

func TestViewsUpdate(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	open := decodeAppAnswer(t, appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+e.triggerFor(t, "")+`","view":`+reviewForm+`}`))
	retitled := strings.Replace(reviewForm, `"text":"Review"`, `"text":"Review A3"`, 1)

	body, _ := json.Marshal(map[string]any{"view_id": open.View.ID, "hash": open.View.Hash, "view": json.RawMessage(retitled)})
	rec := appJSON(e.h.ViewsUpdate, token, string(body))
	updated := decodeAppAnswer(t, rec)
	if rec.Code != http.StatusOK || !updated.OK || updated.View.ID != open.View.ID || updated.View.Title.Text != "Review A3" || updated.View.Hash == open.View.Hash {
		t.Fatalf("update by id: %d %s", rec.Code, rec.Body.String())
	}
	if e.state.views[open.View.ID].View.Title.Text != "Review A3" {
		t.Fatal("the stored form wasn't updated")
	}
	// The old hash is stale now: two updates can't overwrite each other.
	expectAppError(t, "stale hash", appJSON(e.h.ViewsUpdate, token, string(body)), http.StatusConflict, "hash_conflict")

	// Found by the app's external_id instead.
	body, _ = json.Marshal(map[string]any{"external_id": "ext-1", "view": json.RawMessage(reviewForm)})
	if a := decodeAppAnswer(t, appJSON(e.h.ViewsUpdate, token, string(body))); !a.OK || a.View.ID != open.View.ID || a.View.Title.Text != "Review" {
		t.Fatalf("update by external id: %+v", a)
	}

	expectAppError(t, "unknown view", appJSON(e.h.ViewsUpdate, token, `{"view_id":"V-nope","view":`+reviewForm+`}`), http.StatusNotFound, "view_not_found")
	expectAppError(t, "unknown external id", appJSON(e.h.ViewsUpdate, token, `{"external_id":"nope","view":`+reviewForm+`}`), http.StatusNotFound, "view_not_found")
	expectAppError(t, "invalid view", appJSON(e.h.ViewsUpdate, token, `{"view_id":"`+open.View.ID+`","view":{"type":"modal","title":{"type":"plain_text","text":"x"},"blocks":[]}}`), http.StatusBadRequest, "invalid_view")
	expectAppError(t, "malformed body", appJSON(e.h.ViewsUpdate, token, `{"view_id":7}`), http.StatusBadRequest, "invalid_arguments")
}

func TestMessagesUpdate(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	e.messages.messages["ch-1#human"] = &model.Message{ID: "human", ParentID: "ch-1", AuthorID: "u-1", Body: "hi"}

	rec := appJSON(e.h.MessagesUpdate, token, `{"channel_id":"ch-1","message_id":"m1","text":"Reviewed by Ana"}`)
	a := decodeAppAnswer(t, rec)
	if rec.Code != http.StatusOK || !a.OK || a.ChannelID != "ch-1" || a.MessageID != "m1" || a.Version != 1 {
		t.Fatalf("update: %d %s", rec.Code, rec.Body.String())
	}
	if m := e.messages.messages["ch-1#m1"]; m.Body != "Reviewed by Ana" || m.Version != 1 {
		t.Fatalf("stored message: %q v%d", m.Body, m.Version)
	}

	// Form-encoded, Slack style: blocks are JSON text, if_version a number.
	rec = appForm(e.h.MessagesUpdate, token, url.Values{
		"channel_id": {"ch-1"}, "message_id": {"m1"}, "if_version": {"1"},
		"blocks": {`[{"type":"section","text":{"type":"mrkdwn","text":"**Done**"}}]`},
	})
	if a := decodeAppAnswer(t, rec); rec.Code != http.StatusOK || !a.OK || a.Version != 2 {
		t.Fatalf("form-encoded update: %d %s", rec.Code, rec.Body.String())
	}
	if m := e.messages.messages["ch-1#m1"]; len(m.Blocks) != 1 || m.Blocks[0].Text.Text != "**Done**" {
		t.Fatalf("stored blocks: %+v", m.Blocks)
	}

	expectAppError(t, "stale version", appForm(e.h.MessagesUpdate, token, url.Values{"channel_id": {"ch-1"}, "message_id": {"m1"}, "text": {"x"}, "if_version": {"1"}}), http.StatusConflict, "version_conflict")
	expectAppError(t, "non-numeric version", appForm(e.h.MessagesUpdate, token, url.Values{"channel_id": {"ch-1"}, "message_id": {"m1"}, "if_version": {"one"}}), http.StatusBadRequest, "invalid_arguments")
	expectAppError(t, "a person's message", appJSON(e.h.MessagesUpdate, token, `{"channel_id":"ch-1","message_id":"human","text":"x"}`), http.StatusForbidden, "cant_update_message")
	expectAppError(t, "missing message", appJSON(e.h.MessagesUpdate, token, `{"channel_id":"ch-1","message_id":"nope","text":"x"}`), http.StatusNotFound, "message_not_found")
	expectAppError(t, "no ids", appJSON(e.h.MessagesUpdate, token, `{"text":"x"}`), http.StatusBadRequest, "invalid_arguments")
	expectAppError(t, "bad blocks", appJSON(e.h.MessagesUpdate, token, `{"channel_id":"ch-1","message_id":"m1","blocks":[{"type":"header"}]}`), http.StatusBadRequest, "invalid_blocks")
	expectAppError(t, "malformed body", appJSON(e.h.MessagesUpdate, token, `{"channel_id":1}`), http.StatusBadRequest, "invalid_arguments")
	if m := e.messages.messages["ch-1#m1"]; m.Version != 2 {
		t.Fatalf("a refused update changed the message: v%d", m.Version)
	}
}

func TestAppCall_IdempotencyKey(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	body := `{"channel_id":"ch-1","message_id":"m1","text":"Reviewed"}`

	first := appJSON(e.h.MessagesUpdate, token, body, "Idempotency-Key", "k1")
	retry := appJSON(e.h.MessagesUpdate, token, body, "Idempotency-Key", "k1")
	if first.Code != http.StatusOK || retry.Code != http.StatusOK || first.Body.String() != retry.Body.String() || retry.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("retry: %d %s / %d %s", first.Code, first.Body.String(), retry.Code, retry.Body.String())
	}
	if v := e.messages.messages["ch-1#m1"].Version; v != 1 {
		t.Fatalf("the retry ran again: v%d", v)
	}
	// A key that is per method: the same key on another method runs.
	expectAppError(t, "same key, other method", appJSON(e.h.ViewsOpen, token, `{"trigger_id":"t_x","view":`+reviewForm+`}`, "Idempotency-Key", "k1"), http.StatusBadRequest, "expired_trigger_id")

	// The first call with this key is still running.
	e.state.idem["wh:messages.update"+"k2"] = nil
	expectAppError(t, "in progress", appJSON(e.h.MessagesUpdate, token, body, "Idempotency-Key", "k2"), http.StatusConflict, "idempotency_in_progress")
	expectAppError(t, "long key", appJSON(e.h.MessagesUpdate, token, body, "Idempotency-Key", strings.Repeat("k", 256)), http.StatusBadRequest, "invalid_arguments")
}

func TestAppCall_Auth(t *testing.T) {
	e := newIxHandlerEnv(t)
	e.botToken(t)
	for name, fn := range map[string]http.HandlerFunc{"views.open": e.h.ViewsOpen, "views.update": e.h.ViewsUpdate, "messages.update": e.h.MessagesUpdate} {
		expectAppError(t, name+" without a token", appJSON(fn, "", `{}`), http.StatusUnauthorized, "invalid_auth")
		expectAppError(t, name+" with another token", appJSON(fn, "exb_nope", `{}`), http.StatusUnauthorized, "invalid_auth")
	}

	// The apps can't be read: the server's own failure, nothing leaked.
	e.hooks.listErr = errors.New("dynamo down")
	rec := appJSON(e.h.MessagesUpdate, "exb_any", `{}`)
	if rec.Code != http.StatusInternalServerError || strings.Contains(rec.Body.String(), "dynamo") {
		t.Fatalf("store failure: %d %s", rec.Code, rec.Body.String())
	}
}

// refuseAppCalls is a limiter whose apps are over their budget.
type refuseAppCalls struct{ retry time.Duration }

func (refuseAppCalls) AllowClick(context.Context, string) (bool, error) { return true, nil }
func (l refuseAppCalls) AllowAppCall(context.Context, string) (bool, time.Duration, error) {
	return false, l.retry, nil
}

func TestAppCall_RateLimitedSaysWhenToRetry(t *testing.T) {
	e := newIxHandlerEnvWith(t, refuseAppCalls{retry: 1500 * time.Millisecond})
	token := e.botToken(t)
	rec := appJSON(e.h.MessagesUpdate, token, `{"channel_id":"ch-1","message_id":"m1","text":"x"}`)
	expectAppError(t, "over budget", rec, http.StatusTooManyRequests, "ratelimited")
	if got := rec.Header().Get("Retry-After"); got != "2" {
		t.Fatalf("Retry-After = %q, want 2", got)
	}
	if e.messages.messages["ch-1#m1"].Body != "card" {
		t.Fatal("a refused call changed the message")
	}
}

func TestAppCall_BodyLimits(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	big := `{"text":"` + strings.Repeat("a", int(maxWebhookBodyBytes)) + `"}`
	if a := expectAppError(t, "over 1 MB", appJSON(e.h.MessagesUpdate, token, big), http.StatusBadRequest, "invalid_arguments"); !strings.Contains(a.Message, "1 MB") {
		t.Errorf("message = %q", a.Message)
	}
	rec := appCallRequest(e.h.MessagesUpdate, token, "application/x-www-form-urlencoded", "channel_id=%zz")
	if a := expectAppError(t, "unreadable form", rec, http.StatusBadRequest, "invalid_arguments"); !strings.Contains(a.Message, "form body") {
		t.Errorf("message = %q", a.Message)
	}
}

func TestReadAppBody(t *testing.T) {
	read := func(contentType, body string) (map[string]any, error) {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		req.Header.Set("Content-Type", contentType)
		raw, err := readAppBody(req)
		if err != nil {
			return nil, err
		}
		var out map[string]any
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("not JSON: %s", raw)
		}
		return out, nil
	}

	// JSON passes through as sent.
	if got, err := read("application/json", `{"if_version":"3","view":{"a":1}}`); err != nil || got["if_version"] != "3" {
		t.Fatalf("json: %v %v", got, err)
	}
	form := url.Values{
		"view":       {`  {"type":"modal"}`},
		"blocks":     {`[{"type":"divider"}]`},
		"if_version": {"3"},
		"message_id": {"42"},
		"text":       {"{not json"},
		"channel_id": {"ch-1"},
	}
	got, err := read("application/x-www-form-urlencoded; charset=utf-8", form.Encode())
	if err != nil {
		t.Fatalf("form: %v", err)
	}
	want := map[string]any{
		"view":       map[string]any{"type": "modal"},
		"blocks":     []any{map[string]any{"type": "divider"}},
		"if_version": float64(3),
		"message_id": "42", // only if_version is a number
		"text":       "{not json",
		"channel_id": "ch-1",
	}
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("form fields:\n got %s\nwant %s", gotJSON, wantJSON)
	}
	if got, _ := read("application/x-www-form-urlencoded", "if_version=soon"); got["if_version"] != "soon" {
		t.Fatalf("non-numeric if_version: %v", got)
	}
	if _, err := read("application/x-www-form-urlencoded", "a=%zz"); err == nil {
		t.Fatal("an unreadable form must be an error")
	}
}

func TestAppError_EveryRow(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{apperr.Reject(service.ErrInvalidAuth, "x"), http.StatusUnauthorized, "invalid_auth"},
		{&service.RateLimitedError{RetryAfter: time.Second}, http.StatusTooManyRequests, "ratelimited"},
		{apperr.Reject(service.ErrTriggerExpired, "x"), http.StatusBadRequest, "expired_trigger_id"},
		{apperr.Reject(service.ErrInvalidView, "x"), http.StatusBadRequest, "invalid_view"},
		{apperr.Reject(service.ErrInvalidBlocks, "x"), http.StatusBadRequest, "invalid_blocks"},
		{apperr.Reject(service.ErrViewNotFound, "x"), http.StatusNotFound, "view_not_found"},
		{apperr.Reject(service.ErrHashConflict, "x"), http.StatusConflict, "hash_conflict"},
		{apperr.Reject(service.ErrDuplicateExternalID, "x"), http.StatusConflict, "duplicate_external_id"},
		{apperr.Reject(service.ErrCantUpdateMessage, "x"), http.StatusForbidden, "cant_update_message"},
		{apperr.Reject(service.ErrAppVersionConflict, "x"), http.StatusConflict, "version_conflict"},
		{apperr.Reject(service.ErrAppUnavailable, "x"), http.StatusConflict, "app_unavailable"},
		{apperr.Reject(service.ErrIdempotencyInProgress, "x"), http.StatusConflict, "idempotency_in_progress"},
		{apperr.NotFound("x"), http.StatusNotFound, "message_not_found"},
		{apperr.Invalid("x"), http.StatusBadRequest, "invalid_arguments"},
		{errors.New("boom"), http.StatusInternalServerError, ""},
	} {
		status, code := appError(c.err)
		if status != c.status || code != c.code {
			t.Errorf("%v: %d %q, want %d %q", c.err, status, code, c.status, c.code)
		}
		rec := httptest.NewRecorder()
		writeAppError(rec, httptest.NewRequest(http.MethodPost, "/api/v1/apps/x", nil), c.err)
		if rec.Code != c.status {
			t.Errorf("%v written as %d", c.err, rec.Code)
		}
		if c.status == http.StatusInternalServerError {
			if strings.Contains(rec.Body.String(), "boom") || strings.Contains(rec.Body.String(), `"ok"`) {
				t.Errorf("a server failure leaked: %s", rec.Body.String())
			}
			continue
		}
		if a := decodeAppAnswer(t, rec); a.OK || a.Error != c.code || a.Message != c.err.Error() {
			t.Errorf("%v: body %s", c.err, rec.Body.String())
		}
		if got, want := rec.Header().Get("Retry-After"), map[bool]string{true: "1"}[c.code == "ratelimited"]; got != want {
			t.Errorf("%v: Retry-After %q, want %q", c.err, got, want)
		}
	}
}

func TestSubmitAndCloseView_Refusals(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	open := decodeAppAnswer(t, appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+e.triggerFor(t, "")+`","view":`+reviewForm+`}`))

	if rec := submitView(e.h, "u-1", open.View.ID, `{"values":`); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_body"`) {
		t.Fatalf("bad body: %d %s", rec.Code, rec.Body.String())
	}
	// Only its person closes it; anyone else's close changes nothing.
	if rec := closeView(e.h, "u-2", open.View.ID); rec.Code != http.StatusNoContent || e.state.views[open.View.ID] == nil {
		t.Fatalf("another person's close: %d", rec.Code)
	}

	// The form store is down: a server failure, not "closed".
	e.state.viewErr = errors.New("redis down")
	if rec := submitView(e.h, "u-1", open.View.ID, `{"values":{}}`); rec.Code != http.StatusInternalServerError {
		t.Fatalf("submit, store down: %d %s", rec.Code, rec.Body.String())
	}
	if rec := closeView(e.h, "u-1", open.View.ID); rec.Code != http.StatusInternalServerError {
		t.Fatalf("close, store down: %d %s", rec.Code, rec.Body.String())
	}
	e.state.viewErr = nil

	if rec := closeView(e.h, "u-1", open.View.ID); rec.Code != http.StatusNoContent || e.state.views[open.View.ID] != nil {
		t.Fatalf("close: %d", rec.Code)
	}
	// Closing a form already gone is fine.
	if rec := closeView(e.h, "u-1", open.View.ID); rec.Code != http.StatusNoContent {
		t.Fatalf("close again: %d", rec.Code)
	}
}

// The app's calls and the person's form routes are registered: the app
// routes answer without a session (their bot token is the credential), the
// form routes need one.
func TestRouterRegistersAppAndViewRoutes(t *testing.T) {
	e := newIxHandlerEnv(t)
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{}, Interaction: e.h,
		JWT: auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour), AppVersion: "test", AllowOrigins: []string{"*"},
	})
	for _, p := range []string{"/api/v1/apps/views.open", "/api/v1/apps/views.update", "/api/v1/apps/messages.update"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, p, strings.NewReader(`{}`)))
		if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"error":"invalid_auth"`) {
			t.Errorf("%s: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	for _, p := range []string{"/api/v1/views/V1/submit", "/api/v1/views/V1/close"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, p, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without a session: %d", p, rec.Code)
		}
	}
}
