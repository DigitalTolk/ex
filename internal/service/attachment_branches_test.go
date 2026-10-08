package service

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func makeJPEG(w, h int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	return buf.Bytes()
}

// nthPutErrSigner fails the Nth PutObject (1-based), succeeding otherwise.
type nthPutErrSigner struct {
	*fakeAttachmentSigner
	failOn int
	calls  int
}

func (s *nthPutErrSigner) PutObject(ctx context.Context, key, contentType string, body []byte) error {
	s.calls++
	if s.calls == s.failOn {
		return errors.New("put failed")
	}
	return s.fakeAttachmentSigner.PutObject(ctx, key, contentType, body)
}

func TestAttachment_ScheduleDimensionsBackfill_EmptyArgs(t *testing.T) {
	svc := NewAttachmentService(newMockAttachmentStore(), &fakeAttachmentSigner{}, nil)
	// Empty id or key → no-op (no goroutine spawned).
	svc.scheduleDimensionsBackfill("", "key")
	svc.scheduleDimensionsBackfill("id", "")
}

func TestAttachment_GetManyForUser_EmptyAndSkip(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := makePNG(2, 2)
	a := &model.Attachment{
		ID: "a1", CreatedBy: "u1", S3Key: "attachments/a1", ContentType: "image/png",
		Size: int64(len(object)), SHA256: sha256Hex(object),
	}
	storeM.byID[a.ID] = a
	svc := NewAttachmentService(storeM, &fakeAttachmentSigner{}, nil)
	svc.SetAccessChecker(fakeAttachmentAccessChecker{})

	// Empty list → nil.
	if out, err := svc.GetManyForUser(context.Background(), "u1", nil, "p", "c", "m"); err != nil || out != nil {
		t.Fatalf("empty list got out=%v err=%v", out, err)
	}
	// Empty-id entries are skipped; only a1 resolves.
	out, err := svc.GetManyForUser(context.Background(), "u1", []string{"", "a1"}, "p", "channel", "m")
	if err != nil {
		t.Fatalf("GetManyForUser: %v", err)
	}
	if len(out) != 1 || out[0].ID != "a1" {
		t.Fatalf("expected [a1], got %v", out)
	}
}

func TestAttachment_ProcessUpload_GetByIDNotFound(t *testing.T) {
	svc := NewAttachmentService(newMockAttachmentStore(), &fakeAttachmentSigner{}, nil)
	if _, err := svc.ProcessUpload(context.Background(), "u1", "nope"); err == nil {
		t.Fatal("expected get-for-processing error")
	}
}

func TestAttachment_ProcessUpload_ValidateObjectMissing(t *testing.T) {
	storeM := newMockAttachmentStore()
	storeM.byID["a"] = &model.Attachment{ID: "a", CreatedBy: "u1", S3Key: "attachments/a", Size: 1}
	// signer has no object for the key → verifyObject errors.
	svc := NewAttachmentService(storeM, &fakeAttachmentSigner{objects: map[string][]byte{}}, nil)
	if _, err := svc.ProcessUpload(context.Background(), "u1", "a"); err == nil {
		t.Fatal("expected validate-object error")
	}
}

func TestAttachment_VerifyObject_StreamedSizeMismatch(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := makePNG(2, 2)
	a := &model.Attachment{
		ID: "a", CreatedBy: "u1", S3Key: "attachments/a", ContentType: "image/png",
		Size: int64(len(object)) + 5, SHA256: sha256Hex(object), // declared size > actual
	}
	storeM.byID[a.ID] = a
	// GetObject reports objectSize == len(object) which already != a.Size and
	// is caught earlier; force the stream-path mismatch by making GetObject
	// report size 0 (unknown) so the streamed byte count check fires.
	signer := &sizeZeroSigner{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: object}}, declared: a.Size}
	svc := NewAttachmentService(storeM, signer, nil)
	if _, err := svc.ProcessUpload(context.Background(), "u1", "a"); err == nil || !strings.Contains(err.Error(), "size mismatch") {
		t.Fatalf("expected size mismatch error, got %v", err)
	}
}

// sizeZeroSigner passes the HEAD (it reports the declared size) but streams
// with an unknown (0) size, so the streamed byte count comparison runs.
type sizeZeroSigner struct {
	*fakeAttachmentSigner
	declared int64
}

func (s *sizeZeroSigner) StatObject(context.Context, string) (int64, string, string, string, error) {
	return s.declared, "image/png", `"e"`, "", nil
}

func (s *sizeZeroSigner) OpenObject(ctx context.Context, key string) (io.ReadCloser, string, int64, string, error) {
	body, ct, _, etag, err := s.fakeAttachmentSigner.OpenObject(ctx, key)
	return body, ct, 0, etag, err
}

// changedSigner passes the HEAD but the GET reports a different size, as if
// the object were replaced between the two.
type changedSigner struct{ sizeZeroSigner }

func (s *changedSigner) OpenObject(ctx context.Context, key string) (io.ReadCloser, string, int64, string, error) {
	body, ct, _, etag, err := s.fakeAttachmentSigner.OpenObject(ctx, key)
	return body, ct, s.declared + 1, etag, err
}

func TestAttachment_VerifyObject_ObjectChangedBetweenHeadAndGet(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := makePNG(2, 2)
	a := &model.Attachment{
		ID: "a", CreatedBy: "u1", S3Key: "attachments/a", ContentType: "image/png",
		Size: int64(len(object)), SHA256: sha256Hex(object),
	}
	storeM.byID[a.ID] = a
	signer := &changedSigner{sizeZeroSigner{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: object}}, declared: a.Size}}
	svc := NewAttachmentService(storeM, signer, nil)
	if _, err := svc.ProcessUpload(context.Background(), "u1", "a"); err == nil || !strings.Contains(err.Error(), "size mismatch") {
		t.Fatalf("expected size mismatch, got %v", err)
	}
}

