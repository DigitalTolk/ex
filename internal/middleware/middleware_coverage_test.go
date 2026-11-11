package middleware

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
)

func mwCovManager() *auth.JWTManager {
	return auth.NewJWTManager("mw-secret", time.Hour, 24*time.Hour)
}

func mwCovUser() *model.User {
	return &model.User{ID: "u-1", Email: "u1@example.com", DisplayName: "U", SystemRole: model.SystemRoleMember}
}

// Scoped (machine) tokens must never authenticate the interactive API.
func TestMwCov_AuthRejectsScopedTokens(t *testing.T) {
	m := mwCovManager()
	runnerTok, err := m.GenerateRunnerToken(mwCovUser(), "rt-1", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	h := Auth(m)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Fatal("scoped token must not reach the handler")
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+runnerTok)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("scoped token on session API: want 401, got %d", rec.Code)
	}
}

// AuthScope: exactly the demanded scope passes; anything else is a 401.
func TestMwCov_AuthScope(t *testing.T) {
	m := mwCovManager()
	runnerTok, _ := m.GenerateRunnerToken(mwCovUser(), "rt-1", time.Now().Add(time.Hour))
	runTok, _ := m.GenerateRunToken("run-1", "u-1", "a-gg", time.Now().Add(time.Hour))

	nextRan := false
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextRan = true
		if r.Context().Value(claimsKey) == nil {
			t.Fatal("claims missing from context")
		}
	})
	guard := AuthScope(m, model.TokenScopeRunner)(next)

	t.Run("missing token", func(t *testing.T) {
		rec := httptest.NewRecorder()
		guard.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("no token: want 401, got %d", rec.Code)
		}
	})
	t.Run("wrong scope", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+runTok)
		rec := httptest.NewRecorder()
		guard.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("run token on runner API: want 401, got %d", rec.Code)
		}
	})
	t.Run("right scope", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+runnerTok)
		rec := httptest.NewRecorder()
		guard.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !nextRan {
			t.Fatalf("runner token: want 200 + handler run, got %d (ran=%v)", rec.Code, nextRan)
		}
	})
}

// mwCovChecker is a canned RunnerTokenChecker.
type mwCovChecker struct {
	err    error
	seen   *model.TokenClaims
	seenRq RunnerRequest
}

func (c *mwCovChecker) CheckRunner(_ context.Context, claims *model.TokenClaims, req RunnerRequest) error {
	c.seen, c.seenRq = claims, req
	return c.err
}

// AuthRunner: the scope check, then the per-install check — its refusal as a
// JSON error with the checker's status and code, 503 when the check itself
// fails, fail-closed with no checker wired.
func TestMwCov_AuthRunner(t *testing.T) {
	m := mwCovManager()
	runnerTok, _ := m.GenerateRunnerToken(mwCovUser(), "rt-1", time.Now().Add(time.Hour))
	runTok, _ := m.GenerateRunToken("run-1", "u-1", "a-gg", time.Now().Add(time.Hour))

	serve := func(checker RunnerTokenChecker, tok string) (*httptest.ResponseRecorder, bool) {
		ran := false
		h := AuthRunner(m, checker)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ran = ClaimsFromContext(r.Context()) != nil
		}))
		req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/runner/heartbeat?x=1", nil)
		req.RemoteAddr = "203.0.113.9:4444"
		req.Header.Set(RunnerProofHeader, "v1.1.sig")
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec, ran
	}

	if rec, _ := serve(&mwCovChecker{}, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: want 401, got %d", rec.Code)
	}
	if rec, _ := serve(&mwCovChecker{}, runTok); rec.Code != http.StatusUnauthorized {
		t.Fatalf("run token: want 401, got %d", rec.Code)
	}
	if rec, _ := serve(nil, runnerTok); rec.Code != http.StatusUnauthorized {
		t.Fatalf("nil checker must fail closed: got %d", rec.Code)
	}
	refused := &mwCovChecker{err: fmt.Errorf("wrapped: %w", &RunnerRefusal{Status: http.StatusUnauthorized, Code: "runner_clock_skew", Message: "clock off"})}
	rec, ran := serve(refused, runnerTok)
	if rec.Code != http.StatusUnauthorized || ran {
		t.Fatalf("refusal: want 401 and no handler, got %d (ran=%v)", rec.Code, ran)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("refusal content type = %q", ct)
	}
	if body := strings.TrimSpace(rec.Body.String()); body != `{"error":{"code":"runner_clock_skew","message":"clock off"}}` {
		t.Fatalf("refusal body = %s", body)
	}
	if rec, ran := serve(&mwCovChecker{err: errors.New("dynamo down")}, runnerTok); rec.Code != http.StatusServiceUnavailable || ran {
		t.Fatalf("check failure: want 503 and no handler, got %d (ran=%v)", rec.Code, ran)
	}
	ok := &mwCovChecker{}
	rec, ran = serve(ok, runnerTok)
	if rec.Code != http.StatusOK || !ran {
		t.Fatalf("live install: want 200 + handler, got %d (ran=%v)", rec.Code, ran)
	}
	if ok.seen == nil || ok.seen.ID != "rt-1" {
		t.Fatalf("checker must see the token's claims (jti), got %+v", ok.seen)
	}
	want := RunnerRequest{Method: http.MethodPost, Path: "/api/v1/agent/runner/heartbeat", Proof: "v1.1.sig", IP: "203.0.113.9"}
	if ok.seenRq != want {
		t.Fatalf("checker saw %+v, want %+v", ok.seenRq, want)
	}
	if (&RunnerRefusal{Message: "m"}).Error() != "m" {
		t.Fatal("RunnerRefusal.Error")
	}
}
