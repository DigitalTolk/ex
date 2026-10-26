package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
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
	// As stored, from a client that didn't turn it: still the same photo,
	// kept as shown.
	if cfg, err := inspectBytes(jpegAttachment(30, 20), "image/jpeg", photo); err != nil || cfg.Width != 20 || cfg.Height != 30 {
		t.Fatalf("stored size = %v, %v; want accepted and kept as shown, 20x30", cfg, err)
	}
	// Decoded (for thumbnails), the same.
	cfg, img, release, err := inspectContent(context.Background(), jpegAttachment(30, 20), "image/jpeg", bufio.NewReader(bytes.NewReader(photo)), true)
	release()
	if err != nil || img == nil || cfg.Width != 20 || cfg.Height != 30 {
		t.Fatalf("decoded size = %v, %v; want the upright 20x30", cfg, err)
	}
	// A partial claim (one side unknown) matches either orientation too.
	if cfg, err := inspectBytes(jpegAttachment(30, 0), "image/jpeg", photo); err != nil || cfg.Width != 20 || cfg.Height != 30 {
		t.Fatalf("partial stored claim = %v, %v; want 20x30", cfg, err)
	}
	if cfg, err := inspectBytes(jpegAttachment(0, 0), "image/jpeg", photo); err != nil || cfg.Width != 20 || cfg.Height != 30 {
		t.Fatalf("no claim = %v, %v; want it as shown, 20x30", cfg, err)
	}
	// Any other size is not this photo.
	if _, err := inspectBytes(jpegAttachment(25, 30), "image/jpeg", photo); err == nil {
		t.Fatal("a wrong width was accepted")
	}
	if _, err := inspectBytes(jpegAttachment(20, 35), "image/jpeg", photo); err == nil {
		t.Fatal("a wrong height was accepted")
	}
}

// messageThumbnail is the message thumbnail of a photo as shown.
func messageThumbnail(t *testing.T, photo []byte) image.Image {
	t.Helper()
	_, img, release, err := inspectContent(context.Background(), &model.Attachment{ContentType: "image/jpeg"}, "image/jpeg", bufio.NewReader(bytes.NewReader(photo)), true)
	defer release()
	if err != nil {
		t.Fatal(err)
	}
	thumb, _, err := image.Decode(bytes.NewReader(mustThumb(encodeWebPThumbnail(*img, thumbnailModeMessage))))
	if err != nil {
		t.Fatal(err)
	}
	return thumb
}

// The thumbnails show the photo upright.
func TestEncodeWebPThumbnail_ShowsThePhotoUpright(t *testing.T) {
	thumb := messageThumbnail(t, sidewaysPhoto(t, 6))
	if thumb.Bounds().Dx() != 20 || thumb.Bounds().Dy() != 30 {
		t.Fatalf("thumbnail is %v, want 20x30", thumb.Bounds())
	}
	// Turned a quarter clockwise, the red corner is now top-right.
	r, g, b, _ := thumb.At(17, 2).RGBA()
	if r>>8 < 200 || g>>8 > 60 || b>>8 > 60 {
		t.Fatalf("top-right pixel = %d,%d,%d, want red", r>>8, g>>8, b>>8)
	}
}

