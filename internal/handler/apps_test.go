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
	"strconv"
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
	if _, err := e.svc.Click(ctx, e.messages.messages["ch-1#m1"], service.ParentChannel, button, "b1", "u-1", nil); err != nil || trigger == "" {
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
	for name, fn := range map[string]http.HandlerFunc{"views.open": e.h.ViewsOpen, "views.update": e.h.ViewsUpdate, "views.push": e.h.ViewsPush, "messages.update": e.h.MessagesUpdate} {
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
		{apperr.Reject(service.ErrPushNotAllowed, "x"), http.StatusBadRequest, "push_not_allowed"},
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
	for _, p := range []string{"/api/v1/apps/views.open", "/api/v1/apps/views.update", "/api/v1/apps/views.push", "/api/v1/apps/messages.update"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, p, strings.NewReader(`{}`)))
		if rec.Code != http.StatusUnauthorized || !strings.Contains(rec.Body.String(), `"error":"invalid_auth"`) {
			t.Errorf("%s: %d %s", p, rec.Code, rec.Body.String())
		}
	}
	for _, p := range []string{"/api/v1/views/V1/submit", "/api/v1/views/V1/close", "/api/v1/views/V1/actions", "/api/v1/admin/webhooks/preview-view"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, p, nil))
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without a session: %d", p, rec.Code)
		}
	}
}

// ---- stacked forms, changes inside a form, picks on a card

// viewCall sends a person's request to one of their form's routes (submit,
// close, actions); an empty body sends none.
func viewCall(fn http.HandlerFunc, userID, viewID, route, body string) *httptest.ResponseRecorder {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/views/"+viewID+"/"+route, rd)
	req.SetPathValue("id", viewID)
	rec := httptest.NewRecorder()
	fn(rec, asUser(req, userID, model.SystemRoleMember))
	return rec
}

// planForm is a form whose "Add a step" button and "Lane" picker go to the
// app as the person uses them, and whose due date does too.
const planForm = `{"type":"modal","callback_id":"plan","title":{"type":"plain_text","text":"Plan"},"submit":{"type":"plain_text","text":"Save"},
	"blocks":[
		{"type":"input","block_id":"notes","label":{"type":"plain_text","text":"Notes"},"element":{"type":"plain_text_input","action_id":"text"}},
		{"type":"input","block_id":"due","dispatch_action":true,"label":{"type":"plain_text","text":"Due"},"element":{"type":"datepicker","action_id":"date"}},
		{"type":"input","block_id":"tags","optional":true,"label":{"type":"plain_text","text":"Tags"},"element":{"type":"checkboxes","action_id":"tick","options":[
			{"text":{"type":"plain_text","text":"Urgent"},"value":"urgent"},{"text":{"type":"plain_text","text":"Customer"},"value":"customer"}]}},
		{"type":"actions","block_id":"steps","elements":[
			{"type":"button","action_id":"add","value":"s1","text":{"type":"plain_text","text":"Add a step"}},
			{"type":"static_select","action_id":"lane","options":[
				{"text":{"type":"plain_text","text":"Backend"},"value":"be"},{"text":{"type":"plain_text","text":"Frontend"},"value":"fe"}]},
			{"type":"button","action_id":"docs","url":"https://example.com/docs","text":{"type":"plain_text","text":"Docs"}}
		]}
	]}`

// stepForm is what the app pushes on a form: it asks to hear when it is
// closed, and has its own button to push one more.
const stepForm = `{"type":"modal","callback_id":"step","notify_on_close":true,"title":{"type":"plain_text","text":"Step"},"submit":{"type":"plain_text","text":"Add"},
	"blocks":[
		{"type":"input","block_id":"step","label":{"type":"plain_text","text":"Step"},"element":{"type":"plain_text_input","action_id":"name"}},
		{"type":"actions","block_id":"more","elements":[{"type":"button","action_id":"deeper","text":{"type":"plain_text","text":"Add a sub-step"}}]}
	]}`

// formAppCall is one request the stacking app got: its kind, and the parts
// of it the tests look at.
type formAppCall struct {
	Type      string `json:"type"`
	TriggerID string `json:"trigger_id"`
	IsCleared *bool  `json:"is_cleared"`
	Container struct {
		Type   string `json:"type"`
		ViewID string `json:"view_id"`
	} `json:"container"`
	View struct {
		ID         string                                             `json:"id"`
		CallbackID string                                             `json:"callback_id"`
		RootViewID string                                             `json:"root_view_id"`
		State      map[string]map[string]map[string]service.ViewValue `json:"state"`
	} `json:"view"`
	Actions []struct {
		ActionID        string               `json:"action_id"`
		BlockID         string               `json:"block_id"`
		Value           string               `json:"value"`
		SelectedOption  *model.SelectOption  `json:"selected_option"`
		SelectedOptions []model.SelectOption `json:"selected_options"`
		SelectedDate    *string              `json:"selected_date"`
	} `json:"actions"`
}

