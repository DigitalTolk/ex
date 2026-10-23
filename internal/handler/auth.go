package handler

import (
	"crypto/subtle"
	"net/http"
	"net/url"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// AuthHandler exposes HTTP endpoints for authentication flows.
type AuthHandler struct {
	authSvc *service.AuthService
	jwt     *auth.JWTManager
}

// NewAuthHandler creates an AuthHandler.
func NewAuthHandler(authSvc *service.AuthService, jwt *auth.JWTManager) *AuthHandler {
	return &AuthHandler{authSvc: authSvc, jwt: jwt}
}

// OIDCLogin initiates the OIDC login flow by redirecting to the identity provider.
// An optional ?redirect_to=<url> query parameter overrides where the browser is
// sent after a successful callback (must be a localhost, tauri://, or ex:// URL).
func (h *AuthHandler) OIDCLogin(w http.ResponseWriter, r *http.Request) {
	authURL, state, nonce, err := h.authSvc.HandleOIDCLogin()
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "oauth_state",
		Value:    state,
		Path:     "/auth",
		MaxAge:   600, // 10 minutes
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     "oauth_nonce",
		Value:    nonce,
		Path:     "/auth",
		MaxAge:   600, // 10 minutes
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})

	if redirectTo := r.URL.Query().Get("redirect_to"); isAllowedOIDCRedirect(redirectTo) {
		http.SetCookie(w, &http.Cookie{
			Name:     "oauth_redirect",
			Value:    redirectTo,
			Path:     "/auth",
			MaxAge:   600,
			HttpOnly: true,
			Secure:   true,
			SameSite: http.SameSiteLaxMode,
		})
	}

	http.Redirect(w, r, authURL, http.StatusFound)
}

// OIDCCallback handles the identity provider redirect after authentication.
func (h *AuthHandler) OIDCCallback(w http.ResponseWriter, r *http.Request) {
	stateCookie, err := r.Cookie("oauth_state")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing_state", "missing OAuth state cookie")
		return
	}

	queryState := r.URL.Query().Get("state")
	if queryState == "" || subtle.ConstantTimeCompare([]byte(queryState), []byte(stateCookie.Value)) != 1 {
		writeError(w, http.StatusBadRequest, "invalid_state", "OAuth state mismatch")
		return
	}

	// The nonce bound at login time is verified against the ID token's nonce
	// claim inside HandleOIDCCallback. A missing nonce cookie yields an empty
	// expected value, which will not match a provider-issued nonce → rejected.
	nonce := ""
	if nonceCookie, err := r.Cookie("oauth_nonce"); err == nil {
		nonce = nonceCookie.Value
	}

	// Clear the state + nonce cookies.
	for _, name := range []string{"oauth_state", "oauth_nonce"} {
		http.SetCookie(w, &http.Cookie{
			Name:     name,
			Value:    "",
			Path:     "/auth",
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   true,
			SameSite: http.SameSiteLaxMode,
		})
	}

	code := r.URL.Query().Get("code")
	if code == "" {
		writeError(w, http.StatusBadRequest, "missing_code", "missing authorization code")
		return
	}

	_, refreshToken, _, err := h.authSvc.HandleOIDCCallback(r.Context(), code, queryState, nonce)
	if err != nil {
		// A refusal by the identity policy is a fixed 403 sign_in_refused;
		// anything else is internal.
		writeServiceError(w, r, err)
		return
	}

	// No URL ever carries a credential. A browser lands on the bare SPA
	// route (outside /auth/, which the router 404s for unknown paths) with
	// the refresh cookie set here, and the SPA signs in by refreshing — it
	// ignores any token a URL offers, so a crafted link can't sign a victim
	// into someone else's account. An app shell gets a one-time desktop_code
	// it redeems itself at /auth/desktop/complete.
	if redirectCookie, err := r.Cookie("oauth_redirect"); err == nil && isAllowedOIDCRedirect(redirectCookie.Value) {
		code, err := h.authSvc.CreateDesktopAuthSession(r.Context(), refreshToken)
		if err != nil {
			writeServiceError(w, r, err)
			return
		}
		http.SetCookie(w, &http.Cookie{
			Name:     "oauth_redirect",
			Value:    "",
			Path:     "/auth",
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   true,
			SameSite: http.SameSiteLaxMode,
		})
		http.Redirect(w, r, redirectWithQuery(redirectCookie.Value, url.Values{"desktop_code": []string{code}}), http.StatusFound)
		return
	}

	h.setRefreshCookie(w, refreshToken, h.jwt.RefreshTTL())
	http.Redirect(w, r, oidcCallbackPath, http.StatusFound)
}

