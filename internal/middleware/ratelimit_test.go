package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

type fakeRateCounter struct {
	allow      bool
	retryAfter time.Duration
	err        error
	gotKey     string
	gotLimit   Limit
	calls      int
}

func (f *fakeRateCounter) Allow(_ context.Context, key string, limit Limit) (bool, time.Duration, error) {
	f.calls++
	f.gotKey, f.gotLimit = key, limit
	return f.allow, f.retryAfter, f.err
}

func TestPerMinute(t *testing.T) {
	got := PerMinute("login", 20, 30)
	want := Limit{Name: "login", Rate: 20, Burst: 30, Period: time.Minute}
	if got != want {
		t.Fatalf("PerMinute = %+v, want %+v", got, want)
	}
}

func TestRateLimit_AllowsWithinLimit(t *testing.T) {
	c := &fakeRateCounter{allow: true}
	lim := PerMinute("login", 5, 5)
	h := RateLimit(c, lim)(okHandler())
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req.RemoteAddr = "203.0.113.7:5555"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if c.gotLimit != lim {
		t.Errorf("limit = %+v, want %+v", c.gotLimit, lim)
	}
	if want := "ip:login:" + pathDigest("/auth/login") + ":203.0.113.7"; c.gotKey != want {
		t.Errorf("key = %q, want %q", c.gotKey, want)
	}
}

// The webhook route's path IS its credential: it must never land in a Redis
// key verbatim, yet each route keeps its own per-IP bucket.
func TestRateLimit_KeysOnAPathDigest(t *testing.T) {
	c := &fakeRateCounter{allow: true}
	h := RateLimit(c, PerMinute("webhook", 60, 60))(okHandler())
	req := httptest.NewRequest(http.MethodPost, "/hooks/super-secret-id", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)
	first := c.gotKey
	if strings.Contains(first, "super-secret-id") {
		t.Fatalf("rate-limit key %q carries the webhook secret", first)
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/hooks/another-id", nil))
	if c.gotKey == first {
		t.Fatal("two webhooks share one per-IP bucket")
	}
}

func TestRateLimit_RejectsOverLimit(t *testing.T) {
	h := RateLimit(&fakeRateCounter{allow: false, retryAfter: 2500 * time.Millisecond}, PerMinute("login", 1, 1))(okHandler())
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if got := rec.Header().Get("Retry-After"); got != "3" {
		t.Errorf("Retry-After = %q, want 3 (rounded up)", got)
	}
}

func TestRateLimit_RetryAfterNeverBelowOneSecond(t *testing.T) {
	h := RateLimit(&fakeRateCounter{allow: false, retryAfter: -1}, PerMinute("login", 1, 1))(okHandler())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/auth/login", nil))
	if got := rec.Header().Get("Retry-After"); got != "1" {
		t.Errorf("Retry-After = %q, want 1", got)
	}
}

func TestRateLimit_FailsOpenOnError(t *testing.T) {
	h := RateLimit(&fakeRateCounter{err: context.DeadlineExceeded}, PerMinute("login", 1, 1))(okHandler())
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("counter error must fail open (200), got %d", rec.Code)
	}
}

func TestRateLimit_NilCounterPassThrough(t *testing.T) {
	h := RateLimit(nil, PerMinute("login", 1, 1))(okHandler())
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("nil counter must pass through (200), got %d", rec.Code)
	}
}

