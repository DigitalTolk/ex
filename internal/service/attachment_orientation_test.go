package service

import (
	"bufio"
	"bytes"
	"context"
	"image"
	"image/color"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// A phone photo taken upright is stored sideways, with an EXIF orientation
// saying how to turn it. The browser measures and shows it upright; so must
// the upload check, the stored size and the thumbnails.

// sidewaysPhoto is a 30×20 JPEG whose EXIF says "turn a quarter clockwise"
// (6): shown 20 wide and 30 tall. Its top-left pixel is red.
func sidewaysPhoto(t *testing.T, orientation uint16) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 30, 20))
	for y := range 20 {
		for x := range 30 {
			img.Set(x, y, color.RGBA{0, 0, 255, 255})
		}
	}
	for y := range 6 {
		for x := range 6 {
			img.Set(x, y, color.RGBA{255, 0, 0, 255})
		}
	}
	return cameraJPEG(t, img, orientation)
}

func TestInspectContent_PhotoTakenUpright(t *testing.T) {
	photo := sidewaysPhoto(t, 6)
	jpegAttachment := func(w, h int) *model.Attachment {
		return &model.Attachment{ContentType: "image/jpeg", Width: w, Height: h}
	}

	// As the browser measured it: upright.
	cfg, err := inspectBytes(jpegAttachment(20, 30), "image/jpeg", photo)
	if err != nil {
		t.Fatalf("upright size refused: %v", err)
	}
	if cfg.Width != 20 || cfg.Height != 30 {
		t.Fatalf("size = %dx%d, want it as shown, 20x30", cfg.Width, cfg.Height)
	}
	// As stored, from a client that didn't turn it: still the same photo.
	// Without decoding, the server has no orientation of its own to go by,
	// so it keeps the size the client measured.
	if cfg, err := inspectBytes(jpegAttachment(30, 20), "image/jpeg", photo); err != nil || cfg.Width != 30 || cfg.Height != 20 {
		t.Fatalf("stored size = %v, %v; want accepted as claimed, 30x20", cfg, err)
	}
	// Decoded (for thumbnails), the upright pixels are the truth.
	cfg, img, release, err := inspectContent(context.Background(), jpegAttachment(30, 20), "image/jpeg", bufio.NewReader(bytes.NewReader(photo)), true)
	release()
	if err != nil || img == nil || cfg.Width != 20 || cfg.Height != 30 {
		t.Fatalf("decoded size = %v, %v; want the upright 20x30", cfg, err)
	}
	// A partial claim (one side unknown) matches either orientation too.
	if cfg, err := inspectBytes(jpegAttachment(20, 0), "image/jpeg", photo); err != nil || cfg.Width != 20 || cfg.Height != 30 {
		t.Fatalf("partial upright claim = %v, %v; want 20x30", cfg, err)
	}
	if cfg, err := inspectBytes(jpegAttachment(0, 0), "image/jpeg", photo); err != nil || cfg.Width != 30 || cfg.Height != 20 {
		t.Fatalf("no claim = %v, %v; want the stored 30x20", cfg, err)
	}
	// Any other size is not this photo.
	if _, err := inspectBytes(jpegAttachment(25, 30), "image/jpeg", photo); err == nil {
		t.Fatal("a wrong width was accepted")
	}
	if _, err := inspectBytes(jpegAttachment(20, 35), "image/jpeg", photo); err == nil {
		t.Fatal("a wrong height was accepted")
	}
}

// The thumbnails are made from the photo turned upright.
func TestInspectContent_DecodesThePhotoUpright(t *testing.T) {
	photo := sidewaysPhoto(t, 6)
	cfg, img, release, err := inspectContent(context.Background(), &model.Attachment{ContentType: "image/jpeg"}, "image/jpeg", bufio.NewReader(bytes.NewReader(photo)), true)
	defer release()
	if err != nil {
		t.Fatal(err)
	}
	if img.Bounds().Dx() != 20 || img.Bounds().Dy() != 30 || cfg.Width != 20 {
		t.Fatalf("decoded %v (cfg %dx%d), want 20x30", img.Bounds(), cfg.Width, cfg.Height)
	}
	// Turned a quarter clockwise, the red corner is now top-right.
	r, g, b, _ := img.At(17, 2).RGBA()
	if r>>8 < 200 || g>>8 > 60 || b>>8 > 60 {
		t.Fatalf("top-right pixel = %d,%d,%d, want red", r>>8, g>>8, b>>8)
	}
}