// oidcCallbackPath is the SPA route that completes a sign-in from the
// refresh cookie.
const oidcCallbackPath = "/oidc/callback"

// DesktopComplete redeems a one-time desktop_code: it sets the refresh cookie
// first-party and lands the app on the SPA callback. Only a navigation the
// app itself starts may redeem a code — Electron's loadURL and WKWebView's
// load(URLRequest) send Sec-Fetch-Site: none (a client without fetch
// metadata sends nothing). A link to this URL — posted in a message
// (same-origin) or on another site — would otherwise plant the code minter's
// session in whoever clicks it, so any other value is refused before the
// code is touched.
func (h *AuthHandler) DesktopComplete(w http.ResponseWriter, r *http.Request) {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "none" {
		writeError(w, http.StatusForbidden, "desktop_auth_error", "this sign-in link can only be opened by the app")
		return
	}
	session, err := h.authSvc.ConsumeDesktopAuthSession(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	h.setRefreshCookie(w, session.RefreshToken, h.jwt.RefreshTTL())
	http.Redirect(w, r, oidcCallbackPath, http.StatusFound)
}

// isAllowedOIDCRedirect permits localhost (dev), tauri:// (desktop WebView),
// and ex:// (desktop/mobile deep-link) redirect targets; all other URLs are rejected
// to prevent open redirect attacks. The match uses url.Parse so an attacker
// controlling e.g. localhost.evil.com cannot satisfy the allowlist.
func isAllowedOIDCRedirect(u string) bool {
	if u == "" {
		return false
	}
	parsed, err := url.Parse(u)
	if err != nil {
		return false
	}
	switch parsed.Scheme {
	case "http", "https", "tauri":
		return parsed.Hostname() == "localhost"
	case "ex":
		return parsed.Host == "app" || parsed.Host == "mobile"
	default:
		return false
	}
}

func redirectWithQuery(raw string, query url.Values) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	existing := parsed.Query()
	for key, values := range query {
		existing.Del(key)
		for _, value := range values {
			existing.Add(key, value)
		}
	}
	parsed.RawQuery = existing.Encode()
	return parsed.String()
}

// RefreshToken exchanges a refresh token for a new access token.
// Accepts the token from an httpOnly cookie.
func (h *AuthHandler) RefreshToken(w http.ResponseWriter, r *http.Request) {
	var rawToken string
	if cookie, err := r.Cookie("refresh_token"); err == nil {
		rawToken = cookie.Value
	}
	if rawToken == "" {
		writeError(w, http.StatusUnauthorized, "missing_token", "missing refresh token")
		return
	}

	accessToken, newRefresh, err := h.authSvc.RefreshAccessToken(r.Context(), rawToken)
	if err != nil {
		// A refused session is a 4xx — 401 for a dead session, 403 for a
		// deactivated account — and the client signs out; anything else is the
		// server's fault and a 5xx, so the client retries instead of dropping a
		// session that is probably fine. Never the error's text: the caller is
		// unauthenticated, and every mapped auth row has a fixed message.
		writeServiceError(w, r, err)
		return
	}

	// Rotation: replace the cookie with the freshly-issued refresh token.
	h.setRefreshCookie(w, newRefresh, h.jwt.RefreshTTL())
	writeJSON(w, http.StatusOK, JSON{"accessToken": accessToken})
}

