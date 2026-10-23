package service

import (
	"context"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// gatedSigner holds every full object read until gate is closed, counting
// them, so a test can tell a read that waits for verification from one that
// does not.
type gatedSigner struct {
	*fakeAttachmentSigner
	gate  chan struct{}
	reads atomic.Int32
}

func (g *gatedSigner) OpenObject(ctx context.Context, key string) (io.ReadCloser, string, int64, string, error) {
	g.reads.Add(1)
	<-g.gate
	return g.fakeAttachmentSigner.OpenObject(ctx, key)
}

// syncAttachmentStore serializes the mock store and hands out copies, as a
// real store does: the background backfill writes rows while reads go on.
type syncAttachmentStore struct {
	mu sync.Mutex
	*mockAttachmentStore
}

func (s *syncAttachmentStore) GetByID(ctx context.Context, id string) (*model.Attachment, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, err := s.mockAttachmentStore.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	cp := *a
	return &cp, nil
}

func (s *syncAttachmentStore) SetDimensions(ctx context.Context, id string, w, h int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mockAttachmentStore.SetDimensions(ctx, id, w, h)
}

func (s *syncAttachmentStore) SetThumbnailKeys(ctx context.Context, id, thumb, square string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mockAttachmentStore.SetThumbnailKeys(ctx, id, thumb, square)
}

func (s *syncAttachmentStore) SetVerifiedETag(ctx context.Context, id, etag string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.mockAttachmentStore.SetVerifiedETag(ctx, id, etag)
}

func waitBackfill(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("thumbnail backfill never finished")
		return nil
	}
}

// Reading an attachment used to verify it inline: an image missing
// thumbnails (a legacy upload, or one whose bytes never verify) was
// downloaded and hashed in full on EVERY read of it, by every viewer. Reads
// now only schedule one background attempt, and a failed attempt is
// remembered instead of repeated.
func TestAttachmentReads_NeverVerifyInline(t *testing.T) {
	object := makePNG(40, 20)
	storeM := newMockAttachmentStore()
	signer := &gatedSigner{fakeAttachmentSigner: &fakeAttachmentSigner{objects: map[string][]byte{}}, gate: make(chan struct{})}
	gateOpen := false
	t.Cleanup(func() {
		if !gateOpen {
			close(signer.gate)
		}
	})
	a := &model.Attachment{
		ID: "bad", S3Key: "attachments/bad", SHA256: testSHA256A, // not this object's hash
		Size: int64(len(object)), ContentType: "image/png", CreatedBy: "u1",
	}
	signer.objects[a.S3Key] = object
	storeM.byID[a.ID] = a
	svc := NewAttachmentService(&syncAttachmentStore{mockAttachmentStore: storeM}, signer, newMockPublisher())
	done := make(chan error, 4)
	svc.afterThumbnailBackfill = func(_ string, err error) { done <- err }

	read := make(chan struct{})
	go func() {
		_, _ = svc.Get(context.Background(), a.ID)
		close(read)
	}()
	select {
	case <-read:
	case <-time.After(5 * time.Second):
		t.Fatal("a read waited for the object to be downloaded and verified")
	}

	close(signer.gate)
	gateOpen = true
	if err := waitBackfill(t, done); err == nil {
		t.Fatal("an object with the wrong hash verified")
	}
	for range 3 {
		if _, err := svc.Get(context.Background(), a.ID); err != nil {
			t.Fatal(err)
		}
	}
	if scheduled := svc.ensureThumbnailsForRead(context.Background(), a); scheduled {
		t.Fatal("a known-bad object was scheduled for verification again")
	}
	if got := signer.reads.Load(); got != 1 {
		t.Fatalf("object downloaded %d times, want once", got)
	}
}

// A legacy image still gets its thumbnails (and dimensions), off the read
// path: the read that finds them missing schedules the work, a later read
// sees the result.
func TestAttachmentReads_BackfillThumbnailsInTheBackground(t *testing.T) {
	object := makePNG(40, 20)
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}, putContentTypes: map[string]string{}}
	a := &model.Attachment{
		ID: "legacy", S3Key: "attachments/legacy-img", SHA256: sha256Hex(object), Size: int64(len(object)), ContentType: "image/png", CreatedBy: "u1",
		// Sized already, so only the thumbnail backfill runs (the size
		// backfill has its own tests).
		Width: 40, Height: 20,
	}
	signer.objects[a.S3Key] = object
	storeM.byID[a.ID] = a
	svc := NewAttachmentService(&syncAttachmentStore{mockAttachmentStore: storeM}, signer, newMockPublisher())
	done := make(chan error, 4)
	svc.afterThumbnailBackfill = func(_ string, err error) { done <- err }

	if _, err := svc.Get(context.Background(), a.ID); err != nil {
		t.Fatal(err)
	}
	if err := waitBackfill(t, done); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	got, err := svc.Get(context.Background(), a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ThumbnailURL == "" || got.SquareThumbnailURL == "" || got.Width != 40 || got.Height != 20 {
		t.Fatalf("after the backfill: thumb %q square %q size %dx%d", got.ThumbnailURL, got.SquareThumbnailURL, got.Width, got.Height)
	}
}

// Backfills are bounded: with every slot busy, a read schedules nothing (a
// later read tries again) instead of queueing unbounded work.
func TestAttachmentReads_BackfillsAreBounded(t *testing.T) {
	svc := NewAttachmentService(newMockAttachmentStore(), &fakeAttachmentSigner{}, newMockPublisher())
	for range cap(svc.thumbnailBackfillSlots) {
		svc.thumbnailBackfillSlots <- struct{}{}
	}
	a := &model.Attachment{ID: "busy", S3Key: "k", Size: 1, SHA256: "h", ContentType: "image/png"}
	if svc.ensureThumbnailsForRead(context.Background(), a) {
		t.Fatal("scheduled past the concurrency bound")
	}
	<-svc.thumbnailBackfillSlots
	// The same attachment already in flight is not scheduled twice.
	svc.thumbnailBackfillMu.Lock()
	svc.thumbnailBackfills[a.ID] = struct{}{}
	svc.thumbnailBackfillMu.Unlock()
	if svc.ensureThumbnailsForRead(context.Background(), a) {
		t.Fatal("scheduled an attachment already in flight")
	}
}
