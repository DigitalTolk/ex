package handler

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

const testBridgeSecret = "test-bridge-secret-at-least-32-characters"

type fakeLimiter struct {
	allow bool
	err   error
}

func (f fakeLimiter) AllowRequest(context.Context, string, int, time.Duration) (bool, error) {
	return f.allow, f.err
}

// cliffhubStub serves both the bridge mint endpoint and the agent endpoint. The
// agent asserts it received the exact token the mint issued, proving ex injects
// the bridged token server-side, and streams a short SSE body.
type cliffhubStub struct {
	mintStatus      int
	agentCalls      int32
	writeCalls      int32
	lastWriteMethod string
}

func newCliffhubStub() *cliffhubStub { return &cliffhubStub{mintStatus: http.StatusOK} }

func (s *cliffhubStub) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ai/bridge/mint", func(w http.ResponseWriter, _ *http.Request) {
		if s.mintStatus != http.StatusOK {
			w.WriteHeader(s.mintStatus)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":      "minted-tok-xyz",
			"token_type": "Bearer",
			"expires_at": time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339Nano),
		})
	})
	mux.HandleFunc("/api/work/tasks", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&s.writeCalls, 1)
		if r.Header.Get("Authorization") != "Bearer minted-tok-xyz" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		s.lastWriteMethod = r.Method
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, `{"id":"TASK-1","title":"Ship it"}`)
	})
	mux.HandleFunc("/api/ai/chat", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&s.agentCalls, 1)
		if r.Header.Get("Authorization") != "Bearer minted-tok-xyz" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		_, _ = io.WriteString(w, "data: hello\n\n")
		if fl != nil {
			fl.Flush()
		}
		_, _ = io.WriteString(w, "data: world\n\n")
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func newTestCliffyHandler(t *testing.T, srvURL, agentURL string, limiter middleware.RateLimitCounter) *CliffyHandler {
	t.Helper()
	bridge, err := service.NewCliffyBridge(service.CliffyBridgeConfig{
		Secret:  testBridgeSecret,
		MintURL: srvURL + "/api/ai/bridge/mint",
	})
	if err != nil || bridge == nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	return NewCliffyHandler(CliffyHandlerConfig{
		Bridge:    bridge,
		AgentURL:  agentURL,
		APIOrigin: srvURL, // write passthrough targets the same stub
		Limiter:   limiter,
	})
}

func chatRequest(t *testing.T, userID, email string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/cliffy/chat", strings.NewReader(`{"messages":[]}`))
	ctx := middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: userID, Email: email})
	return req.WithContext(ctx)
}

func TestChat_StreamsAgentAndInjectsToken(t *testing.T) {
	stub := newCliffhubStub()
	srv := stub.server(t)
	h := newTestCliffyHandler(t, srv.URL, srv.URL+"/api/ai/chat", fakeLimiter{allow: true})

	rec := httptest.NewRecorder()
	h.Chat(rec, chatRequest(t, "u1", "user@example.com"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("content-type = %q, want text/event-stream", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "data: hello") || !strings.Contains(body, "data: world") {
		t.Errorf("streamed body missing SSE chunks: %q", body)
	}
	if n := atomic.LoadInt32(&stub.agentCalls); n != 1 {
		t.Errorf("agent calls = %d, want 1", n)
	}
}

func TestChat_RateLimited(t *testing.T) {
	stub := newCliffhubStub()
	srv := stub.server(t)
	h := newTestCliffyHandler(t, srv.URL, srv.URL+"/api/ai/chat", fakeLimiter{allow: false})

	rec := httptest.NewRecorder()
	h.Chat(rec, chatRequest(t, "u1", "user@example.com"))

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	if n := atomic.LoadInt32(&stub.agentCalls); n != 0 {
		t.Errorf("agent must not be called when rate-limited (calls=%d)", n)
	}
}

func TestChat_NoAccount(t *testing.T) {
	stub := newCliffhubStub()
	stub.mintStatus = http.StatusForbidden
	srv := stub.server(t)
	h := newTestCliffyHandler(t, srv.URL, srv.URL+"/api/ai/chat", fakeLimiter{allow: true})

	rec := httptest.NewRecorder()
	h.Chat(rec, chatRequest(t, "u1", "guest@example.com"))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
	if n := atomic.LoadInt32(&stub.agentCalls); n != 0 {
		t.Errorf("agent must not be called without an account (calls=%d)", n)
	}
}

func TestChat_UnconfiguredAgent(t *testing.T) {
	stub := newCliffhubStub()
	srv := stub.server(t)
	h := newTestCliffyHandler(t, srv.URL, "", fakeLimiter{allow: true}) // no agent URL

	rec := httptest.NewRecorder()
	h.Chat(rec, chatRequest(t, "u1", "user@example.com"))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestChat_MissingEmailForbidden(t *testing.T) {
	stub := newCliffhubStub()
	srv := stub.server(t)
	h := newTestCliffyHandler(t, srv.URL, srv.URL+"/api/ai/chat", fakeLimiter{allow: true})

	rec := httptest.NewRecorder()
	h.Chat(rec, chatRequest(t, "u1", "")) // no email

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func apiRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/cliffy/api", strings.NewReader(body))
	ctx := middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: "u1", Email: "user@example.com"})
	return req.WithContext(ctx)
}

func TestProxyAPI_RelaysWriteAndInjectsToken(t *testing.T) {
	stub := newCliffhubStub()
	srv := stub.server(t)
	h := newTestCliffyHandler(t, srv.URL, srv.URL+"/api/ai/chat", fakeLimiter{allow: true})

	rec := httptest.NewRecorder()
	h.ProxyAPI(rec, apiRequest(t, `{"method":"POST","path":"api/work/tasks","body":{"title":"Ship it"}}`))

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201\nbody: %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "TASK-1") {
		t.Errorf("body missing created record: %q", rec.Body.String())
	}
	if n := atomic.LoadInt32(&stub.writeCalls); n != 1 {
		t.Errorf("write calls = %d, want 1", n)
	}
	if stub.lastWriteMethod != http.MethodPost {
		t.Errorf("upstream method = %q, want POST", stub.lastWriteMethod)
	}
}

