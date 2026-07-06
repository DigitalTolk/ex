package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/png"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

func TestValidateAttachmentContentType_Branches(t *testing.T) {
	// object content type contradicts declared → error
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "image/png"}, "image/jpeg", nil); err == nil {
		t.Error("expected content-type mismatch error")
	}
	// non-image declared → accepted as-is (no decode)
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "text/plain"}, "text/plain", []byte("hello")); err != nil {
		t.Errorf("non-image should be accepted, got %v", err)
	}
	// image declared but bytes aren't a valid image → error
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "image/png"}, "image/png", []byte("not an image")); err == nil {
		t.Error("expected invalid-image error")
	}
}

func newAttachmentSvc(signer AttachmentSigner) (*AttachmentService, *mockAttachmentStore) {
	store := newMockAttachmentStore()
	return NewAttachmentService(store, signer, newMockPublisher()), store
}

func TestValidateForUse_EarlyErrors(t *testing.T) {
	signer := &fakeAttachmentSigner{}
	ctx := context.Background()

	svc, _ := newAttachmentSvc(signer)
	if err := svc.ValidateForUse(ctx, ""); err == nil {
		t.Error("empty id should error")
	}

	svc, _ = newAttachmentSvc(signer)
	if err := svc.ValidateForUse(ctx, "missing"); err == nil {
		t.Error("missing attachment should error")
	}

	svc, store := newAttachmentSvc(signer)
	store.byID["a1"] = &model.Attachment{ID: "a1", S3Key: "", Size: 10}
	if err := svc.ValidateForUse(ctx, "a1"); err == nil {
		t.Error("empty S3Key should error")
	}

	svc, store = newAttachmentSvc(signer)
	store.byID["a2"] = &model.Attachment{ID: "a2", S3Key: "k", Size: 0}
	if err := svc.ValidateForUse(ctx, "a2"); err == nil {
		t.Error("non-positive size should error")
	}

	svc, store = newAttachmentSvc(nil) // nil signer
	store.byID["a3"] = &model.Attachment{ID: "a3", S3Key: "k", Size: 10}
	if err := svc.ValidateForUse(ctx, "a3"); err == nil {
		t.Error("nil signer should error")
	}
}

func TestValidateUploadedObject_Branches(t *testing.T) {
	ctx := context.Background()
	mk := func(sig *fakeAttachmentSigner) *AttachmentService {
		return NewAttachmentService(newMockAttachmentStore(), sig, newMockPublisher())
	}

	// nil attachment
	if _, _, err := mk(&fakeAttachmentSigner{objects: map[string][]byte{}}).validateUploadedObject(ctx, nil); err == nil {
		t.Error("nil attachment should error")
	}
	// empty S3Key
	if _, _, err := mk(&fakeAttachmentSigner{objects: map[string][]byte{}}).validateUploadedObject(ctx, &model.Attachment{Size: 4}); err == nil {
		t.Error("empty S3Key should error")
	}
	// non-positive size
	if _, _, err := mk(&fakeAttachmentSigner{objects: map[string][]byte{}}).validateUploadedObject(ctx, &model.Attachment{S3Key: "k", Size: 0}); err == nil {
		t.Error("non-positive size should error")
	}
	// object missing (GetObject error)
	if _, _, err := mk(&fakeAttachmentSigner{objects: map[string][]byte{}}).validateUploadedObject(ctx, &model.Attachment{S3Key: "missing", Size: 4}); err == nil {
		t.Error("missing object should error")
	}
	// object size mismatch: stored body length != declared size
	data := []byte("abcd")
	if _, _, err := mk(&fakeAttachmentSigner{objects: map[string][]byte{"k": data}}).validateUploadedObject(ctx, &model.Attachment{S3Key: "k", Size: 99}); err == nil {
		t.Error("size mismatch should error")
	}
	// sha256 mismatch: size matches, declared hash is wrong
	if _, _, err := mk(&fakeAttachmentSigner{objects: map[string][]byte{"k": data}}).validateUploadedObject(ctx, &model.Attachment{S3Key: "k", Size: int64(len(data)), SHA256: "deadbeef", ContentType: "image/png"}); err == nil {
		t.Error("sha256 mismatch should error")
	}
}

