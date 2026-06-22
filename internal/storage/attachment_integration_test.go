//go:build integration

package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/png"
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
