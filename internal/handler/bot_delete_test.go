package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// End-to-end cover for the bot admin API's create → read → delete path, driven
// through the real BotService. Added while chasing a "bot cannot be deleted"
// report: the delete path itself is sound (that turned out to be a stale server
// build serving camelCase ids to a snake_case client), and this pins the wire
// contract so the same mismatch can't recur silently.

// memBotStore is an in-memory store.BotStore.
type memBotStore struct {
	bots   map[string]*model.BotAccount
	order  []string
	tokens map[string]*model.BotToken
}

func newMemBotStore() *memBotStore {
	return &memBotStore{
		bots:   map[string]*model.BotAccount{},
		tokens: map[string]*model.BotToken{},
	}
}

func (m *memBotStore) CreateBot(_ context.Context, bot *model.BotAccount) error {
	if _, dup := m.bots[bot.UserID]; dup {
		return store.ErrAlreadyExists
	}
	copied := *bot
	m.bots[bot.UserID] = &copied
	m.order = append(m.order, bot.UserID)
	return nil
}

func (m *memBotStore) UpdateBot(_ context.Context, bot *model.BotAccount) error {
	copied := *bot
	m.bots[bot.UserID] = &copied
	return nil
}

func (m *memBotStore) GetBot(_ context.Context, userID string) (*model.BotAccount, error) {
	bot, ok := m.bots[userID]
	if !ok {
		return nil, store.ErrNotFound
	}
	copied := *bot
	return &copied, nil
}

func (m *memBotStore) ListBots(_ context.Context) ([]*model.BotAccount, error) {
	out := make([]*model.BotAccount, 0, len(m.order))
	for _, id := range m.order {
		if bot, ok := m.bots[id]; ok {
			copied := *bot
			out = append(out, &copied)
		}
	}
	return out, nil
}

func (m *memBotStore) RemoveBotFromDirectory(_ context.Context, userID string) error {
	kept := make([]string, 0, len(m.order))
	for _, id := range m.order {
		if id != userID {
			kept = append(kept, id)
		}
	}
	m.order = kept
	return nil
}

func (m *memBotStore) CreateBotToken(_ context.Context, tok *model.BotToken) error {
	copied := *tok
	m.tokens[tok.TokenHash] = &copied
	return nil
}

func (m *memBotStore) GetBotTokenByHash(_ context.Context, hash string) (*model.BotToken, error) {
	tok, ok := m.tokens[hash]
	if !ok {
		return nil, store.ErrNotFound
	}
	copied := *tok
	return &copied, nil
}

func (m *memBotStore) ListBotTokens(_ context.Context, botUserID string) ([]*model.BotToken, error) {
	out := []*model.BotToken{}
	for _, tok := range m.tokens {
		if tok.BotUserID == botUserID {
			copied := *tok
			out = append(out, &copied)
		}
	}
	return out, nil
}

func (m *memBotStore) RevokeBotToken(_ context.Context, hash string, at time.Time) error {
	tok, ok := m.tokens[hash]
	// Mirrors the real store's conditional write: revoking an already-revoked (or
	// absent) token reports ErrNotFound rather than silently succeeding.
	if !ok || tok.RevokedAt != nil {
		return store.ErrNotFound
	}
	tok.RevokedAt = &at
	return nil
}

func (m *memBotStore) TouchBotTokenLastUsed(_ context.Context, hash string, at time.Time) error {
	tok, ok := m.tokens[hash]
	if !ok {
		return store.ErrNotFound
	}
	tok.LastUsedAt = &at
	return nil
}

func setupBotHandler(t *testing.T) (*BotHandler, *auth.JWTManager, *memBotStore, *dataUserStoreForConv) {
	t.Helper()
	bots := newMemBotStore()
	users := newDataUserStoreForConv()
	jwtMgr := auth.NewJWTManager("test-secret-that-is-long-enough-for-hs256", time.Minute, time.Hour)
	return NewBotHandler(service.NewBotService(bots, users)), jwtMgr, bots, users
}

