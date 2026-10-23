package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
)

// recordingUploadSigner records what the upload handler asked to sign.
type recordingUploadSigner struct {
	sizedSizes  []int64
	inlineTypes []string
}

func (s *recordingUploadSigner) PresignedSizedPutURL(_ context.Context, key, _ string, size int64, _ time.Duration) (string, error) {
	s.sizedSizes = append(s.sizedSizes, size)
	return "https://upload/" + key, nil
}

func (s *recordingUploadSigner) PresignedInlineURL(_ context.Context, key, contentType, _ string, _ time.Duration) (string, error) {
	s.inlineTypes = append(s.inlineTypes, contentType)
	return "https://get/" + key, nil
}

func postUpload(t *testing.T, h *UploadHandler, body string) *httptest.ResponseRecorder {
	t.Helper()
	jwtMgr := auth.NewJWTManager("upload-bound-secret", 15*time.Minute, 720*time.Hour)
	tok := makeTokenForUser(jwtMgr, &model.User{ID: "up-b", Email: "b@x.com", SystemRole: model.SystemRoleMember})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/uploads/url", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	middleware.Auth(jwtMgr)(http.HandlerFunc(h.CreateUploadURL)).ServeHTTP(rec, req)
	return rec
}

// The PUT URL is reusable for its lifetime: it must bind the declared size,
// or a 512 KiB "emoji" URL uploads gigabytes.
func TestCreateUploadURL_BindsTheDeclaredSize(t *testing.T) {
	signer := &recordingUploadSigner{}
	rec := postUpload(t, &UploadHandler{s3: signer}, `{"filename":"e.png","contentType":"image/png","size":128}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if len(signer.sizedSizes) != 1 || signer.sizedSizes[0] != 128 {
		t.Fatalf("PUT signed with sizes %v, want exactly [128]", signer.sizedSizes)
	}
	// The preview URL pins the served type instead of trusting the stored one.
	if len(signer.inlineTypes) != 1 || signer.inlineTypes[0] != "image/png" {
		t.Fatalf("file URL types %v, want [image/png]", signer.inlineTypes)
	}
}

// "image/png, text/html" starts with image/ but renders as HTML.
func TestCreateUploadURL_RejectsAContentTypeList(t *testing.T) {
	for _, ct := range []string{"image/png, text/html", "image/png,text/html", "image/", "IMAGE/SVG+XML"} {
		signer := &recordingUploadSigner{}
		rec := postUpload(t, &UploadHandler{s3: signer}, `{"filename":"e.png","contentType":"`+ct+`","size":128}`)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%q: status %d, want 400", ct, rec.Code)
		}
		if len(signer.sizedSizes) != 0 {
			t.Errorf("%q: a PUT URL was signed", ct)
		}
	}
}
