package handler

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ------------------------------------------------------------------ fakes

var errHRT = errors.New("hrt store failure")

// hrtStore is an in-memory service.RunnerTokenStore with per-method faults.
type hrtStore struct {
	mu     sync.Mutex
	grants map[string]*model.RunnerGrant
	tokens map[string]*model.RunnerToken
	fail   map[string]bool
}

func newHRTStore() *hrtStore {
	return &hrtStore{grants: map[string]*model.RunnerGrant{}, tokens: map[string]*model.RunnerToken{}, fail: map[string]bool{}}
}

func (s *hrtStore) failing(m string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fail[m]
}

func (s *hrtStore) PutRunnerGrant(_ context.Context, g *model.RunnerGrant) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *g
	s.grants[g.CodeHash] = &cp
	return nil
}

func (s *hrtStore) TakeRunnerGrant(_ context.Context, h string) (*model.RunnerGrant, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.grants[h]
	if !ok {
		return nil, store.ErrNotFound
	}
	delete(s.grants, h)
	return g, nil
}

func (s *hrtStore) PutRunnerToken(_ context.Context, t *model.RunnerToken) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *t
	s.tokens[t.ID] = &cp
	return nil
}

func (s *hrtStore) GetRunnerToken(_ context.Context, id string) (*model.RunnerToken, error) {
	if s.failing("GetRunnerToken") {
		return nil, errHRT
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tokens[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *t
	return &cp, nil
}

func (s *hrtStore) SetRunnerTokenExpiry(_ context.Context, id string, exp time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.tokens[id]
	if !ok {
		return store.ErrNotFound
	}
	t.ExpiresAt = exp
	return nil
}

func (s *hrtStore) ListRunnerTokens(_ context.Context, uid string) ([]*model.RunnerToken, error) {
	if s.failing("ListRunnerTokens") {
		return nil, errHRT
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*model.RunnerToken
	for _, t := range s.tokens {
		if t.UserID == uid {
			cp := *t
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *hrtStore) DeleteRunnerToken(_ context.Context, id string) error {
	if s.failing("DeleteRunnerToken") {
		return errHRT
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tokens, id)
	return nil
}

func (s *hrtStore) DeleteAllRunnerTokensForUser(context.Context, string) error { return nil }

type hrtUsers struct{ users map[string]*model.User }

func (u *hrtUsers) GetByID(_ context.Context, id string) (*model.User, error) {
	if user, ok := u.users[id]; ok {
		return user, nil
	}
	return nil, store.ErrNotFound
}

type hrtEnv struct {
	router http.Handler
	store  *hrtStore
	users  *hrtUsers
	jwt    *auth.JWTManager
}

// newHRTEnv serves the REAL router, so routes, session auth and the runner
// revocation middleware are all exercised together.
func newHRTEnv() *hrtEnv {
	jwtMgr := auth.NewJWTManager("hrt-secret", 15*time.Minute, 24*time.Hour)
	st := newHRTStore()
	users := &hrtUsers{users: map[string]*model.User{
		"u-alice": {ID: "u-alice", DisplayName: "Alice", Status: "active"},
		"u-bob":   {ID: "u-bob", DisplayName: "Bob", Status: "active"},
		"a-gg":    {ID: "a-gg", DisplayName: "gg", Kind: model.UserKindAgent, Status: "active"},
	}}
	svc := service.NewRunnerTokenService(st, users, jwtMgr)
	router := NewRouter(&Deps{
		Auth:         &AuthHandler{},
		User:         &UserHandler{},
		Channel:      &ChannelHandler{},
		Conversation: &ConversationHandler{},
		WS:           &WSHandler{},
		RunnerToken:  NewRunnerTokenHandler(svc),
		JWT:          jwtMgr,
		AppVersion:   "hrt",
		AllowOrigins: []string{"*"},
	})
	return &hrtEnv{router: router, store: st, users: users, jwt: jwtMgr}
}

func (e *hrtEnv) session(t *testing.T, uid string) string {
	t.Helper()
	tok, err := e.jwt.GenerateAccessToken(e.users.users[uid])
	if err != nil {
		t.Fatalf("session token: %v", err)
	}
	return tok
}

func (e *hrtEnv) do(method, path, bearer, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	rec := httptest.NewRecorder()
	e.router.ServeHTTP(rec, req)
	return rec
}

func hrtPKCE() (verifier, challenge string) {
	verifier = strings.Repeat("k", 43)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

func hrtDecode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return out
}

func hrtErrCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	e, _ := hrtDecode(t, rec)["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

func hrtWant(t *testing.T, rec *httptest.ResponseRecorder, status int) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d (body %s)", rec.Code, status, rec.Body.String())
	}
}

// pair runs grant + exchange for a user and returns the issued runner token.
func (e *hrtEnv) pair(t *testing.T, uid, label string) (token, id string) {
	t.Helper()
	verifier, challenge := hrtPKCE()
	rec := e.do(http.MethodPost, "/api/v1/runner-tokens/grants", e.session(t, uid), `{"challenge":"`+challenge+`","label":"`+label+`"}`)
	hrtWant(t, rec, http.StatusCreated)
	code, _ := hrtDecode(t, rec)["code"].(string)
	rec = e.do(http.MethodPost, "/api/v1/runner-tokens/exchange", "", `{"code":"`+code+`","verifier":"`+verifier+`"}`)
	hrtWant(t, rec, http.StatusOK)
	body := hrtDecode(t, rec)
	token, _ = body["token"].(string)
	id, _ = body["id"].(string)
	if token == "" || id == "" || body["label"] != label || body["userName"] == "" || body["expiresAt"] == "" {
		t.Fatalf("exchange body = %v", body)
	}
	return token, id
}

// ------------------------------------------------------------------ tests

func TestHRT_PairListRenewRevoke(t *testing.T) {
	env := newHRTEnv()
	token, id := env.pair(t, "u-alice", "Alices-Mac")

	// The Runners page lists the install — never the token.
	rec := env.do(http.MethodGet, "/api/v1/runner-tokens", env.session(t, "u-alice"), "")
	hrtWant(t, rec, http.StatusOK)
	if strings.Contains(rec.Body.String(), token) || !strings.Contains(rec.Body.String(), `"label":"Alices-Mac"`) {
		t.Fatalf("list body = %s", rec.Body.String())
	}
	// Bob sees none of Alice's runners.
	rec = env.do(http.MethodGet, "/api/v1/runner-tokens", env.session(t, "u-bob"), "")
	hrtWant(t, rec, http.StatusOK)
	if !strings.Contains(rec.Body.String(), `"runners":[]`) {
		t.Fatalf("bob's list = %s", rec.Body.String())
	}

	// The runner renews through the revocation middleware.
	rec = env.do(http.MethodPost, "/api/v1/agent/runner/renew", token, "{}")
	hrtWant(t, rec, http.StatusOK)
	renewed, _ := hrtDecode(t, rec)["token"].(string)
	if renewed == "" {
		t.Fatalf("renew body = %s", rec.Body.String())
	}
	// A session token is not a runner token.
	hrtWant(t, env.do(http.MethodPost, "/api/v1/agent/runner/renew", env.session(t, "u-alice"), "{}"), http.StatusUnauthorized)

	// Bob can't revoke Alice's install; Alice can. Afterwards BOTH the old
	// and the renewed JWT are dead — they share the install's id.
	hrtWant(t, env.do(http.MethodDelete, "/api/v1/runner-tokens/"+id, env.session(t, "u-bob"), ""), http.StatusNotFound)
	hrtWant(t, env.do(http.MethodDelete, "/api/v1/runner-tokens/"+id, env.session(t, "u-alice"), ""), http.StatusNoContent)
	hrtWant(t, env.do(http.MethodPost, "/api/v1/agent/runner/renew", token, "{}"), http.StatusUnauthorized)
	hrtWant(t, env.do(http.MethodPost, "/api/v1/agent/runner/renew", renewed, "{}"), http.StatusUnauthorized)
}

func TestHRT_LogoutRevokesItself(t *testing.T) {
	env := newHRTEnv()
	token, _ := env.pair(t, "u-alice", "mac")
	hrtWant(t, env.do(http.MethodPost, "/api/v1/agent/runner/revoke", token, "{}"), http.StatusNoContent)
	hrtWant(t, env.do(http.MethodPost, "/api/v1/agent/runner/revoke", token, "{}"), http.StatusUnauthorized)
}

func TestHRT_GrantAndExchangeRefusals(t *testing.T) {
	env := newHRTEnv()
	_, challenge := hrtPKCE()

	// No session → 401 before the handler.
	hrtWant(t, env.do(http.MethodPost, "/api/v1/runner-tokens/grants", "", `{}`), http.StatusUnauthorized)
	rec := env.do(http.MethodPost, "/api/v1/runner-tokens/grants", env.session(t, "u-alice"), `not json`)
	hrtWant(t, rec, http.StatusBadRequest)
	rec = env.do(http.MethodPost, "/api/v1/runner-tokens/grants", env.session(t, "u-alice"), `{"challenge":"short"}`)
	hrtWant(t, rec, http.StatusBadRequest)
	// Agent users never pair runners.
	rec = env.do(http.MethodPost, "/api/v1/runner-tokens/grants", env.session(t, "a-gg"), `{"challenge":"`+challenge+`"}`)
	hrtWant(t, rec, http.StatusForbidden)

	rec = env.do(http.MethodPost, "/api/v1/runner-tokens/exchange", "", `not json`)
	hrtWant(t, rec, http.StatusBadRequest)
	rec = env.do(http.MethodPost, "/api/v1/runner-tokens/exchange", "", `{"code":"nope","verifier":"`+strings.Repeat("k", 43)+`"}`)
	hrtWant(t, rec, http.StatusBadRequest)
	if code := hrtErrCode(t, rec); code != "invalid_grant" {
		t.Fatalf("error code = %q, want invalid_grant", code)
	}
}

func TestHRT_RenewOfDeactivatedOwnerIsDisconnected(t *testing.T) {
	env := newHRTEnv()
	token, _ := env.pair(t, "u-alice", "mac")
	env.users.users["u-alice"].Status = "deactivated"
	rec := env.do(http.MethodPost, "/api/v1/agent/runner/renew", token, "{}")
	hrtWant(t, rec, http.StatusUnauthorized)
	if code := hrtErrCode(t, rec); code != "runner_disconnected" {
		t.Fatalf("error code = %q, want runner_disconnected", code)
	}
}

func TestHRT_StoreFailuresAreGeneric500s(t *testing.T) {
	env := newHRTEnv()
	token, id := env.pair(t, "u-alice", "mac")

	env.store.fail["ListRunnerTokens"] = true
	hrtWant(t, env.do(http.MethodGet, "/api/v1/runner-tokens", env.session(t, "u-alice"), ""), http.StatusInternalServerError)

	env.store.fail["DeleteRunnerToken"] = true
	hrtWant(t, env.do(http.MethodPost, "/api/v1/agent/runner/revoke", token, "{}"), http.StatusInternalServerError)

	// A store failure behind the revocation check is a 503 (runner backs off),
	// and behind DELETE a generic 500.
	env.store.fail["GetRunnerToken"] = true
	hrtWant(t, env.do(http.MethodPost, "/api/v1/agent/runner/renew", token, "{}"), http.StatusServiceUnavailable)
	rec := env.do(http.MethodDelete, "/api/v1/runner-tokens/"+id, env.session(t, "u-alice"), "")
	hrtWant(t, rec, http.StatusInternalServerError)
	if strings.Contains(rec.Body.String(), errHRT.Error()) {
		t.Fatalf("internal error leaked to the client: %s", rec.Body.String())
	}
}

func TestHRT_CheckerFailsClosedWhenUnwired(t *testing.T) {
	var nilHandler *RunnerTokenHandler
	if nilHandler.Checker() != nil {
		t.Fatal("nil handler must yield no checker")
	}
	if (&RunnerTokenHandler{}).Checker() != nil {
		t.Fatal("handler without a service must yield no checker")
	}
	if NewRunnerTokenHandler(service.NewRunnerTokenService(newHRTStore(), &hrtUsers{}, nil)).Checker() == nil {
		t.Fatal("wired handler must yield its service as the checker")
	}
}