// createBotViaAPI creates a bot through the handler and returns its id.
func createBotViaAPI(t *testing.T, h *BotHandler, jwtMgr *auth.JWTManager, body string) string {
	t.Helper()
	rec := callAsAdmin(t, jwtMgr, h.Create, httptest.NewRequest(http.MethodPost, "/api/v1/admin/bots", strings.NewReader(body)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var created map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	id, _ := created["user_id"].(string)
	if id == "" {
		t.Fatalf("create response carried no user_id: %v", created)
	}
	return id
}

// The field the client uses to address a bot must be `user_id`. A camelCase
// response here is exactly what makes delete silently 404 on the client.
func TestBotHandler_ResponsesAreSnakeCase(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)
	createBotViaAPI(t, h, jwtMgr, `{"name":"test"}`)

	rec := callAsAdmin(t, jwtMgr, h.List, httptest.NewRequest(http.MethodGet, "/api/v1/admin/bots", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{`"user_id"`, `"created_by"`, `"create_at"`} {
		if !strings.Contains(body, want) {
			t.Errorf("list response missing %s: %s", want, body)
		}
	}
	for _, stale := range []string{`"userID"`, `"createdBy"`, `"createdAt"`} {
		if strings.Contains(body, stale) {
			t.Errorf("list response still emits the camelCase %s: %s", stale, body)
		}
	}
}

// Mattermost's POST /api/v4/bots spells the name `username` + `display_name`.
func TestBotHandler_CreateAcceptsMattermostFieldNames(t *testing.T) {
	h, jwtMgr, bots, _ := setupBotHandler(t)
	id := createBotViaAPI(t, h, jwtMgr, `{"username":"deploybot","display_name":"Deploy Bot"}`)
	bot, err := bots.GetBot(context.Background(), id)
	if err != nil {
		t.Fatalf("GetBot: %v", err)
	}
	// display_name is the more specific spelling, so it wins over username.
	if bot.Name != "Deploy Bot" {
		t.Errorf("Name = %q, want the display_name alias", bot.Name)
	}
}

func TestBotHandler_Delete(t *testing.T) {
	h, jwtMgr, bots, users := setupBotHandler(t)
	ctx := context.Background()
	id := createBotViaAPI(t, h, jwtMgr, `{"name":"test"}`)

	// Give it a live token and an outgoing webhook, so the delete has something to
	// actually tear down.
	tokenRec := callAsAdmin(t, jwtMgr, h.CreateToken, func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"label":"prod"}`))
		req.SetPathValue("id", id)
		return req
	}())
	if tokenRec.Code != http.StatusCreated {
		t.Fatalf("token status = %d, body = %s", tokenRec.Code, tokenRec.Body.String())
	}
	hookReq := httptest.NewRequest(http.MethodPut, "/",
		strings.NewReader(`{"callback_url":"https://bot.example.com/hook","transport":"mattermost","trigger_words":["deploy"]}`))
	hookReq.SetPathValue("id", id)
	if rec := callAsAdmin(t, jwtMgr, h.SetWebhook, hookReq); rec.Code != http.StatusOK {
		t.Fatalf("webhook status = %d, body = %s", rec.Code, rec.Body.String())
	}

	delReq := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/bots/"+id, nil)
	delReq.SetPathValue("id", id)
	rec := callAsAdmin(t, jwtMgr, h.Delete, delReq)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete status = %d, body = %s", rec.Code, rec.Body.String())
	}

	// Gone from the admin listing…
	listed, err := bots.ListBots(ctx)
	if err != nil {
		t.Fatalf("ListBots: %v", err)
	}
	if len(listed) != 0 {
		t.Errorf("ListBots = %+v, want the bot removed from the directory", listed)
	}
	// …its user row survives so authored messages still resolve an author, but
	// deactivated so its credentials stop working…
	user, err := users.GetUser(ctx, id)
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if user.Status != "deactivated" {
		t.Errorf("user status = %q, want deactivated", user.Status)
	}
	// …every token is revoked…
	tokens, err := bots.ListBotTokens(ctx, id)
	if err != nil {
		t.Fatalf("ListBotTokens: %v", err)
	}
	for _, tok := range tokens {
		if !tok.Revoked() {
			t.Errorf("token %s left live on a retired bot", tok.TokenID)
		}
	}
	// …and it is no longer dispatchable: an @mention or trigger word must not
	// still POST to a retired bot's callback.
	meta, err := bots.GetBot(ctx, id)
	if err != nil {
		t.Fatalf("GetBot: %v", err)
	}
	if meta.CallbackURL != "" || meta.CallbackSecret != "" || len(meta.TriggerWords) != 0 {
		t.Errorf("webhook config survived the delete: %+v", meta)
	}
}

func TestBotHandler_DeleteUnknownIsNotFound(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)
	// This is the exact response the UI was getting when a stale API served
	// camelCase ids and the client sent "undefined".
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/bots/undefined", nil)
	req.SetPathValue("id", "undefined")
	rec := callAsAdmin(t, jwtMgr, h.Delete, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestBotHandler_DeleteRequiresAdmin(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)
	req := httptest.NewRequest(http.MethodDelete, "/api/v1/admin/bots/bot_x", nil)
	req.SetPathValue("id", "bot_x")
	rec := callAsMember(t, jwtMgr, h.Delete, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

// The rest of the bot admin API: the read endpoints, token issue/list/revoke, and
// the webhook configuration errors.

func TestBotHandler_GetAndList(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)
	id := createBotViaAPI(t, h, jwtMgr, `{"name":"Helper","description":"does things"}`)

	getReq := httptest.NewRequest(http.MethodGet, "/api/v1/admin/bots/"+id, nil)
	getReq.SetPathValue("id", id)
	rec := callAsAdmin(t, jwtMgr, h.Get, getReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("get status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	// The user row supplies the display name and retirement status.
	if got["display_name"] != "Helper" || got["status"] != "active" {
		t.Errorf("get = %+v, want the user row's display fields", got)
	}

	// An unknown bot is a 404, not an empty 200.
	missing := httptest.NewRequest(http.MethodGet, "/api/v1/admin/bots/nope", nil)
	missing.SetPathValue("id", "nope")
	if rec := callAsAdmin(t, jwtMgr, h.Get, missing); rec.Code != http.StatusNotFound {
		t.Errorf("get unknown status = %d, want 404", rec.Code)
	}
}

func TestBotHandler_CreateRejectsAnEmptyName(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)
	for _, body := range []string{`{}`, `{"name":"   "}`, `{`} {
		rec := callAsAdmin(t, jwtMgr, h.Create, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("body %s: status = %d, want 400", body, rec.Code)
		}
	}
}

func TestBotHandler_Tokens(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)
	id := createBotViaAPI(t, h, jwtMgr, `{"name":"Helper"}`)

	// A body is optional — the label is.
	noBody := httptest.NewRequest(http.MethodPost, "/", nil)
	noBody.SetPathValue("id", id)
	if rec := callAsAdmin(t, jwtMgr, h.CreateToken, noBody); rec.Code != http.StatusCreated {
		t.Fatalf("token (no body) status = %d, body = %s", rec.Code, rec.Body.String())
	}

	withLabel := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"label":"prod"}`))
	withLabel.SetPathValue("id", id)
	rec := callAsAdmin(t, jwtMgr, h.CreateToken, withLabel)
	if rec.Code != http.StatusCreated {
		t.Fatalf("token status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var issued map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&issued); err != nil {
		t.Fatal(err)
	}
	plaintext, _ := issued["token"].(string)
	if !strings.HasPrefix(plaintext, "exbot_") {
		t.Fatalf("token = %q, want an exbot_ credential", plaintext)
	}
	tokenID, _ := issued["token_id"].(string)

	// Listing exposes metadata only — never anything that could authenticate.
	listReq := httptest.NewRequest(http.MethodGet, "/", nil)
	listReq.SetPathValue("id", id)
	rec = callAsAdmin(t, jwtMgr, h.ListTokens, listReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("list status = %d", rec.Code)
	}
	body := rec.Body.String()
	if strings.Contains(body, plaintext) {
		t.Error("the token list leaks a token's plaintext")
	}
	if !strings.Contains(body, `"token_id"`) {
		t.Errorf("list response missing token_id: %s", body)
	}

	revoke := httptest.NewRequest(http.MethodDelete, "/", nil)
	revoke.SetPathValue("id", id)
	revoke.SetPathValue("tokenID", tokenID)
	if rec := callAsAdmin(t, jwtMgr, h.RevokeToken, revoke); rec.Code != http.StatusNoContent {
		t.Fatalf("revoke status = %d, body = %s", rec.Code, rec.Body.String())
	}
	// Revoking again (or an unknown id) is a 404 rather than a silent success.
	if rec := callAsAdmin(t, jwtMgr, h.RevokeToken, revoke); rec.Code != http.StatusNotFound {
		t.Errorf("second revoke status = %d, want 404", rec.Code)
	}
}

func TestBotHandler_TokenErrors(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)

	t.Run("issuing for an unknown bot is a 404", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
		req.SetPathValue("id", "bot_nope")
		if rec := callAsAdmin(t, jwtMgr, h.CreateToken, req); rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("a malformed body is a 400", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{`))
		req.SetPathValue("id", "bot_x")
		if rec := callAsAdmin(t, jwtMgr, h.CreateToken, req); rec.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", rec.Code)
		}
	})

	t.Run("listing an unknown bot's tokens is a 404", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.SetPathValue("id", "bot_nope")
		if rec := callAsAdmin(t, jwtMgr, h.ListTokens, req); rec.Code != http.StatusNotFound {
			t.Errorf("status = %d, want 404", rec.Code)
		}
	})

	t.Run("admin gating covers every token route", func(t *testing.T) {
		for name, handler := range map[string]http.HandlerFunc{
			"create token": h.CreateToken, "list tokens": h.ListTokens, "revoke": h.RevokeToken,
			"get": h.Get, "list bots": h.List, "webhook": h.SetWebhook, "create bot": h.Create,
		} {
			req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{}`))
			req.SetPathValue("id", "bot_x")
			if rec := callAsMember(t, jwtMgr, handler, req); rec.Code != http.StatusForbidden {
				t.Errorf("%s: status = %d, want 403", name, rec.Code)
			}
		}
	})
}

