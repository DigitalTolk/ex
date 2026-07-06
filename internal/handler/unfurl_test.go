package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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

type fakeUnfurlSvc struct {
	preview *service.UnfurlPreview
	err     error
}

func (f fakeUnfurlSvc) Unfurl(context.Context, string) (*service.UnfurlPreview, error) {
	return f.preview, f.err
}

type fakeMsgLinks struct {
	preview  *service.UnfurlPreview
	internal bool
}

func (f fakeMsgLinks) Preview(context.Context, string, string) (*service.UnfurlPreview, bool) {
	return f.preview, f.internal
}

func TestUnfurlHandler_InternalMessageLinkReturnsPreview(t *testing.T) {
	h := &UnfurlHandler{
		svc:      fakeUnfurlSvc{err: errors.New("should not be called")},
		msgLinks: fakeMsgLinks{preview: &service.UnfurlPreview{Kind: "message", AuthorName: "Günter"}, internal: true},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/unfurl?url=https://ex.test/channel/general%23msg-m1", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"kind":"message"`) {
		t.Errorf("body missing message preview: %s", rec.Body.String())
	}
}

func TestUnfurlHandler_InternalLinkNoAccessReturns204(t *testing.T) {
	h := &UnfurlHandler{
		svc:      fakeUnfurlSvc{err: errors.New("should not be called")},
		msgLinks: fakeMsgLinks{preview: nil, internal: true},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/unfurl?url=https://ex.test/channel/secret%23msg-x", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204 (no leak)", rec.Code)
	}
}

func TestUnfurlHandler_NonInternalLinkFallsThroughToWeb(t *testing.T) {
	h := &UnfurlHandler{
		svc:      fakeUnfurlSvc{preview: &service.UnfurlPreview{Title: "Web Page"}},
		msgLinks: fakeMsgLinks{internal: false},
	}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/unfurl?url=https://example.com/article", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Web Page") {
		t.Errorf("expected web fall-through 200, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestUnfurlHandler_SetMessageLinksWiresResolver(t *testing.T) {
	h := &UnfurlHandler{svc: fakeUnfurlSvc{err: errors.New("should not be called")}}
	h.SetMessageLinks(fakeMsgLinks{preview: &service.UnfurlPreview{Kind: "message"}, internal: true})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/unfurl?url=https://ex.test/channel/general%23msg-m1", nil)
	rec := httptest.NewRecorder()
	h.Get(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 via the wired resolver", rec.Code)
	}
}