func TestCanAccessAttachment_Branches(t *testing.T) {
	ctx := context.Background()
	svc := NewAttachmentService(newMockAttachmentStore(), &fakeAttachmentSigner{}, newMockPublisher())

	assertAccess := func(t *testing.T, wantAllowed bool, wantErr bool, allowed bool, err error, label string) {
		t.Helper()
		if allowed != wantAllowed {
			t.Errorf("%s: allowed = %v, want %v", label, allowed, wantAllowed)
		}
		if (err != nil) != wantErr {
			t.Errorf("%s: err = %v, want err=%v", label, err, wantErr)
		}
	}

	// Empty user / nil attachment → definitive no access.
	allowed, err := svc.canAccessAttachment(ctx, "", &model.Attachment{}, "p", "channel", "m")
	assertAccess(t, false, false, allowed, err, "empty userID")
	allowed, err = svc.canAccessAttachment(ctx, "u1", nil, "p", "channel", "m")
	assertAccess(t, false, false, allowed, err, "nil attachment")

	// Owner of an unbound (no message refs) attachment → allowed.
	allowed, err = svc.canAccessAttachment(ctx, "u1", &model.Attachment{ID: "a", CreatedBy: "u1"}, "", "", "")
	assertAccess(t, true, false, allowed, err, "unbound owner")

	bound := &model.Attachment{ID: "a", CreatedBy: "u1", MessageIDs: []string{"m1"}}
	// Bound attachment but missing parent context and no access checker → deny.
	allowed, err = svc.canAccessAttachment(ctx, "u2", bound, "", "", "")
	assertAccess(t, false, false, allowed, err, "missing parent context")
	allowed, err = svc.canAccessAttachment(ctx, "u2", bound, "p", "channel", "m1")
	assertAccess(t, false, false, allowed, err, "nil access checker")

	// Access checker grants.
	svc.SetAccessChecker(fakeAttachmentAccessChecker{})
	allowed, err = svc.canAccessAttachment(ctx, "u2", bound, "p", "channel", "m1")
	assertAccess(t, true, false, allowed, err, "checker grants")

	// Definitive denial (ErrForbidden / ErrNotFound) → false with NO error.
	svc.SetAccessChecker(fakeAttachmentAccessChecker{err: fmt.Errorf("not a member: %w", ErrForbidden)})
	allowed, err = svc.canAccessAttachment(ctx, "u2", bound, "p", "channel", "m1")
	assertAccess(t, false, false, allowed, err, "forbidden denial")
	svc.SetAccessChecker(fakeAttachmentAccessChecker{err: fmt.Errorf("message gone: %w", store.ErrNotFound)})
	allowed, err = svc.canAccessAttachment(ctx, "u2", bound, "p", "channel", "m1")
	assertAccess(t, false, false, allowed, err, "not-found denial")

	// Transient failure (the check could not run) → error, NOT a silent deny.
	// Regression: this used to read as "no access", which silently dropped
	// attachments from batch responses until a hard refresh.
	svc.SetAccessChecker(fakeAttachmentAccessChecker{err: errors.New("dynamo timeout")})
	allowed, err = svc.canAccessAttachment(ctx, "u2", bound, "p", "channel", "m1")
	assertAccess(t, false, true, allowed, err, "transient failure")
}

func encodePNGBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func TestValidateAttachmentContentType_DimensionAndFormatMismatch(t *testing.T) {
	data := encodePNGBytes(t, 4, 6)

	// Declared width disagrees with the decoded image.
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "image/png", Width: 99}, "image/png", data); err == nil {
		t.Error("expected width mismatch error")
	}
	// Declared height disagrees.
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "image/png", Height: 99}, "image/png", data); err == nil {
		t.Error("expected height mismatch error")
	}
	// Declared format (jpeg) disagrees with the actual PNG payload.
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "image/jpeg"}, "", data); err == nil {
		t.Error("expected format mismatch error")
	}
	// Matching dimensions and format → accepted.
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "image/png", Width: 4, Height: 6}, "image/png", data); err != nil {
		t.Errorf("matching image should validate, got %v", err)
	}

	// Declared image but the bytes sniff as application/octet-stream.
	binary := []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05}
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "image/png"}, "image/png", binary); err == nil {
		t.Error("expected undetectable-content-type error")
	}

	// Valid SVG declared as svg → accepted via validateSVG.
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`)
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "image/svg+xml"}, "image/svg+xml", svg); err != nil {
		t.Errorf("valid svg should validate, got %v", err)
	}
	// Unsafe SVG (script element) → rejected.
	badSVG := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)
	if _, err := validateAttachmentContentType(&model.Attachment{ContentType: "image/svg+xml"}, "image/svg+xml", badSVG); err == nil {
		t.Error("expected unsafe svg rejection")
	}
}

func TestEnsureThumbnailsForRead_Branches(t *testing.T) {
	ctx := context.Background()
	object := makePNG(40, 20)

	// Happy path: a legacy image with no dimensions/thumbnails gets both
	// backfilled on read.
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}, putContentTypes: map[string]string{}}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	a := &model.Attachment{ID: "a1", S3Key: "attachments/a1", SHA256: sha256Hex(object), Size: int64(len(object)), ContentType: "image/png"}
	signer.objects[a.S3Key] = object
	storeM.byID[a.ID] = a
	svc.ensureThumbnailsForRead(ctx, a)
	if a.Width != 40 || a.Height != 20 {
		t.Fatalf("dimensions not backfilled: %dx%d", a.Width, a.Height)
	}
	if a.ThumbnailS3Key == "" || a.SquareThumbnailS3Key == "" {
		t.Fatal("thumbnails not generated on read")
	}

	// Guard: nil signer → no-op.
	NewAttachmentService(newMockAttachmentStore(), nil, newMockPublisher()).
		ensureThumbnailsForRead(ctx, &model.Attachment{ID: "x", S3Key: "k", Size: 1, SHA256: "h", ContentType: "image/png"})

	// Guard: incomplete metadata (no SHA256) → no-op.
	svc.ensureThumbnailsForRead(ctx, &model.Attachment{ID: "y", S3Key: "k", Size: 1, ContentType: "image/png"})

	// Guard: non-image content type → no-op.
	svc.ensureThumbnailsForRead(ctx, &model.Attachment{ID: "z", S3Key: "k", Size: 1, SHA256: "h", ContentType: "application/pdf"})

	// Guard: already has both thumbnail keys → no-op.
	svc.ensureThumbnailsForRead(ctx, &model.Attachment{
		ID: "w", S3Key: "k", Size: 1, SHA256: "h", ContentType: "image/png",
		ThumbnailS3Key: "t", SquareThumbnailS3Key: "s",
	})
}
