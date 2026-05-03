package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/crypto/bcrypt"
)

// --- Minimal mock implementations for auth handler tests ---

type mockUserStore struct {
	users       map[string]*model.User
	emailIndex  map[string]*model.User
	createErr   error
	hasUsersVal bool
}

func newMockUserStore() *mockUserStore {
	return &mockUserStore{
		users:      make(map[string]*model.User),
		emailIndex: make(map[string]*model.User),
	}
}

func (m *mockUserStore) CreateUser(_ context.Context, u *model.User) error {
	if m.createErr != nil {
		return m.createErr
	}
	m.users[u.ID] = u
	m.emailIndex[u.Email] = u
	return nil
}

func (m *mockUserStore) GetUser(_ context.Context, id string) (*model.User, error) {
	u, ok := m.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return u, nil
}

func (m *mockUserStore) GetUserByEmail(_ context.Context, email string) (*model.User, error) {
	u, ok := m.emailIndex[email]
	if !ok {
		return nil, store.ErrNotFound
	}
	return u, nil
}

func (m *mockUserStore) UpdateUser(_ context.Context, u *model.User) error {
	m.users[u.ID] = u
	m.emailIndex[u.Email] = u
	return nil
}

func (m *mockUserStore) ListUsers(_ context.Context, _ int, _ string) ([]*model.User, string, error) {
	var result []*model.User
	for _, u := range m.users {
		result = append(result, u)
	}
	return result, "", nil
}

func (m *mockUserStore) HasUsers(_ context.Context) (bool, error) {
	return m.hasUsersVal, nil
}

type mockTokenStore struct {
	tokens map[string]*model.RefreshToken
}

func newMockTokenStore() *mockTokenStore {
	return &mockTokenStore{tokens: make(map[string]*model.RefreshToken)}
}

func (m *mockTokenStore) StoreRefreshToken(_ context.Context, rt *model.RefreshToken) error {
	m.tokens[rt.TokenHash] = rt
	return nil
}

func (m *mockTokenStore) GetRefreshToken(_ context.Context, hash string) (*model.RefreshToken, error) {
	rt, ok := m.tokens[hash]
	if !ok {
		return nil, store.ErrNotFound
	}
	return rt, nil
}

func (m *mockTokenStore) DeleteRefreshToken(_ context.Context, hash string) error {
	delete(m.tokens, hash)
	return nil
}

func (m *mockTokenStore) DeleteAllRefreshTokensForUser(_ context.Context, userID string) error {
	for h, rt := range m.tokens {
		if rt.UserID == userID {
			delete(m.tokens, h)
		}
	}
	return nil
}

type mockInviteStore struct{}

func (m *mockInviteStore) CreateInvite(_ context.Context, _ *model.Invite) error { return nil }
func (m *mockInviteStore) GetInvite(_ context.Context, _ string) (*model.Invite, error) {
	return nil, store.ErrNotFound
}
func (m *mockInviteStore) DeleteInvite(_ context.Context, _ string) error { return nil }

type mockMembershipStore struct{}

func (m *mockMembershipStore) AddMember(_ context.Context, _ *model.ChannelMembership, _ *model.UserChannel) error {
	return nil
}
func (m *mockMembershipStore) RemoveMember(_ context.Context, _, _ string) error { return nil }
func (m *mockMembershipStore) GetMembership(_ context.Context, _, _ string) (*model.ChannelMembership, error) {
	return nil, nil
}
func (m *mockMembershipStore) UpdateMemberRole(_ context.Context, _, _ string, _ model.ChannelRole) error {
	return nil
}
func (m *mockMembershipStore) ListMembers(_ context.Context, _ string) ([]*model.ChannelMembership, error) {
	return nil, nil
}
func (m *mockMembershipStore) ListUserChannels(_ context.Context, _ string) ([]*model.UserChannel, error) {
	return nil, nil
}
func (m *mockMembershipStore) SetMute(_ context.Context, _, _ string, _ bool) error {
	return nil
}
func (m *mockMembershipStore) SetFavorite(_ context.Context, _, _ string, _ bool) error {
	return nil
}
func (m *mockMembershipStore) SetCategory(_ context.Context, _, _, _ string, _ *int) error {
	return nil
}