// stackingApp is an app that, for every change in one of its forms,
// pushes stepForm on it through views.push — with the trigger_id the change
// carried — and answers with a notice. Closed forms it was told about
// arrive on closed.
type stackingApp struct {
	mu     sync.Mutex
	calls  []formAppCall
	pushes []*httptest.ResponseRecorder
	closed chan formAppCall
}

func (e *ixHandlerEnv) stackingApp(t *testing.T, token string) *stackingApp {
	t.Helper()
	a := &stackingApp{closed: make(chan formAppCall, 8)}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p formAppCall
		_ = json.NewDecoder(r.Body).Decode(&p)
		if p.Type == "view_closed" {
			a.closed <- p
			return
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		a.calls = append(a.calls, p)
		if p.Type == "block_actions" && p.Container.Type == "view" {
			a.pushes = append(a.pushes, appJSON(e.h.ViewsPush, token, `{"trigger_id":"`+p.TriggerID+`","view":`+stepForm+`}`))
			_, _ = w.Write([]byte(`{"notice":"Step added"}`))
		}
	}))
	t.Cleanup(srv.Close)
	e.hooks.items["wh"].InteractivityURL = srv.URL
	return a
}

func (a *stackingApp) last(t *testing.T) (formAppCall, *httptest.ResponseRecorder) {
	t.Helper()
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.calls) == 0 || len(a.pushes) == 0 {
		t.Fatal("the app never got the change")
	}
	return a.calls[len(a.calls)-1], a.pushes[len(a.pushes)-1]
}

// nextClosed waits for the app to hear that a form closed: ex tells it in
// the background, after answering the person.
func (a *stackingApp) nextClosed(t *testing.T) formAppCall {
	t.Helper()
	select {
	case p := <-a.closed:
		return p
	case <-time.After(5 * time.Second):
		t.Fatal("the app never heard the form closed")
		return formAppCall{}
	}
}

// openPlan opens planForm the way an app does: from a click in tab-3.
func (e *ixHandlerEnv) openPlan(t *testing.T, token string) model.View {
	t.Helper()
	rec := appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+e.triggerFor(t, "tab-3")+`","view":`+planForm+`}`)
	a := decodeAppAnswer(t, rec)
	if rec.Code != http.StatusOK || !a.OK {
		t.Fatalf("open plan: %d %s", rec.Code, rec.Body.String())
	}
	return a.View
}

