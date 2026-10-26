package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
)

// keyRecorder denies every request (so no handler runs) and records which
// counter key each route spent, plus the limit it was checked against.
type keyRecorder struct {
	mu     sync.Mutex
	keys   []string
	limits map[string]int
}

func (k *keyRecorder) Allow(_ context.Context, key string, limit middleware.Limit) (bool, time.Duration, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.keys = append(k.keys, key)
	if k.limits == nil {
		k.limits = map[string]int{}
	}
	k.limits[key] = limit.Burst
	return false, time.Second, nil
}

func (k *keyRecorder) last() string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.keys[len(k.keys)-1]
}

func rateLimitRouter(rl *keyRecorder, jwtMgr *auth.JWTManager) http.Handler {
	return NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		AgentRunTool: &AgentRunToolHandler{},
		JWT:          jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"}, RateLimiter: rl,
	})
}

// Regression: every per-user limiter keyed on the same `rlu:write:<id>`
// counter, so ~30 message sends left a user unable to mint a WebSocket ticket
// — and a user without a socket gets no desktop alerts. Each limiter must
// spend its own counter.
func TestRouterRateLimitersDoNotShareCounters(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	rl := &keyRecorder{}
	router := rateLimitRouter(rl, jwtMgr)

	router.ServeHTTP(httptest.NewRecorder(), authedReq(t, jwtMgr, http.MethodPost, "/api/v1/channels/ch-1/members", `{"userID":"u-2"}`))
	writeKey := rl.last()
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, authedReq(t, jwtMgr, http.MethodPost, "/api/v1/ws/ticket", ""))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("ws ticket = %d, want 429 from its limiter", rec.Code)
	}
	ticketKey := rl.last()
	if writeKey == ticketKey {
		t.Fatalf("write and ws-ticket limiters share counter %q", writeKey)
	}
}

// Regression: run tokens carry the invoking human's user ID, so an agent's
// tool calls spent the human's own write budget. Run-scoped calls are keyed
// by the run.
func TestRouterRunToolWritesDoNotSpendTheHumansBudget(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	rl := &keyRecorder{}
	router := rateLimitRouter(rl, jwtMgr)

	router.ServeHTTP(httptest.NewRecorder(), authedReq(t, jwtMgr, http.MethodPost, "/api/v1/channels/ch-1/members", `{"userID":"u-2"}`))
	humanKey := rl.last()

	runTok, err := jwtMgr.GenerateRunToken("run-7", "u-1", "agent-1", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatalf("run token: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/agent/run/messages", strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer "+runTok)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("run post = %d, want 429 from its limiter", rec.Code)
	}
	runKey := rl.last()
	if runKey == humanKey {
		t.Fatalf("run-token write spent the human's counter %q", humanKey)
	}
	if !strings.Contains(runKey, "run-7") {
		t.Fatalf("run-token write key %q is not keyed by the run", runKey)
	}
}

// An office behind one NAT reconnects every client right after a deploy: the
// per-IP limits on the WebSocket upgrade and on token refresh must absorb a
// burst of hundreds, not 20-60 a minute.
func TestRouterReconnectLimitsAllowAnOfficeBurst(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	rl := &keyRecorder{}
	router := rateLimitRouter(rl, jwtMgr)

	for _, target := range []struct{ method, path string }{
		{http.MethodPost, "/auth/token/refresh"},
		{http.MethodGet, "/api/v1/ws"},
	} {
		router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(target.method, target.path, nil))
		key := rl.last()
		if got := rl.limits[key]; got < 300 {
			t.Errorf("%s %s per-IP burst = %d, want >= 300", target.method, target.path, got)
		}
	}
}

// Reading attachments can make the server fetch and thumbnail an object, so
// the read routes are limited per user, on their own counter.
func TestRouterAttachmentReadsAreRateLimited(t *testing.T) {
	jwtMgr := auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
	rl := &keyRecorder{}
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{}, Attachment: &AttachmentHandler{},
		JWT: jwtMgr, AppVersion: "test", AllowOrigins: []string{"*"}, RateLimiter: rl,
	})
	for _, target := range []string{"/api/v1/attachments?ids=a-1", "/api/v1/attachments/a-1"} {
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, authedReq(t, jwtMgr, http.MethodGet, target, ""))
		if rec.Code != http.StatusTooManyRequests {
			t.Fatalf("GET %s = %d, want 429 from the read limiter", target, rec.Code)
		}
		if key := rl.last(); !strings.Contains(key, "attachment-read") || !strings.Contains(key, "u-1") {
			t.Fatalf("GET %s spent counter %q, want the per-user attachment-read one", target, key)
		}
	}
}
