// Package picture makes the pictures the server derives from an image: the
// thumbnails, a HEIF photo's viewing copy, avatars and emoji. Scaling is
// bild's Catmull-Rom resampler; turning a picture upright per its EXIF
// orientation is a plain remapping of its pixels.
//
// Every picture comes back as *image.NRGBA, colour not premultiplied by alpha:
// that is how the WebP encoder reads pixels (it takes an *image.RGBA's bytes
// as they are, which would darken every partly transparent pixel).
package picture

import (
	"bytes"
	"image"
	"image/draw"

	"github.com/anthonynsimon/bild/clone"
	"github.com/anthonynsimon/bild/transform"
	"github.com/bep/imagemeta"
)

// RGBA is img as the resizer reads it: img itself when it already is an
// *image.RGBA, otherwise a copy, 4 bytes a pixel. Convert once when several
// pictures are made from one image.
func RGBA(img image.Image) *image.RGBA {
	return clone.AsShallowRGBA(img)
}

// Fit scales img down to fit within w×h, keeping its shape. An image that
// fits already keeps its size: it is never enlarged.
func Fit(img image.Image, w, h int) *image.NRGBA {
	b := img.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw <= w && sh <= h {
		return nrgba(img)
	}
	aspect := float64(sw) / float64(sh)
	if aspect > float64(w)/float64(h) {
		h = max(1, int(float64(w)/aspect))
	} else {
		w = max(1, int(float64(h)*aspect))
	}
	return scale(img, w, h)
}

// Fill scales the centre of img, cut to the shape of w×h, to exactly w×h.
func Fill(img image.Image, w, h int) *image.NRGBA {
	b := img.Bounds()
	cw, ch := b.Dx(), b.Dy()
	if float64(cw)/float64(ch) < float64(w)/float64(h) {
		ch = int(max(1, float64(cw)*float64(h)/float64(w)) + 0.5)
	} else {
		cw = int(max(1, float64(ch)*float64(w)/float64(h)) + 0.5)
	}
	x0 := b.Min.X + (b.Dx()-cw)/2
	y0 := b.Min.Y + (b.Dy()-ch)/2
	return scale(RGBA(img).SubImage(image.Rect(x0, y0, x0+cw, y0+ch)), w, h)
}

// Shrink fits img within a w×h box as it is shown, then turns it upright:
// stored turned a quarter (orientations 5–8), it fits the box turned a
// quarter.
func Shrink(img image.Image, orientation, w, h int) *image.NRGBA {
	bw, bh := ShownSize(w, h, orientation)
	return Upright(Fit(img, bw, bh), orientation)
}

func scale(img image.Image, w, h int) *image.NRGBA {
	return straight(transform.Resize(img, w, h, transform.CatmullRom))
}

// straight is m with its colour no longer premultiplied by alpha. Next to a
// transparent edge, Catmull-Rom's negative lobes can push a channel past its
// pixel's alpha, which no premultiplied colour can be (it would wrap round
// when divided out): it is held at the alpha, the brightest that alpha
// allows. m is the resizer's own, laid out from its origin.
func straight(m *image.RGBA) *image.NRGBA {
	for i := 0; i < len(m.Pix); i += 4 {
		a := m.Pix[i+3]
		m.Pix[i] = min(m.Pix[i], a)
		m.Pix[i+1] = min(m.Pix[i+1], a)
		m.Pix[i+2] = min(m.Pix[i+2], a)
	}
	return nrgba(m)
}

// nrgba copies img into a new *image.NRGBA from the origin.
func nrgba(img image.Image) *image.NRGBA {
	b := img.Bounds()
	n := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(n, n.Rect, img, b.Min, draw.Src)
	return n
}

// ShownSize is the size of w×h stored pixels as shown: orientations 5–8 turn
// them a quarter.
func ShownSize(w, h, orientation int) (int, int) {
	if orientation >= 5 && orientation <= 8 {
		return h, w
	}
	return w, h
}

// shown says where each EXIF orientation shows the stored pixel at x, y of a
// w×h image.
var shown = map[int]func(x, y, w, h int) (int, int){
	2: func(x, y, w, _ int) (int, int) { return w - 1 - x, y },         // mirrored
	3: func(x, y, w, h int) (int, int) { return w - 1 - x, h - 1 - y }, // half a turn
	4: func(x, y, _, h int) (int, int) { return x, h - 1 - y },         // upside down, mirrored
	5: func(x, y, _, _ int) (int, int) { return y, x },                 // transposed
	6: func(x, y, _, h int) (int, int) { return h - 1 - y, x },         // a quarter turn clockwise
	7: func(x, y, w, h int) (int, int) { return h - 1 - y, w - 1 - x }, // transversed
	8: func(x, y, w, _ int) (int, int) { return y, w - 1 - x },         // a quarter turn anticlockwise
}

// Upright turns pixels as stored the way EXIF orientation shows them. As
// stored (1), or no orientation (0 or anything unknown), is img itself.
func Upright(img *image.NRGBA, orientation int) *image.NRGBA {
	at, ok := shown[orientation]
	if !ok {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := ShownSize(w, h, orientation)
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	for y := range h {
		for x := range w {
			dx, dy := at(x, y, w, h)
			copy(dst.Pix[dst.PixOffset(dx, dy):][:4], img.Pix[img.PixOffset(b.Min.X+x, b.Min.Y+y):])
		}
	}
	return dst
}

// JPEGOrientation is the EXIF orientation (1–8) in a JPEG's header, or 0 when
// it has none (or is no JPEG). An unreadable one is none: the image is then
// shown as stored.
func JPEGOrientation(header []byte) int {
	orientation := 0
	_, _ = imagemeta.Decode(imagemeta.Options{
		R:           bytes.NewReader(header),
		ImageFormat: imagemeta.JPEG,
		Sources:     imagemeta.EXIF,
		// IFD0's: the other IFD describes the embedded thumbnail.
		ShouldHandleTag: func(ti imagemeta.TagInfo) bool { return ti.Namespace == "IFD0" && ti.Tag == "Orientation" },
		HandleTag: func(ti imagemeta.TagInfo) error {
			if o, ok := ti.Value.(uint16); ok && o <= 8 {
				orientation = int(o)
			}
			return imagemeta.ErrStopWalking
		},
	})
	return orientation
}
