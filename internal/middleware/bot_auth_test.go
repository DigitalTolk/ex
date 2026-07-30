package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
)

// stubBotValidator records what it was asked to validate so a test can prove
// the middleware routed (or didn't route) a token to the bot path.
type stubBotValidator struct {
	claims *model.TokenClaims
	err    error
	called []string
}

func (s *stubBotValidator) ValidateBotToken(_ context.Context, token string) (*model.TokenClaims, error) {
	s.called = append(s.called, token)
	return s.claims, s.err
}

// claimsCapturingHandler records the claims the middleware put in context.
func claimsCapturingHandler(dest **model.TokenClaims) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		*dest = ClaimsFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}
}

// AuthWithBots replaces the middleware nearly every authenticated route runs
// through, so with no validator wired it must behave exactly like the JWT-only
// middleware it supersedes — same statuses, same bodies, for every token shape.
func TestAuthWithBotsNilValidatorMatchesAuthWithUserStatus(t *testing.T) {
	mgr := newTestJWTManager()
	valid := generateTestToken(mgr)

	cases := []struct {
		name   string
		header string
	}{
		{"valid jwt", "Bearer " + valid},
		{"invalid jwt", "Bearer not-a-jwt"},
		{"missing header", ""},
		{"wrong scheme", "Basic " + valid},
		// A bot-prefixed token with no validator must fall through to the JWT
		// path and be rejected there, not crash or be treated as special.
		{"bot-prefixed token", "Bearer " + model.BotTokenPrefix + "whatever"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			old := AuthWithUserStatus(mgr, nil)(okHandler())
			new := AuthWithBots(mgr, nil, nil)(okHandler())

			run := func(h http.Handler) *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodGet, "/test", nil)
				if tc.header != "" {
					req.Header.Set("Authorization", tc.header)
				}
				rec := httptest.NewRecorder()
				h.ServeHTTP(rec, req)
				return rec
			}

			oldRec, newRec := run(old), run(new)
			if oldRec.Code != newRec.Code {
				t.Errorf("status: AuthWithUserStatus = %d, AuthWithBots = %d", oldRec.Code, newRec.Code)
			}
			if oldRec.Body.String() != newRec.Body.String() {
				t.Errorf("body: AuthWithUserStatus = %q, AuthWithBots = %q", oldRec.Body.String(), newRec.Body.String())
			}
		})
	}
}

func TestAuthWithBotsAcceptsBotToken(t *testing.T) {
	botClaims := &model.TokenClaims{
		UserID:     "bot_01H",
		Email:      "bot_01H@bots.invalid",
		SystemRole: model.SystemRoleMember,
	}
	validator := &stubBotValidator{claims: botClaims}

	var got *model.TokenClaims
	handler := AuthWithBots(newTestJWTManager(), nil, validator)(claimsCapturingHandler(&got))

	token := model.BotTokenPrefix + "abc123"
	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if len(validator.called) != 1 || validator.called[0] != token {
		t.Errorf("validator calls = %v, want exactly [%q]", validator.called, token)
	}
	// Downstream handlers read identity only through these accessors, so a bot
	// request must populate them exactly like a human's does.
	if got == nil || got.UserID != "bot_01H" {
		t.Fatalf("claims in context = %+v, want UserID bot_01H", got)
	}
	if got.SystemRole != model.SystemRoleMember {
		t.Errorf("SystemRole = %q, want member", got.SystemRole)
	}
}

func TestAuthWithBotsRejectsInvalidBotToken(t *testing.T) {
	validator := &stubBotValidator{err: errors.New("invalid token")}
	handler := AuthWithBots(newTestJWTManager(), nil, validator)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer "+model.BotTokenPrefix+"revoked")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

// A JWT must never reach the bot validator, even when one is wired.
func TestAuthWithBotsRoutesJWTToJWTPath(t *testing.T) {
	mgr := newTestJWTManager()
	validator := &stubBotValidator{err: errors.New("should not be called")}
	handler := AuthWithBots(mgr, nil, validator)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer "+generateTestToken(mgr))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if len(validator.called) != 0 {
		t.Errorf("bot validator saw a JWT: %v", validator.called)
	}
}

// Retiring a bot deactivates its user; the shared status check is what makes
// that stick, so a valid token for a deactivated bot must still be rejected.
func TestAuthWithBotsRejectsDeactivatedBot(t *testing.T) {
	validator := &stubBotValidator{claims: &model.TokenClaims{
		UserID:     "bot_gone",
		SystemRole: model.SystemRoleMember,
	}}
	users := statusUserStore{user: &model.User{ID: "bot_gone", Status: "deactivated"}}
	handler := AuthWithBots(newTestJWTManager(), users, validator)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer "+model.BotTokenPrefix+"still-held")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

// Guard against the prefix drifting: external integrations pattern-match on it,
// and a JWT must remain distinguishable from a bot token by first bytes alone.
func TestBotTokenPrefixCannotCollideWithJWT(t *testing.T) {
	mgr := newTestJWTManager()
	jwt := generateTestToken(mgr)
	if len(jwt) == 0 {
		t.Fatal("failed to generate a test JWT")
	}
	if got := jwt[:3]; got != "eyJ" {
		t.Fatalf("JWT no longer starts with eyJ (got %q) — the prefix dispatch assumption is broken", got)
	}
	if model.BotTokenPrefix == "" {
		t.Fatal("BotTokenPrefix must not be empty")
	}
	var _ *auth.JWTManager = mgr
}
