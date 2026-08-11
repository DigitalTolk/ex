package handler

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/email"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// errTestStore stands in for an infrastructure failure behind the store.
var errTestStore = errors.New("store unavailable")

// hashTokenForTest mirrors the service's token hashing so a test can seed a
// ticket the service will find. Kept as its own implementation rather than
// exporting the production helper — if the two ever diverge, the end-to-end
// tests above catch it.
func hashTokenForTest(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// --- fakes ---

type fakeResetStore struct {
	mu      sync.Mutex
	tickets map[string]string
}

func newFakeResetStore() *fakeResetStore {
	return &fakeResetStore{tickets: map[string]string{}}
}

func (f *fakeResetStore) MintPasswordResetTicket(_ context.Context, tokenHash, userID string, _ time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tickets[tokenHash] = userID
	return nil
}

func (f *fakeResetStore) ConsumePasswordResetTicket(_ context.Context, tokenHash string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	userID, ok := f.tickets[tokenHash]
	if !ok {
		return "", nil
	}
	delete(f.tickets, tokenHash)
	return userID, nil
}

type fakeMailer struct {
	mu   sync.Mutex
	sent []email.Message
}

func (f *fakeMailer) Send(_ context.Context, msg email.Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, msg)
	return nil
}

func (f *fakeMailer) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

type resetHandlerEnv struct {
	h      *AuthHandler
	jwt    *auth.JWTManager
	users  *mockUserStore
	resets *fakeResetStore
	mailer *fakeMailer
}

func setupResetHandler(t *testing.T) *resetHandlerEnv {
	t.Helper()
	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
	userStore := newMockUserStore()
	resets := newFakeResetStore()
	mailer := &fakeMailer{}

	authSvc := service.NewAuthService(
		userStore, newMockTokenStore(), &mockInviteStore{}, &mockMembershipStore{},
		&mockChannelStore{}, jwtMgr, nil, newMockCache(),
	)
	authSvc.SetPasswordResetStore(resets)
	authSvc.SetMailer(mailer, "https://ex.example.com")

	guest := &model.User{
		ID: "u-guest", Email: "guest@example.com", DisplayName: "Guest User",
		SystemRole: model.SystemRoleGuest, AuthProvider: model.AuthProviderGuest,
		PasswordHash: "old-hash", Status: "active",
	}
	sso := &model.User{
		ID: "u-sso", Email: "sso@example.com", DisplayName: "SSO User",
		SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC,
		Status: "active",
	}
	userStore.users[guest.ID] = guest
	userStore.emailIndex[guest.Email] = guest
	userStore.users[sso.ID] = sso
	userStore.emailIndex[sso.Email] = sso

	return &resetHandlerEnv{
		h: NewAuthHandler(authSvc, jwtMgr), jwt: jwtMgr,
		users: userStore, resets: resets, mailer: mailer,
	}
}

// adminReset drives POST /api/v1/users/{id}/password-reset as the given caller.
func (e *resetHandlerEnv) adminReset(caller *model.User, targetID string) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	mux.Handle("POST /api/v1/users/{id}/password-reset",
		middleware.Auth(e.jwt)(http.HandlerFunc(e.h.AdminResetUserPassword)))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/"+targetID+"/password-reset", nil)
	req.Header.Set("Authorization", "Bearer "+makeTokenForUser(e.jwt, caller))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

func admin() *model.User {
	return &model.User{ID: "u-admin", Email: "admin@example.com", SystemRole: model.SystemRoleAdmin}
}

// --- admin-initiated reset ---