// Every EXIF orientation is shown the way it says: sized upright, with the
// stored top-left corner where the turn puts it. An out-of-range value is
// ignored (shown as stored).
func TestEncodeWebPThumbnail_ShowsEveryOrientationUpright(t *testing.T) {
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
		thumb := messageThumbnail(t, sidewaysPhoto(t, tc.orientation))
		if thumb.Bounds().Dx() != tc.w || thumb.Bounds().Dy() != tc.h {
			t.Errorf("orientation %d: thumbnail is %v, want %dx%d", tc.orientation, thumb.Bounds(), tc.w, tc.h)
			continue
		}
		at := map[corner]image.Point{
			topLeft: image.Pt(2, 2), topRight: image.Pt(tc.w-3, 2),
			bottomRight: image.Pt(tc.w-3, tc.h-3), bottomLeft: image.Pt(2, tc.h-3),
		}[tc.red]
		if r, g, _, _ := thumb.At(at.X, at.Y).RGBA(); r>>8 < 200 || g>>8 > 60 {
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

// An editor may write its XMP segment ahead of the camera's EXIF one; the
// orientation behind it still counts, as it does in the browser.
func TestInspectContent_ReadsTheOrientationBehindXMP(t *testing.T) {
	payload := append([]byte("http://ns.adobe.com/xap/1.0/\x00"), `<x:xmpmeta xmlns:x="adobe:ns:meta/"/>`...)
	xmp := binary.BigEndian.AppendUint16([]byte{0xFF, 0xE1}, uint16(len(payload)+2))
	xmp = append(xmp, payload...)
	photo := sidewaysPhoto(t, 6)
	photo = append(append(append([]byte{}, photo[:2]...), xmp...), photo[2:]...)
	if cfg, err := inspectBytes(&model.Attachment{ContentType: "image/jpeg"}, "image/jpeg", photo); err != nil || cfg.Width != 20 || cfg.Height != 30 {
		t.Fatalf("size = %v, %v; want it as shown, 20x30", cfg, err)
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

// phonePhoto is a camera's full-size photo: w×h pixels as stored, with an
// EXIF orientation. Its stored top-left quarter is red, the rest blue.
func phonePhoto(t *testing.T, w, h int, orientation uint16) []byte {
	t.Helper()
	img := image.NewYCbCr(image.Rect(0, 0, w, h), image.YCbCrSubsampleRatio420)
	redY, redCb, redCr := color.RGBToYCbCr(255, 0, 0)
	blueY, blueCb, blueCr := color.RGBToYCbCr(0, 0, 255)
	for y := range h {
		for x := range w {
			img.Y[img.YOffset(x, y)] = blueY
			if x < w/2 && y < h/2 {
				img.Y[img.YOffset(x, y)] = redY
			}
		}
	}
	for y := range h / 2 {
		for x := range w / 2 {
			i := y*img.CStride + x
			img.Cb[i], img.Cr[i] = blueCb, blueCr
			if x < w/4 && y < h/4 {
				img.Cb[i], img.Cr[i] = redCb, redCr
			}
		}
	}
	return cameraJPEG(t, img, orientation)
}

// A phone's full-size photo, taken upright: 24 MP (an iPhone's default),
// stored sideways. Turning all of it upright was costed as one more copy of
// every pixel, which put it over the decode budget, so it got no thumbnails
// and showed as a file.
func TestProcessUpload_FullSizePhotoTakenUpright(t *testing.T) {
	photo := phonePhoto(t, 5712, 4284, 6)
	storeM := newMockAttachmentStore()
	a := &model.Attachment{
		ID: "photo", CreatedBy: "u1", S3Key: "attachments/photo", Filename: "IMG_0001.jpg", ContentType: "image/jpeg",
		Size: int64(len(photo)), SHA256: sha256Hex(photo), Width: 4284, Height: 5712,
	}
	storeM.byID[a.ID] = a
	signer := &fakeAttachmentSigner{objects: map[string][]byte{a.S3Key: photo}, objectContentType: "image/jpeg", putContentTypes: map[string]string{}}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	processed, err := svc.ProcessUpload(context.Background(), "u1", a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if processed.Width != 4284 || processed.Height != 5712 {
		t.Fatalf("size = %dx%d, want it as shown, 4284x5712", processed.Width, processed.Height)
	}
	if processed.ThumbnailS3Key == "" || processed.SquareThumbnailS3Key == "" {
		t.Fatal("no thumbnails")
	}
	thumb, _, err := image.Decode(bytes.NewReader(signer.objects[processed.ThumbnailS3Key]))
	if err != nil {
		t.Fatal(err)
	}
	if b := thumb.Bounds(); b.Dx() != 432 || b.Dy() != 576 {
		t.Fatalf("message thumbnail is %v, want it upright, 432x576", b)
	}
	// Turned a quarter clockwise, the red corner is top-right.
	if r, _, b, _ := thumb.At(432-20, 20).RGBA(); r>>8 < 200 || b>>8 > 60 {
		t.Fatalf("message thumbnail's top-right is %d,%d, want red", r>>8, b>>8)
	}
	square, _, err := image.Decode(bytes.NewReader(signer.objects[processed.SquareThumbnailS3Key]))
	if err != nil {
		t.Fatal(err)
	}
	if b := square.Bounds(); b.Dx() != squareThumbnailSize || b.Dy() != squareThumbnailSize {
		t.Fatalf("square thumbnail is %v", b)
	}
	if r, _, b, _ := square.At(squareThumbnailSize-5, 5).RGBA(); r>>8 < 200 || b>>8 > 60 {
		t.Fatalf("square thumbnail's top-right is %d,%d, want red", r>>8, b>>8)
	}
}
