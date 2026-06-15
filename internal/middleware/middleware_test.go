package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
)

func newTestJWTManager() *auth.JWTManager {
	return auth.NewJWTManager("test-secret-middleware", 15*time.Minute, 720*time.Hour)
}

func generateTestToken(mgr *auth.JWTManager) string {
	user := &model.User{
		ID:          "user-42",
		Email:       "test@example.com",
		DisplayName: "Test User",
		SystemRole:  model.SystemRoleMember,
	}
	token, _ := mgr.GenerateAccessToken(user)
	return token
}

func okHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}
}

func TestAuthMiddlewareValidToken(t *testing.T) {
	mgr := newTestJWTManager()
	token := generateTestToken(mgr)

	handler := Auth(mgr)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestAuthMiddlewareQueryParam(t *testing.T) {
	mgr := newTestJWTManager()
	token := generateTestToken(mgr)

	handler := Auth(mgr)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test?token="+token, nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

type statusUserStore struct {
	user *model.User
	err  error
}

func (s statusUserStore) GetByID(context.Context, string) (*model.User, error) {
	return s.user, s.err
}

func TestAuthWithUserStatusRejectsDeactivatedUser(t *testing.T) {
	mgr := newTestJWTManager()
	token := generateTestToken(mgr)
	handler := AuthWithUserStatus(mgr, statusUserStore{user: &model.User{ID: "user-42", Status: "deactivated"}})(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestAuthMiddlewareMissingToken(t *testing.T) {
	mgr := newTestJWTManager()
	handler := Auth(mgr)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestAuthMiddlewareInvalidToken(t *testing.T) {
	mgr := newTestJWTManager()
	handler := Auth(mgr)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Authorization", "Bearer invalid-token")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestRequireSystemRoleAllowed(t *testing.T) {
	mgr := newTestJWTManager()

	// Create an admin user token.
	adminUser := &model.User{
		ID:          "admin-1",
		Email:       "admin@example.com",
		DisplayName: "Admin",
		SystemRole:  model.SystemRoleAdmin,
	}
	token, _ := mgr.GenerateAccessToken(adminUser)

	handler := Auth(mgr)(RequireSystemRole(model.SystemRoleAdmin)(okHandler()))

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestRequireSystemRoleBlocked(t *testing.T) {
	mgr := newTestJWTManager()
	token := generateTestToken(mgr) // member role

	handler := Auth(mgr)(RequireSystemRole(model.SystemRoleAdmin)(okHandler()))

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
}

func TestRequireSystemRoleNoClaims(t *testing.T) {
	handler := RequireSystemRole(model.SystemRoleAdmin)(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/admin", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
	}
}

func TestClaimsFromContext(t *testing.T) {
	// No claims in context.
	ctx := context.Background()
	if c := ClaimsFromContext(ctx); c != nil {
		t.Error("expected nil claims from empty context")
	}

	// With claims.
	claims := &model.TokenClaims{UserID: "u1"}
	ctx = context.WithValue(ctx, claimsKey, claims)
	got := ClaimsFromContext(ctx)
	if got == nil {
		t.Fatal("expected non-nil claims")
	}
	if got.UserID != "u1" {
		t.Errorf("UserID = %q, want %q", got.UserID, "u1")
	}
}

func TestUserIDFromContext(t *testing.T) {
	// No claims.
	ctx := context.Background()
	if id := UserIDFromContext(ctx); id != "" {
		t.Errorf("expected empty user ID, got %q", id)
	}

	// With claims.
	claims := &model.TokenClaims{UserID: "u42"}
	ctx = context.WithValue(ctx, claimsKey, claims)
	if id := UserIDFromContext(ctx); id != "u42" {
		t.Errorf("UserID = %q, want %q", id, "u42")
	}
}

func TestCORSPreflight(t *testing.T) {
	handler := CORS("https://example.com")(okHandler())

	req := httptest.NewRequest(http.MethodOptions, "/test", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusNoContent)
	}

	checks := map[string]string{
		"Access-Control-Allow-Origin":      "https://example.com",
		"Access-Control-Allow-Methods":     "GET, POST, PUT, PATCH, DELETE, OPTIONS",
		"Access-Control-Allow-Headers":     "Authorization, Content-Type",
		"Access-Control-Allow-Credentials": "true",
		"Access-Control-Max-Age":           "86400",
	}
	for header, want := range checks {
		got := rec.Header().Get(header)
		if got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
}

func TestCORSNonPreflight(t *testing.T) {
	handler := CORS("*")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, "*")
	}
}

func TestCORSAllowedOriginEchoed(t *testing.T) {
	handler := CORS("https://a.example.com", "https://b.example.com")(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("Origin", "https://b.example.com")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	// A request Origin that matches the allowlist is echoed back verbatim,
	// not collapsed to the primary origin.
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://b.example.com" {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, "https://b.example.com")
	}
}

func TestLoggingHealthzSuppressed(t *testing.T) {
	// A 2xx /healthz response is suppressed from the access log; the
	// middleware must still pass the request through to the handler.
	called := false
	handler := Logging(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if !called {
		t.Error("inner handler not called")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestLoggingHealthzNon2xxLogged(t *testing.T) {
	// A non-2xx /healthz still flows through (and is logged) — exercises the
	// branch where the suppression condition is false because of the status.
	handler := Logging(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))

	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
}

func TestRequestID(t *testing.T) {
	handler := RequestID(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	id := rec.Header().Get("X-Request-ID")
	if id == "" {
		t.Error("X-Request-ID header not set")
	}
}

func TestRequestIDExisting(t *testing.T) {
	handler := RequestID(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	req.Header.Set("X-Request-ID", "existing-id")
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("X-Request-ID"); got != "existing-id" {
		t.Errorf("X-Request-ID = %q, want %q", got, "existing-id")
	}
}

func TestRequestIDFromContext(t *testing.T) {
	ctx := context.Background()
	if id := RequestIDFromContext(ctx); id != "" {
		t.Errorf("expected empty, got %q", id)
	}

	ctx = context.WithValue(ctx, requestIDKey, "req-123")
	if id := RequestIDFromContext(ctx); id != "req-123" {
		t.Errorf("RequestIDFromContext = %q, want %q", id, "req-123")
	}
}

func TestLogging(t *testing.T) {
	// Logging middleware should not panic and should pass through.
	handler := Logging(okHandler())

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestWrap(t *testing.T) {
	var order []string

	mw1 := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			order = append(order, "mw1")
			next.ServeHTTP(w, r)
		})
	}
	mw2 := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			order = append(order, "mw2")
			next.ServeHTTP(w, r)
		})
	}

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		order = append(order, "handler")
	})

	handler := Wrap(inner, mw1, mw2)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// mw1 is outermost, mw2 is inner, handler is innermost.
	if len(order) != 3 || order[0] != "mw1" || order[1] != "mw2" || order[2] != "handler" {
		t.Errorf("execution order = %v, want [mw1 mw2 handler]", order)
	}
}

func TestWrapFunc(t *testing.T) {
	called := false
	inner := func(w http.ResponseWriter, r *http.Request) {
		called = true
	}

	handler := WrapFunc(inner)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if !called {
		t.Error("inner handler not called")
	}
}