// Logout invalidates the refresh token and clears the cookie.
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("refresh_token")
	if err != nil {
		h.clearRefreshCookie(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	_ = h.authSvc.Logout(r.Context(), cookie.Value)
	h.clearRefreshCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

// CreateInvite generates an invitation for a new user.
func (h *AuthHandler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	var body struct {
		Email      string   `json:"email"`
		ChannelIDs []string `json:"channelIDs"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Email == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "email is required")
		return
	}

	invite, err := h.authSvc.CreateInvite(r.Context(), userID, body.Email, body.ChannelIDs)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, invite)
}

// AcceptInvite accepts an invitation and creates a guest account.
func (h *AuthHandler) AcceptInvite(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token       string `json:"token"`
		DisplayName string `json:"displayName"`
		Password    string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Token == "" || body.DisplayName == "" || body.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "token, displayName, and password are required")
		return
	}

	accessToken, refreshToken, user, err := h.authSvc.AcceptInvite(r.Context(), body.Token, body.DisplayName, body.Password)
	if err != nil {
		// Unauthenticated caller: fixed messages for the failures they can
		// act on, a generic 500 (detail logged) for everything else.
		writeServiceError(w, r, err)
		return
	}

	h.setRefreshCookie(w, refreshToken, h.jwt.RefreshTTL())
	writeJSON(w, http.StatusOK, JSON{
		"accessToken": accessToken,
		"user":        user,
	})
}

// GuestLogin authenticates a guest user with email and password.
func (h *AuthHandler) GuestLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Email == "" || body.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "email and password are required")
		return
	}

	accessToken, refreshToken, user, err := h.authSvc.GuestLogin(r.Context(), body.Email, body.Password)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	h.setRefreshCookie(w, refreshToken, h.jwt.RefreshTTL())
	writeJSON(w, http.StatusOK, JSON{
		"accessToken": accessToken,
		"user":        user,
	})
}

// AdminResetUserPassword mints a one-time password-reset link for a guest
// account and emails it to that guest. Admin-only.
//
// The link comes back in the response as well, so an admin can relay it
// directly when mail is unconfigured or the relay is down; `emailSent` tells
// the UI which story to show. SSO users are rejected with 409 — their
// credential lives in the identity provider and must stay there.
func (h *AuthHandler) AdminResetUserPassword(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	targetID := pathParam(r, "id")
	if targetID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "user ID is required")
		return
	}

	ticket, err := h.authSvc.CreatePasswordResetForUser(r.Context(), targetID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}

	writeJSON(w, http.StatusCreated, ticket)
}

// ForgotPassword is the unauthenticated "email me a reset link" endpoint for
// guest accounts. It always answers 204: the response must not reveal whether
// an address is registered, whether it is a guest, or whether mail went out.
func (h *AuthHandler) ForgotPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email string `json:"email"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	// RequestPasswordReset answers nil or ErrPasswordResetUnavailable and
	// nothing else: every per-account failure (unknown address, SSO account,
	// store outage, mail outage) is deliberately swallowed so this response
	// cannot be used to enumerate accounts. Hence a single error arm, and a
	// fixed message rather than the error's own — that keeps the endpoint
	// non-revealing even if the service's error set ever widens.
	if err := h.authSvc.RequestPasswordReset(r.Context(), body.Email); err != nil {
		writeError(w, http.StatusServiceUnavailable, "reset_unavailable",
			service.ErrPasswordResetUnavailable.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ResetPassword redeems a one-time reset token and sets a new password. The
// caller is unauthenticated — the token IS the credential — so the token is
// single-use and every existing session for the account is revoked.
func (h *AuthHandler) ResetPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Token    string `json:"token"`
		Password string `json:"password"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Token == "" || body.Password == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "token and password are required")
		return
	}

	if err := h.authSvc.ResetPassword(r.Context(), body.Token, body.Password); err != nil {
		writeServiceError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// setRefreshCookie sets a secure httpOnly cookie containing the refresh token.
func (h *AuthHandler) setRefreshCookie(w http.ResponseWriter, token string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     "refresh_token",
		Value:    token,
		Path:     "/auth",
		MaxAge:   int(ttl.Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}

// clearRefreshCookie removes the refresh token cookie.
func (h *AuthHandler) clearRefreshCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     "refresh_token",
		Value:    "",
		Path:     "/auth",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteStrictMode,
	})
}