func TestRateLimitPerUser(t *testing.T) {
	c := &fakeRateCounter{allow: true}
	h := RateLimitPerUser(c, PerMinute("write", 5, 5))(okHandler())

	// Authenticated → keyed by user ID (route-agnostic), not IP.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/channels/x/messages", nil)
	req = req.WithContext(ContextWithClaims(req.Context(), &model.TokenClaims{UserID: "u-42"}))
	req.RemoteAddr = "203.0.113.7:9"
	h.ServeHTTP(httptest.NewRecorder(), req)
	if want := "user:write:u-42"; c.gotKey != want {
		t.Errorf("per-user key = %q, want %q", c.gotKey, want)
	}

	// A different limiter for the same user spends its own counter.
	RateLimitPerUser(c, PerMinute("ws-ticket", 30, 30))(okHandler()).ServeHTTP(httptest.NewRecorder(), req)
	if want := "user:ws-ticket:u-42"; c.gotKey != want {
		t.Errorf("second limiter key = %q, want %q", c.gotKey, want)
	}

	// A run-scoped token is keyed by its run, not the invoking human.
	runReq := httptest.NewRequest(http.MethodPost, "/api/v1/agent/run/messages", nil)
	runReq = runReq.WithContext(ContextWithClaims(runReq.Context(), &model.TokenClaims{UserID: "u-42", Scope: model.TokenScopeRun, RunID: "run-1"}))
	h.ServeHTTP(httptest.NewRecorder(), runReq)
	if want := "run:write:run-1"; c.gotKey != want {
		t.Errorf("run key = %q, want %q", c.gotKey, want)
	}

	// Claims without an identity, and no claims at all → client IP.
	anon := httptest.NewRequest(http.MethodPost, "/api/v1/channels/x/messages", nil)
	anon = anon.WithContext(ContextWithClaims(anon.Context(), &model.TokenClaims{}))
	anon.RemoteAddr = "203.0.113.7:9"
	h.ServeHTTP(httptest.NewRecorder(), anon)
	if want := "ip:write:203.0.113.7"; c.gotKey != want {
		t.Errorf("identity-less key = %q, want %q", c.gotKey, want)
	}
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/channels/x/messages", nil)
	req2.RemoteAddr = "203.0.113.7:9"
	h.ServeHTTP(httptest.NewRecorder(), req2)
	if want := "ip:write:203.0.113.7"; c.gotKey != want {
		t.Errorf("fallback key = %q, want %q", c.gotKey, want)
	}

	// Over-limit → 429.
	blocked := RateLimitPerUser(&fakeRateCounter{allow: false}, PerMinute("write", 1, 1))(okHandler())
	rec := httptest.NewRecorder()
	blocked.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("over-limit status = %d, want 429", rec.Code)
	}

	// Counter error → fail open; nil counter → pass through.
	failOpen := RateLimitPerUser(&fakeRateCounter{err: context.DeadlineExceeded}, PerMinute("write", 1, 1))(okHandler())
	recOpen := httptest.NewRecorder()
	failOpen.ServeHTTP(recOpen, req)
	if recOpen.Code != http.StatusOK {
		t.Errorf("fail-open status = %d, want 200", recOpen.Code)
	}
	recNil := httptest.NewRecorder()
	RateLimitPerUser(nil, PerMinute("write", 1, 1))(okHandler()).ServeHTTP(recNil, req)
	if recNil.Code != http.StatusOK {
		t.Errorf("nil-counter status = %d, want 200", recNil.Code)
	}
}

func TestRateLimit_ClientIPSources(t *testing.T) {
	c := &fakeRateCounter{allow: true}
	h := RateLimit(c, PerMinute("login", 5, 5))(okHandler())
	prefix := "ip:login:" + pathDigest("/auth/login") + ":"

	// X-Forwarded-For multi-hop with one trusted proxy (default): the entry the
	// proxy appended (right-most) wins, NOT the spoofable leading hop.
	req := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req.Header.Set("X-Forwarded-For", "198.51.100.9, 10.0.0.1")
	req.RemoteAddr = "10.0.0.1:1"
	h.ServeHTTP(httptest.NewRecorder(), req)
	if want := prefix + "10.0.0.1"; c.gotKey != want {
		t.Errorf("XFF key = %q, want %q", c.gotKey, want)
	}

	// A forged leading X-Forwarded-For can't change the key — the trusted
	// proxy's appended real client IP is still used.
	req3 := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req3.Header.Set("X-Forwarded-For", "1.2.3.4, 203.0.113.7")
	req3.RemoteAddr = "10.0.0.1:1"
	h.ServeHTTP(httptest.NewRecorder(), req3)
	if want := prefix + "203.0.113.7"; c.gotKey != want {
		t.Errorf("forged XFF key = %q, want %q (trusted hop)", c.gotKey, want)
	}

	// trustedProxyCount = 0 → ignore X-Forwarded-For, key on RemoteAddr.
	SetTrustedProxyCount(0)
	t.Cleanup(func() { SetTrustedProxyCount(1) })
	req4 := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req4.Header.Set("X-Forwarded-For", "1.2.3.4")
	req4.RemoteAddr = "203.0.113.7:9"
	h.ServeHTTP(httptest.NewRecorder(), req4)
	if want := prefix + "203.0.113.7"; c.gotKey != want {
		t.Errorf("no-trust key = %q, want %q", c.gotKey, want)
	}

	// No XFF, unparseable RemoteAddr → used verbatim.
	SetTrustedProxyCount(1)
	req2 := httptest.NewRequest(http.MethodPost, "/auth/login", nil)
	req2.RemoteAddr = "weird-addr"
	h.ServeHTTP(httptest.NewRecorder(), req2)
	if want := prefix + "weird-addr"; c.gotKey != want {
		t.Errorf("fallback key = %q, want %q", c.gotKey, want)
	}
}
