package middleware

import (
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
	runnerTok, err := m.GenerateRunnerToken(mwCovUser(), time.Hour)
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
	runnerTok, _ := m.GenerateRunnerToken(mwCovUser(), time.Hour)
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
