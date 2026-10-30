package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

type fakeSharePointSvc struct {
	link       *model.SharePointLink
	linkErr    error
	retryErr   error
	preview    string
	previewErr error
	calls      []string
}

func (f *fakeSharePointSvc) Preview(_ context.Context, viewerID, parentID, parentType, fileID string) (string, error) {
	f.calls = append(f.calls, "preview "+viewerID+" "+parentType+" "+parentID+" "+fileID)
	return f.preview, f.previewErr
}

func (f *fakeSharePointSvc) Link(_ context.Context, viewerID, parentID, parentType, rawURL string) (*model.SharePointLink, error) {
	f.calls = append(f.calls, "link "+viewerID+" "+parentType+" "+parentID+" "+rawURL)
	return f.link, f.linkErr
}

func (f *fakeSharePointSvc) RetryLink(_ context.Context, userID, parentID, parentType, rawURL string) error {
	f.calls = append(f.calls, "retry "+userID+" "+parentType+" "+parentID+" "+rawURL)
	return f.retryErr
}

const spTestLink = "https://contoso.sharepoint.com/:w:/s/team/Eabc?e=1"

func serveSharePoint(t *testing.T, svc *fakeSharePointSvc, h func(*SharePointHandler) http.HandlerFunc, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	jwt := auth.NewJWTManager("sp-secret", 15*time.Minute, 24*time.Hour)
	rec := httptest.NewRecorder()
	middleware.Auth(jwt)(h(NewSharePointHandler(svc))).ServeHTTP(rec, authedReq(t, jwt, method, target, body))
	return rec
}

func linkQuery(parentType, parentID, link string) string {
	return "/api/v1/sharepoint/link?" + url.Values{"parentType": {parentType}, "parentID": {parentID}, "url": {link}}.Encode()
}

func TestSharePointHandler_Link(t *testing.T) {
	link := func(h *SharePointHandler) http.HandlerFunc { return h.Link }
	svc := &fakeSharePointSvc{link: &model.SharePointLink{URL: spTestLink, Status: model.SharePointShared, PosterID: "u-1"}}
	rec := serveSharePoint(t, svc, link, http.MethodGet, linkQuery("channel", "ch-1", spTestLink), "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"shared"`) {
		t.Fatalf("Link = %d %s", rec.Code, rec.Body.String())
	}
	if svc.calls[0] != "link u-1 channel ch-1 "+spTestLink {
		t.Fatalf("calls = %v", svc.calls)
	}

	// Never shared: no content.
	rec = serveSharePoint(t, &fakeSharePointSvc{}, link, http.MethodGet, linkQuery("conversation", "dm-1", spTestLink), "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("unknown link = %d", rec.Code)
	}
	rec = serveSharePoint(t, &fakeSharePointSvc{linkErr: service.ErrForbidden}, link, http.MethodGet, linkQuery("channel", "ch-1", spTestLink), "")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("no access = %d", rec.Code)
	}
	for _, target := range []string{
		linkQuery("thread", "ch-1", spTestLink),
		linkQuery("channel", "", spTestLink),
		linkQuery("channel", "ch-1", ""),
		linkQuery("channel", "ch-1", "https://x/"+strings.Repeat("a", maxSharePointURL)),
	} {
		if rec := serveSharePoint(t, &fakeSharePointSvc{}, link, http.MethodGet, target, ""); rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", target, rec.Code)
		}
	}
}

func TestSharePointHandler_Retry(t *testing.T) {
	retry := func(h *SharePointHandler) http.HandlerFunc { return h.Retry }
	body := `{"parentType":"channel","parentID":"ch-1","url":"` + spTestLink + `"}`
	svc := &fakeSharePointSvc{}
	if rec := serveSharePoint(t, svc, retry, http.MethodPost, "/api/v1/sharepoint/link/retry", body); rec.Code != http.StatusAccepted {
		t.Fatalf("Retry = %d %s", rec.Code, rec.Body.String())
	}
	if svc.calls[0] != "retry u-1 channel ch-1 "+spTestLink {
		t.Fatalf("calls = %v", svc.calls)
	}
	if rec := serveSharePoint(t, &fakeSharePointSvc{retryErr: service.ErrNotFound}, retry, http.MethodPost, "/x", body); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown link = %d", rec.Code)
	}
	if rec := serveSharePoint(t, &fakeSharePointSvc{retryErr: errors.New("redis")}, retry, http.MethodPost, "/x", body); rec.Code != http.StatusInternalServerError {
		t.Fatalf("queue down = %d", rec.Code)
	}
	for _, bad := range []string{"{", `{"parentType":"channel","parentID":"ch-1"}`} {
		if rec := serveSharePoint(t, &fakeSharePointSvc{}, retry, http.MethodPost, "/x", bad); rec.Code != http.StatusBadRequest {
			t.Errorf("%s = %d, want 400", bad, rec.Code)
		}
	}
}

func TestSettingsCarrySharePointHosts(t *testing.T) {
	h := &AdminHandler{}
	if got := h.newSettingsResponse(&model.WorkspaceSettings{}); got.SharePointHosts != nil {
		t.Fatalf("sharing off: hosts = %v", got.SharePointHosts)
	}
	h.SetSharePointHosts([]string{"*.sharepoint.com"})
	if got := h.newSettingsResponse(&model.WorkspaceSettings{}); len(got.SharePointHosts) != 1 || got.SharePointHosts[0] != "*.sharepoint.com" {
		t.Fatalf("hosts = %v", got.SharePointHosts)
	}
}

func TestSharePointHandler_Preview(t *testing.T) {
	preview := func(h *SharePointHandler) http.HandlerFunc { return h.Preview }
	target := func(q url.Values) string { return "/api/v1/sharepoint/preview?" + q.Encode() }
	ok := url.Values{"parentType": {"conversation"}, "parentID": {"conv-1"}, "fileID": {"file-1"}}
	svc := &fakeSharePointSvc{preview: "https://contoso.sharepoint.com/embed?nb=true"}
	rec := serveSharePoint(t, svc, preview, http.MethodGet, target(ok), "")
	if rec.Code != http.StatusOK || rec.Body.String() != `{"url":"https://contoso.sharepoint.com/embed?nb=true"}`+"\n" {
		t.Fatalf("Preview = %d %q", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" || svc.calls[0] != "preview u-1 conversation conv-1 file-1" {
		t.Fatalf("cache %q, calls %v", rec.Header().Get("Cache-Control"), svc.calls)
	}
	for _, bad := range []url.Values{{"parentType": {"channel"}, "parentID": {"ch-1"}}, {"parentType": {"thread"}, "parentID": {"ch-1"}, "fileID": {"f"}}} {
		if rec := serveSharePoint(t, svc, preview, http.MethodGet, target(bad), ""); rec.Code != http.StatusBadRequest {
			t.Fatalf("%v: %d", bad, rec.Code)
		}
	}
	svc.previewErr = service.ErrForbidden
	if rec := serveSharePoint(t, svc, preview, http.MethodGet, target(ok), ""); rec.Code != http.StatusForbidden {
		t.Fatalf("refused: %d", rec.Code)
	}
}