func TestProxyAPI_RejectsReadMethod(t *testing.T) {
	stub := newCliffhubStub()
	srv := stub.server(t)
	h := newTestCliffyHandler(t, srv.URL, srv.URL+"/api/ai/chat", fakeLimiter{allow: true})

	rec := httptest.NewRecorder()
	h.ProxyAPI(rec, apiRequest(t, `{"method":"GET","path":"api/work/tasks"}`))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (reads go through the agent)", rec.Code)
	}
	if n := atomic.LoadInt32(&stub.writeCalls); n != 0 {
		t.Errorf("upstream must not be called for a rejected method (calls=%d)", n)
	}
}

type fakePoster struct {
	calls      int32
	err        error
	lastUser   string
	lastParent string
	lastType   string
	lastBody   string
}

func (p *fakePoster) SendBotCard(_ context.Context, requestUserID, _, _, _ /* authorID, username, iconEmoji */, parentID, parentType, _ /* parentMessageID */, body string, _ []model.MessageAttachment) (*model.Message, error) {
	atomic.AddInt32(&p.calls, 1)
	p.lastUser, p.lastParent, p.lastType, p.lastBody = requestUserID, parentID, parentType, body
	if p.err != nil {
		return nil, p.err
	}
	return &model.Message{ID: "msg-1"}, nil
}

func newCliffyHandlerWithPoster(t *testing.T, poster cliffyPoster) *CliffyHandler {
	t.Helper()
	// A bridge is required to build the handler but Share never mints.
	bridge, err := service.NewCliffyBridge(service.CliffyBridgeConfig{
		Secret:  testBridgeSecret,
		MintURL: "http://127.0.0.1:1/api/ai/bridge/mint",
	})
	if err != nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	return NewCliffyHandler(CliffyHandlerConfig{Bridge: bridge, Poster: poster})
}

func makeShareRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/cliffy/share", strings.NewReader(body))
	ctx := middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: "u1", Email: "user@example.com"})
	return req.WithContext(ctx)
}

func TestShare_PostsCard(t *testing.T) {
	poster := &fakePoster{}
	h := newCliffyHandlerWithPoster(t, poster)

	rec := httptest.NewRecorder()
	h.Share(rec, makeShareRequest(t, `{"scope_type":"channel","scope_id":"c1","text":"Created TASK-1"}`))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200\nbody: %s", rec.Code, rec.Body.String())
	}
	if poster.calls != 1 || poster.lastParent != "c1" || poster.lastType != "channel" || poster.lastUser != "u1" {
		t.Errorf("poster got user=%q parent=%q type=%q calls=%d", poster.lastUser, poster.lastParent, poster.lastType, poster.calls)
	}
}

func TestShare_ForbiddenWhenNotAMember(t *testing.T) {
	poster := &fakePoster{err: service.ErrForbidden}
	h := newCliffyHandlerWithPoster(t, poster)

	rec := httptest.NewRecorder()
	h.Share(rec, makeShareRequest(t, `{"scope_type":"conversation","scope_id":"d1","text":"hi"}`))

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestShare_RejectsInvalidScope(t *testing.T) {
	poster := &fakePoster{}
	h := newCliffyHandlerWithPoster(t, poster)

	rec := httptest.NewRecorder()
	h.Share(rec, makeShareRequest(t, `{"scope_type":"bogus","scope_id":"c1","text":"hi"}`))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if atomic.LoadInt32(&poster.calls) != 0 {
		t.Errorf("poster must not be called for an invalid scope (calls=%d)", poster.calls)
	}
}

func TestShare_UnconfiguredPoster(t *testing.T) {
	bridge, _ := service.NewCliffyBridge(service.CliffyBridgeConfig{Secret: testBridgeSecret, MintURL: "http://127.0.0.1:1/api/ai/bridge/mint"})
	h := NewCliffyHandler(CliffyHandlerConfig{Bridge: bridge}) // no Poster

	rec := httptest.NewRecorder()
	h.Share(rec, makeShareRequest(t, `{"scope_type":"channel","scope_id":"c1","text":"hi"}`))

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestProxyAPI_RejectsSSRFPath(t *testing.T) {
	stub := newCliffhubStub()
	srv := stub.server(t)
	h := newTestCliffyHandler(t, srv.URL, srv.URL+"/api/ai/chat", fakeLimiter{allow: true})

	for _, path := range []string{"https://evil.example/x", "internal/secrets", "//evil.example/api/x"} {
		rec := httptest.NewRecorder()
		h.ProxyAPI(rec, apiRequest(t, `{"method":"POST","path":"`+path+`"}`))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("path %q: status = %d, want 400", path, rec.Code)
		}
	}
	if n := atomic.LoadInt32(&stub.writeCalls); n != 0 {
		t.Errorf("upstream must not be reached for guarded paths (calls=%d)", n)
	}
}
