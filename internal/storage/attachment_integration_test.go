//go:build integration

package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// This suite exercises AttachmentService against the REAL MinIO object store
// spun up in TestMain (see s3_integration_test.go) instead of a mocked signer.
// The previous fakeSigner returned canned results, so attachment validation
// never actually downloaded + decoded the object — exactly how the "403 on
// editing a message that has an attachment" bug slipped past the unit tests.

// memAttachmentStore is a real (map-backed) implementation of
// service.AttachmentStore. It actually persists records; the thing made *real*
// in this test is the S3 layer, which is what the bug depended on.
type memAttachmentStore struct{ items map[string]*model.Attachment }

func newMemAttachmentStore() *memAttachmentStore {
	return &memAttachmentStore{items: map[string]*model.Attachment{}}
}
func (m *memAttachmentStore) Create(_ context.Context, a *model.Attachment) error {
	m.items[a.ID] = a
	return nil
}
func (m *memAttachmentStore) GetByID(_ context.Context, id string) (*model.Attachment, error) {
	if a, ok := m.items[id]; ok {
		return a, nil
	}
	return nil, errors.New("attachment not found")
}
func (m *memAttachmentStore) GetByHash(context.Context, string) (*model.Attachment, error) {
	return nil, errors.New("not found")
}
func (m *memAttachmentStore) AddRef(context.Context, string, string) error { return nil }
func (m *memAttachmentStore) RemoveRef(context.Context, string, string) (*model.Attachment, error) {
	return nil, nil
}
func (m *memAttachmentStore) Delete(context.Context, string) error                  { return nil }
func (m *memAttachmentStore) SetDimensions(context.Context, string, int, int) error { return nil }
func (m *memAttachmentStore) SetMultipartUploadID(_ context.Context, id, uploadID string) error {
	if a, ok := m.items[id]; ok {
		a.MultipartUploadID = uploadID
	}
	return nil
}
func (m *memAttachmentStore) SetVerifiedETag(_ context.Context, id, etag string) error {
	if a, ok := m.items[id]; ok {
		a.VerifiedETag = etag
	}
	return nil
}
func (m *memAttachmentStore) SetThumbnailKeys(_ context.Context, id, thumb, square string) error {
	if a, ok := m.items[id]; ok {
		a.ThumbnailS3Key = thumb
		a.SquareThumbnailS3Key = square
	}
	return nil
}

func makePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for x := 0; x < w; x++ {
		for y := 0; y < h; y++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 20), G: uint8(y * 20), B: 120, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func TestAttachmentService_ValidateForUse_RealImageRoundTrip(t *testing.T) {
	s3 := newMinioS3(t, "attachments")
	ctx := context.Background()
	store := newMemAttachmentStore()
	svc := service.NewAttachmentService(store, s3, nil)

	data := makePNG(t, 8, 6)
	sum := sha256.Sum256(data)
	a := &model.Attachment{
		ID: "att-real-1", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(data)),
		ContentType: "image/png", Filename: "pic.png", S3Key: "attachments/att-real-1",
		Width: 8, Height: 6, CreatedBy: "u1", CreatedAt: time.Now(),
	}
	if err := store.Create(ctx, a); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s3.PutObject(ctx, a.S3Key, "image/png", data); err != nil {
		t.Fatalf("PutObject: %v", err)
	}

	// Real validation: downloads from MinIO, verifies sha/size, decodes the PNG,
	// and writes real WebP thumbnails back to MinIO.
	if err := svc.ValidateForUse(ctx, a.ID); err != nil {
		t.Fatalf("ValidateForUse on a genuine image must pass: %v", err)
	}
	if a.ThumbnailS3Key == "" || a.SquareThumbnailS3Key == "" {
		t.Errorf("thumbnails should have been generated, got %q / %q", a.ThumbnailS3Key, a.SquareThumbnailS3Key)
	}
	if _, _, _, _, err := s3.GetObject(ctx, a.ThumbnailS3Key); err != nil {
		t.Errorf("generated thumbnail not present in object store: %v", err)
	}
}

func TestAttachmentService_ValidateForUse_RejectsTamperedObject(t *testing.T) {
	s3 := newMinioS3(t, "attachments-bad")
	ctx := context.Background()
	store := newMemAttachmentStore()
	svc := service.NewAttachmentService(store, s3, nil)

	data := makePNG(t, 8, 6)
	sum := sha256.Sum256(data)
	a := &model.Attachment{
		ID: "att-bad-1", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(data)),
		ContentType: "image/png", Filename: "pic.png", S3Key: "attachments/att-bad-1",
		Width: 8, Height: 6, CreatedBy: "u1", CreatedAt: time.Now(),
	}
	_ = store.Create(ctx, a)
	// Upload bytes that don't match the record's sha256/size.
	tampered := append(append([]byte(nil), data...), []byte("tampered")...)
	if err := s3.PutObject(ctx, a.S3Key, "image/png", tampered); err != nil {
		t.Fatalf("PutObject: %v", err)
	}
	if err := svc.ValidateForUse(ctx, a.ID); err == nil {
		t.Fatal("ValidateForUse must reject an object whose bytes don't match the record")
	}
}

