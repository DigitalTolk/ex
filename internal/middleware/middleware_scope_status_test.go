package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// A run token outlived its invoker's deactivation: AuthScope checked the
// scope only, so a run started before the account was switched off kept
// acting with that account's access until the token expired. With a user
// store wired, a deactivated (or unreadable) token user is refused.
func TestMwCov_AuthScopeWithUserStatus(t *testing.T) {
	m := mwCovManager()
	runTok, _ := m.GenerateRunToken("run-1", "u-1", "a-gg", time.Now().Add(time.Hour))
	call := func(users authUserStore) int {
		h := AuthScopeWithUserStatus(m, model.TokenScopeRun, users)(okHandler())
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.Header.Set("Authorization", "Bearer "+runTok)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec.Code
	}
	if got := call(statusUserStore{user: &model.User{ID: "u-1", Status: "deactivated"}}); got != http.StatusUnauthorized {
		t.Fatalf("deactivated invoker: want 401, got %d", got)
	}
	if got := call(statusUserStore{err: errors.New("store down")}); got != http.StatusUnauthorized {
		t.Fatalf("unreadable status fails closed: want 401, got %d", got)
	}
	if got := call(statusUserStore{user: &model.User{ID: "u-1", Status: "active"}}); got != http.StatusOK {
		t.Fatalf("active invoker: want 200, got %d", got)
	}
	if got := call(nil); got != http.StatusOK {
		t.Fatalf("no store wired (plain AuthScope): want 200, got %d", got)
	}
}
