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
)

// giphyUpstreamBody is a minimal Giphy v1 envelope — `data`,
// `pagination`, and `meta` are exactly the fields the frontend Grid
// reads, so the handler test asserts they survive the proxy.
const giphyUpstreamBody = `{"data":[{"id":"id-1","title":"title-1","images":{"original":{"url":"https://media.giphy.com/big.gif","width":"100","height":"80"}}}],"pagination":{"total_count":1,"count":1,"offset":0},"meta":{"status":200,"msg":"OK","response_id":"r1"}}`

// makeGiphyHandler wires a real GiphyService against an httptest
// upstream + the existing fakeSettingsStore from missing_handlers_test.
func makeGiphyHandler(t *testing.T, apiKey string) (*GiphyHandler, *auth.JWTManager, func()) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(giphyUpstreamBody))
	}))
	settings := service.NewSettingsService(&fakeSettingsStore{current: &model.WorkspaceSettings{GiphyAPIKey: apiKey}})
	svc := service.NewGiphyService(settings).WithBaseURL(upstream.URL)
	jwtMgr := auth.NewJWTManager("giphy-test-secret", 15*time.Minute, 720*time.Hour)
	return NewGiphyHandler(svc), jwtMgr, upstream.Close
}

func makeMemberToken(t *testing.T, mgr *auth.JWTManager) string {
	t.Helper()
	return makeTokenForUser(mgr, &model.User{ID: "u-mem", Email: "m@x.com", SystemRole: model.SystemRoleMember})
}

// assertGiphyEnvelope checks that the response body is the raw Giphy
// envelope shape the React Grid expects. We don't enumerate every
// field — only that the wrapper made it through unmolested.
func assertGiphyEnvelope(t *testing.T, body []byte) {
	t.Helper()
	var got struct {
		Data       []map[string]any `json:"data"`
		Pagination map[string]any   `json:"pagination"`
		Meta       map[string]any   `json:"meta"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v; body=%s", err, string(body))
	}
	if got.Pagination == nil || got.Meta == nil {
		t.Errorf("missing envelope fields: %s", string(body))
	}
}

func TestGiphyHandler_Search_OK(t *testing.T) {
	h, jwtMgr, cleanup := makeGiphyHandler(t, "k-1")
	defer cleanup()
	token := makeMemberToken(t, jwtMgr)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Search))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/giphy/search?q=cat", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("content-type = %q, want application/json", ct)
	}
	assertGiphyEnvelope(t, rec.Body.Bytes())
}

func TestGiphyHandler_Search_Unauthenticated(t *testing.T) {
	h, _, cleanup := makeGiphyHandler(t, "k-1")
	defer cleanup()

	// No middleware → no claims in context → handler returns 401.
	req := httptest.NewRequest(http.MethodGet, "/api/v1/giphy/search?q=cat", nil).WithContext(context.Background())
	rec := httptest.NewRecorder()
	h.Search(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestGiphyHandler_Search_NotConfigured(t *testing.T) {
	h, jwtMgr, cleanup := makeGiphyHandler(t, "")
	defer cleanup()
	token := makeMemberToken(t, jwtMgr)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Search))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/giphy/search?q=cat", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestGiphyHandler_Trending_OK(t *testing.T) {
	h, jwtMgr, cleanup := makeGiphyHandler(t, "k-1")
	defer cleanup()
	token := makeMemberToken(t, jwtMgr)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Trending))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/giphy/trending", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	assertGiphyEnvelope(t, rec.Body.Bytes())
}

func TestGiphyHandler_Trending_Unauthenticated(t *testing.T) {
	h, _, cleanup := makeGiphyHandler(t, "k-1")
	defer cleanup()

	req := httptest.NewRequest(http.MethodGet, "/api/v1/giphy/trending", nil).WithContext(context.Background())
	rec := httptest.NewRecorder()
	h.Trending(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestGiphyHandler_Search_UpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()
	settings := service.NewSettingsService(&fakeSettingsStore{current: &model.WorkspaceSettings{GiphyAPIKey: "k"}})
	svc := service.NewGiphyService(settings).WithBaseURL(upstream.URL)
	h := NewGiphyHandler(svc)
	jwtMgr := auth.NewJWTManager("giphy-test-secret", 15*time.Minute, 720*time.Hour)
	token := makeMemberToken(t, jwtMgr)

	handler := middleware.Auth(jwtMgr)(http.HandlerFunc(h.Search))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/giphy/search?q=cat", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}