// countingS3 is the real MinIO client, counting full-object reads so a test
// can prove which verifications never download the file.
type countingS3 struct {
	*S3Client
	opens int
}

func (c *countingS3) OpenObject(ctx context.Context, key string) (io.ReadCloser, string, int64, string, error) {
	c.opens++
	return c.S3Client.OpenObject(ctx, key)
}

func signedBy(t *testing.T, svc *service.AttachmentService, a *model.Attachment) func(method string, query url.Values, headers map[string]string) (string, map[string]string) {
	return func(method string, query url.Values, _ map[string]string) (string, map[string]string) {
		t.Helper()
		part := 0
		if n := query.Get("partNumber"); n != "" {
			_, _ = fmt.Sscan(n, &part)
		}
		signed, err := svc.SignUploadRequest(context.Background(), a.CreatedBy, a.ID, service.UploadRequest{
			Method: method, Key: a.S3Key, UploadID: query.Get("uploadId"), PartNumber: part,
		})
		if err != nil {
			t.Fatalf("SignUploadRequest %s: %v", method, err)
		}
		return signed.URL, signed.Headers
	}
}

// End to end against real S3: a file uploaded in one browser PUT is verified
// by S3's own SHA-256 check — the server never downloads it, not on process
// and not on send.
func TestAttachmentUpload_SinglePutIsVerifiedWithoutReading(t *testing.T) {
	s3 := &countingS3{S3Client: newMinioS3(t, "upload-single")}
	ctx := context.Background()
	store := newMemAttachmentStore()
	svc := service.NewAttachmentService(store, s3, nil)
	payload := []byte("meeting notes, verified by S3 on arrival")
	sum := sha256.Sum256(payload)
	a := &model.Attachment{
		ID: "att-single", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(payload)),
		ContentType: "text/plain", Filename: "notes.txt", S3Key: "attachments/att-single",
		CreatedBy: "u1", CreatedAt: time.Now(),
	}
	_ = store.Create(ctx, a)

	putURL, headers := signedBy(t, svc, a)(http.MethodPut, url.Values{}, nil)
	if resp, body := s3Do(t, http.MethodPut, putURL, headers, payload); resp.StatusCode != http.StatusOK {
		t.Fatalf("browser PUT: %d %s", resp.StatusCode, body)
	}
	if _, err := svc.ProcessUpload(ctx, "u1", a.ID); err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if err := svc.ValidateForUse(ctx, a.ID); err != nil {
		t.Fatalf("ValidateForUse: %v", err)
	}
	if s3.opens != 0 || a.VerifiedETag == "" {
		t.Fatalf("expected verification without any download, got %d reads (etag %q)", s3.opens, a.VerifiedETag)
	}
	// The object is final now: no further upload requests are signed.
	if _, err := svc.SignUploadRequest(ctx, "u1", a.ID, service.UploadRequest{Method: http.MethodPut, Key: a.S3Key}); !errors.Is(err, service.ErrAttachmentUploaded) {
		t.Fatalf("expected ErrAttachmentUploaded, got %v", err)
	}
}

// End to end against real S3: a multipart upload has no whole-file SHA-256 on
// record, so processing streams it once; the send afterwards is a HEAD.
func TestAttachmentUpload_MultipartIsStreamedOnce(t *testing.T) {
	s3 := &countingS3{S3Client: newMinioS3(t, "upload-multipart")}
	ctx := context.Background()
	store := newMemAttachmentStore()
	svc := service.NewAttachmentService(store, s3, nil)
	first := bytes.Repeat([]byte("z"), 5<<20)
	last := []byte("end")
	whole := append(append([]byte(nil), first...), last...)
	sum := sha256.Sum256(whole)
	a := &model.Attachment{
		ID: "att-multi", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(whole)),
		ContentType: "application/zip", Filename: "big.zip", S3Key: "attachments/att-multi",
		CreatedBy: "u1", CreatedAt: time.Now(),
	}
	_ = store.Create(ctx, a)

	uploadID := browserMultipartUpload(t, signedBy(t, svc, a), [][]byte{first, last}, "application/zip")
	if a.MultipartUploadID != uploadID {
		t.Fatalf("multipart upload not tracked for resume: %q vs %q", a.MultipartUploadID, uploadID)
	}
	if _, err := svc.ProcessUpload(ctx, "u1", a.ID); err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if err := svc.ValidateForUse(ctx, a.ID); err != nil {
		t.Fatalf("ValidateForUse: %v", err)
	}
	if s3.opens != 1 || a.VerifiedETag == "" {
		t.Fatalf("expected exactly one streamed read, got %d (etag %q)", s3.opens, a.VerifiedETag)
	}
}

