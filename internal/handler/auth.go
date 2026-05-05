package handler

import (
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
// sent after a successful callback (must be a localhost or tauri:// URL).
func (h *AuthHandler) OIDCLogin(w http.ResponseWriter, r *http.Request) {
	authURL, state, err := h.authSvc.HandleOIDCLogin()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "oidc_error", err.Error())
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
	if queryState == "" || queryState != stateCookie.Value {
		writeError(w, http.StatusBadRequest, "invalid_state", "OAuth state mismatch")
		return
	}

	// Clear the state cookie.
	http.SetCookie(w, &http.Cookie{
		Name:     "oauth_state",
		Value:    "",
		Path:     "/auth",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})

	code := r.URL.Query().Get("code")
	if code == "" {
		writeError(w, http.StatusBadRequest, "missing_code", "missing authorization code")
		return
	}

	accessToken, refreshToken, _, err := h.authSvc.HandleOIDCCallback(r.Context(), code, queryState)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "callback_error", err.Error())
		return
	}

	h.setRefreshCookie(w, refreshToken, h.jwt.RefreshTTL())

	// Default redirect: the SPA lives outside /auth/ to avoid the namespace
	// the router 404s for unknown /auth/** paths.
	finalRedirect := oidcCallbackRedirect(accessToken)
	if redirectCookie, err := r.Cookie("oauth_redirect"); err == nil && isAllowedOIDCRedirect(redirectCookie.Value) {
		target := redirectWithQuery(redirectCookie.Value, url.Values{"token": []string{accessToken}})
		parsed, _ := url.Parse(redirectCookie.Value)
		if parsed != nil && parsed.Hostname() == "localhost" && parsed.Scheme == "http" {
			code, err := h.authSvc.CreateDesktopAuthSession(r.Context(), accessToken, refreshToken)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "desktop_auth_error", err.Error())
				return
			}
			target = redirectWithQuery(redirectCookie.Value, url.Values{"desktop_code": []string{code}})
		}
		finalRedirect = target
		http.SetCookie(w, &http.Cookie{
			Name:     "oauth_redirect",
			Value:    "",
			Path:     "/auth",
			MaxAge:   -1,
			HttpOnly: true,
			Secure:   true,
			SameSite: http.SameSiteLaxMode,
		})
	}

	http.Redirect(w, r, finalRedirect, http.StatusFound)
}

func (h *AuthHandler) DesktopComplete(w http.ResponseWriter, r *http.Request) {
	session, err := h.authSvc.ConsumeDesktopAuthSession(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		writeError(w, http.StatusUnauthorized, "desktop_auth_error", err.Error())
		return
	}

	h.setRefreshCookie(w, session.RefreshToken, h.jwt.RefreshTTL())
	http.Redirect(w, r, oidcCallbackRedirect(session.AccessToken), http.StatusFound)
}

// isAllowedOIDCRedirect permits localhost (dev), tauri:// (desktop WebView),
// and ex:// (desktop deep-link) redirect targets; all other URLs are rejected
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
		return parsed.Host == "app"
	default:
		return false
	}
}

func oidcCallbackRedirect(accessToken string) string {
	return redirectWithQuery("/oidc/callback", url.Values{"token": []string{accessToken}})
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

	accessToken, err := h.authSvc.RefreshAccessToken(r.Context(), rawToken)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "refresh_error", err.Error())
		return
	}

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
		writeError(w, http.StatusInternalServerError, "invite_error", err.Error())
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
		writeError(w, http.StatusBadRequest, "invite_error", err.Error())
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
		writeError(w, http.StatusUnauthorized, "auth_error", err.Error())
		return
	}

	h.setRefreshCookie(w, refreshToken, h.jwt.RefreshTTL())
	writeJSON(w, http.StatusOK, JSON{
		"accessToken": accessToken,
		"user":        user,
	})
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
