package handler

import (
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
// for unknown paths (client-side routing fallback).
func TestSpaHandler_ServesIndexHTML(t *testing.T) {
	memFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>app</html>")},
		"assets/main.js": &fstest.MapFile{Data: []byte("console.log('ok')")},
	}

	spa := &spaHandler{
		fs:         http.FS(memFS),
		fileServer: http.FileServer(http.FS(memFS)),
	}

	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{"root serves index", "/", http.StatusOK, "<html>app</html>"},
		{"static file served directly", "/assets/main.js", http.StatusOK, "console.log('ok')"},
		{"unknown path falls back to index", "/some/route", http.StatusOK, ""},
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

// TestSpaHandler_APIRoutesReturn404 verifies that /api/ and /auth/ paths are
// not handled by the SPA handler.
func TestSpaHandler_APIRoutesReturn404(t *testing.T) {
	memFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>app</html>")},
	}

	spa := &spaHandler{
		fs:         http.FS(memFS),
		fileServer: http.FileServer(http.FS(memFS)),
	}

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
	router := NewRouter(&AuthHandler{}, &UserHandler{}, &ChannelHandler{}, &ConversationHandler{}, &WSHandler{}, nil, nil, nil, nil, nil, jwtMgr, frontendFS, "*")

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

// setupJWTManager creates a JWT manager for test helpers.
func setupJWTManager() *jwtManagerForTest {
	return newJWTManagerForTest()
}

type jwtManagerForTest = auth.JWTManager

func newJWTManagerForTest() *auth.JWTManager {
	return auth.NewJWTManager("test-secret", 15*time.Minute, 24*time.Hour)
}
