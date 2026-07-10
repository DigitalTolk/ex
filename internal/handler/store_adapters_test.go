package handler

import (
	"context"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
)

// TestSpaHandler_ServesIndexHTML verifies that the SPA handler serves index.html
// for unknown paths (client-side routing fallback) and injects the version meta.
func TestSpaHandler_ServesIndexHTML(t *testing.T) {
	BuildVersion = "release-1"
	t.Cleanup(func() { BuildVersion = "" })
	memFS := fstest.MapFS{
		"index.html":     &fstest.MapFile{Data: []byte("<html><head><title>app</title></head></html>")},
		"assets/main.js": &fstest.MapFile{Data: []byte("console.log('ok')")},
	}

	spa := newSPAHandler(memFS, "abc123", SentryFrontendConfig{
		DSN:                     "https://k3y@o0.ingest.sentry.io/42",
		TracesSampleRate:        0.25,
		ReplaySessionSampleRate: 0.1,
	})

	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{"root serves index with injected app meta", "/", http.StatusOK, `<meta name="app-version" content="abc123">`},
		{"root serves index with injected build meta", "/", http.StatusOK, `<meta name="build-version" content="release-1">`},
		{"root serves index with injected sentry meta", "/", http.StatusOK, `<meta name="sentry-dsn" content="https://k3y@o0.ingest.sentry.io/42">`},
		{"root serves index with injected traces rate", "/", http.StatusOK, `<meta name="sentry-traces-sample-rate" content="0.25">`},
		{"root serves index with injected replay session rate", "/", http.StatusOK, `<meta name="sentry-replay-session-sample-rate" content="0.1">`},
		{"static file served directly", "/assets/main.js", http.StatusOK, "console.log('ok')"},
		{"unknown path falls back to index", "/some/route", http.StatusOK, `<meta name="app-version" content="abc123">`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.path, nil)
			rec := httptest.NewRecorder()
			spa.ServeHTTP(rec, req)

			if rec.Code != tt.wantStatus {
				t.Errorf("status = %d, want %d for path %q", rec.Code, tt.wantStatus, tt.path)
			}
			if tt.wantBody != "" && !strings.Contains(rec.Body.String(), tt.wantBody) {
				t.Errorf("body = %q, want to contain %q", rec.Body.String(), tt.wantBody)
			}
		})
	}
}

// Without a configured DSN, no sentry-dsn meta tag is emitted — the SPA then
// leaves error reporting entirely uninitialized.
func TestSpaHandler_NoSentryMetaWithoutDSN(t *testing.T) {
	memFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html><head><title>app</title></head></html>")},
	}
	// Rates without a DSN are meaningless — nothing sentry-related is served.
	spa := newSPAHandler(memFS, "abc123", SentryFrontendConfig{TracesSampleRate: 0.5})
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	spa.ServeHTTP(rec, req)
	if strings.Contains(rec.Body.String(), "sentry-") {
		t.Errorf("body must not contain sentry metas when no DSN is configured: %q", rec.Body.String())
	}
	// A DSN with zero rates serves the DSN but no rate metas (all off).
	spa = newSPAHandler(memFS, "abc123", SentryFrontendConfig{DSN: "https://k@o0.ingest.sentry.io/1"})
	rec = httptest.NewRecorder()
	spa.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(rec.Body.String(), "sentry-dsn") {
		t.Errorf("expected the sentry-dsn meta: %q", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "sample-rate") {
		t.Errorf("zero rates must not emit rate metas: %q", rec.Body.String())
	}
}

// TestSpaHandler_APIRoutesReturn404 verifies that /api/ and /auth/ paths are
// not handled by the SPA handler.
func TestSpaHandler_APIRoutesReturn404(t *testing.T) {
	memFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>app</html>")},
	}

	spa := newSPAHandler(memFS, "v1", SentryFrontendConfig{})

	paths := []string{"/api/v1/users", "/api/v1/channels", "/auth/login"}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, path, nil)
			rec := httptest.NewRecorder()
			spa.ServeHTTP(rec, req)

			if rec.Code != http.StatusNotFound {
				t.Errorf("status = %d, want %d for path %q", rec.Code, http.StatusNotFound, path)
			}
		})
	}
}

