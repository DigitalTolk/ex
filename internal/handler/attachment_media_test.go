package handler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// mediaTokenFor stores an object of the given content type and returns the
// handler plus the media token the service hands out for it.
func mediaTokenFor(t *testing.T, contentType string) (*AttachmentHandler, string) {
	t.Helper()
	st := newFakeAttachmentStore()
	key := "attachments/a-typed"
	signer := &fakeSigner{objects: map[string][]byte{key: []byte("<script>alert(1)</script>")}, objectTypes: map[string]string{key: contentType}}
	svc := service.NewAttachmentService(st, signer, nil)
	svc.SetMediaURLCache(newFakeMediaCacheH())
	att := &model.Attachment{
		ID: "a-typed", SHA256: "sha-typed", S3Key: key, Filename: "pic.png",
		ContentType: "image/png", Size: 25, CreatedBy: "u1",
	}
	if err := st.Create(context.Background(), att); err != nil {
		t.Fatalf("Create: %v", err)
	}
	resolved, err := svc.Get(context.Background(), att.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	parts := strings.Split(resolved.URL, "/")
	return NewAttachmentHandler(svc), parts[len(parts)-2]
}

// A Content-Type header is a comma list to a browser, which takes the LAST
// valid type: "image/png, text/html" renders as HTML. Whatever the stored
// type, the media route must serve one well-formed type, and anything it
// cannot parse as a single safe type downloads instead of rendering.
func TestAttachmentHandler_Media_ContentTypeListNeverRendersHTML(t *testing.T) {
	for _, stored := range []string{
		"image/png, text/html",
		"image/png,text/html; charset=utf-8",
		"text/html",
		"TEXT/HTML; charset=utf-8",
		"image/svg+xml",
		"not a type",
	} {
		h, token := mediaTokenFor(t, stored)
		rec := getMedia(h, token, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("%q: status %d", stored, rec.Code)
		}
		ct := rec.Header().Get("Content-Type")
		if strings.Contains(ct, ",") {
			t.Errorf("%q: served Content-Type %q is a list", stored, ct)
		}
		if got := rec.Header().Get("Content-Disposition"); !strings.HasPrefix(got, "attachment") {
			t.Errorf("%q: Content-Disposition = %q, want a forced download", stored, got)
		}
	}
}

func TestAttachmentHandler_Media_NormalizesASafeType(t *testing.T) {
	h, token := mediaTokenFor(t, "Image/PNG")
	rec := getMedia(h, token, nil)
	if got := rec.Header().Get("Content-Type"); got != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != "" {
		t.Fatalf("Content-Disposition = %q, want inline", got)
	}
}

type allowAllAttachments struct{}

func (allowAllAttachments) CanAccessMessageAttachment(context.Context, string, string, string, string, string) error {
	return nil
}

// A URL handed to a user carries the grant binding it to them; the media
// route passes it on, and the URL does not open without it.
func TestAttachmentHandler_Media_PassesTheGrant(t *testing.T) {
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &fakeSigner{}, nil)
	svc.SetMediaURLCache(newFakeMediaCacheH())
	svc.SetAccessChecker(allowAllAttachments{})
	att := &model.Attachment{
		ID: "a-granted", SHA256: "sha-granted", S3Key: "attachments/a-granted", Filename: "doc.txt",
		ContentType: "text/plain", Size: 4, CreatedBy: "owner", MessageIDs: []string{"m1"},
	}
	if err := st.Create(context.Background(), att); err != nil {
		t.Fatal(err)
	}
	resolved, err := svc.GetForUser(context.Background(), "u2", att.ID, "ch1", "channel", "m1")
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(resolved.URL)
	if err != nil || u.Query().Get("g") == "" {
		t.Fatalf("URL %q carries no grant", resolved.URL)
	}
	token := strings.Split(strings.TrimPrefix(u.Path, "/api/v1/media/"), "/")[0]
	h := NewAttachmentHandler(svc)
	for _, tc := range []struct {
		query string
		want  int
	}{
		{"?" + u.RawQuery, http.StatusOK},
		{"", http.StatusNotFound},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/media/"+token+"/doc.txt"+tc.query, nil)
		req.SetPathValue("token", token)
		rec := httptest.NewRecorder()
		h.Media(rec, req)
		if rec.Code != tc.want {
			t.Errorf("query %q: status %d, want %d", tc.query, rec.Code, tc.want)
		}
	}
}

// A storage failure is the server's problem: the caller gets a fixed message,
// never the backend's error text.
func TestAttachmentHandler_Media_BadGatewayHidesTheCause(t *testing.T) {
	st := newFakeAttachmentStore()
	svc := service.NewAttachmentService(st, &fakeSigner{}, nil)
	mc := newFakeMediaCacheH()
	mc.getErr = errors.New("redis exploded at 10.0.0.7:6379")
	svc.SetMediaURLCache(mc)
	h := NewAttachmentHandler(svc)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/media/some-token/x.png", nil)
	req.SetPathValue("token", "some-token")
	rec := httptest.NewRecorder()
	h.Media(rec, req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if body := rec.Body.String(); strings.Contains(body, "redis") || strings.Contains(body, "10.0.0.7") {
		t.Fatalf("500 body leaks the cause: %s", body)
	}
}