// A person presses a button inside a form; the app, answering, pushes a
// second form on it with the trigger_id that press carried. Pressing the
// second form's button pushes a third; a fourth is past the stack's limit.
// Closing the top one with "all" closes the whole stack, and the app hears
// about each form that asked.
func TestAppsFlow_FormButtonPushesFormsAndCloseAllEndsTheStack(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	root := e.openPlan(t, token)
	app := e.stackingApp(t, token)

	rec := viewCall(e.h.ViewAction, "u-1", root.ID, "actions",
		`{"blockID":"steps","actionID":"add","values":{"notes":{"text":"draft"},"tags":{"tick":["urgent"]}}}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"notice":"Step added"`) || strings.Contains(rec.Body.String(), `"failed"`) {
		t.Fatalf("press: %d %s", rec.Code, rec.Body.String())
	}
	got, pushed := app.last(t)
	if got.Container.ViewID != root.ID || got.View.ID != root.ID || got.View.CallbackID != "plan" || got.TriggerID == "" {
		t.Fatalf("the app's request: %+v", got)
	}
	if len(got.Actions) != 1 || got.Actions[0].ActionID != "add" || got.Actions[0].BlockID != "steps" || got.Actions[0].Value != "s1" {
		t.Fatalf("the action: %+v", got.Actions)
	}
	// The form as it stands comes along, read against the stored form.
	state := got.View.State["values"]
	if v := state["notes"]["text"].Value; v == nil || *v != "draft" {
		t.Errorf("notes = %v", v)
	}
	if o := state["tags"]["tick"].SelectedOptions; len(o) != 1 || o[0].Value != "urgent" || o[0].Text.Text != "Urgent" {
		t.Errorf("tags = %+v", o)
	}

	step := decodeAppAnswer(t, pushed)
	if pushed.Code != http.StatusOK || !step.OK || step.View.ID == "" || step.View.ID == root.ID || step.View.PreviousViewID != root.ID || step.View.RootViewID != root.ID || !step.View.NotifyOnClose {
		t.Fatalf("views.push: %d %s", pushed.Code, pushed.Body.String())
	}
	if sv := e.state.views[step.View.ID]; sv == nil || sv.Depth != 1 || sv.UserID != "u-1" || sv.ClickID != "tab-3" || sv.WebhookID != "wh" {
		t.Fatalf("stored pushed form: %+v", sv)
	}
	// That trigger_id is spent.
	expectAppError(t, "reused trigger", appJSON(e.h.ViewsPush, token, `{"trigger_id":"`+got.TriggerID+`","view":`+stepForm+`}`), http.StatusBadRequest, "expired_trigger_id")

	// One more on top, from the pushed form's own button.
	if rec := viewCall(e.h.ViewAction, "u-1", step.View.ID, "actions", `{"blockID":"more","actionID":"deeper"}`); rec.Code != http.StatusOK {
		t.Fatalf("press on the pushed form: %d %s", rec.Code, rec.Body.String())
	}
	_, pushed = app.last(t)
	top := decodeAppAnswer(t, pushed)
	if !top.OK || top.View.PreviousViewID != step.View.ID || top.View.RootViewID != root.ID || e.state.views[top.View.ID].Depth != 2 {
		t.Fatalf("second push: %d %s", pushed.Code, pushed.Body.String())
	}
	// Three forms is as deep as a stack goes.
	if rec := viewCall(e.h.ViewAction, "u-1", top.View.ID, "actions", `{"blockID":"more","actionID":"deeper"}`); rec.Code != http.StatusOK {
		t.Fatalf("press on the top form: %d %s", rec.Code, rec.Body.String())
	}
	_, pushed = app.last(t)
	expectAppError(t, "a fourth form", pushed, http.StatusBadRequest, "push_not_allowed")
	if len(e.state.views) != 3 {
		t.Fatalf("%d forms open, want 3", len(e.state.views))
	}

	// Closing the top form with all: the whole stack goes.
	rec = viewCall(e.h.CloseView, "u-1", top.View.ID, "close", `{"all":true,"values":{"step":{"name":"half-typed"}}}`)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("close all: %d %s", rec.Code, rec.Body.String())
	}
	for _, id := range []string{root.ID, step.View.ID, top.View.ID} {
		if e.state.views[id] != nil {
			t.Errorf("form %s still open", id)
		}
	}
	// Both step forms asked to hear about closing; the plan form didn't.
	heard := map[string]formAppCall{}
	for range 2 {
		p := app.nextClosed(t)
		heard[p.View.ID] = p
	}
	topClosed, under := heard[top.View.ID], heard[step.View.ID]
	if topClosed.IsCleared == nil || !*topClosed.IsCleared || under.IsCleared == nil || !*under.IsCleared {
		t.Fatalf("view_closed: %+v", heard)
	}
	// Only the form on top has what the person typed.
	if v := topClosed.View.State["values"]["step"]["name"].Value; v == nil || *v != "half-typed" {
		t.Errorf("top form's values: %+v", topClosed.View.State)
	}
	if v := under.View.State["values"]["step"]["name"].Value; v != nil {
		t.Errorf("the form under it got values: %q", *v)
	}
	select {
	case p := <-app.closed:
		t.Fatalf("the app heard about a form that didn't ask: %+v", p)
	default:
	}
}

// Closing just the top form shows the one under it again; the app hears
// it wasn't a clear.
func TestCloseView_TopFormOnly(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	root := e.openPlan(t, token)
	app := e.stackingApp(t, token)
	if rec := viewCall(e.h.ViewAction, "u-1", root.ID, "actions", `{"blockID":"steps","actionID":"add"}`); rec.Code != http.StatusOK {
		t.Fatalf("press: %d %s", rec.Code, rec.Body.String())
	}
	_, pushed := app.last(t)
	step := decodeAppAnswer(t, pushed)

	// A body that isn't a close request, or values that are neither a
	// string nor a list, change nothing.
	for _, body := range []string{`{"all":"yes"}`, `{"values":{"step":{"name":7}}}`, `{"values":{"step":{"name":{"a":"b"}}}}`, `{`} {
		if rec := viewCall(e.h.CloseView, "u-1", step.View.ID, "close", body); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_body"`) {
			t.Errorf("close %s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	if e.state.views[step.View.ID] == nil {
		t.Fatal("a refused close closed the form")
	}

	if rec := viewCall(e.h.CloseView, "u-1", step.View.ID, "close", `{}`); rec.Code != http.StatusNoContent {
		t.Fatalf("close: %d %s", rec.Code, rec.Body.String())
	}
	if e.state.views[step.View.ID] != nil || e.state.views[root.ID] == nil {
		t.Fatalf("after closing the top form: %d open", len(e.state.views))
	}
	if p := app.nextClosed(t); p.View.ID != step.View.ID || p.IsCleared == nil || *p.IsCleared {
		t.Fatalf("view_closed: %+v", p)
	}
}

func TestViewsPush_Refusals(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	// A click on a card opens forms; it can't push one.
	expectAppError(t, "a card's trigger", appJSON(e.h.ViewsPush, token, `{"trigger_id":"`+e.triggerFor(t, "")+`","view":`+stepForm+`}`), http.StatusBadRequest, "push_not_allowed")
	expectAppError(t, "unknown trigger", appJSON(e.h.ViewsPush, token, `{"trigger_id":"t_nope","view":`+stepForm+`}`), http.StatusBadRequest, "expired_trigger_id")
	expectAppError(t, "malformed body", appJSON(e.h.ViewsPush, token, `{"view":"x"}`), http.StatusBadRequest, "invalid_arguments")

	// The form under it has closed meanwhile.
	root := e.openPlan(t, token)
	trigger := e.formTrigger(t, root.ID)
	if rec := viewCall(e.h.CloseView, "u-1", root.ID, "close", ""); rec.Code != http.StatusNoContent {
		t.Fatalf("close: %d", rec.Code)
	}
	expectAppError(t, "the form under it closed", appJSON(e.h.ViewsPush, token, `{"trigger_id":"`+trigger+`","view":`+stepForm+`}`), http.StatusNotFound, "view_not_found")
}

// formTrigger presses planForm's button and returns the trigger_id the app
// got with the press, unused.
func (e *ixHandlerEnv) formTrigger(t *testing.T, viewID string) string {
	t.Helper()
	var trigger string
	app := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		var p formAppCall
		_ = json.NewDecoder(r.Body).Decode(&p)
		trigger = p.TriggerID
	}))
	defer app.Close()
	e.hooks.items["wh"].InteractivityURL = app.URL
	if rec := viewCall(e.h.ViewAction, "u-1", viewID, "actions", `{"blockID":"steps","actionID":"add"}`); rec.Code != http.StatusOK || trigger == "" {
		t.Fatalf("press for a trigger: %d %s", rec.Code, rec.Body.String())
	}
	return trigger
}

