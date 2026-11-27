package picture

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"testing"
)

// grid is a w×h picture whose pixel at x, y has red x and green y, so where a
// pixel went shows where it came from.
func grid(w, h int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetNRGBA(x, y, color.NRGBA{uint8(x), uint8(y), 0, 255})
		}
	}
	return img
}

func size(img image.Image) image.Point { return img.Bounds().Size() }

func TestFit(t *testing.T) {
	for _, tc := range []struct {
		name       string
		w, h       int
		boxW, boxH int
		want       image.Point
	}{
		{"fits already", 30, 20, 40, 40, image.Pt(30, 20)},
		{"wide", 400, 100, 100, 100, image.Pt(100, 25)},
		{"tall", 100, 400, 100, 100, image.Pt(25, 100)},
		{"a line across", 1000, 1, 10, 10, image.Pt(10, 1)},
		{"a line down", 1, 1000, 10, 10, image.Pt(1, 10)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := size(Fit(grid(tc.w, tc.h), tc.boxW, tc.boxH)); got != tc.want {
				t.Fatalf("fitted to %v, want %v", got, tc.want)
			}
		})
	}
}

// A picture that fits is copied as it is, from wherever its bounds start.
func TestFit_CopiesAPictureThatFits(t *testing.T) {
	src := grid(10, 10).SubImage(image.Rect(2, 3, 6, 8))
	got := Fit(src, 20, 20)
	if got.Rect != image.Rect(0, 0, 4, 5) {
		t.Fatalf("bounds = %v", got.Rect)
	}
	if c := got.NRGBAAt(0, 0); c.R != 2 || c.G != 3 {
		t.Fatalf("top-left = %v, want the source's pixel at 2,3", c)
	}
}

// Fill keeps the centre: a picture in three bands, red, green and blue, is
// its green middle band once cut square.
func TestFill_KeepsTheCentre(t *testing.T) {
	bands := func(w, h int, across bool) *image.NRGBA {
		img := image.NewNRGBA(image.Rect(0, 0, w, h))
		for y := range h {
			for x := range w {
				at, n := x, w
				if !across {
					at, n = y, h
				}
				c := []color.NRGBA{{255, 0, 0, 255}, {0, 255, 0, 255}, {0, 0, 255, 255}}[at*3/n]
				img.SetNRGBA(x, y, c)
			}
		}
		return img
	}
	for name, src := range map[string]image.Image{
		"wide":          bands(300, 100, true),
		"tall":          bands(100, 300, false),
		"offset bounds": bands(310, 110, true).SubImage(image.Rect(5, 5, 305, 105)),
	} {
		t.Run(name, func(t *testing.T) {
			got := Fill(src, 50, 50)
			if size(got) != image.Pt(50, 50) {
				t.Fatalf("filled to %v", size(got))
			}
			for _, p := range []image.Point{{0, 0}, {49, 0}, {0, 49}, {49, 49}, {25, 25}} {
				if c := got.NRGBAAt(p.X, p.Y); c.G < 250 || c.R > 5 || c.B > 5 {
					t.Errorf("pixel %v = %v, want the green middle", p, c)
				}
			}
		})
	}
	// A small picture is enlarged to the size asked for.
	if got := size(Fill(grid(10, 20), 50, 50)); got != image.Pt(50, 50) {
		t.Errorf("small picture filled to %v", got)
	}
}

// Every EXIF orientation shows a 3×2 picture
//
//	a b c
//	d e f
//
// as the EXIF specification draws it.
func TestUpright(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 3, 2))
	for i, v := range "abcdef" {
		src.SetNRGBA(i%3, i/3, color.NRGBA{uint8(v), 0, 0, 255})
	}
	for o, want := range map[int][]string{
		2: {"cba", "fed"},
		3: {"fed", "cba"},
		4: {"def", "abc"},
		5: {"ad", "be", "cf"},
		6: {"da", "eb", "fc"},
		7: {"fc", "eb", "da"},
		8: {"cf", "be", "ad"},
	} {
		got := Upright(src, o)
		if size(got) != image.Pt(len(want[0]), len(want)) {
			t.Errorf("%d: size %v", o, size(got))
			continue
		}
		for y, row := range want {
			for x, v := range row {
				if r := got.NRGBAAt(x, y).R; r != uint8(v) {
					t.Errorf("%d: pixel %d,%d is %q, want %q", o, x, y, r, v)
				}
			}
		}
	}
	for _, o := range []int{0, 1, 9} {
		if Upright(src, o) != src {
			t.Errorf("%d: turned", o)
		}
	}
	// Bounds that start elsewhere turn the same.
	offset := grid(5, 5).SubImage(image.Rect(1, 2, 4, 4)).(*image.NRGBA)
	if c := Upright(offset, 3).NRGBAAt(0, 0); c.R != 3 || c.G != 3 {
		t.Errorf("half a turn of an offset picture starts at %v, want its last pixel (3,3)", c)
	}
}

