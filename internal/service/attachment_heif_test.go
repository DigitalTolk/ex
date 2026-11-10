package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/gen2brain/h265/heic"

	"github.com/DigitalTolk/ex/internal/model"
)

// The fixtures are 32×24 photos in four solid quarters (top left red, top
// right green, bottom left blue, bottom right white), written by macOS's own
// HEIC encoder told to show them in EXIF orientation N: it stores the pixels
// as given and says how to turn them in irot/imir boxes, as an iPhone does.
func heifFixture(t *testing.T, orientation int) []byte {
	t.Helper()
	data, err := os.ReadFile(fmt.Sprintf("testdata/heic/orientation-%d.heic", orientation))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// Every orientation turns the stored pixels exactly as the decoder itself
// does when asked to apply the file's transforms.
func TestHeifOrientation_MatchesTheDecoder(t *testing.T) {
	for o := 1; o <= 8; o++ {
		t.Run(fmt.Sprint(o), func(t *testing.T) {
			data := heifFixture(t, o)
			if got := heifOrientation(data); got != o {
				t.Fatalf("heifOrientation = %d, want %d", got, o)
			}
			stored, format, err := image.Decode(bytes.NewReader(data))
			if err != nil || format != "heic" {
				t.Fatalf("decode = %q, %v", format, err)
			}
			want, err := heic.Decode(bytes.NewReader(data), heic.Options{AutoRotate: true})
			if err != nil {
				t.Fatal(err)
			}
			got := upright(stored.(*image.NRGBA), o)
			if got.Bounds() != want.Bounds() || !bytes.Equal(got.Pix, want.(*image.NRGBA).Pix) {
				t.Fatalf("turned %v differs from the decoder's %v", got.Bounds(), want.Bounds())
			}
		})
	}
}

// box is an ISO BMFF box of a type around its body.
func box(typ string, body ...[]byte) []byte {
	b := bytes.Join(body, nil)
	return append(append(binary.BigEndian.AppendUint32(nil, uint32(8+len(b))), typ...), b...)
}

// fullBox is a box whose body starts with a version and 24 bits of flags.
func fullBox(typ string, version byte, flags uint32, body ...[]byte) []byte {
	return box(typ, append([]byte{version, byte(flags >> 16), byte(flags >> 8), byte(flags)}, bytes.Join(body, nil)...))
}

func u16(v uint16) []byte { return binary.BigEndian.AppendUint16(nil, v) }
func u32(v uint32) []byte { return binary.BigEndian.AppendUint32(nil, v) }

// heifHeader is a meta box naming item 1 primary, with these properties
// and this ipma.
func heifHeader(pitm, ipco, ipma []byte) []byte {
	return fullBox("meta", 0, 0, pitm, box("iprp", ipco, ipma))
}

func TestHeifOrientation_Header(t *testing.T) {
	pitm := fullBox("pitm", 0, 0, u16(1))
	irot := box("ipco", box("irot", []byte{3}))
	// Item 1 has property 1.
	ipma := fullBox("ipma", 0, 0, u32(1), u16(1), []byte{1}, []byte{0x81})
	valid := heifHeader(pitm, irot, ipma)

	largeMeta := append(append(u32(1), "meta"...), binary.BigEndian.AppendUint64(nil, uint64(16+len(valid)-8))...)
	largeMeta = append(largeMeta, valid[8:]...)

	for _, tc := range []struct {
		name   string
		header []byte
		want   int
	}{
		{"rotated", valid, 6},
		{"after other boxes", append(box("ftyp", []byte("heic")), valid...), 6},
		{"meta to the end (size 0)", append(u32(0), valid[4:]...), 6},
		{"meta with a 64-bit size", largeMeta, 6},
		{"32-bit item ids", heifHeader(fullBox("pitm", 1, 0, u32(1)), irot, fullBox("ipma", 1, 0, u32(1), u32(1), []byte{1}, []byte{0x81})), 6},
		{"15-bit property indexes", heifHeader(pitm, irot, fullBox("ipma", 0, 1, u32(1), u16(1), []byte{1}, u16(0x8001))), 6},
		{"rotated and mirrored", heifHeader(pitm, box("ipco", box("irot", []byte{1}), box("imir", []byte{1})), fullBox("ipma", 0, 0, u32(1), u16(1), []byte{2}, []byte{1, 2})), 7},
		{"another item's rotation", heifHeader(pitm, irot, fullBox("ipma", 0, 0, u32(1), u16(2), []byte{1}, []byte{1})), 1},
		{"property index 0", heifHeader(pitm, irot, fullBox("ipma", 0, 0, u32(1), u16(1), []byte{1}, []byte{0})), 1},
		{"property index past ipco", heifHeader(pitm, irot, fullBox("ipma", 0, 0, u32(1), u16(1), []byte{1}, []byte{2})), 1},
		{"empty irot", heifHeader(pitm, box("ipco", box("irot")), ipma), 1},
		{"no header", nil, 0},
		{"meta too short", box("meta", []byte{0, 0}), 0},
		{"no pitm", heifHeader(nil, irot, ipma), 0},
		{"no ipma", heifHeader(pitm, irot, nil), 0},
		{"ipma cut short", heifHeader(pitm, irot, fullBox("ipma", 0, 0, u32(1), u16(1))), 0},
		{"64-bit size cut short", append(u32(1), "meta"...), 0},
		{"box smaller than its header", append(u32(4), "meta"...), 0},
		{"box past the end", valid[:len(valid)-1], 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := heifOrientation(tc.header); got != tc.want {
				t.Fatalf("heifOrientation = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestSniffsAsImage(t *testing.T) {
	if !sniffsAsImage(makePNG(4, 4)) {
		t.Error("a PNG does not sniff as an image")
	}
	if !sniffsAsImage(heifFixture(t, 1)) {
		t.Error("a HEIC does not sniff as an image")
	}
	if sniffsAsImage([]byte{0x00, 0x01, 0x02, 0x03, 0xfe, 0xff}) {
		t.Error("unknown bytes sniff as an image")
	}
}

func TestIsHEIF(t *testing.T) {
	for ct, want := range map[string]bool{
		"image/heic":      true,
		"IMAGE/HEIF":      true,
		"image/heic; x=y": true,
		"image/png":       false,
		"":                false,
	} {
		if got := isHEIF(ct); got != want {
			t.Errorf("isHEIF(%q) = %v, want %v", ct, got, want)
		}
	}
}

func TestDecodeCost(t *testing.T) {
	base := imageDecodeCost(100, 50)
	for _, tc := range []struct {
		format string
		model  color.Model
		want   int64
	}{
		{"heic", color.NRGBAModel, base},
		{"heic", color.NRGBA64Model, base + base/2},
		{"png", color.NRGBA64Model, base},
	} {
		if got := decodeCost(tc.format, image.Config{Width: 100, Height: 50, ColorModel: tc.model}); got != tc.want {
			t.Errorf("decodeCost(%s, %v) = %d, want %d", tc.format, tc.model, got, tc.want)
		}
	}
}

func TestViewingCopy(t *testing.T) {
	small := image.NewNRGBA(image.Rect(0, 0, 40, 30))
	if viewingCopy(small) != small {
		t.Error("a photo that fits was copied")
	}
	wide := viewingCopy(image.NewNRGBA(image.Rect(0, 0, displayMaxSide*2, 10)))
	if wide.Bounds().Dx() != displayMaxSide || wide.Bounds().Dy() != 5 {
		t.Errorf("wide photo fitted to %v, want %dx5", wide.Bounds(), displayMaxSide)
	}
	deep := viewingCopy(image.NewNRGBA64(image.Rect(0, 0, 40, 30)))
	if deep.Bounds().Dx() != 40 || deep.Bounds().Dy() != 30 {
		t.Errorf("16-bit photo became %v, want 40x30", deep.Bounds())
	}
}

func TestDisplayFilename(t *testing.T) {
	for in, want := range map[string]string{
		"IMG_0001.HEIC": "IMG_0001.webp",
		"photo":         "photo.webp",
	} {
		if got := displayFilename(in); got != want {
			t.Errorf("displayFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

// A HEIC is checked like any image: decoded, sized as shown, and its format
// must be the one declared.
func TestInspectContent_HEIC(t *testing.T) {
	photo := heifFixture(t, 6) // stored 32×24, shown 24×32
	heicAttachment := func(ct string, w, h int) *model.Attachment {
		return &model.Attachment{ContentType: ct, Width: w, Height: h}
	}
	for _, a := range []*model.Attachment{
		heicAttachment("image/heic", 24, 32),
		heicAttachment("image/heic", 32, 24),
		heicAttachment("image/heif", 0, 0),
	} {
		cfg, err := inspectBytes(a, a.ContentType, photo)
		if err != nil || cfg.Width != 24 || cfg.Height != 32 {
			t.Fatalf("%s claiming %dx%d: %v, %v; want accepted as shown, 24x32", a.ContentType, a.Width, a.Height, cfg, err)
		}
	}
	cfg, img, release, err := inspectContent(context.Background(), heicAttachment("image/heic", 0, 0), "image/heic", bufio.NewReader(bytes.NewReader(photo)), true)
	release()
	if err != nil || img == nil || img.orientation != 6 || img.Bounds().Dx() != 32 || cfg.Width != 24 {
		t.Fatalf("decoded = %v, %+v, %v; want the stored 32x24 pixels, orientation 6, shown 24 wide", cfg, img, err)
	}
	if _, err := inspectBytes(heicAttachment("image/png", 0, 0), "image/png", photo); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("a HEIC declared as PNG: %v, want a format mismatch", err)
	}
	if _, err := inspectBytes(heicAttachment("image/heic", 0, 0), "image/heic", makePNG(4, 4)); err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("a PNG declared as HEIC: %v, want a format mismatch", err)
	}
}

// uploadHEIC uploads the orientation-6 fixture and processes it.
func uploadHEIC(t *testing.T, svc *AttachmentService, signer *fakeAttachmentSigner) (*model.Attachment, error) {
	t.Helper()
	photo := heifFixture(t, 6)
	res, err := svc.CreateUploadURL(context.Background(), CreateUploadParams{
		UserID: "u1", Filename: "IMG_0001.HEIC", ContentType: "image/heic", SHA256: sha256Hex(photo), Size: int64(len(photo)),
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	signer.objects[res.Attachment.S3Key] = photo
	signer.objectContentType = "image/heic"
	return svc.ProcessUpload(context.Background(), "u1", res.Attachment.ID)
}

// A HEIC upload keeps the file for download and shows a WebP copy: upright,
// with thumbnails, removed with the attachment.
func TestAttachmentService_ProcessUpload_HEICGetsAViewingCopy(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}, putContentTypes: map[string]string{}}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())

	processed, err := uploadHEIC(t, svc, signer)
	if err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if processed.Width != 24 || processed.Height != 32 {
		t.Fatalf("dimensions = %dx%d, want as shown, 24x32", processed.Width, processed.Height)
	}
	if processed.ThumbnailS3Key == "" || processed.SquareThumbnailS3Key == "" {
		t.Fatal("no thumbnails")
	}
	key := displayObjectKey(processed)
	if got := signer.putContentTypes[key]; got != "image/webp" {
		t.Fatalf("viewing copy content type = %q, want image/webp", got)
	}
	if !isLossyWebP(signer.objects[key]) {
		t.Fatal("viewing copy is not a lossy WebP")
	}
	view, _, err := image.Decode(bytes.NewReader(signer.objects[key]))
	if err != nil {
		t.Fatal(err)
	}
	if view.Bounds().Dx() != 24 || view.Bounds().Dy() != 32 {
		t.Fatalf("viewing copy is %v, want upright 24x32", view.Bounds())
	}
	// Turned a quarter clockwise, the red top-left quarter is now top right.
	if r, g, b, _ := view.At(20, 3).RGBA(); r>>8 < 180 || g>>8 > 80 || b>>8 > 80 {
		t.Fatalf("top-right pixel = %d,%d,%d, want red", r>>8, g>>8, b>>8)
	}

	// The URL shows the copy; the download is the file.
	if !strings.Contains(processed.URL, key) || !strings.Contains(processed.URL, "type=image%2Fwebp") {
		t.Fatalf("URL = %q, want the viewing copy served as WebP", processed.URL)
	}
	if !strings.Contains(processed.DownloadURL, processed.S3Key+"?download=IMG_0001.HEIC") {
		t.Fatalf("download = %q, want the uploaded file", processed.DownloadURL)
	}

	if err := svc.DeleteDraft(context.Background(), "u1", processed.ID); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(signer.deleted, key) {
		t.Fatalf("deleted %v, want the viewing copy among them", signer.deleted)
	}
}

func TestAttachmentService_HEICStableMediaURLIsTheViewingCopy(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}, putContentTypes: map[string]string{}}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	cache := newFakeMediaCache()
	svc.SetMediaURLCache(cache)

	processed, err := uploadHEIC(t, svc, signer)
	if err != nil {
		t.Fatalf("ProcessUpload: %v", err)
	}
	if !strings.HasPrefix(processed.URL, "/api/v1/media/") || !strings.HasSuffix(processed.URL, "/IMG_0001.webp") {
		t.Fatalf("URL = %q, want the viewing copy's media URL", processed.URL)
	}
	var rec mediaRecord
	if err := cache.Get(context.Background(), "media:attachment-display:"+processed.ID, &rec); err != nil {
		t.Fatal(err)
	}
	if rec.S3Key != displayObjectKey(processed) || rec.ContentType != "image/webp" {
		t.Fatalf("media record = %+v, want the viewing copy as WebP", rec)
	}
}

// Without its viewing copy stored the photo can't be shown, and storing it
// is part of making the thumbnails.
func TestAttachmentService_ProcessUpload_HEICViewingCopyStoreFails(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{objects: map[string][]byte{}, putContentTypes: map[string]string{}}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	signer.putErr = fmt.Errorf("s3 down")

	if _, err := uploadHEIC(t, svc, signer); err == nil || !strings.Contains(err.Error(), "store viewing copy") {
		t.Fatalf("ProcessUpload = %v, want the viewing copy's store error", err)
	}
}

// A HEIC without thumbnails (too large to decode) has no viewing copy: its
// URL is the file.
func TestAttachmentService_HEICWithoutThumbnailsShowsTheFile(t *testing.T) {
	storeM := newMockAttachmentStore()
	signer := &fakeAttachmentSigner{}
	svc := NewAttachmentService(storeM, signer, newMockPublisher())
	a := &model.Attachment{
		ID: "a-big", SHA256: "sha-big", S3Key: "attachments/a-big", Filename: "IMG_0002.HEIC",
		ContentType: "image/heic", Size: 42, CreatedBy: "u1", Width: 8064, Height: 6048,
	}
	if err := storeM.Create(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Get(context.Background(), a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.URL, "attachments/a-big?") || !strings.Contains(got.URL, "type=image%2Fheic") {
		t.Fatalf("URL = %q, want the file itself", got.URL)
	}
}
