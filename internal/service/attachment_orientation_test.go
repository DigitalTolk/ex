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
	if cfg, err := inspectBytes(jpegAttachment(30, 20), "image/jpeg", photo); err != nil || cfg.Width != 20 || cfg.Height != 30 {
		t.Fatalf("stored size = %v, %v; want accepted as 20x30", cfg, err)
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

func TestOrient(t *testing.T) {
	// A 3×2 image with one marked pixel at (0,0).
	src := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	src.Set(0, 0, color.NRGBA{255, 0, 0, 255})
	for _, tc := range []struct {
		orientation int
		w, h        int
		marked      image.Point
	}{
		{1, 3, 2, image.Pt(0, 0)},
		{2, 3, 2, image.Pt(2, 0)},
		{3, 3, 2, image.Pt(2, 1)},
		{4, 3, 2, image.Pt(0, 1)},
		{5, 2, 3, image.Pt(0, 0)},
		{6, 2, 3, image.Pt(1, 0)},
		{7, 2, 3, image.Pt(1, 2)},
		{8, 2, 3, image.Pt(0, 2)},
	} {
		got := orient(src, tc.orientation)
		if got.Bounds().Dx() != tc.w || got.Bounds().Dy() != tc.h {
			t.Errorf("orientation %d: %v, want %dx%d", tc.orientation, got.Bounds(), tc.w, tc.h)
			continue
		}
		if r, _, _, _ := got.At(tc.marked.X, tc.marked.Y).RGBA(); r>>8 != 255 {
			t.Errorf("orientation %d: marked pixel not at %v", tc.orientation, tc.marked)
		}
		if c := upright(image.Config{Width: 3, Height: 2}, tc.orientation); c.Width != tc.w || c.Height != tc.h {
			t.Errorf("orientation %d: upright size %dx%d", tc.orientation, c.Width, c.Height)
		}
	}
}

func TestExifOrientation(t *testing.T) {
	if got := exifOrientation(sidewaysPhoto(t, 8)); got != 8 {
		t.Errorf("orientation = %d, want 8", got)
	}
	// No EXIF, no orientation tag, a value out of range: as stored.
	if got := exifOrientation(makePNG(4, 4)); got != 1 {
		t.Errorf("PNG = %d", got)
	}
	if got := exifOrientation(sidewaysPhoto(t, 9)); got != 1 {
		t.Errorf("out of range = %d", got)
	}
	noTag := sidewaysPhoto(t, 6)
	// Turn the one IFD entry's tag (0x0112, Orientation) into another one.
	i := bytes.Index(noTag, []byte{0x01, 0x12, 0, 3})
	noTag[i], noTag[i+1] = 0x01, 0x0e
	if got := exifOrientation(noTag); got != 1 {
		t.Errorf("no orientation tag = %d", got)
	}
	wrongType := sidewaysPhoto(t, 6)
	// Make the Orientation entry an ASCII string: no integer to read.
	j := bytes.Index(wrongType, []byte{0x01, 0x12, 0, 3})
	wrongType[j+3] = 2
	if got := exifOrientation(wrongType); got != 1 {
		t.Errorf("non-integer orientation = %d", got)
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
		if stored := storeM.byID["photo"]; stored.Width != 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if stored := storeM.byID["photo"]; stored.Width != 20 || stored.Height != 30 {
		t.Fatalf("backfilled %dx%d, want 20x30", stored.Width, stored.Height)
	}
}
