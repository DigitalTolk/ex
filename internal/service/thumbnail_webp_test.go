package service

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"math/rand/v2"
	"testing"

	"github.com/gen2brain/webp"
)

func losslessWebP(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := webp.Encode(&b, img, webp.Options{Lossless: true}); err != nil {
		t.Fatal(err)
	}
	if !isLosslessWebP(b.Bytes()) {
		t.Fatalf("fixture is not a simple lossless WebP: % x", b.Bytes()[:16])
	}
	return b.Bytes()
}

// photoLike is halves with grain, so it compresses like a photo rather than
// like two flat colours.
func photoLike(w, h int, alpha uint8) *image.NRGBA {
	img := halves(w, h, alpha)
	r := rand.New(rand.NewPCG(1, 2))
	for i := 0; i < len(img.Pix); i += 4 {
		for c := 0; c < 3; c++ {
			v := int(img.Pix[i+c]) + r.IntN(41) - 20
			img.Pix[i+c] = uint8(min(255, max(0, v)))
		}
	}
	return img
}

func TestReencodeThumbnail_RewritesALosslessThumbnailInPlace(t *testing.T) {
	objects := newFakeAvatarObjects()
	key := "attachments/a1/thumb-message@2x.webp"
	before := losslessWebP(t, photoLike(640, 360, 200))
	objects.objects[key] = before

	changed, err := ReencodeThumbnail(context.Background(), objects, key, false)
	if err != nil || !changed {
		t.Fatalf("ReencodeThumbnail = %v, %v", changed, err)
	}
	after := objects.objects[key]
	if objects.types[key] != "image/webp" || !isLossyWebP(after) || len(after) >= len(before) {
		t.Fatalf("got %s, %d bytes (was %d), lossy %v", objects.types[key], len(after), len(before), isLossyWebP(after))
	}
	img, _, err := image.Decode(bytes.NewReader(after))
	if err != nil {
		t.Fatal(err)
	}
	left := color.NRGBAModel.Convert(img.At(100, 180)).(color.NRGBA)
	right := color.NRGBAModel.Convert(img.At(540, 180)).(color.NRGBA)
	if img.Bounds().Size() != image.Pt(640, 360) || left.R < 180 || left.B > 70 || right.B < 180 || right.R > 70 {
		t.Fatalf("not the same picture: left %v, right %v", left, right)
	}
	if left.A != 200 {
		t.Fatalf("alpha = %d, want 200", left.A)
	}

	// Run again: already lossy, nothing to do — and nothing downloaded.
	if changed, err := ReencodeThumbnail(context.Background(), objects, key, false); err != nil || changed {
		t.Fatalf("second run = %v, %v", changed, err)
	}
	if objects.fullReads != 1 {
		t.Fatalf("downloads = %d, want only the first run's", objects.fullReads)
	}
}

func TestReencodeThumbnail_DryRunOnlyReports(t *testing.T) {
	objects := newFakeAvatarObjects()
	objects.objects["k"] = losslessWebP(t, halves(20, 20, 255))
	before := objects.objects["k"]
	if changed, err := ReencodeThumbnail(context.Background(), objects, "k", true); err != nil || !changed {
		t.Fatalf("ReencodeThumbnail = %v, %v", changed, err)
	}
	if !bytes.Equal(objects.objects["k"], before) {
		t.Fatal("a dry run wrote")
	}
	if objects.fullReads != 0 {
		t.Fatal("a dry run downloaded the thumbnail; its first bytes say enough")
	}
}

func TestReencodeThumbnail_KeepsALosslessThumbnailLossyWouldNotShrink(t *testing.T) {
	objects := newFakeAvatarObjects()
	flat := losslessWebP(t, halves(640, 360, 255))
	objects.objects["k"] = flat
	if changed, err := ReencodeThumbnail(context.Background(), objects, "k", false); err != nil || changed {
		t.Fatalf("ReencodeThumbnail = %v, %v", changed, err)
	}
	if !bytes.Equal(objects.objects["k"], flat) {
		t.Fatal("replaced it with a bigger file")
	}
}

func TestReencodeThumbnail_LeavesAnythingElseAlone(t *testing.T) {
	objects := newFakeAvatarObjects()
	objects.objects["png"] = encodePNG(t, halves(20, 20, 255))
	objects.objects["short"] = []byte("RIFF")
	for _, key := range []string{"png", "short"} {
		if changed, err := ReencodeThumbnail(context.Background(), objects, key, false); err != nil || changed {
			t.Fatalf("%s: %v, %v", key, changed, err)
		}
	}
	if objects.fullReads != 0 {
		t.Fatal("downloaded a thumbnail with nothing to do")
	}
}

func TestReencodeThumbnail_LeavesAThumbnailRewrittenSinceItsHeaderWasRead(t *testing.T) {
	objects := newFakeAvatarObjects()
	objects.objects["k"] = losslessWebP(t, photoLike(64, 64, 255))
	var lossy bytes.Buffer
	if err := webp.Encode(&lossy, photoLike(64, 64, 255), lossyWebP); err != nil {
		t.Fatal(err)
	}
	// Another run gets there between this one's peek and its download.
	objects.afterRange = func() { objects.objects["k"] = lossy.Bytes() }

	if changed, err := ReencodeThumbnail(context.Background(), objects, "k", false); err != nil || changed {
		t.Fatalf("ReencodeThumbnail = %v, %v", changed, err)
	}
	if !bytes.Equal(objects.objects["k"], lossy.Bytes()) {
		t.Fatal("re-encoded an already lossy thumbnail")
	}
}

func TestReencodeThumbnail_Failures(t *testing.T) {
	boom := errors.New("boom")
	cases := []struct {
		name  string
		setup func(*fakeAvatarObjects)
		want  error
	}{
		{"peek fails", func(o *fakeAvatarObjects) { o.rangeErr = boom }, boom},
		{"read fails", func(o *fakeAvatarObjects) { o.getErr = boom }, boom},
		{"body fails", func(o *fakeAvatarObjects) { o.readErr = boom }, boom},
		{"write fails", func(o *fakeAvatarObjects) { o.putErr = boom }, boom},
		{"too big", func(o *fakeAvatarObjects) {
			o.objects["k"] = append(bytes.Clone(o.objects["k"]), make([]byte, maxThumbnailBytes)...)
		}, nil},
		{"corrupt", func(o *fakeAvatarObjects) {
			o.objects["k"] = append([]byte("RIFF\x00\x00\x00\x00WEBPVP8L"), "garbage"...)
		}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			objects := newFakeAvatarObjects()
			objects.objects["k"] = losslessWebP(t, photoLike(64, 64, 255))
			tc.setup(objects)
			changed, err := ReencodeThumbnail(context.Background(), objects, "k", false)
			if err == nil || changed || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Fatalf("ReencodeThumbnail = %v, %v; want an error", changed, err)
			}
		})
	}
}