// TestNewRouterWithFrontendFS verifies that the router works when frontendFS is provided.
func TestNewRouterWithFrontendFS(t *testing.T) {
	memFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>app</html>")},
	}

	var frontendFS fs.FS = memFS

	jwtMgr := setupJWTManager()
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: jwtMgr, FrontendFS: frontendFS, AppVersion: "test", AllowOrigins: []string{"*"},
	})

	// SPA route should return index.html.
	req := httptest.NewRequest(http.MethodGet, "/some-spa-route", nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("SPA fallback: status = %d, want %d", rec.Code, http.StatusOK)
	}
	if !strings.Contains(rec.Body.String(), "<html>app</html>") {
		t.Errorf("SPA fallback: body = %q, expected index.html content", rec.Body.String())
	}
}

// TestReadJSON_NilBody verifies readJSON handles a request with nil body gracefully.
func TestReadJSON_NilBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	var dest struct {
		Name string `json:"name"`
	}
	err := readJSON(req, &dest)
	if err == nil {
		t.Fatal("expected error for nil body, got nil")
	}
}

// TestWriteJSON_UnmarshalableValue verifies writeJSON handles values that can't
// be marshaled to JSON.
func TestWriteJSON_UnmarshalableValue(t *testing.T) {
	rec := httptest.NewRecorder()
	// Channels can't be marshaled to JSON.
	ch := make(chan int)
	writeJSON(rec, http.StatusOK, ch)

	// The function will still set the header and status, but the body will
	// contain an error or be empty since Encode fails.
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

// TestQueryInt_NonNumeric verifies queryInt returns the fallback for non-numeric values.
func TestQueryInt_NonNumeric(t *testing.T) {
	tests := []struct {
		name     string
		url      string
		param    string
		fallback int
		want     int
	}{
		{"letters", "/test?page=abc", "page", 42, 42},
		{"float", "/test?page=3.14", "page", 42, 42},
		{"special chars", "/test?page=@!", "page", 42, 42},
		{"overflow", "/test?page=99999999999999999999999", "page", 42, 42},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tt.url, nil)
			got := queryInt(req, tt.param, tt.fallback)
			if got != tt.want {
				t.Errorf("queryInt = %d, want %d", got, tt.want)
			}
		})
	}
}

// TestUnreadSeqAdapter pins the function-value adapter that binds a parent's
// seq incrementer + last-read setter into one service.UnreadSeqStore.
func TestUnreadSeqAdapter(t *testing.T) {
	ctx := context.Background()
	var gotInc, gotParent, gotUser string
	var gotSeq int64
	adapter := NewUnreadSeqAdapter(
		func(_ context.Context, parentID string) (int64, error) {
			gotInc = parentID
			return 7, nil
		},
		func(_ context.Context, parentID, userID string, seq int64) error {
			gotParent, gotUser, gotSeq = parentID, userID, seq
			return nil
		},
	)
	seq, err := adapter.IncrementMessageSeq(ctx, "p-1")
	if err != nil || seq != 7 || gotInc != "p-1" {
		t.Fatalf("IncrementMessageSeq seq=%d err=%v inc=%q", seq, err, gotInc)
	}
	if err := adapter.SetLastRead(ctx, "p-1", "u-9", 7); err != nil {
		t.Fatalf("SetLastRead: %v", err)
	}
	if gotParent != "p-1" || gotUser != "u-9" || gotSeq != 7 {
		t.Fatalf("SetLastRead got parent=%q user=%q seq=%d", gotParent, gotUser, gotSeq)
	}
}

// setupJWTManager creates a JWT manager for test helpers.
func setupJWTManager() *jwtManagerForTest {
	return newJWTManagerForTest()
}

type jwtManagerForTest = auth.JWTManager

func newJWTManagerForTest() *auth.JWTManager {
	return auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
}
