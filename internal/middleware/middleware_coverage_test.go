package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
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
	active bool
	err    error
	seen   *model.TokenClaims
}

func (c *mwCovChecker) RunnerTokenActive(_ context.Context, claims *model.TokenClaims) (bool, error) {
	c.seen = claims
	return c.active, c.err
}

// AuthRunner: the scope check, then the per-install revocation check — 401
// for a revoked install, 503 when the check itself fails, fail-closed with no
// checker wired.
func TestMwCov_AuthRunner(t *testing.T) {
	m := mwCovManager()
	runnerTok, _ := m.GenerateRunnerToken(mwCovUser(), "rt-1", time.Now().Add(time.Hour))
	runTok, _ := m.GenerateRunToken("run-1", "u-1", "a-gg", time.Now().Add(time.Hour))

	serve := func(checker RunnerTokenChecker, tok string) (*httptest.ResponseRecorder, bool) {
		ran := false
		h := AuthRunner(m, checker)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ran = ClaimsFromContext(r.Context()) != nil
		}))
		req := httptest.NewRequest(http.MethodPost, "/", nil)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec, ran
	}

	if rec, _ := serve(&mwCovChecker{active: true}, ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: want 401, got %d", rec.Code)
	}
	if rec, _ := serve(&mwCovChecker{active: true}, runTok); rec.Code != http.StatusUnauthorized {
		t.Fatalf("run token: want 401, got %d", rec.Code)
	}
	if rec, _ := serve(nil, runnerTok); rec.Code != http.StatusUnauthorized {
		t.Fatalf("nil checker must fail closed: got %d", rec.Code)
	}
	if rec, ran := serve(&mwCovChecker{active: false}, runnerTok); rec.Code != http.StatusUnauthorized || ran {
		t.Fatalf("revoked install: want 401 and no handler, got %d (ran=%v)", rec.Code, ran)
	}
	if rec, ran := serve(&mwCovChecker{err: errors.New("dynamo down")}, runnerTok); rec.Code != http.StatusServiceUnavailable || ran {
		t.Fatalf("check failure: want 503 and no handler, got %d (ran=%v)", rec.Code, ran)
	}
	ok := &mwCovChecker{active: true}
	rec, ran := serve(ok, runnerTok)
	if rec.Code != http.StatusOK || !ran {
		t.Fatalf("live install: want 200 + handler, got %d (ran=%v)", rec.Code, ran)
	}
	if ok.seen == nil || ok.seen.ID != "rt-1" {
		t.Fatalf("checker must see the token's claims (jti), got %+v", ok.seen)
	}
}
