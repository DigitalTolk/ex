package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/model"
)

func TestSecurityHeaders(t *testing.T) {
	h := SecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))

	want := map[string]string{
		"X-Frame-Options":        "DENY",
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
	}
	for k, v := range want {
		if got := rec.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Errorf("CSP missing frame-ancestors 'none': %q", csp)
	}
	if rec.Header().Get("Strict-Transport-Security") == "" {
		t.Error("missing Strict-Transport-Security header")
	}
}

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

type fakeRateCounter struct {
	allow  bool
	err    error
	gotKey string
	gotLim int
	gotWin time.Duration
	calls  int
}

func (f *fakeRateCounter) AllowRequest(_ context.Context, key string, limit int, window time.Duration) (bool, error) {
	f.calls++
	f.gotKey, f.gotLim, f.gotWin = key, limit, window
	return f.allow, f.err
}

func TestRateLimit_AllowsWithinLimit(t *testing.T) {
	c := &fakeRateCounter{allow: true}
	h := RateLimit(c, 5, time.Minute)(okHandler())
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req.RemoteAddr = "203.0.113.7:5555"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if c.gotLim != 5 || c.gotWin != time.Minute {
		t.Errorf("limit/window = %d/%v, want 5/1m", c.gotLim, c.gotWin)
	}
	if want := "rl:/auth/login:203.0.113.7"; c.gotKey != want {
		t.Errorf("key = %q, want %q", c.gotKey, want)
	}
}

func TestRateLimit_RejectsOverLimit(t *testing.T) {
	h := RateLimit(&fakeRateCounter{allow: false}, 1, time.Minute)(okHandler())
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") != "60" {
		t.Errorf("Retry-After = %q, want 60", rec.Header().Get("Retry-After"))
	}
}

func TestRateLimit_FailsOpenOnError(t *testing.T) {
	h := RateLimit(&fakeRateCounter{err: context.DeadlineExceeded}, 1, time.Minute)(okHandler())
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("counter error must fail open (200), got %d", rec.Code)
	}
}

func TestRateLimit_NilCounterPassThrough(t *testing.T) {
	c := &fakeRateCounter{}
	_ = c
	h := RateLimit(nil, 1, time.Minute)(okHandler())
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("nil counter must pass through (200), got %d", rec.Code)
	}
}

func TestRequestTimeout(t *testing.T) {
	var hadDeadline bool
	capture := func(w http.ResponseWriter, r *http.Request) {
		_, hadDeadline = r.Context().Deadline()
		w.WriteHeader(http.StatusOK)
	}

	// Normal request → a deadline is attached.
	RequestTimeout(time.Second)(http.HandlerFunc(capture)).
		ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	if !hadDeadline {
		t.Error("expected a context deadline on a normal request")
	}

	// WebSocket upgrade → exempt (no deadline, or the socket dies).
	wsReq := httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil)
	wsReq.Header.Set("Upgrade", "websocket")
	RequestTimeout(time.Second)(http.HandlerFunc(capture)).ServeHTTP(httptest.NewRecorder(), wsReq)
	if hadDeadline {
		t.Error("WebSocket upgrade must not get a deadline")
	}

	// Non-positive duration → passthrough, no deadline.
	RequestTimeout(0)(http.HandlerFunc(capture)).
		ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	if hadDeadline {
		t.Error("zero duration must not set a deadline")
	}
}

