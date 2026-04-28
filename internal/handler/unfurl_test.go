package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DigitalTolk/ex/internal/service"
)

func TestUnfurlHandler_MissingURLReturns400(t *testing.T) {
	h := NewUnfurlHandler(service.NewUnfurlService(nil))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/unfurl", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

func TestUnfurlHandler_BlockedHostReturns204(t *testing.T) {
	// Loopback is blocked by the SSRF guard. The handler swallows the
	// error and emits 204 so the client renders nothing for the link.
	h := NewUnfurlHandler(service.NewUnfurlService(nil))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/unfurl?url=http://127.0.0.1/", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
}

func TestUnfurlHandler_NonHTTPSchemeReturns204(t *testing.T) {
	h := NewUnfurlHandler(service.NewUnfurlService(nil))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/unfurl?url=javascript:alert(1)", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", rec.Code)
	}
}
