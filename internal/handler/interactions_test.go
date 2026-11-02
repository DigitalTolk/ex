package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// memIxState is interactivity's state kept in memory, for handler tests.
type memIxState struct {
	mu       sync.Mutex
	urls     map[string]*model.ResponseURLRecord
	uses     map[string]int
	triggers map[string]model.TriggerRecord
	views    map[string]*model.StoredView
	idem     map[string][]byte
	err      error
	// viewErr fails reading an open form (a Redis outage).
	viewErr error
}

func (m *memIxState) MintTrigger(_ context.Context, hash string, rec model.TriggerRecord, _ time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.triggers[hash] = rec
	return nil
}

func (m *memIxState) UseTrigger(_ context.Context, hash string) (*model.TriggerRecord, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.triggers[hash]
	if !ok {
		return nil, nil
	}
	delete(m.triggers, hash)
	return &rec, nil
}

func (m *memIxState) SaveView(_ context.Context, v *model.StoredView, _ time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := *v
	m.views[v.View.ID] = &cp
	return nil
}

func (m *memIxState) GetView(_ context.Context, id string) (*model.StoredView, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.viewErr != nil {
		return nil, m.viewErr
	}
	if v, ok := m.views[id]; ok {
		cp := *v
		return &cp, nil
	}
	return nil, nil
}

func (m *memIxState) ViewIDByExternalID(_ context.Context, webhookID, externalID string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, v := range m.views {
		if v.WebhookID == webhookID && v.View.ExternalID == externalID {
			return id, nil
		}
	}
	return "", nil
}

func (m *memIxState) DeleteView(_ context.Context, v *model.StoredView) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.views, v.View.ID)
	return nil
}

func (m *memIxState) TakeView(_ context.Context, v *model.StoredView) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.views[v.View.ID]
	delete(m.views, v.View.ID)
	return ok, nil
}

func (m *memIxState) DropViewExternalID(context.Context, string, string, string) error { return nil }

func (m *memIxState) ClaimIdempotencyKey(_ context.Context, scope, key string, _ time.Duration) ([]byte, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if prev, ok := m.idem[scope+key]; ok {
		return prev, false, nil
	}
	m.idem[scope+key] = nil
	return nil, true, nil
}

func (m *memIxState) FinishIdempotencyKey(_ context.Context, scope, key string, answer []byte, _ time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.idem[scope+key] = answer
	return nil
}

func (m *memIxState) MintResponseURL(_ context.Context, hash string, rec model.ResponseURLRecord, uses int, _ time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.urls[hash], m.uses[hash] = &rec, uses
	return nil
}

func (m *memIxState) UseResponseURL(_ context.Context, hash string) (*model.ResponseURLRecord, int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return nil, 0, m.err
	}
	rec, ok := m.urls[hash]
	if !ok {
		return nil, 0, nil
	}
	m.uses[hash]--
	return rec, m.uses[hash], nil
}

func (m *memIxState) RecordInteraction(context.Context, string, model.InteractionEntry) error {
	return nil
}
func (m *memIxState) ListInteractions(context.Context, string) ([]model.InteractionEntry, error) {
	return nil, nil
}
func (m *memIxState) NoteAppFailure(context.Context, string, int, time.Duration) (time.Duration, error) {
	return 0, nil
}
func (m *memIxState) NoteAppSuccess(context.Context, string) error { return nil }
func (m *memIxState) AppPausedFor(context.Context, string) (time.Duration, error) {
	return 0, nil
}

type allowAllClicks struct{}

func (allowAllClicks) AllowClick(context.Context, string) (bool, error) { return true, nil }
func (allowAllClicks) AllowAppCall(context.Context, string) (bool, time.Duration, error) {
	return true, 0, nil
}

type ixHandlerEnv struct {
	h        *InteractionHandler
	svc      *service.InteractionService
	state    *memIxState
	hooks    *handlerWebhookStore
	messages *handlerWebhookMessageStore
	app      *httptest.Server
	reply    string
}

func newIxHandlerEnv(t *testing.T) *ixHandlerEnv {
	t.Helper()
	return newIxHandlerEnvWith(t, allowAllClicks{})
}