func TestRateLimitPerUser(t *testing.T) {
	c := &fakeRateCounter{allow: true}
	h := RateLimitPerUser(c, 5, time.Minute)(okHandler())

	// Authenticated → keyed by user ID (route-agnostic), not IP.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/x/messages", nil)
	req = req.WithContext(ContextWithClaims(req.Context(), &model.TokenClaims{UserID: "u-42"}))
	req.RemoteAddr = "203.0.113.7:9"
	h.ServeHTTP(httptest.NewRecorder(), req)
	if want := "rlu:write:u-42"; c.gotKey != want {
		t.Errorf("per-user key = %q, want %q", c.gotKey, want)
	}

	// Unauthenticated → falls back to client IP.
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/channels/x/messages", nil)
	req2.RemoteAddr = "203.0.113.7:9"
	h.ServeHTTP(httptest.NewRecorder(), req2)
	if want := "rlu:write:203.0.113.7"; c.gotKey != want {
		t.Errorf("fallback key = %q, want %q", c.gotKey, want)
	}

	// Over-limit → 429.
	blocked := RateLimitPerUser(&fakeRateCounter{allow: false}, 1, time.Minute)(okHandler())
	rec := httptest.NewRecorder()
	blocked.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("over-limit status = %d, want 429", rec.Code)
	}

	// Counter error → fail open; nil counter → pass through.
	failOpen := RateLimitPerUser(&fakeRateCounter{err: context.DeadlineExceeded}, 1, time.Minute)(okHandler())
	recOpen := httptest.NewRecorder()
	failOpen.ServeHTTP(recOpen, req)
	if recOpen.Code != http.StatusOK {
		t.Errorf("fail-open status = %d, want 200", recOpen.Code)
	}
	recNil := httptest.NewRecorder()
	RateLimitPerUser(nil, 1, time.Minute)(okHandler()).ServeHTTP(recNil, req)
	if recNil.Code != http.StatusOK {
		t.Errorf("nil-counter status = %d, want 200", recNil.Code)
	}
}

func TestRateLimit_ClientIPSources(t *testing.T) {
	c := &fakeRateCounter{allow: true}
	h := RateLimit(c, 5, time.Minute)(okHandler())

	// X-Forwarded-For multi-hop with one trusted proxy (default): the entry the
	// proxy appended (right-most) wins, NOT the spoofable leading hop.
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.1")
	req.RemoteAddr = "10.0.0.1:1"
	h.ServeHTTP(httptest.NewRecorder(), req)
	if want := "rl:/auth/login:10.0.0.1"; c.gotKey != want {
		t.Errorf("XFF key = %q, want %q", c.gotKey, want)
	}

	// A forged leading X-Forwarded-For can't change the key — the trusted
	// proxy's appended real client IP is still used.
	req3 := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req3.Header.Set("X-Forwarded-For", "1.2.3.4, 203.0.113.7")
	req3.RemoteAddr = "10.0.0.1:1"
	h.ServeHTTP(httptest.NewRecorder(), req3)
	if want := "rl:/auth/login:203.0.113.7"; c.gotKey != want {
		t.Errorf("forged XFF key = %q, want %q (trusted hop)", c.gotKey, want)
	}

	// trustedProxyCount = 0 → ignore X-Forwarded-For, key on RemoteAddr.
	SetTrustedProxyCount(0)
	t.Cleanup(func() { SetTrustedProxyCount(1) })
	req4 := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req4.Header.Set("X-Forwarded-For", "1.2.3.4")
	req4.RemoteAddr = "203.0.113.7:9"
	h.ServeHTTP(httptest.NewRecorder(), req4)
	if want := "rl:/auth/login:203.0.113.7"; c.gotKey != want {
		t.Errorf("no-trust key = %q, want %q", c.gotKey, want)
	}

	// No XFF, unparseable RemoteAddr → used verbatim.
	SetTrustedProxyCount(1)
	req2 := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req2.RemoteAddr = "weird-addr"
	h.ServeHTTP(httptest.NewRecorder(), req2)
	if want := "rl:/auth/login:weird-addr"; c.gotKey != want {
		t.Errorf("fallback key = %q, want %q", c.gotKey, want)
	}
}

// A negative trusted-proxy count is nonsense topology; SetTrustedProxyCount
// must clamp it to 0 (ignore X-Forwarded-For entirely) rather than store it —
// a negative count would index past the left end of the XFF list.
func TestSetTrustedProxyCountClampsNegative(t *testing.T) {
	t.Cleanup(func() { SetTrustedProxyCount(1) }) // restore the package default

	SetTrustedProxyCount(-1)
	if trustedProxyCount != 0 {
		t.Fatalf("trustedProxyCount = %d, want 0 (negative input must clamp)", trustedProxyCount)
	}

	// Effective behavior: with the clamped count, XFF is ignored and the
	// client IP comes from RemoteAddr.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	req.RemoteAddr = "203.0.113.9:443"
	if got := clientIP(req); got != "203.0.113.9" {
		t.Errorf("clientIP = %q, want %q (XFF must be ignored at count 0)", got, "203.0.113.9")
	}
}
