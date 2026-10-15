package service

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"github.com/gabriel-vasile/mimetype"

	"github.com/DigitalTolk/ex/internal/model"
)

// sniffHeadBytes is how much of a file its content check reads: what
// mimetype looks at to tell what a file is.
const sniffHeadBytes = 4096

// claimedKind is a file type the app opens in its own viewer — a PDF in the
// PDF reader, an MP4 in the video player — so a file that claims to be one
// must really be one. A file claims it by its declared content type or by
// its file name's extension, whichever the client sent; its first bytes
// decide.
type claimedKind struct {
	name        string
	contentType string
	extensions  []string
	// What mimetype may detect for the bytes to count as this kind.
	detected []string
}

var claimedKinds = []claimedKind{
	{
		name:        "a PDF",
		contentType: "application/pdf",
		extensions:  []string{".pdf"},
		detected:    []string{"application/pdf"},
	},
	{
		name:        "an MP4 video",
		contentType: "video/mp4",
		extensions:  []string{".mp4", ".m4v"},
		// Any ISO media file is video/mp4 to mimetype unless it is something
		// more specific (an M4A, a HEIC photo, a 3GP): only these two pass.
		detected: []string{"video/mp4", "video/x-m4v"},
	},
}

// claimedKindOf returns the kind an attachment claims to be, or nil. It is
// asked only of non-images: an image goes to the image checks, which decode
// it.
func claimedKindOf(a *model.Attachment) *claimedKind {
	declared := normalizeContentType(a.ContentType)
	ext := strings.ToLower(filepath.Ext(a.Filename))
	for i := range claimedKinds {
		k := &claimedKinds[i]
		if declared == k.contentType || slices.Contains(k.extensions, ext) {
			return k
		}
	}
	return nil
}

// check rejects a file whose first bytes are not what it claims to be. The
// message is the one the uploader sees.
func (k *claimedKind) check(filename string, head []byte) error {
	got := mimetype.Detect(head)
	for _, want := range k.detected {
		if got.Is(want) {
			return nil
		}
	}
	return fmt.Errorf("attachment: %s is not %s", filename, k.name)
}
