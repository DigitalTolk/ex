package service

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"testing"
	"time"

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
	// signer has no object for the key → validateUploadedObject errors.
	svc := NewAttachmentService(storeM, &fakeAttachmentSigner{objects: map[string][]byte{}}, nil)
	if _, err := svc.ProcessUpload(context.Background(), "u1", "a"); err == nil {
		t.Fatal("expected validate-object error")
	}
}

func TestAttachment_ValidateUploadedObject_SizeMismatch(t *testing.T) {
	storeM := newMockAttachmentStore()
	object := makePNG(2, 2)
	a := &model.Attachment{
		ID: "a", CreatedBy: "u1", S3Key: "attachments/a", ContentType: "image/png",
		Size: int64(len(object)) + 5, SHA256: sha256Hex(object), // declared size > actual
	}
	storeM.byID[a.ID] = a
	// GetObject reports objectSize == len(object) which already != a.Size and
	// is caught earlier; force the read-path mismatch by making GetObject
	// report size 0 (unknown) so the len(data) check at the end fires.
	signer := &sizeZeroSigner{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: object}}}
	svc := NewAttachmentService(storeM, signer, nil)
	if _, err := svc.ProcessUpload(context.Background(), "u1", "a"); err == nil {
		t.Fatal("expected size mismatch error")
	}
}

// sizeZeroSigner reports an unknown (0) object size so the size guard before
// ReadAll is skipped and the post-read length comparison runs.
type sizeZeroSigner struct {
	*fakeAttachmentSigner
}

func (s *sizeZeroSigner) GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error) {
	body, ct, _, mod, err := s.fakeAttachmentSigner.GetObject(ctx, key)
	return body, ct, 0, mod, err
}

// errBodyOnReadSigner returns a body that fails on Read so validateUploadedObject
// exercises its io.ReadAll error branch.
type errBodyOnReadSigner struct {
	*fakeAttachmentSigner
	size int64
}

func (s *errBodyOnReadSigner) GetObject(_ context.Context, _ string) (io.ReadCloser, string, int64, time.Time, error) {
	return errBody{}, "image/png", s.size, time.Time{}, nil
}

func TestAttachment_ValidateUploadedObject_ReadError(t *testing.T) {
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "a", CreatedBy: "u1", S3Key: "attachments/a", ContentType: "image/png",
		Size: 10, SHA256: sha256Hex([]byte("x")),
	}
	storeM.byID[a.ID] = a
	// objectSize 0 (unknown) so the early size guard is skipped and ReadAll runs.
	signer := &errBodyOnReadSigner{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: {}}}, size: 0}
	svc := NewAttachmentService(storeM, signer, nil)
	if _, err := svc.ProcessUpload(context.Background(), "u1", "a"); err == nil {
		t.Fatal("expected read-object error")
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

func TestAttachment_GenerateThumbnails_SkipsWhenAlreadyPresent(t *testing.T) {
	object := makePNG(4, 4)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(object))
	if err != nil {
		t.Fatalf("DecodeConfig: %v", err)
	}
	svc := NewAttachmentService(newMockAttachmentStore(), &fakeAttachmentSigner{putErr: errors.New("should not be called")}, nil)
	a := &model.Attachment{
		ID: "a", ContentType: "image/png",
		ThumbnailS3Key: "t", SquareThumbnailS3Key: "sq",
	}
	// force=false and both keys present → early skip (PutObject never called).
	if err := svc.generateThumbnails(context.Background(), a, object, cfg, false); err != nil {
		t.Fatalf("expected skip, got %v", err)
	}
}

func TestAttachment_GenerateThumbnails_SquarePutError(t *testing.T) {
	object := makePNG(8, 8)
	cfg, _, err := image.DecodeConfig(bytes.NewReader(object))
	if err != nil {
		t.Fatalf("DecodeConfig: %v", err)
	}
	storeM := newMockAttachmentStore()
	a := &model.Attachment{ID: "a", ContentType: "image/png", S3Key: "attachments/a"}
	storeM.byID[a.ID] = a
	signer := &nthPutErrSigner{
		fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{}, putContentTypes: map[string]string{}},
		failOn:               2, // message thumb put succeeds, square thumb put fails
	}
	svc := NewAttachmentService(storeM, signer, nil)
	if err := svc.generateThumbnails(context.Background(), a, object, cfg, true); err == nil {
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