// newIxHandlerEnvWith is newIxHandlerEnv with the given click/app-call
// limiter.
func newIxHandlerEnvWith(t *testing.T, limiter service.ClickLimiter) *ixHandlerEnv {
	t.Helper()
	general := &model.Channel{ID: "ch-1", Name: "General", Slug: "general"}
	channels := handlerWebhookChannels{byID: map[string]*model.Channel{general.ID: general}, bySlug: map[string]*model.Channel{general.Slug: general}}
	messages := &handlerWebhookMessageStore{messages: map[string]*model.Message{
		"ch-1#m1": {ID: "m1", ParentID: "ch-1", AuthorID: service.WebhookAuthorID, Body: "card", WebhookID: "wh", AppButtons: true},
	}}
	hooks := &handlerWebhookStore{items: map[string]*model.IncomingWebhook{
		"wh": {ID: "wh", Title: "MeetingMind", ChannelID: "ch-1", CreatedBy: "u-1", SecretVersion: 1, Kind: model.WebhookKindRich},
	}}
	msgSvc := service.NewMessageService(messages, nil, nil, nil, nil)
	webhooks := service.NewIncomingWebhookService(hooks, channels, msgSvc, handlerWebhookImageProxy{}, "")
	state := &memIxState{urls: map[string]*model.ResponseURLRecord{}, uses: map[string]int{}, triggers: map[string]model.TriggerRecord{}, views: map[string]*model.StoredView{}, idem: map[string][]byte{}}
	svc := service.NewInteractionService(msgSvc, webhooks, state, limiter, nil, service.InteractionConfig{SigningKey: []byte("k"), BaseURL: "https://chat.test", AllowPrivate: true})
	env := &ixHandlerEnv{h: NewInteractionHandler(svc), svc: svc, state: state, hooks: hooks, messages: messages}
	env.app = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(env.reply)) }))
	t.Cleanup(env.app.Close)
	hooks.items["wh"].InteractivityURL = env.app.URL
	return env
}

func (e *ixHandlerEnv) call(t *testing.T, fn http.HandlerFunc, method, body string, role model.SystemRole) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/api/v1/admin/webhooks/wh/interactivity", strings.NewReader(body))
	req.SetPathValue("id", "wh")
	rec := httptest.NewRecorder()
	fn(rec, asUser(req, "u-1", role))
	return rec
}

func TestInteractionHandler_Setup(t *testing.T) {
	e := newIxHandlerEnv(t)
	member := model.SystemRoleMember

	if rec := e.call(t, e.h.Status, http.MethodGet, "", member); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"hasSigningSecret":true`) {
		t.Fatalf("status: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.call(t, e.h.SetRequestURL, http.MethodPut, `{"requestURL":"`+e.app.URL+`"}`, member); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), e.app.URL) {
		t.Fatalf("request url: %d %s", rec.Code, rec.Body.String())
	}
	rec := e.call(t, e.h.RotateBotToken, http.MethodPost, `{"revokeNow":false}`, member)
	var token struct {
		Token   string                `json:"token"`
		Webhook model.IncomingWebhook `json:"webhook"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&token); err != nil || !strings.HasPrefix(token.Token, "exb_") || !token.Webhook.HasBotToken {
		t.Fatalf("bot token: %d %+v %v", rec.Code, token, err)
	}
	if strings.Contains(rec.Body.String(), "botTokenHash") {
		t.Fatal("the hash must never be served")
	}
	if rec := e.call(t, e.h.RotateSigningSecret, http.MethodPost, `{"revokeNow":true}`, member); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"secret":"exs_`) {
		t.Fatalf("secret: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.call(t, e.h.SendTest, http.MethodPost, ``, member); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("test: %d %s", rec.Code, rec.Body.String())
	}

	// Admin-only switches.
	if rec := e.call(t, e.h.SetEmailSharing, http.MethodPut, `{"enabled":true}`, member); rec.Code != http.StatusForbidden {
		t.Fatalf("owner email sharing: %d", rec.Code)
	}
	if rec := e.call(t, e.h.SetEmailSharing, http.MethodPut, `{"enabled":true}`, model.SystemRoleAdmin); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"emailSharing":true`) {
		t.Fatalf("admin email sharing: %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.call(t, e.h.SetPaused, http.MethodPut, `{"enabled":true}`, model.SystemRoleAdmin); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"adminPaused":true`) {
		t.Fatalf("admin pause: %d %s", rec.Code, rec.Body.String())
	}
}

func TestInteractionHandler_SetupRefusals(t *testing.T) {
	e := newIxHandlerEnv(t)
	guest := model.SystemRoleGuest
	for name, fn := range map[string]http.HandlerFunc{
		"status": e.h.Status, "url": e.h.SetRequestURL, "token": e.h.RotateBotToken, "secret": e.h.RotateSigningSecret,
		"email": e.h.SetEmailSharing, "pause": e.h.SetPaused, "test": e.h.SendTest,
	} {
		if rec := e.call(t, fn, http.MethodPost, `{}`, guest); rec.Code < 400 {
			t.Errorf("%s as a guest: %d", name, rec.Code)
		}
	}
	for name, fn := range map[string]http.HandlerFunc{"url": e.h.SetRequestURL, "token": e.h.RotateBotToken, "email": e.h.SetEmailSharing} {
		if rec := e.call(t, fn, http.MethodPost, `{`, model.SystemRoleMember); rec.Code != http.StatusBadRequest {
			t.Errorf("%s with a bad body: %d", name, rec.Code)
		}
	}
	if rec := e.call(t, e.h.SetRequestURL, http.MethodPut, `{"requestURL":"ftp://x"}`, model.SystemRoleMember); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad url: %d", rec.Code)
	}
}