func TestAdminResetUserPassword_Guest(t *testing.T) {
	env := setupResetHandler(t)

	rec := env.adminReset(admin(), "u-guest")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var got struct {
		ResetURL  string `json:"resetURL"`
		ExpiresAt string `json:"expiresAt"`
		EmailSent bool   `json:"emailSent"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got.ResetURL, "https://ex.example.com/reset-password/") {
		t.Errorf("resetURL = %q", got.ResetURL)
	}
	if !got.EmailSent {
		t.Error("emailSent = false; the admin would wrongly assume nothing was delivered")
	}
	if got.ExpiresAt == "" {
		t.Error("no expiry returned")
	}
	if env.mailer.count() != 1 {
		t.Errorf("emails sent = %d, want 1", env.mailer.count())
	}
}

// SSO accounts are refused with a distinguishable status so the UI can say why.
func TestAdminResetUserPassword_SSOConflict(t *testing.T) {
	env := setupResetHandler(t)

	rec := env.adminReset(admin(), "u-sso")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409, body = %s", rec.Code, rec.Body.String())
	}
	if env.mailer.count() != 0 {
		t.Error("an email was sent for an SSO account")
	}
}

func TestAdminResetUserPassword_AccessControl(t *testing.T) {
	env := setupResetHandler(t)

	t.Run("member is forbidden", func(t *testing.T) {
		caller := &model.User{ID: "u-m", Email: "m@example.com", SystemRole: model.SystemRoleMember}
		if rec := env.adminReset(caller, "u-guest"); rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
	})

	t.Run("guest is forbidden", func(t *testing.T) {
		caller := &model.User{ID: "u-g", Email: "g@example.com", SystemRole: model.SystemRoleGuest}
		if rec := env.adminReset(caller, "u-guest"); rec.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want 403", rec.Code)
		}
	})

	t.Run("unauthenticated is rejected", func(t *testing.T) {
		mux := http.NewServeMux()
		mux.Handle("POST /api/v1/users/{id}/password-reset",
			middleware.Auth(env.jwt)(http.HandlerFunc(env.h.AdminResetUserPassword)))
		req := httptest.NewRequest(http.MethodPost, "/api/v1/users/u-guest/password-reset", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want 401", rec.Code)
		}
	})
}

func TestAdminResetUserPassword_UnknownUser(t *testing.T) {
	env := setupResetHandler(t)

	if rec := env.adminReset(admin(), "nobody"); rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestAdminResetUserPassword_MissingID(t *testing.T) {
	env := setupResetHandler(t)
	// Call the handler directly: the router pattern can't produce an empty id.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users//password-reset", nil)
	req = req.WithContext(middleware.ContextWithClaims(req.Context(), &model.TokenClaims{
		UserID: "u-admin", SystemRole: model.SystemRoleAdmin,
	}))
	rec := httptest.NewRecorder()
	env.h.AdminResetUserPassword(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestAdminResetUserPassword_StoreFailure(t *testing.T) {
	env := setupResetHandler(t)
	env.users.getUserErr = errTestStore

	if rec := env.adminReset(admin(), "u-guest"); rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

func TestAdminResetUserPassword_Unavailable(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
	authSvc := service.NewAuthService(
		newMockUserStore(), newMockTokenStore(), &mockInviteStore{}, &mockMembershipStore{},
		&mockChannelStore{}, jwtMgr, nil, newMockCache(),
	)
	// No reset store wired at all.
	h := NewAuthHandler(authSvc, jwtMgr)

	mux := http.NewServeMux()
	mux.Handle("POST /api/v1/users/{id}/password-reset",
		middleware.Auth(jwtMgr)(http.HandlerFunc(h.AdminResetUserPassword)))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/users/u-guest/password-reset", nil)
	req.Header.Set("Authorization", "Bearer "+makeTokenForUser(jwtMgr, admin()))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

// --- self-service request ---

func postJSON(h http.HandlerFunc, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

// Every input answers 204 — an unauthenticated caller must not be able to tell
// a registered guest from an unknown address or an SSO user.
func TestForgotPassword_NeverEnumerates(t *testing.T) {
	cases := []struct {
		name      string
		body      string
		wantMails int
	}{
		{"guest address", `{"email":"guest@example.com"}`, 1},
		{"SSO address", `{"email":"sso@example.com"}`, 0},
		{"unknown address", `{"email":"nobody@example.com"}`, 0},
		{"malformed address", `{"email":"not-an-email"}`, 0},
		{"empty address", `{"email":""}`, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := setupResetHandler(t)
			rec := postJSON(env.h.ForgotPassword, "/auth/password/forgot", tc.body)
			if rec.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want 204, body = %s", rec.Code, rec.Body.String())
			}
			if rec.Body.Len() != 0 {
				t.Errorf("body = %q, want empty", rec.Body.String())
			}
			if env.mailer.count() != tc.wantMails {
				t.Errorf("emails sent = %d, want %d", env.mailer.count(), tc.wantMails)
			}
		})
	}
}

func TestForgotPassword_MalformedBody(t *testing.T) {
	env := setupResetHandler(t)
	rec := postJSON(env.h.ForgotPassword, "/auth/password/forgot", `{`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestForgotPassword_Unavailable(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
	authSvc := service.NewAuthService(
		newMockUserStore(), newMockTokenStore(), &mockInviteStore{}, &mockMembershipStore{},
		&mockChannelStore{}, jwtMgr, nil, newMockCache(),
	)
	h := NewAuthHandler(authSvc, jwtMgr)

	rec := postJSON(h.ForgotPassword, "/auth/password/forgot", `{"email":"guest@example.com"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

// --- redemption ---

// The full unauthenticated flow: an admin mints a link, the guest redeems it.
func TestResetPassword_EndToEndOverHTTP(t *testing.T) {
	env := setupResetHandler(t)

	rec := env.adminReset(admin(), "u-guest")
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint status = %d", rec.Code)
	}
	var ticket struct {
		ResetURL string `json:"resetURL"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&ticket); err != nil {
		t.Fatal(err)
	}
	token := strings.TrimPrefix(ticket.ResetURL, "https://ex.example.com/reset-password/")

	body := `{"token":"` + token + `","password":"brand-new-password"}`
	rec = postJSON(env.h.ResetPassword, "/auth/password/reset", body)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204, body = %s", rec.Code, rec.Body.String())
	}

	// Single-use: replaying the same link fails.
	rec = postJSON(env.h.ResetPassword, "/auth/password/reset", body)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("replay status = %d, want 400", rec.Code)
	}
}

func TestResetPassword_BadRequests(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{"malformed json", `{`, http.StatusBadRequest},
		{"missing token", `{"password":"long-enough-password"}`, http.StatusBadRequest},
		{"missing password", `{"token":"tok"}`, http.StatusBadRequest},
		{"unknown token", `{"token":"tok","password":"long-enough-password"}`, http.StatusBadRequest},
		{"password too short", `{"token":"tok","password":"short"}`, http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := setupResetHandler(t)
			rec := postJSON(env.h.ResetPassword, "/auth/password/reset", tc.body)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d, body = %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

// A ticket that outlives its account fails closed rather than 500ing.
func TestResetPassword_AccountVanished(t *testing.T) {
	env := setupResetHandler(t)
	env.resets.tickets[hashTokenForTest("tok")] = "ghost"

	rec := postJSON(env.h.ResetPassword, "/auth/password/reset",
		`{"token":"tok","password":"long-enough-password"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body = %s", rec.Code, rec.Body.String())
	}
}

// An SSO account can never be written to, even with a valid-looking ticket.
func TestResetPassword_SSOAccountRejected(t *testing.T) {
	env := setupResetHandler(t)
	env.resets.tickets[hashTokenForTest("tok")] = "u-sso"

	rec := postJSON(env.h.ResetPassword, "/auth/password/reset",
		`{"token":"tok","password":"long-enough-password"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if env.users.users["u-sso"].PasswordHash != "" {
		t.Fatal("a local password was written onto an SSO account")
	}
}

func TestResetPassword_Unavailable(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-handler-secret", 15*time.Minute, 720*time.Hour)
	authSvc := service.NewAuthService(
		newMockUserStore(), newMockTokenStore(), &mockInviteStore{}, &mockMembershipStore{},
		&mockChannelStore{}, jwtMgr, nil, newMockCache(),
	)
	h := NewAuthHandler(authSvc, jwtMgr)

	rec := postJSON(h.ResetPassword, "/auth/password/reset",
		`{"token":"tok","password":"long-enough-password"}`)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}
