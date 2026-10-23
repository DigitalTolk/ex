package service

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/storage"
)

// PresignedInlineURL mirrors storage.S3Client: the URL records the response
// type S3 will answer with and whether it forces a download.
func (s *fakeAttachmentSigner) PresignedInlineURL(_ context.Context, key, contentType, _ string, _ time.Duration) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.presignCalls++
	served, inline := storage.ServedContentType(contentType)
	return fmt.Sprintf("https://signed.test/%s?sig=%d&type=%s&inline=%t", key, s.presignCalls, url.QueryEscape(served), inline), nil
}

// A browser reads a Content-Type as a comma list and renders the last type it
// knows, so a declared "image/png, text/html" must never be stored.
func TestAttachmentService_CreateUploadURL_NormalizesTheDeclaredType(t *testing.T) {
	svc := NewAttachmentService(newMockAttachmentStore(), &fakeAttachmentSigner{}, newMockPublisher())
	for _, bad := range []string{"image/png, text/html", "image/png,text/html", "not a type"} {
		_, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{
			UserID: "u1", Filename: "pic.png", ContentType: bad, SHA256: testSHA256A, Size: 10,
		})
		if err == nil {
			t.Errorf("content type %q was accepted", bad)
		}
	}
	res, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{
		UserID: "u1", Filename: "pic.png", ContentType: "Image/PNG", SHA256: testSHA256A, Size: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Attachment.ContentType != "image/png" {
		t.Fatalf("stored content type %q, want image/png", res.Attachment.ContentType)
	}
}

// Without the media route, the browser fetches the object straight from S3,
// which answers with the stored type. The signed URL must pin a safe response
// type and force a download for anything scriptable.
func TestAttachmentService_PresignedFallbackPinsTheResponseType(t *testing.T) {
	storeM := newMockAttachmentStore()
	att := &model.Attachment{
		ID: "a-html", SHA256: "h", S3Key: "attachments/a-html", Filename: "page.html",
		ContentType: "text/html", Size: 10, CreatedBy: "u1",
	}
	if err := storeM.Create(context.Background(), att); err != nil {
		t.Fatal(err)
	}
	svc := NewAttachmentService(storeM, &fakeAttachmentSigner{}, newMockPublisher())
	got, err := svc.Get(context.Background(), att.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.URL, "type=text%2Fhtml") || !strings.Contains(got.URL, "inline=false") {
		t.Fatalf("fallback URL %q does not pin the response type and disposition", got.URL)
	}
}