// A pick inside a form goes to the app as its value, checked against the
// stored form; a field that sends changes sends its value the same way.
func TestViewAction_PicksAndRefusals(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	root := e.openPlan(t, token)

	var mu sync.Mutex
	var got []formAppCall
	status := http.StatusOK
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p formAppCall
		_ = json.NewDecoder(r.Body).Decode(&p)
		mu.Lock()
		defer mu.Unlock()
		got = append(got, p)
		w.WriteHeader(status)
	}))
	defer app.Close()
	e.hooks.items["wh"].InteractivityURL = app.URL

	if rec := viewCall(e.h.ViewAction, "u-1", root.ID, "actions", `{"blockID":"steps","actionID":"lane","value":"fe"}`); rec.Code != http.StatusOK || rec.Body.String() != "{}\n" {
		t.Fatalf("lane: %d %q", rec.Code, rec.Body.String())
	}
	if o := got[0].Actions[0].SelectedOption; o == nil || o.Value != "fe" || o.Text.Text != "Frontend" {
		t.Fatalf("lane picked: %+v", got[0].Actions)
	}
	if rec := viewCall(e.h.ViewAction, "u-1", root.ID, "actions", `{"blockID":"due","actionID":"date","value":"2026-11-20"}`); rec.Code != http.StatusOK {
		t.Fatalf("due: %d %s", rec.Code, rec.Body.String())
	}
	if d := got[1].Actions[0].SelectedDate; d == nil || *d != "2026-11-20" {
		t.Fatalf("due picked: %+v", got[1].Actions)
	}

	// The app doesn't answer: the person is told, the form stays.
	status = http.StatusInternalServerError
	rec := viewCall(e.h.ViewAction, "u-1", root.ID, "actions", `{"blockID":"steps","actionID":"add"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"failed":true`) || !strings.Contains(rec.Body.String(), "didn't respond") {
		t.Fatalf("app down: %d %s", rec.Code, rec.Body.String())
	}
	if e.state.views[root.ID] == nil {
		t.Fatal("a failed press closed the form")
	}

	calls := len(got)
	for _, c := range []struct {
		name, user, view, body string
		status                 int
		code                   string
	}{
		{"malformed", "u-1", root.ID, `{`, http.StatusBadRequest, "invalid_body"},
		{"no block", "u-1", root.ID, `{"actionID":"add"}`, http.StatusBadRequest, "invalid_body"},
		{"no action", "u-1", root.ID, `{"blockID":"steps"}`, http.StatusBadRequest, "invalid_body"},
		{"value an object", "u-1", root.ID, `{"blockID":"steps","actionID":"lane","value":{"v":"fe"}}`, http.StatusBadRequest, "invalid_body"},
		{"value a number", "u-1", root.ID, `{"blockID":"steps","actionID":"lane","value":2}`, http.StatusBadRequest, "invalid_body"},
		{"values not strings", "u-1", root.ID, `{"blockID":"steps","actionID":"add","values":{"notes":{"text":[1]}}}`, http.StatusBadRequest, "invalid_body"},
		{"not an option", "u-1", root.ID, `{"blockID":"steps","actionID":"lane","value":"ops"}`, http.StatusBadRequest, "bad_request"},
		{"two for one", "u-1", root.ID, `{"blockID":"steps","actionID":"lane","value":["be","fe"]}`, http.StatusBadRequest, "bad_request"},
		{"nothing picked", "u-1", root.ID, `{"blockID":"steps","actionID":"lane"}`, http.StatusBadRequest, "bad_request"},
		{"a field that doesn't send changes", "u-1", root.ID, `{"blockID":"notes","actionID":"text","value":"x"}`, http.StatusNotFound, "not_found"},
		{"a link button", "u-1", root.ID, `{"blockID":"steps","actionID":"docs"}`, http.StatusNotFound, "not_found"},
		{"no such element", "u-1", root.ID, `{"blockID":"steps","actionID":"gone"}`, http.StatusNotFound, "not_found"},
		{"someone else's form", "u-2", root.ID, `{"blockID":"steps","actionID":"add"}`, http.StatusNotFound, "view_not_found"},
		{"a closed form", "u-1", "V-gone", `{"blockID":"steps","actionID":"add"}`, http.StatusNotFound, "view_not_found"},
	} {
		rec := viewCall(e.h.ViewAction, c.user, c.view, "actions", c.body)
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), `"`+c.code+`"`) {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body.String())
		}
	}
	if len(got) != calls {
		t.Fatalf("a refused change reached the app (%d calls, want %d)", len(got), calls)
	}

	// An app an admin paused takes no changes.
	e.hooks.items["wh"].AdminPaused = true
	if rec := viewCall(e.h.ViewAction, "u-1", root.ID, "actions", `{"blockID":"steps","actionID":"add"}`); rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), `"app_unavailable"`) {
		t.Fatalf("paused app: %d %s", rec.Code, rec.Body.String())
	}
}