func TestShownSize(t *testing.T) {
	for o := range 10 {
		w, h := ShownSize(30, 20, o)
		turned := o >= 5 && o <= 8
		if turned && (w != 20 || h != 30) || !turned && (w != 30 || h != 20) {
			t.Errorf("%d: %dx%d", o, w, h)
		}
	}
}

// Stored sideways (6: a quarter turn clockwise), a 40×20 photo is shown 20
// wide and 40 tall, and shrunk into a 10×20 box it fills it.
func TestShrink(t *testing.T) {
	if got := size(Shrink(grid(40, 20), 6, 10, 20)); got != image.Pt(10, 20) {
		t.Fatalf("shrunk to %v, want 10x20", got)
	}
}

// Beside a transparent edge, the resampler's negative lobes push colour past
// alpha; divided out, such a colour wrapped round to a dark fringe. Across an
// edge from opaque black to half-transparent white, the colour as shown only
// ever gets lighter.
func TestFit_LeavesNoFringeAtATransparentEdge(t *testing.T) {
	src := image.NewNRGBA(image.Rect(0, 0, 60, 1))
	for x := range 60 {
		c := color.NRGBA{0, 0, 0, 255}
		if x >= 30 {
			c = color.NRGBA{255, 255, 255, 128}
		}
		src.SetNRGBA(x, 0, c)
	}
	got := Fit(src, 20, 1)
	last := uint8(0)
	for x := range 20 {
		c := got.NRGBAAt(x, 0)
		if c.R < last {
			t.Fatalf("colour at %d is %d after %d: a fringe (%v)", x, c.R, last, got.Pix)
		}
		last = c.R
	}
	if last != 255 {
		t.Fatalf("the white side ends at %d", last)
	}
}

func TestRGBA(t *testing.T) {
	rgba := image.NewRGBA(image.Rect(0, 0, 2, 2))
	if RGBA(rgba) != rgba {
		t.Error("an RGBA picture was copied")
	}
	if got := RGBA(grid(2, 2)); got.Bounds() != rgba.Bounds() {
		t.Errorf("copy bounds = %v", got.Bounds())
	}
}

// cameraJPEG is a JPEG with an EXIF segment saying orientation.
func cameraJPEG(t *testing.T, orientation uint16) []byte {
	t.Helper()
	var plain bytes.Buffer
	if err := jpeg.Encode(&plain, grid(4, 2), nil); err != nil {
		t.Fatal(err)
	}
	// TIFF header (big-endian), one IFD0 entry: Orientation, SHORT, 1 value.
	tiff := []byte{'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1}
	tiff = binary.BigEndian.AppendUint16(tiff, orientation)
	tiff = append(tiff, 0, 0, 0, 0, 0, 0)
	payload := append([]byte("Exif\x00\x00"), tiff...)
	app1 := binary.BigEndian.AppendUint16([]byte{0xFF, 0xE1}, uint16(len(payload)+2))
	app1 = append(app1, payload...)
	data := plain.Bytes()
	return append(append(append([]byte{}, data[:2]...), app1...), data[2:]...)
}

func TestJPEGOrientation(t *testing.T) {
	if got := JPEGOrientation(cameraJPEG(t, 6)); got != 6 {
		t.Errorf("orientation 6 read as %d", got)
	}
	if got := JPEGOrientation(cameraJPEG(t, 9)); got != 0 {
		t.Errorf("no such orientation (9) read as %d", got)
	}
	var plain bytes.Buffer
	if err := jpeg.Encode(&plain, grid(4, 2), nil); err != nil {
		t.Fatal(err)
	}
	if got := JPEGOrientation(plain.Bytes()); got != 0 {
		t.Errorf("a JPEG without EXIF read as %d", got)
	}
	if got := JPEGOrientation([]byte("not a picture")); got != 0 {
		t.Errorf("junk read as %d", got)
	}
}
