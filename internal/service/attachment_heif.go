package service

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/disintegration/imaging"
	"github.com/gabriel-vasile/mimetype"
	// Registers the "heic" image format, so image.DecodeConfig and
	// image.Decode read HEIC/HEIF photos (what iPhones take) like the other
	// formats the upload pipeline accepts. Decode hands back the pixels as
	// stored; heifOrientation says how they are shown.
	_ "github.com/gen2brain/h265/heic"

	"github.com/DigitalTolk/ex/internal/model"
)

// A HEIC photo is kept as it was uploaded, and downloading it gives that
// file, but most browsers cannot show one. So the server makes a WebP copy
// for viewing, no larger than displayMaxSide on either side, and that copy
// is what the attachment's URL serves (the lightbox opens it). The
// thumbnails are made from it rather than from the full photo.
const displayMaxSide = 2048

// isHEIF reports whether a content type is a HEIF photo, which the
// attachment's URL shows through its viewing copy.
func isHEIF(contentType string) bool {
	switch normalizeContentType(contentType) {
	case "image/heic", "image/heif":
		return true
	}
	return false
}

// sniffsAsImage reports whether a file's first bytes look like an image
// (whether they are the image the upload says is decided by decoding it).
// Go's sniffer knows no HEIF, mimetype does.
func sniffsAsImage(head []byte) bool {
	if http.DetectContentType(head) != "application/octet-stream" {
		return true
	}
	m := mimetype.Detect(head)
	return m.Is("image/heic") || m.Is("image/heif")
}

// shownOrientation is the EXIF orientation (1–8, 0 for none) an image's
// stored pixels are shown in. A JPEG says it in EXIF. A HEIF file says it in
// its own rotation and mirroring boxes, and any EXIF it carries does not
// count (MIAF 7.3.6.7).
func shownOrientation(format string, header []byte) int {
	if format == "heic" {
		return heifOrientation(header)
	}
	return exifOrientation(header)
}

// decodeCost is the decode budget an image needs (see decodeBytesPerPixel).
// A HEIF image above 8 bits decodes to 16-bit RGBA through 16-bit planes:
// half as much again.
func decodeCost(format string, cfg image.Config) int64 {
	cost := imageDecodeCost(cfg.Width, cfg.Height)
	if format == "heic" && cfg.ColorModel == color.NRGBA64Model {
		cost += cost / 2
	}
	return cost
}

// heifOrientations maps the rotation a HEIF image is shown with (irot: 0–3
// quarter turns anticlockwise) and the mirroring that follows it (imir:
// none, top to bottom for axis 0, left to right for axis 1) to the EXIF
// orientation that shows its pixels the same way.
var heifOrientations = [4][3]int{
	{1, 4, 2},
	{8, 5, 7},
	{3, 2, 4},
	{6, 7, 5},
}

// heifOrientation is the EXIF orientation equivalent to the irot and imir
// properties of a HEIF file's primary image, read from the file's header (its
// meta box). A header it cannot read is shown as stored (0).
func heifOrientation(header []byte) int {
	meta := isoChild(header, "meta")
	if len(meta) < 4 {
		return 0
	}
	// meta is a full box: version and flags come first.
	meta = meta[4:]
	iprp := isoChild(meta, "iprp")

	pitm := isoReader{b: isoChild(meta, "pitm")}
	pitmVersion := pitm.n(1)
	pitm.n(3) // flags
	primary := pitm.n(itemIDBytes(pitmVersion))

	var props [][]byte
	var types []string
	eachISOBox(isoChild(iprp, "ipco"), func(typ string, body []byte) bool {
		types = append(types, typ)
		props = append(props, body)
		return true
	})

	// ipma lists, per item, the 1-based indexes into ipco of its properties.
	// With flag 1 set an index takes 15 bits, otherwise 7; the top bit marks
	// a property essential.
	ipma := isoReader{b: isoChild(iprp, "ipma")}
	version := ipma.n(1)
	wide := int(ipma.n(3) & 1)
	angle, mirror := 0, 0
	for entries := ipma.n(4); entries > 0 && !ipma.bad; entries-- {
		item := ipma.n(itemIDBytes(version))
		for count := ipma.n(1); count > 0; count-- {
			index := int(ipma.n(1+wide) & (0x7f | uint32(wide)*0x7f80))
			if item != primary || index < 1 || index > len(props) || len(props[index-1]) == 0 {
				continue
			}
			switch types[index-1] {
			case "irot":
				angle = int(props[index-1][0] & 3)
			case "imir":
				mirror = 1 + int(props[index-1][0]&1)
			}
		}
	}
	if pitm.bad || ipma.bad {
		return 0
	}
	return heifOrientations[angle][mirror]
}