// Multi-value fields submit as lists; a value that is neither a string nor
// a list is a malformed body.
func TestSubmitView_ListValues(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	root := e.openPlan(t, token)
	var got formAppCall
	app := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
	}))
	defer app.Close()
	e.hooks.items["wh"].InteractivityURL = app.URL

	for _, body := range []string{
		`{"values":{"notes":{"text":7}}}`,
		`{"values":{"notes":{"text":{"v":"x"}}}}`,
		`{"values":{"tags":{"tick":["urgent",3]}}}`,
	} {
		if rec := viewCall(e.h.SubmitView, "u-1", root.ID, "submit", body); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_body"`) {
			t.Errorf("%s: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	// A list where one value goes is the person's to fix, not malformed.
	rec := viewCall(e.h.SubmitView, "u-1", root.ID, "submit", `{"values":{"notes":{"text":["a","b"]},"due":{"date":"2026-11-20"}}}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"notes":"Please choose one."`) || got.Type != "" {
		t.Fatalf("list for text: %d %s", rec.Code, rec.Body.String())
	}

	rec = viewCall(e.h.SubmitView, "u-1", root.ID, "submit", `{"values":{"notes":{"text":"ship"},"due":{"date":"2026-11-20"},"tags":{"tick":["customer","urgent"]}}}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"action":"close"`) {
		t.Fatalf("submit: %d %s", rec.Code, rec.Body.String())
	}
	tags := got.View.State["values"]["tags"]["tick"].SelectedOptions
	if got.Type != "view_submission" || len(tags) != 2 || tags[0].Value != "customer" || tags[1].Text.Text != "Urgent" {
		t.Fatalf("submitted tags: %+v", got.View.State["values"]["tags"])
	}
}

// pickCard is a card with a picker and checkboxes the app hears about.
func pickCard() model.Blocks {
	opt := func(label, value string) model.SelectOption {
		return model.SelectOption{Text: model.TextObject{Type: model.TextPlain, Text: label}, Value: value}
	}
	return model.Blocks{{Type: model.BlockActions, BlockID: "triage", Elements: []model.BlockElement{
		{Type: model.ElementStaticSelect, ActionID: "owner", Options: []model.SelectOption{opt("Backend", "be"), opt("Frontend", "fe")}},
		{Type: model.ElementCheckboxes, ActionID: "labels", Options: []model.SelectOption{opt("Bug", "bug"), opt("P1", "p1"), opt("Docs", "docs")}},
	}}}
}

// A person picks on a card: the pick goes to the app — one value for a
// select, a list for checkboxes — read against the card as stored.
func TestAppsFlow_PickOnACard(t *testing.T) {
	e := newIxHandlerEnv(t)
	e.messages.messages["ch-1#m1"].Blocks = pickCard()
	var (
		mu  sync.Mutex
		got []formAppCall
	)
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p formAppCall
		_ = json.NewDecoder(r.Body).Decode(&p)
		mu.Lock()
		got = append(got, p)
		mu.Unlock()
		_, _ = w.Write([]byte(`{"notice":"Triaged"}`))
	}))
	defer app.Close()
	e.hooks.items["wh"].InteractivityURL = app.URL

	click := e.cardClicks()

	if rec := click(`{"blockID":"triage","actionID":"owner","value":"fe"}`); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"notice":"Triaged"`) {
		t.Fatalf("pick owner: %d %s", rec.Code, rec.Body.String())
	}
	if len(got) != 1 || got[0].Type != "block_actions" || got[0].Container.Type != "message" {
		t.Fatalf("the app's request: %+v", got)
	}
	if o := got[0].Actions[0].SelectedOption; o == nil || o.Value != "fe" || o.Text.Text != "Frontend" {
		t.Fatalf("owner picked: %+v", got[0].Actions)
	}

	if rec := click(`{"blockID":"triage","actionID":"labels","value":["bug","p1"]}`); rec.Code != http.StatusOK {
		t.Fatalf("tick labels: %d %s", rec.Code, rec.Body.String())
	}
	if o := got[1].Actions[0].SelectedOptions; len(o) != 2 || o[0].Value != "bug" || o[1].Text.Text != "P1" {
		t.Fatalf("labels ticked: %+v", got[1].Actions)
	}
	// Unticking everything is a pick too.
	if rec := click(`{"blockID":"triage","actionID":"labels","value":[]}`); rec.Code != http.StatusOK {
		t.Fatalf("untick all: %d %s", rec.Code, rec.Body.String())
	}
	if len(got) != 3 || len(got[2].Actions[0].SelectedOptions) != 0 {
		t.Fatalf("unticked: %+v", got)
	}

	for _, c := range []struct {
		body, code string
	}{
		{`{"blockID":"triage","actionID":"owner","value":"ops"}`, "bad_request"},
		{`{"blockID":"triage","actionID":"owner","value":["be","fe"]}`, "bad_request"},
		{`{"blockID":"triage","actionID":"owner"}`, "bad_request"},
		{`{"blockID":"triage","actionID":"labels","value":["bug","wontfix"]}`, "bad_request"},
		{`{"blockID":"triage","actionID":"owner","value":{"v":"fe"}}`, "invalid_body"},
		{`{"blockID":"triage","actionID":"labels","value":[1]}`, "invalid_body"},
	} {
		if rec := click(c.body); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"`+c.code+`"`) {
			t.Errorf("%s: %d %s", c.body, rec.Code, rec.Body.String())
		}
	}
	if len(got) != 3 {
		t.Fatalf("a refused pick reached the app: %d calls", len(got))
	}
}