func TestBotHandler_ListBots(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)
	createBotViaAPI(t, h, jwtMgr, `{"name":"Helper"}`)
	rec := callAsAdmin(t, jwtMgr, h.List, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var bots []map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&bots); err != nil {
		t.Fatal(err)
	}
	if len(bots) != 1 || bots[0]["name"] != "Helper" {
		t.Errorf("list = %+v, want the created bot", bots)
	}
}

func TestBotHandler_SetWebhookErrors(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)
	id := createBotViaAPI(t, h, jwtMgr, `{"name":"Helper"}`)

	tests := []struct {
		name string
		id   string
		body string
		want int
	}{
		{name: "malformed body", id: id, body: `{`, want: http.StatusBadRequest},
		{
			name: "unsafe callback URL", id: id,
			body: `{"callback_url":"http://127.0.0.1/hook"}`, want: http.StatusBadRequest,
		},
		{
			name: "unknown transport", id: id,
			body: `{"callback_url":"https://bot.example.com/hook","transport":"slack"}`, want: http.StatusBadRequest,
		},
		{
			name: "unusable trigger word", id: id,
			body: `{"callback_url":"https://bot.example.com/hook","trigger_words":["two words"]}`, want: http.StatusBadRequest,
		},
		{
			// Triggers with nothing to dispatch to would look configured but never fire.
			name: "triggers without a callback", id: id,
			body: `{"trigger_words":["deploy"]}`, want: http.StatusBadRequest,
		},
		{
			name: "unknown bot", id: "bot_nope",
			body: `{"callback_url":"https://bot.example.com/hook"}`, want: http.StatusNotFound,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(tc.body))
			req.SetPathValue("id", tc.id)
			rec := callAsAdmin(t, jwtMgr, h.SetWebhook, req)
			if rec.Code != tc.want {
				t.Errorf("status = %d, want %d (body %s)", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

// Clearing the webhook returns an empty secret — there is nothing left to verify.
func TestBotHandler_SetWebhookClear(t *testing.T) {
	h, jwtMgr, _, _ := setupBotHandler(t)
	id := createBotViaAPI(t, h, jwtMgr, `{"name":"Helper"}`)

	set := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"callback_url":"https://bot.example.com/hook"}`))
	set.SetPathValue("id", id)
	rec := callAsAdmin(t, jwtMgr, h.SetWebhook, set)
	if rec.Code != http.StatusOK {
		t.Fatalf("set status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var setRes map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&setRes); err != nil {
		t.Fatal(err)
	}
	if setRes["signing_secret"] == "" {
		t.Error("no signing secret returned; the receiver could never verify a call")
	}

	clear := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"callback_url":""}`))
	clear.SetPathValue("id", id)
	rec = callAsAdmin(t, jwtMgr, h.SetWebhook, clear)
	if rec.Code != http.StatusOK {
		t.Fatalf("clear status = %d", rec.Code)
	}
	var clearRes map[string]any
	if err := json.NewDecoder(rec.Body).Decode(&clearRes); err != nil {
		t.Fatal(err)
	}
	if clearRes["signing_secret"] != "" {
		t.Errorf("signing_secret = %v, want empty after clearing", clearRes["signing_secret"])
	}
}

