package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

// Hashed build assets must carry immutable cache headers — without them every
// app open re-downloads the whole bundle, and on a mobile webview a stalled
// re-fetch is the "opens blank" failure. index.html stays no-store so a new
// deploy's hashes propagate immediately.
func TestSpaHandler_CacheHeaders(t *testing.T) {
	memFS := fstest.MapFS{
		"index.html":         &fstest.MapFile{Data: []byte("<html><head></head><body>ok</body></html>")},
		"assets/main-abc.js": &fstest.MapFile{Data: []byte("console.log('ok')")},
		"favicon.svg":        &fstest.MapFile{Data: []byte("<svg/>")},
	}
	spa := newSPAHandler(memFS, "v1", SentryFrontendConfig{})

	tests := []struct {
		path      string
		wantCache string
	}{
		{"/", "no-store"},
		{"/some/spa/route", "no-store"},
		{"/assets/main-abc.js", "public, max-age=31536000, immutable"},
		{"/favicon.svg", "public, max-age=3600"},
	}
	for _, tt := range tests {
		req := httptest.NewRequest(http.MethodGet, tt.path, nil)
		rec := httptest.NewRecorder()
		spa.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", tt.path, rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != tt.wantCache {
			t.Errorf("%s: Cache-Control = %q, want %q", tt.path, got, tt.wantCache)
		}
	}
}