func previewView(h *InteractionHandler, role model.SystemRole, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/webhooks/preview-view", strings.NewReader(body))
	rec := httptest.NewRecorder()
	h.PreviewView(rec, asUser(req, "u-1", role))
	return rec
}

// The webhooks panel's builder previews a form as ex would draw it, without
// opening anything.
func TestPreviewView(t *testing.T) {
	e := newIxHandlerEnv(t)
	rec := previewView(e.h, model.SystemRoleMember, strings.Replace(planForm, `"blocks":[`, `"blocks":[{"type":"section","text":{"type":"mrkdwn","text":"*Plan* the week"}},`, 1))
	var v model.View
	if err := json.Unmarshal(rec.Body.Bytes(), &v); rec.Code != http.StatusOK || err != nil {
		t.Fatalf("preview: %d %s", rec.Code, rec.Body.String())
	}
	if v.ID != "preview" || v.Hash != "preview" || v.Title.Text != "Plan" || len(v.Blocks) != 5 || v.Blocks[0].Text.Type != model.TextMarkdown || v.Blocks[0].BlockID == "" {
		t.Fatalf("previewed form: %+v", v)
	}
	if len(e.state.views) != 0 {
		t.Fatal("a preview opened a form")
	}

	if rec := previewView(e.h, model.SystemRoleMember, `{"type":"home","title":{"type":"plain_text","text":"x"},"blocks":[]}`); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_view"`) {
		t.Fatalf("invalid form: %d %s", rec.Code, rec.Body.String())
	}
	if rec := previewView(e.h, model.SystemRoleMember, `{"type":"modal","blocks":"x"}`); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_body"`) {
		t.Fatalf("malformed: %d %s", rec.Code, rec.Body.String())
	}
	big := `{"type":"modal","private_metadata":"` + strings.Repeat("a", int(maxWebhookBodyBytes)) + `"}`
	if rec := previewView(e.h, model.SystemRoleMember, big); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_body"`) {
		t.Fatalf("over 1 MB: %d", rec.Code)
	}
	if rec := previewView(e.h, model.SystemRoleGuest, planForm); rec.Code != http.StatusForbidden {
		t.Fatalf("guest preview: %d %s", rec.Code, rec.Body.String())
	}
}