func (e *ixHandlerEnv) respond(t *testing.T, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/apps/respond/"+token, strings.NewReader(body))
	req.SetPathValue("token", token)
	rec := httptest.NewRecorder()
	e.h.Respond(rec, req)
	return rec
}

// mintFor clicks the card's app button through the real click path, so the
// app's request carries a response_url, and returns its token.
func (e *ixHandlerEnv) mintFor(t *testing.T) string {
	t.Helper()
	var url string
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			ResponseURL string `json:"response_url"`
		}
		_ = json.NewDecoder(r.Body).Decode(&p)
		url = p.ResponseURL
	}))
	defer app.Close()
	e.hooks.items["wh"].InteractivityURL = app.URL
	e.messages.messages["ch-1#m1"].Blocks = model.Blocks{{Type: model.BlockActions, BlockID: "b1", Elements: []model.BlockElement{
		{Type: model.ElementButton, ActionID: "go", Text: &model.TextObject{Type: model.TextPlain, Text: "Go"}},
	}}}
	button, _ := service.ButtonAt(e.messages.messages["ch-1#m1"], "b1", "go")
	if _, err := e.svc.Click(context.Background(), e.messages.messages["ch-1#m1"], service.ParentChannel, button, "b1", "u-1", nil); err != nil || url == "" {
		t.Fatalf("click for a response url: %v %q", err, url)
	}
	return url[strings.LastIndex(url, "/")+1:]
}

func TestInteractionHandler_Respond(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.mintFor(t)
	if rec := e.respond(t, token, `{"replace_original":true,"text":"Reviewed"}`); rec.Code != http.StatusOK || rec.Body.String() != "{\"ok\":true}\n" {
		t.Fatalf("respond: %d %s", rec.Code, rec.Body.String())
	}
	if e.messages.messages["ch-1#m1"].Body != "Reviewed" {
		t.Fatalf("message = %q", e.messages.messages["ch-1#m1"].Body)
	}
	cases := []struct {
		token, body string
		status      int
		code        string
	}{
		{token, `{`, http.StatusBadRequest, "invalid_payload"},
		{token, `{"replace_original":true,"blocks":[{"type":"header"}]}`, http.StatusBadRequest, "invalid_blocks"},
		{token, `{"replace_original":true,"text":"x","if_version":9}`, http.StatusConflict, "version_conflict"},
		{"nope", `{}`, http.StatusGone, "expired_url"},
	}
	for _, c := range cases {
		rec := e.respond(t, c.token, c.body)
		if rec.Code != c.status || !strings.Contains(rec.Body.String(), `"error":"`+c.code+`"`) {
			t.Errorf("%s: %d %s", c.body, rec.Code, rec.Body.String())
		}
	}
	// The card is gone: not found.
	e.messages.messages["ch-1#m1"].Deleted = true
	if rec := e.respond(t, token, `{"replace_original":true,"text":"x"}`); rec.Code != http.StatusGone && !strings.Contains(rec.Body.String(), "message_not_found") {
		t.Fatalf("deleted: %d %s", rec.Code, rec.Body.String())
	}
	// Spent.
	for i := 0; i < 5; i++ {
		e.respond(t, token, `{}`)
	}
	if rec := e.respond(t, token, `{}`); rec.Code != http.StatusGone || !strings.Contains(rec.Body.String(), `"used_up"`) {
		t.Fatalf("used up: %d %s", rec.Code, rec.Body.String())
	}
	// A state failure is a plain 500.
	e.state.err = errors.New("redis down")
	if rec := e.respond(t, "any", `{}`); rec.Code != http.StatusInternalServerError {
		t.Fatalf("state failure: %d", rec.Code)
	}
}

func TestRespondError_NotFound(t *testing.T) {
	e := newIxHandlerEnv(t)
	token := e.mintFor(t)
	e.messages.messages["ch-1#m1"].Deleted = true
	rec := e.respond(t, token, `{"replace_original":true,"text":"x"}`)
	if rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"message_not_found"`) {
		t.Fatalf("not found: %d %s", rec.Code, rec.Body.String())
	}
}

func TestBearerToken(t *testing.T) {
	for header, want := range map[string]string{
		"Bearer exb_abc":   "exb_abc",
		"bearer  exb_abc ": "exb_abc",
		"Basic xyz":        "",
		"Bearer":           "",
		"":                 "",
	} {
		r := httptest.NewRequest(http.MethodPost, "/hooks/x", nil)
		r.Header.Set("Authorization", header)
		if got := bearerToken(r); got != want {
			t.Errorf("bearerToken(%q) = %q, want %q", header, got, want)
		}
	}
}
