package handler

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/service"
)

// TestIsAllowedOIDCRedirect_ParseError covers the url.Parse error arm of
// isAllowedOIDCRedirect: a non-empty but unparseable URL is rejected.
func TestIsAllowedOIDCRedirect_ParseError(t *testing.T) {
	if isAllowedOIDCRedirect("http://[::1") {
		t.Fatal("unparseable redirect URL must be rejected")
	}
}

// TestRedirectWithQuery_ParseError covers redirectWithQuery's url.Parse error
// arm: when the raw target can't be parsed, it is returned unchanged.
func TestRedirectWithQuery_ParseError(t *testing.T) {
	raw := "\x7f" // control byte → url.Parse fails
	if got := redirectWithQuery(raw, url.Values{"token": []string{"t"}}); got != raw {
		t.Fatalf("redirectWithQuery on parse error = %q, want raw %q unchanged", got, raw)
	}
}

// TestOIDCCallback_DesktopAuthSessionError covers the callback arm where a
// desktop (localhost) redirect would mint a one-shot code, but
// CreateDesktopAuthSession fails (no cache configured) → 500.
func TestOIDCCallback_DesktopAuthSessionError(t *testing.T) {
	jwtMgr := auth.NewJWTManager("desktop-err-secret", 15*time.Minute, 720*time.Hour)
	userStore := newMockUserStore()
	tokenStore := newMockTokenStore()
	// Nil cache → CreateDesktopAuthSession returns an error.
	authSvc := service.NewAuthService(
		userStore,
		tokenStore,
		&mockInviteStore{},
		&mockMembershipStore{},
		&mockChannelStore{},
		jwtMgr,
		&stubOIDCProvider{
			url: "https://provider.example.com/authorize",
			userInfo: &service.OIDCUserInfo{
				Email: "desk@example.com", Name: "Desk User", Picture: "https://example.com/a.png",
			},
		},
		nil,
	)
	h := NewAuthHandler(authSvc, jwtMgr)

	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=ok&code=c", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_state", Value: "ok"})
	// localhost http → shouldUseDesktopAuthCode true → hits CreateDesktopAuthSession.
	req.AddCookie(&http.Cookie{Name: "oauth_redirect", Value: "http://localhost:1234/callback"})
	rec := httptest.NewRecorder()
	h.OIDCCallback(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "desktop_auth_error") {
		t.Fatalf("expected desktop_auth_error, got %s", rec.Body.String())
	}
}