// cardClicks sends u-1's clicks and picks on the env's card through the
// channel's message-actions route, as the browser does.
func (e *ixHandlerEnv) cardClicks() func(body string) *httptest.ResponseRecorder {
	memberships := newDataMembershipStore()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1", Role: model.ChannelRoleMember}
	msgSvc := service.NewMessageService(e.messages, memberships, nil, nil, nil)
	msgSvc.SetAppClicker(e.svc)
	channels := NewChannelHandler(nil, msgSvc)
	return func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/ch-1/messages/m1/actions", strings.NewReader(body))
		req.SetPathValue("id", "ch-1")
		req.SetPathValue("msgId", "m1")
		rec := httptest.NewRecorder()
		channels.Act(rec, asUser(req, "u-1", model.SystemRoleMember))
		return rec
	}
}

// The whole stacked round, every step through its route: a person clicks
// the card's button; the app opens a form with that click's trigger_id. A
// button in the form goes to the app, which pushes a second form with the
// trigger_id the press carried, and from that one a third. Submitting the
// top form closes only it; closing the second with "all" ends the stack,
// and the app hears about the one form that asked and was closed, not
// submitted.
func TestAppsFlow_ClickOpenPushSubmitThenCloseAll(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	e.appButton()

	var (
		mu          sync.Mutex
		answers     []*httptest.ResponseRecorder // views.open, then each views.push
		submissions []formAppCall
		closed      = make(chan formAppCall, 4)
	)
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p formAppCall
		_ = json.NewDecoder(r.Body).Decode(&p)
		if p.Type == "view_closed" {
			closed <- p
			return
		}
		mu.Lock()
		defer mu.Unlock()
		switch {
		case p.Type == "block_actions" && p.Container.Type == "message":
			answers = append(answers, appJSON(e.h.ViewsOpen, token, `{"trigger_id":"`+p.TriggerID+`","view":`+planForm+`}`))
		case p.Type == "block_actions" && p.Container.Type == "view":
			answers = append(answers, appJSON(e.h.ViewsPush, token, `{"trigger_id":"`+p.TriggerID+`","view":`+stepForm+`}`))
		case p.Type == "view_submission":
			submissions = append(submissions, p)
		}
	}))
	defer app.Close()
	e.hooks.items["wh"].InteractivityURL = app.URL
	lastAnswer := func(what string) model.View {
		t.Helper()
		mu.Lock()
		defer mu.Unlock()
		if len(answers) == 0 {
			t.Fatalf("%s: the app never got the interaction", what)
		}
		rec := answers[len(answers)-1]
		a := decodeAppAnswer(t, rec)
		if rec.Code != http.StatusOK || !a.OK || a.View.ID == "" {
			t.Fatalf("%s: %d %s", what, rec.Code, rec.Body.String())
		}
		return a.View
	}

	if rec := e.cardClicks()(`{"blockID":"b1","actionID":"review","clickID":"tab-9"}`); rec.Code != http.StatusOK {
		t.Fatalf("click: %d %s", rec.Code, rec.Body.String())
	}
	root := lastAnswer("views.open")
	if sv := e.state.views[root.ID]; sv == nil || sv.Depth != 0 || sv.ClickID != "tab-9" || root.RootViewID != "" || root.PreviousViewID != "" {
		t.Fatalf("opened form: %+v %+v", root, sv)
	}

	if rec := viewCall(e.h.ViewAction, "u-1", root.ID, "actions", `{"blockID":"steps","actionID":"add","values":{"notes":{"text":"draft"}}}`); rec.Code != http.StatusOK {
		t.Fatalf("press in the form: %d %s", rec.Code, rec.Body.String())
	}
	step := lastAnswer("first views.push")
	if step.PreviousViewID != root.ID || step.RootViewID != root.ID || e.state.views[step.ID].Depth != 1 || e.state.views[step.ID].ClickID != "tab-9" {
		t.Fatalf("pushed form: %+v", step)
	}
	if rec := viewCall(e.h.ViewAction, "u-1", step.ID, "actions", `{"blockID":"more","actionID":"deeper"}`); rec.Code != http.StatusOK {
		t.Fatalf("press in the pushed form: %d %s", rec.Code, rec.Body.String())
	}
	top := lastAnswer("second views.push")
	if top.PreviousViewID != step.ID || top.RootViewID != root.ID || e.state.views[top.ID].Depth != 2 {
		t.Fatalf("top form: %+v", top)
	}

	// Submitting the top form: the app gets it with its place in the stack,
	// and only that form closes.
	rec := viewCall(e.h.SubmitView, "u-1", top.ID, "submit", `{"values":{"step":{"name":"Write the tests"}}}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"action":"close"`) || strings.Contains(rec.Body.String(), `"cleared"`) {
		t.Fatalf("submit the top form: %d %s", rec.Code, rec.Body.String())
	}
	if len(submissions) != 1 || submissions[0].View.ID != top.ID || submissions[0].View.RootViewID != root.ID || submissions[0].View.CallbackID != "step" {
		t.Fatalf("submissions: %+v", submissions)
	}
	if v := submissions[0].View.State["values"]["step"]["name"].Value; v == nil || *v != "Write the tests" {
		t.Fatalf("submitted name: %v", v)
	}
	if e.state.views[top.ID] != nil || e.state.views[step.ID] == nil || e.state.views[root.ID] == nil {
		t.Fatalf("after submitting the top form: %d open", len(e.state.views))
	}

	// Closing the second form with all: it and the form under it go.
	if rec := viewCall(e.h.CloseView, "u-1", step.ID, "close", `{"all":true}`); rec.Code != http.StatusNoContent {
		t.Fatalf("close all: %d %s", rec.Code, rec.Body.String())
	}
	if len(e.state.views) != 0 {
		t.Fatalf("%d forms still open", len(e.state.views))
	}
	select {
	case p := <-closed:
		if p.View.ID != step.ID || p.IsCleared == nil || !*p.IsCleared {
			t.Fatalf("view_closed: %+v", p)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the app never heard the form closed")
	}
	// The submitted form asked too, but was submitted, not closed; the
	// plan form never asked. Nothing more comes: closes are told in the
	// background, so give a late one a moment to show up.
	select {
	case p := <-closed:
		t.Fatalf("an extra view_closed: %+v", p)
	case <-time.After(100 * time.Millisecond):
	}
}

