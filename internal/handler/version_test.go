package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestVersionHandler_ReturnsConfiguredVersion(t *testing.T) {
	h := NewVersionHandler("v1.2.3")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/version", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Version != "v1.2.3" {
		t.Errorf("Version = %q, want %q", body.Version, "v1.2.3")
	}
}

func TestVersionHandler_DefaultsToDevWhenEmpty(t *testing.T) {
	// AppVersion returns "dev" when no FS is wired; the endpoint must
	// still return *something* the client can compare against.
	h := NewVersionHandler("")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/version", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Version != "dev" {
		t.Errorf("Version = %q, want dev", body.Version)
	}
}

func TestAppVersion_HashesIndexHTML(t *testing.T) {
	BuildVersion = ""
	t.Cleanup(func() { BuildVersion = "" })
	a := AppVersion(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>v1</html>")},
	})
	b := AppVersion(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>v1</html>")},
	})
	c := AppVersion(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>v2</html>")},
	})
	if a != b {
		t.Errorf("identical content produced different versions: %q vs %q", a, b)
	}
	if a == c {
		t.Errorf("different content produced same version: both %q", a)
	}
	if len(a) != 12 {
		t.Errorf("version len=%d, want 12 hex chars", len(a))
	}
}

func TestAppVersion_FallsBackToDevWithoutFS(t *testing.T) {
	BuildVersion = ""
	t.Cleanup(func() { BuildVersion = "" })
	if got := AppVersion(nil); got != "dev" {
		t.Errorf("AppVersion(nil) = %q, want dev", got)
	}
	if got := AppVersion(fstest.MapFS{}); got != "dev" {
		t.Errorf("AppVersion(empty) = %q, want dev", got)
	}
}

func TestAppVersion_IgnoresBakedDisplayVersionForReloadDetection(t *testing.T) {
	BuildVersion = "v1.2.3"
	t.Cleanup(func() { BuildVersion = "" })
	a := AppVersion(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>v1</html>")},
	})
	b := AppVersion(fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>v2</html>")},
	})
	if a == "v1.2.3" || b == "v1.2.3" {
		t.Fatalf("AppVersion used display BuildVersion: %q / %q", a, b)
	}
	if a == b {
		t.Fatalf("different frontend artifacts produced same app version %q", a)
	}
}

func TestDisplayVersion_PrefersBakedBuildVersion(t *testing.T) {
	BuildVersion = "v1.2.3"
	t.Cleanup(func() { BuildVersion = "" })
	if got := DisplayVersion("asset-hash"); got != "v1.2.3" {
		t.Errorf("DisplayVersion = %q, want baked build version", got)
	}
}

func TestDisplayVersion_FallsBackToAppVersion(t *testing.T) {
	BuildVersion = ""
	t.Cleanup(func() { BuildVersion = "" })
	if got := DisplayVersion("asset-hash"); got != "asset-hash" {
		t.Errorf("DisplayVersion = %q, want app version fallback", got)
	}
}

func TestVersionHandler_SetsETag(t *testing.T) {
	h := NewVersionHandler("abc123")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/version", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("ETag"); got != `"abc123"` {
		t.Errorf("ETag = %q, want %q", got, `"abc123"`)
	}
}

func TestVersionHandler_ReturnsNotModifiedWhenETagMatches(t *testing.T) {
	h := NewVersionHandler("abc123")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/version", nil)
	req.Header.Set("If-None-Match", `"abc123"`)
	rec := httptest.NewRecorder()
	h.Get(rec, req)

	if rec.Code != http.StatusNotModified {
		t.Errorf("status = %d, want 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body = %q, want empty for 304", rec.Body.String())
	}
}

func TestVersionHandler_ReturnsBodyWhenETagMismatches(t *testing.T) {
	h := NewVersionHandler("abc123")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/version", nil)
	req.Header.Set("If-None-Match", `"old456"`)
	rec := httptest.NewRecorder()
	h.Get(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"abc123"`) {
		t.Errorf("body = %q, expected to contain version", rec.Body.String())
	}
}