// itemIDBytes is the width of an item ID in a pitm or ipma box of a version:
// 16 bits in version 0, 32 after.
func itemIDBytes(version uint32) int {
	return 2 << min(version, 1)
}

// isoReader reads big-endian numbers off an ISO BMFF box body. Reading past
// the end sets bad and reads zero from then on.
type isoReader struct {
	b   []byte
	bad bool
}

// n reads a k-byte number (k ≤ 4).
func (r *isoReader) n(k int) uint32 {
	if r.bad || len(r.b) < k {
		r.bad = true
		return 0
	}
	var v uint32
	for _, c := range r.b[:k] {
		v = v<<8 | uint32(c)
	}
	r.b = r.b[k:]
	return v
}

// eachISOBox calls fn with the type and body of each ISO BMFF box in b, in
// order, until fn returns false or a box runs past the end of b.
func eachISOBox(b []byte, fn func(typ string, body []byte) bool) {
	for len(b) >= 8 {
		size, header := uint64(binary.BigEndian.Uint32(b)), uint64(8)
		switch {
		case size == 0:
			// The last box: it runs to the end.
			size = uint64(len(b))
		case size == 1 && len(b) >= 16:
			size, header = binary.BigEndian.Uint64(b[8:]), 16
		}
		if size < header || size > uint64(len(b)) {
			return
		}
		if !fn(string(b[4:8]), b[header:size]) {
			return
		}
		b = b[size:]
	}
}

// isoChild is the body of the first box of a type in b, or nil.
func isoChild(b []byte, typ string) []byte {
	var body []byte
	eachISOBox(b, func(t string, bb []byte) bool {
		if t != typ {
			return true
		}
		body = bb
		return false
	})
	return body
}

// viewingCopy is the picture a HEIF photo's viewing copy and thumbnails are
// made from: the stored pixels fitted within displayMaxSide, or the decoded
// image itself when it already fits.
func viewingCopy(img image.Image) *image.NRGBA {
	b := img.Bounds()
	if n, ok := img.(*image.NRGBA); ok && b.Dx() <= displayMaxSide && b.Dy() <= displayMaxSide {
		return n
	}
	return imaging.Fit(img, displayMaxSide, displayMaxSide, imaging.Lanczos)
}

// encodeWebPDisplay encodes a viewing copy upright as a lossy WebP.
func encodeWebPDisplay(view *image.NRGBA, orientation int) []byte {
	var out bytes.Buffer
	mustEncode(webpEncode(&out, upright(view, orientation), lossyWebP))
	return out.Bytes()
}

// displayObjectKey is where a HEIF attachment's viewing copy is stored.
func displayObjectKey(a *model.Attachment) string {
	return "attachments/" + a.ID + "/display.webp"
}

// hasDisplayCopy reports whether an attachment's URL serves its viewing copy:
// a HEIF photo whose thumbnails exist (its viewing copy is stored before
// them, in the same step).
func hasDisplayCopy(a *model.Attachment) bool {
	return isHEIF(a.ContentType) && a.ThumbnailS3Key != ""
}

// displayFilename names a viewing copy after its photo: IMG_0001.HEIC is
// shown as IMG_0001.webp.
func displayFilename(filename string) string {
	return strings.TrimSuffix(filename, filepath.Ext(filename)) + ".webp"
}