// What a browser sends for a form or a pick is bounded: a value lists at
// most 100 items and a body is at most 512 KB. Past either, the request is
// malformed and nothing reaches the app or changes a form.
func TestFormAndPickBodies_AreBounded(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.botToken(t)
	root := e.openPlan(t, token)
	e.messages.messages["ch-1#m1"].Blocks = pickCard()
	click := e.cardClicks()
	var calls int
	var mu sync.Mutex
	app := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		mu.Lock()
		calls++
		mu.Unlock()
	}))
	defer app.Close()
	e.hooks.items["wh"].InteractivityURL = app.URL

	list := func(n int) string {
		items := make([]string, n)
		for i := range items {
			items[i] = `"v` + strconv.Itoa(i) + `"`
		}
		return "[" + strings.Join(items, ",") + "]"
	}
	huge := `"` + strings.Repeat("a", 600<<10) + `"`
	to := func(fn http.HandlerFunc, route string) func(string) *httptest.ResponseRecorder {
		return func(body string) *httptest.ResponseRecorder { return viewCall(fn, "u-1", root.ID, route, body) }
	}
	send := map[string]func(body string) *httptest.ResponseRecorder{
		"submit": to(e.h.SubmitView, "submit"), "close": to(e.h.CloseView, "close"), "action": to(e.h.ViewAction, "actions"), "pick": click,
	}
	bodies := func(value string) map[string]string {
		return map[string]string{
			"submit": `{"values":{"tags":{"tick":` + value + `}}}`,
			"close":  `{"values":{"tags":{"tick":` + value + `}}}`,
			"action": `{"blockID":"steps","actionID":"lane","value":` + value + `}`,
			"pick":   `{"blockID":"triage","actionID":"labels","value":` + value + `}`,
		}
	}
	for _, c := range []struct{ name, value, why string }{
		{"101 items", list(101), "at most 100"},
		{"600 KB", huge, "too large"},
	} {
		for route, body := range bodies(c.value) {
			rec := send[route](body)
			if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_body"`) || !strings.Contains(rec.Body.String(), c.why) {
				t.Errorf("%s to %s: %d %.200s", c.name, route, rec.Code, rec.Body.String())
			}
		}
	}
	if calls != 0 || e.state.views[root.ID] == nil {
		t.Fatalf("a refused body reached the app (%d calls) or closed the form", calls)
	}

	// 100 items is a list ex reads: those values aren't options here, so
	// the form says so and a pick is refused — but neither is malformed.
	hundred := bodies(list(100))
	if rec := send["submit"](hundred["submit"]); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"action":"errors"`) {
		t.Errorf("100 items submitted: %d %.300s", rec.Code, rec.Body.String())
	}
	if rec := send["pick"](hundred["pick"]); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"bad_request"`) {
		t.Errorf("100 items picked: %d %.300s", rec.Code, rec.Body.String())
	}
	// A body under 512 KB is read, even with a value too long for its
	// field: that is the form's to say.
	long := `"` + strings.Repeat("a", 400<<10) + `"`
	if rec := send["submit"](`{"values":{"notes":{"text":` + long + `}}}`); rec.Code != http.StatusOK || strings.Contains(rec.Body.String(), "invalid_body") {
		t.Errorf("400 KB submitted: %d %.300s", rec.Code, rec.Body.String())
	}
	if calls != 0 {
		t.Fatalf("an invalid form reached the app: %d calls", calls)
	}
}