type mockChannelStore struct{}

func (m *mockChannelStore) CreateChannel(_ context.Context, _ *model.Channel) error { return nil }
func (m *mockChannelStore) GetChannel(_ context.Context, _ string) (*model.Channel, error) {
	return nil, nil
}
func (m *mockChannelStore) GetChannelBySlug(_ context.Context, _ string) (*model.Channel, error) {
	return nil, nil
}
func (m *mockChannelStore) UpdateChannel(_ context.Context, _ *model.Channel) error { return nil }
func (m *mockChannelStore) ListPublicChannels(_ context.Context, _ int, _ string) ([]*model.Channel, string, error) {
	return nil, "", nil
}

type mockCache struct{}

func (m *mockCache) GetUser(_ context.Context, _ string) (*model.User, error) {
	return nil, store.ErrNotFound // cache miss
}
func (m *mockCache) SetUser(_ context.Context, _ *model.User) error { return nil }
func (m *mockCache) Delete(_ context.Context, _ string) error       { return nil }

// --- Helper to create an AuthHandler for tests ---

func setupAuthHandler(t *testing.T) (*AuthHandler, *mockUserStore, *mockTokenStore) {
	t.Helper()

	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
	userStore := newMockUserStore()
	tokenStore := newMockTokenStore()

	authSvc := service.NewAuthService(
		userStore,
		tokenStore,
		&mockInviteStore{},
		&mockMembershipStore{},
		&mockChannelStore{},
		jwtMgr,
		nil, // no OIDC
		&mockCache{},
	)

	h := NewAuthHandler(authSvc, jwtMgr)
	return h, userStore, tokenStore
}

// stubOIDCProvider is a minimal OIDCProvider used by the handler-level
// OIDC tests so the login flow can run without real network I/O.
type stubOIDCProvider struct {
	url      string
	userInfo *service.OIDCUserInfo
}

func (s *stubOIDCProvider) AuthURL(state string) string {
	return s.url + "?state=" + state
}
func (s *stubOIDCProvider) Exchange(_ context.Context, _ string) (*service.OIDCUserInfo, error) {
	if s.userInfo == nil {
		return nil, nil
	}
	return s.userInfo, nil
}

// setupAuthHandlerWithOIDC builds an AuthHandler whose AuthService has a
// non-nil OIDC provider so OIDCLogin runs to the redirect step.
func setupAuthHandlerWithOIDC(t *testing.T) (*AuthHandler, *mockUserStore, *mockTokenStore) {
	t.Helper()

	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
	userStore := newMockUserStore()
	tokenStore := newMockTokenStore()

	authSvc := service.NewAuthService(
		userStore,
		tokenStore,
		&mockInviteStore{},
		&mockMembershipStore{},
		&mockChannelStore{},
		jwtMgr,
		&stubOIDCProvider{url: "https://provider.example.com/authorize"},
		&mockCache{},
	)

	h := NewAuthHandler(authSvc, jwtMgr)
	return h, userStore, tokenStore
}

// setupAuthHandlerWithOIDCSuccess wires the provider so a code-exchange
// returns a valid OIDCUserInfo, letting OIDCCallback drive the
// signup-and-redirect happy path.
func setupAuthHandlerWithOIDCSuccess(t *testing.T) (*AuthHandler, *mockUserStore, *mockTokenStore) {
	t.Helper()

	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
	userStore := newMockUserStore()
	tokenStore := newMockTokenStore()

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
				Email:   "callback@example.com",
				Name:    "Callback User",
				Picture: "https://example.com/avatar.png",
			},
		},
		&mockCache{},
	)

	h := NewAuthHandler(authSvc, jwtMgr)
	return h, userStore, tokenStore
}

// --- Tests ---