// The remaining server-fault arms: a store that fails behind the read endpoints
// must surface a 500, not an empty list or a misleading 404.
func TestBotHandler_StoreFailures(t *testing.T) {
	bots := &failingMemBotStore{memBotStore: newMemBotStore()}
	users := newDataUserStoreForConv()
	h := NewBotHandler(service.NewBotService(bots, users))
	jwtMgr := auth.NewJWTManager("test-secret-that-is-long-enough-for-hs256", time.Minute, time.Hour)

	bots.failList = true
	if rec := callAsAdmin(t, jwtMgr, h.List, httptest.NewRequest(http.MethodGet, "/", nil)); rec.Code != http.StatusInternalServerError {
		t.Errorf("list status = %d, want 500", rec.Code)
	}
	bots.failList = false

	// A non-not-found failure behind Delete is a server fault, not a 404.
	if err := bots.CreateBot(context.Background(), &model.BotAccount{UserID: "bot_x", Name: "X"}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	bots.failListTokens = true
	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	req.SetPathValue("id", "bot_x")
	if rec := callAsAdmin(t, jwtMgr, h.Delete, req); rec.Code != http.StatusInternalServerError {
		t.Errorf("delete status = %d, want 500", rec.Code)
	}
}

// failingMemBotStore fails selected operations with a non-not-found error.
type failingMemBotStore struct {
	*memBotStore
	failList       bool
	failListTokens bool
}

var errMemBotStore = errors.New("bot store unavailable")

func (m *failingMemBotStore) ListBots(ctx context.Context) ([]*model.BotAccount, error) {
	if m.failList {
		return nil, errMemBotStore
	}
	return m.memBotStore.ListBots(ctx)
}

func (m *failingMemBotStore) ListBotTokens(ctx context.Context, id string) ([]*model.BotToken, error) {
	if m.failListTokens {
		return nil, errMemBotStore
	}
	return m.memBotStore.ListBotTokens(ctx, id)
}
