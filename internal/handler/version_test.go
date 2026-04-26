package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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
	// CI sets the version via -ldflags; the local build leaves it blank.
	// The endpoint should still return *something* the client can compare.
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