// Every EXIF orientation decodes the way it is shown: sized upright, with the
// stored top-left corner where the turn puts it. An out-of-range value is
// ignored (shown as stored).
func TestInspectContent_DecodesEveryOrientationUpright(t *testing.T) {
	type corner int
	const (
		topLeft corner = iota
		topRight
		bottomRight
		bottomLeft
	)
	for _, tc := range []struct {
		orientation uint16
		w, h        int
		red         corner
	}{
		{1, 30, 20, topLeft},
		{2, 30, 20, topRight},
		{3, 30, 20, bottomRight},
		{4, 30, 20, bottomLeft},
		{5, 20, 30, topLeft},
		{6, 20, 30, topRight},
		{7, 20, 30, bottomRight},
		{8, 20, 30, bottomLeft},
		{9, 30, 20, topLeft},
	} {
		_, img, release, err := inspectContent(context.Background(), &model.Attachment{ContentType: "image/jpeg"}, "image/jpeg", bufio.NewReader(bytes.NewReader(sidewaysPhoto(t, tc.orientation))), true)
		release()
		if err != nil {
			t.Fatalf("orientation %d: %v", tc.orientation, err)
		}
		if img.Bounds().Dx() != tc.w || img.Bounds().Dy() != tc.h {
			t.Errorf("orientation %d: decoded %v, want %dx%d", tc.orientation, img.Bounds(), tc.w, tc.h)
			continue
		}
		at := map[corner]image.Point{
			topLeft: image.Pt(2, 2), topRight: image.Pt(tc.w-3, 2),
			bottomRight: image.Pt(tc.w-3, tc.h-3), bottomLeft: image.Pt(2, tc.h-3),
		}[tc.red]
		if r, g, _, _ := img.At(at.X, at.Y).RGBA(); r>>8 < 200 || g>>8 > 60 {
			t.Errorf("orientation %d: the red corner is not at %v", tc.orientation, at)
		}
	}
}

// Auto-orientation copies a JPEG's pixels once more to turn them, so the
// decode budget reserves that copy up front: the orientation is only known
// once decoding has started.
func TestImageDecodeCostFor_ReservesARotationForJPEG(t *testing.T) {
	if got, want := imageDecodeCostFor("jpeg", 10, 20), int64(10*20*(decodeBytesPerPixel+4)); got != want {
		t.Errorf("jpeg cost = %d, want %d", got, want)
	}
	if got, want := imageDecodeCostFor("png", 10, 20), imageDecodeCost(10, 20); got != want {
		t.Errorf("png cost = %d, want %d", got, want)
	}
}

// When a JPEG cannot be decoded upright right now, the backfill keeps the size
// it read from the file's header rather than nothing.
func TestUprightSize_KeepsTheStoredSizeWhenItCannotDecode(t *testing.T) {
	stored := image.Config{Width: 30, Height: 20}
	photo := sidewaysPhoto(t, 6)
	signer := &fakeAttachmentSigner{objects: map[string][]byte{"good": photo, "garbage": []byte("not a jpeg")}}
	svc := NewAttachmentService(newMockAttachmentStore(), signer, newMockPublisher())
	ctx := context.Background()

	if got := svc.uprightSize(ctx, "good", "jpeg", stored); got.Width != 20 || got.Height != 30 {
		t.Fatalf("decodable photo: %dx%d, want upright 20x30", got.Width, got.Height)
	}
	if got := svc.uprightSize(ctx, "good", "jpeg", image.Config{Width: 1 << 15, Height: 1 << 15}); got.Width != 1<<15 {
		t.Fatalf("over the decode budget: %v, want the stored size", got)
	}
	if got := svc.uprightSize(ctx, "missing", "jpeg", stored); got != stored {
		t.Fatalf("unreadable object: %v, want the stored size", got)
	}
	if got := svc.uprightSize(ctx, "garbage", "jpeg", stored); got != stored {
		t.Fatalf("undecodable object: %v, want the stored size", got)
	}
	if !imageDecodeBudget.TryAcquire(maxImageDecodeBytes) {
		t.Fatal("decode budget busy")
	}
	defer imageDecodeBudget.Release(maxImageDecodeBytes)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if got := svc.uprightSize(cancelled, "good", "jpeg", stored); got != stored {
		t.Fatalf("no decode budget: %v, want the stored size", got)
	}
}

// An older upload without a stored size gets it as shown.
func TestAttachmentService_BackfillsAPhotoUpright(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{"attachments/photo": sidewaysPhoto(t, 6)}}
	att := &model.Attachment{
		ID: "photo", SHA256: "h", Size: int64(len(signer.objects["attachments/photo"])), ContentType: "image/jpeg",
		Filename: "IMG_0001.jpg", S3Key: "attachments/photo", CreatedBy: "u1", CreatedAt: time.Now(),
	}
	if err := storeM.Create(context.Background(), att); err != nil {
		t.Fatal(err)
	}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	if _, err := svc.Get(context.Background(), "photo"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if stored := storeM.stored("photo"); stored.Width != 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if stored := storeM.stored("photo"); stored.Width != 20 || stored.Height != 30 {
		t.Fatalf("backfilled %dx%d, want 20x30", stored.Width, stored.Height)
	}
}