func TestRefreshTokenHandler_MissingCookie(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/auth/refresh", nil)
	rec := httptest.NewRecorder()

	h.RefreshToken(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRefreshTokenHandler_ValidCookie(t *testing.T) {
	h, userStore, tokenStore := setupAuthHandler(t)

	// Create a user in the store.
	user := &model.User{
		ID:          "user-refresh",
		Email:       "refresh@example.com",
		DisplayName: "Refresh User",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	// Generate a refresh token and store it.
	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
	raw, hash, _ := jwtMgr.GenerateRefreshToken()
	tokenStore.tokens[hash] = &model.RefreshToken{
		TokenHash: hash,
		UserID:    user.ID,
		ExpiresAt: time.Now().Add(720 * time.Hour),
		CreatedAt: time.Now(),
	}

	req := httptest.NewRequest(http.MethodPost, "/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: "refresh_token", Value: raw})
	rec := httptest.NewRecorder()

	h.RefreshToken(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["accessToken"] == "" {
		t.Error("expected non-empty accessToken in response")
	}
}

func TestRefreshTokenHandler_ValidHeader(t *testing.T) {
	h, userStore, tokenStore := setupAuthHandler(t)

	user := &model.User{
		ID:          "user-header",
		Email:       "header@example.com",
		DisplayName: "Header User",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
	raw, hash, _ := jwtMgr.GenerateRefreshToken()
	tokenStore.tokens[hash] = &model.RefreshToken{
		TokenHash: hash,
		UserID:    user.ID,
		ExpiresAt: time.Now().Add(720 * time.Hour),
		CreatedAt: time.Now(),
	}

	req := httptest.NewRequest(http.MethodPost, "/auth/refresh", nil)
	req.Header.Set("X-Refresh-Token", raw)
	rec := httptest.NewRecorder()

	h.RefreshToken(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["accessToken"] == "" {
		t.Error("expected non-empty accessToken in response")
	}
}

func TestRefreshTokenHandler_InvalidToken(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/auth/refresh", nil)
	req.AddCookie(&http.Cookie{Name: "refresh_token", Value: "nonexistent-token"})
	rec := httptest.NewRecorder()

	h.RefreshToken(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestGuestLoginHandler_ValidCredentials(t *testing.T) {
	h, userStore, _ := setupAuthHandler(t)

	pw := "test-password"
	hashedPW, err := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.MinCost)
	if err != nil {
		t.Fatalf("bcrypt hash: %v", err)
	}
	user := &model.User{
		ID:           "guest-1",
		Email:        "guest@example.com",
		DisplayName:  "Guest User",
		SystemRole:   model.SystemRoleGuest,
		PasswordHash: string(hashedPW),
		Status:       "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	body := `{"email":"guest@example.com","password":"test-password"}`
	req := httptest.NewRequest(http.MethodPost, "/auth/guest/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.GuestLogin(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusOK, rec.Body.String())
	}

	var resp map[string]interface{}
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if resp["accessToken"] == nil || resp["accessToken"] == "" {
		t.Error("expected non-empty accessToken")
	}
}

func TestGuestLoginHandler_MissingFields(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	tests := []struct {
		name string
		body string
	}{
		{"missing email", `{"password":"pw"}`},
		{"missing password", `{"email":"a@b.com"}`},
		{"empty body", `{}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/auth/guest/login", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			h.GuestLogin(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
		})
	}
}

func TestGuestLoginHandler_WrongPassword(t *testing.T) {
	h, userStore, _ := setupAuthHandler(t)

	hashedPW, _ := bcrypt.GenerateFromPassword([]byte("correct-pw"), bcrypt.MinCost)
	user := &model.User{
		ID:           "guest-2",
		Email:        "guest2@example.com",
		DisplayName:  "Guest 2",
		SystemRole:   model.SystemRoleGuest,
		PasswordHash: string(hashedPW),
		Status:       "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	body := `{"email":"guest2@example.com","password":"wrong-pw"}`
	req := httptest.NewRequest(http.MethodPost, "/auth/guest/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.GuestLogin(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestGuestLoginHandler_NotGuest(t *testing.T) {
	h, userStore, _ := setupAuthHandler(t)

	hashedPW, _ := bcrypt.GenerateFromPassword([]byte("pw"), bcrypt.MinCost)
	user := &model.User{
		ID:           "member-1",
		Email:        "member@example.com",
		DisplayName:  "Member",
		SystemRole:   model.SystemRoleMember,
		PasswordHash: string(hashedPW),
		Status:       "active",
	}
	userStore.users[user.ID] = user
	userStore.emailIndex[user.Email] = user

	body := `{"email":"member@example.com","password":"pw"}`
	req := httptest.NewRequest(http.MethodPost, "/auth/guest/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.GuestLogin(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestGuestLoginHandler_UserNotFound(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	body := `{"email":"nonexistent@example.com","password":"pw"}`
	req := httptest.NewRequest(http.MethodPost, "/auth/guest/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.GuestLogin(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestLogoutHandler_ClearsCookie(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	req.AddCookie(&http.Cookie{Name: "refresh_token", Value: "some-token"})
	rec := httptest.NewRecorder()

	h.Logout(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}

	cookies := rec.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == "refresh_token" {
			found = true
			if c.MaxAge != -1 {
				t.Errorf("cookie MaxAge = %d, want -1", c.MaxAge)
			}
			if c.Value != "" {
				t.Errorf("cookie Value = %q, want empty", c.Value)
			}
		}
	}
	if !found {
		t.Error("refresh_token cookie not found in response")
	}
}

func TestCreateInviteHandler_Unauthenticated(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	body := `{"email":"invite@example.com","channelIDs":["ch1"]}`
	req := httptest.NewRequest(http.MethodPost, "/auth/invite", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.CreateInvite(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestCreateInviteHandler_Authenticated(t *testing.T) {
	h, _, _ := setupAuthHandler(t)
	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)

	user := &model.User{
		ID:          "inviter-1",
		Email:       "inviter@example.com",
		DisplayName: "Inviter",
		SystemRole:  model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateInvite))

	body := `{"email":"newinvitee@example.com","channelIDs":["ch1"]}`
	req := httptest.NewRequest(http.MethodPost, "/auth/invite", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("status = %d, want %d; body: %s", rec.Code, http.StatusCreated, rec.Body.String())
	}
}

func TestCreateInviteHandler_MissingEmail(t *testing.T) {
	h, _, _ := setupAuthHandler(t)
	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)

	user := &model.User{
		ID:          "inviter-2",
		Email:       "inviter2@example.com",
		DisplayName: "Inviter 2",
		SystemRole:  model.SystemRoleMember,
	}
	token := makeTokenForUser(jwtMgr, user)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateInvite))

	body := `{"channelIDs":["ch1"]}`
	req := httptest.NewRequest(http.MethodPost, "/auth/invite", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestAcceptInviteHandler_MissingFields(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	tests := []struct {
		name string
		body string
	}{
		{"missing token", `{"displayName":"Name","password":"pw"}`},
		{"missing displayName", `{"token":"t","password":"pw"}`},
		{"missing password", `{"token":"t","displayName":"Name"}`},
		{"empty body", `{}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/auth/invite/accept", strings.NewReader(tt.body))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()

			h.AcceptInvite(rec, req)

			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
			}
		})
	}
}

func TestAcceptInviteHandler_InvalidToken(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	body := `{"token":"nonexistent","displayName":"Name","password":"pw"}`
	req := httptest.NewRequest(http.MethodPost, "/auth/invite/accept", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	h.AcceptInvite(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestOIDCLogin_NoOIDCConfigured(t *testing.T) {
	h, _, _ := setupAuthHandler(t) // oidc is nil

	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/login", nil)
	rec := httptest.NewRecorder()

	h.OIDCLogin(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestOIDCCallback_MissingStateCookie(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=abc&code=xyz", nil)
	rec := httptest.NewRecorder()

	h.OIDCCallback(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestOIDCCallback_StateMismatch(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=wrong&code=xyz", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_state", Value: "correct"})
	rec := httptest.NewRecorder()

	h.OIDCCallback(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestOIDCCallback_MissingCode(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=thestate", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_state", Value: "thestate"})
	rec := httptest.NewRecorder()

	h.OIDCCallback(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestOIDCCallback_NoOIDCConfigured(t *testing.T) {
	h, _, _ := setupAuthHandler(t) // oidc is nil

	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=s&code=c", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_state", Value: "s"})
	rec := httptest.NewRecorder()

	h.OIDCCallback(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusInternalServerError)
	}
}

func TestLogoutHandler_NoCookie(t *testing.T) {
	h, _, _ := setupAuthHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/auth/logout", nil)
	rec := httptest.NewRecorder()

	h.Logout(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}
}

// TestIsAllowedOIDCRedirect covers the open-redirect allowlist that gates
// the optional ?redirect_to=… on /auth/oidc/login. Anything not on the
// localhost / tauri:// list must be rejected so an attacker can't bounce
// freshly-issued tokens to a third-party origin.
func TestIsAllowedOIDCRedirect(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"empty rejected", "", false},
		{"plain localhost http allowed", "http://localhost:5173/cb", true},
		{"plain localhost https allowed", "https://localhost:5173/cb", true},
		{"tauri scheme allowed", "tauri://localhost/oidc/callback", true},
		{"https external rejected", "https://evil.example.com/cb", false},
		{"http external rejected", "http://evil.example.com/cb", false},
		{"javascript scheme rejected", "javascript:alert(1)", false},
		{"data URL rejected", "data:text/html,<script></script>", false},
		{"prefix-match attack rejected", "https://localhost.evil.com/cb", false},
		{"protocol-relative rejected", "//localhost/cb", false},
		{"missing scheme rejected", "localhost/cb", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isAllowedOIDCRedirect(tc.in); got != tc.want {
				t.Errorf("isAllowedOIDCRedirect(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestOIDCCallback_HonorsRedirectCookie covers the success-path branch
// that consumes an oauth_redirect cookie and redirects to the
// allowlisted target with the freshly-issued access token. Together
// with the existing failure-mode tests, this exercises the full
// OIDCCallback handler.
func TestOIDCCallback_HonorsRedirectCookie(t *testing.T) {
	h, _, _ := setupAuthHandlerWithOIDCSuccess(t)

	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=ok&code=c", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_state", Value: "ok"})
	req.AddCookie(&http.Cookie{Name: "oauth_redirect", Value: "tauri://localhost/cb"})
	rec := httptest.NewRecorder()

	h.OIDCCallback(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d (body: %s)", rec.Code, http.StatusFound, rec.Body.String())
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "tauri://localhost/cb?token=") {
		t.Errorf("Location = %q, expected tauri://localhost/cb?token=...", loc)
	}

	// The redirect cookie should be cleared (MaxAge<0).
	var cleared bool
	for _, c := range rec.Result().Cookies() {
		if c.Name == "oauth_redirect" && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Error("expected oauth_redirect cookie to be cleared after consume")
	}
}

// TestOIDCCallback_DefaultRedirect covers the no-cookie fallback branch
// where the SPA's /oidc/callback route is the redirect target.
func TestOIDCCallback_DefaultRedirect(t *testing.T) {
	h, _, _ := setupAuthHandlerWithOIDCSuccess(t)

	req := httptest.NewRequest(http.MethodGet, "/auth/oidc/callback?state=ok&code=c", nil)
	req.AddCookie(&http.Cookie{Name: "oauth_state", Value: "ok"})
	rec := httptest.NewRecorder()

	h.OIDCCallback(rec, req)

	if rec.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusFound)
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "/oidc/callback?token=") {
		t.Errorf("Location = %q, expected /oidc/callback?token=...", loc)
	}
}

// TestOIDCLogin_HonorsAllowedRedirect verifies the login handler stores
// an oauth_redirect cookie when redirect_to is on the allowlist, and skips
// it otherwise.
func TestOIDCLogin_HonorsAllowedRedirect(t *testing.T) {
	h, _, _ := setupAuthHandlerWithOIDC(t)

	t.Run("allowed redirect sets cookie", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/auth/oidc/login?redirect_to=tauri://localhost/cb", nil)
		rec := httptest.NewRecorder()
		h.OIDCLogin(rec, req)

		if rec.Code != http.StatusFound {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusFound)
		}
		var found bool
		for _, c := range rec.Result().Cookies() {
			if c.Name == "oauth_redirect" && c.Value == "tauri://localhost/cb" {
				found = true
			}
		}
		if !found {
			t.Error("expected oauth_redirect cookie to be set with allowed value")
		}
	})

	t.Run("rejected redirect does not set cookie", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/auth/oidc/login?redirect_to=https://evil.example.com/cb", nil)
		rec := httptest.NewRecorder()
		h.OIDCLogin(rec, req)

		for _, c := range rec.Result().Cookies() {
			if c.Name == "oauth_redirect" {
				t.Errorf("oauth_redirect cookie set for disallowed redirect: %q", c.Value)
			}
		}
	})
}