// errBodyOnReadSigner passes the HEAD but returns a body that fails on Read,
// so verifyObject exercises its transport-error branch.
type errBodyOnReadSigner struct {
	*fakeAttachmentSigner
	size int64
}

func (s *errBodyOnReadSigner) StatObject(context.Context, string) (int64, string, string, string, error) {
	return s.size, "image/png", `"e"`, "", nil
}

func (s *errBodyOnReadSigner) OpenObject(context.Context, string) (io.ReadCloser, string, int64, string, error) {
	return errBody{}, "image/png", 0, `"e"`, nil
}

func TestAttachment_VerifyObject_ReadError(t *testing.T) {
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "a", CreatedBy: "u1", S3Key: "attachments/a", ContentType: "image/png",
		Size: 10, SHA256: sha256Hex([]byte("x")),
	}
	storeM.byID[a.ID] = a
	// The HEAD reports the declared size; the GET's body then fails mid-stream.
	signer := &errBodyOnReadSigner{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: {}}}, size: a.Size}
	svc := NewAttachmentService(storeM, signer, nil)
	if _, err := svc.ProcessUpload(context.Background(), "u1", "a"); err == nil || !strings.Contains(err.Error(), "read object") {
		t.Fatalf("expected read-object error, got %v", err)
	}
}

func TestAttachment_ValidateContentType_JPGNormalizesToJPEG(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := makeJPEG(4, 4)
	a := &model.Attachment{
		ID: "j", CreatedBy: "u1", S3Key: "attachments/j", Filename: "p.jpg",
		ContentType: "image/jpg", Size: int64(len(object)), SHA256: sha256Hex(object),
	}
	storeM.byID[a.ID] = a
	signer := &fakeAttachmentSigner{
		objects:           map[string][]byte{a.S3Key: object},
		objectContentType: "image/jpg",
		putContentTypes:   map[string]string{},
	}
	svc := NewAttachmentService(storeM, signer, nil)
	// jpg declared content type normalizes to jpeg and matches the decoded
	// format, so processing succeeds.
	if _, err := svc.ProcessUpload(context.Background(), "u1", "j"); err != nil {
		t.Fatalf("ProcessUpload jpg: %v", err)
	}
}

func TestAttachment_ValidateForUse_UnchangedVerifiedObjectIsNotReRead(t *testing.T) {
	object := makePNG(4, 4)
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "a", CreatedBy: "u1", S3Key: "attachments/a", ContentType: "image/png",
		Size: int64(len(object)), SHA256: sha256Hex(object), Width: 4, Height: 4,
		ThumbnailS3Key: "t", SquareThumbnailS3Key: "sq", VerifiedETag: fakeETag(object),
	}
	storeM.byID[a.ID] = a
	signer := &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: object}, putErr: errors.New("should not be called")}
	svc := NewAttachmentService(storeM, signer, nil)
	// Verified, unchanged since (same ETag), thumbnails present → one HEAD:
	// no body read, no decode, no thumbnail write.
	if err := svc.ValidateForUse(context.Background(), "a"); err != nil {
		t.Fatalf("expected skip, got %v", err)
	}
	if signer.stats != 1 || signer.opens != 0 {
		t.Fatalf("expected exactly one HEAD and no read, got stats=%d opens=%d", signer.stats, signer.opens)
	}
}

func TestAttachment_StoreThumbnails_SquarePutError(t *testing.T) {
	img, _, err := image.Decode(bytes.NewReader(makePNG(8, 8)))
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	storeM := newMockAttachmentStore()
	a := &model.Attachment{ID: "a", ContentType: "image/png", S3Key: "attachments/a"}
	storeM.byID[a.ID] = a
	signer := &nthPutErrSigner{
		fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{}, putContentTypes: map[string]string{}},
		failOn:               2, // message thumb put succeeds, square thumb put fails
	}
	svc := NewAttachmentService(storeM, signer, nil)
	if err := svc.storeThumbnails(context.Background(), a, img, func() {}); err == nil {
		t.Fatal("expected square thumbnail put error")
	}
}

func TestAttachment_ValidateForUse_ThumbnailError(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := makePNG(8, 6)
	a := &model.Attachment{
		ID: "a", CreatedBy: "u1", S3Key: "attachments/a", Filename: "p.png",
		ContentType: "image/png", Size: int64(len(object)), SHA256: sha256Hex(object),
		Width: 8, Height: 6,
	}
	storeM.byID[a.ID] = a
	signer := &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: object}, putErr: errors.New("put failed")}
	svc := NewAttachmentService(storeM, signer, nil)
	if err := svc.ValidateForUse(context.Background(), "a"); err == nil {
		t.Fatal("expected thumbnail generation error")
	}
}

func TestAttachment_RemoveRef_StoreError(t *testing.T) {
	storeM := &removeRefErrStore{mockAttachmentStore: newMockAttachmentStore()}
	svc := NewAttachmentService(storeM, &fakeAttachmentSigner{}, newMockPublisher())
	if err := svc.RemoveRef(context.Background(), "a", "m"); err == nil {
		t.Fatal("expected RemoveRef store error")
	}
}

type removeRefErrStore struct {
	*mockAttachmentStore
}

func (s *removeRefErrStore) RemoveRef(_ context.Context, _, _ string) (*model.Attachment, error) {
	return nil, errors.New("remove ref failed")
}

func TestAttachment_DeleteAttachmentObjects_Nil(t *testing.T) {
	svc := NewAttachmentService(newMockAttachmentStore(), &fakeAttachmentSigner{}, nil)
	// nil attachment → no-op, no panic.
	svc.deleteAttachmentObjects(context.Background(), nil)
}