// createMultipart opens a multipart upload through requests the service
// signed, stages one part, and returns the complete request (signed while the
// attachment was still unverified) with its body.
func createMultipart(t *testing.T, sign func(string, url.Values, map[string]string) (string, map[string]string), part []byte) (completeURL string, completeHeaders map[string]string, body []byte, uploadID string) {
	t.Helper()
	createURL, h := sign(http.MethodPost, url.Values{"uploads": {""}}, nil)
	resp, created := s3Do(t, http.MethodPost, createURL, h, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create: %d %s", resp.StatusCode, created)
	}
	var up struct {
		UploadID string `xml:"UploadId"`
	}
	if err := xml.Unmarshal(created, &up); err != nil || up.UploadID == "" {
		t.Fatalf("create response %s: %v", created, err)
	}
	partURL, ph := sign(http.MethodPut, url.Values{"partNumber": {"1"}, "uploadId": {up.UploadID}}, nil)
	resp, out := s3Do(t, http.MethodPut, partURL, ph, part)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("part: %d %s", resp.StatusCode, out)
	}
	completeURL, completeHeaders = sign(http.MethodPost, url.Values{"uploadId": {up.UploadID}}, nil)
	body = fmt.Appendf(nil, "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>%s</ETag></Part></CompleteMultipartUpload>", resp.Header.Get("ETag"))
	return completeURL, completeHeaders, body, up.UploadID
}

func objectBytes(t *testing.T, s3 *S3Client, key string) string {
	t.Helper()
	body, _, _, _, err := s3.GetObject(context.Background(), key)
	if err != nil {
		t.Fatalf("GetObject: %v", err)
	}
	defer func() { _ = body.Close() }()
	data, _ := io.ReadAll(body)
	return string(data)
}

// End to end against real S3: an uploader stages a multipart upload and gets
// its complete request signed, then uploads a benign file in one PUT and has
// it verified. The complete signed earlier must not be able to replace the
// verified bytes — the media route serves whatever the key holds.
func TestAttachmentUpload_PresignedCompleteCannotReplaceAVerifiedObject(t *testing.T) {
	for _, tc := range []struct {
		name string
		// forget signs (but never sends) an abort, so the server stops
		// tracking the staged upload and cannot abort it on verification.
		forget bool
	}{
		{name: "tracked upload"},
		{name: "upload the server no longer tracks", forget: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s3 := newMinioS3(t, "upload-replace")
			ctx := context.Background()
			store := newMemAttachmentStore()
			svc := service.NewAttachmentService(store, s3, nil)
			benign := []byte("benign notes that the server verified")
			sum := sha256.Sum256(benign)
			id := "att-replace"
			if tc.forget {
				id += "-forget"
			}
			a := &model.Attachment{
				ID: id, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(benign)),
				ContentType: "text/plain", Filename: "notes.txt", S3Key: "attachments/" + id,
				CreatedBy: "u1", CreatedAt: time.Now(),
			}
			_ = store.Create(ctx, a)
			sign := signedBy(t, svc, a)

			completeURL, completeHeaders, completeBody, uploadID := createMultipart(t, sign, []byte("<html><script>evil()</script></html>"))
			if tc.forget {
				_, _ = sign(http.MethodDelete, url.Values{"uploadId": {uploadID}}, nil)
			}
			putURL, headers := sign(http.MethodPut, url.Values{}, nil)
			if resp, body := s3Do(t, http.MethodPut, putURL, headers, benign); resp.StatusCode != http.StatusOK {
				t.Fatalf("benign PUT: %d %s", resp.StatusCode, body)
			}
			if _, err := svc.ProcessUpload(ctx, "u1", a.ID); err != nil {
				t.Fatalf("ProcessUpload: %v", err)
			}

			if resp, body := s3Do(t, http.MethodPost, completeURL, completeHeaders, completeBody); resp.StatusCode == http.StatusOK {
				t.Fatalf("the earlier-signed complete replaced the verified object: %s", body)
			}
			if got := objectBytes(t, s3, a.S3Key); got != string(benign) {
				t.Fatalf("object = %q, want the verified bytes", got)
			}
		})
	}
}

// A single PUT signed for an attachment is write-once too: replaying it after
// the first write landed is refused.
func TestAttachmentUpload_SinglePutIsWriteOnce(t *testing.T) {
	s3 := newMinioS3(t, "upload-write-once")
	ctx := context.Background()
	store := newMemAttachmentStore()
	svc := service.NewAttachmentService(store, s3, nil)
	payload := []byte("first and only")
	sum := sha256.Sum256(payload)
	a := &model.Attachment{
		ID: "att-once", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(payload)),
		ContentType: "text/plain", Filename: "once.txt", S3Key: "attachments/att-once",
		CreatedBy: "u1", CreatedAt: time.Now(),
	}
	_ = store.Create(ctx, a)
	putURL, headers := signedBy(t, svc, a)(http.MethodPut, url.Values{}, nil)
	if resp, body := s3Do(t, http.MethodPut, putURL, headers, payload); resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT: %d %s", resp.StatusCode, body)
	}
	if resp, body := s3Do(t, http.MethodPut, putURL, headers, payload); resp.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("replayed PUT: %d %s, want 412", resp.StatusCode, body)
	}
}
