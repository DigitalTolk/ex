package handler

import (
	"net/http"
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
	// /oidc/callback (not /auth/callback) — the SPA fallback explicitly 404s
	// the /auth/ namespace to avoid shadowing real auth endpoints, so the
	// callback page lives outside that prefix.
	http.Redirect(w, r, "/oidc/callback?token="+accessToken, http.StatusFound)
}

// RefreshToken exchanges a refresh token cookie for a new access token.
func (h *AuthHandler) RefreshToken(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("refresh_token")
	if err != nil {
		writeError(w, http.StatusUnauthorized, "missing_token", "missing refresh token")
		return
	}

	accessToken, err := h.authSvc.RefreshAccessToken(r.Context(), cookie.Value)
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
