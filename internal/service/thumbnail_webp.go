package service

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"io"
	"time"
)

// maxThumbnailBytes caps the stored thumbnail a re-encode reads. Lossless
// thumbnails of the largest size run to about 1 MB.
const maxThumbnailBytes = 8 << 20

// ThumbnailObjects reads and rewrites stored thumbnails.
type ThumbnailObjects interface {
	GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error)
	PutObject(ctx context.Context, key, contentType string, body []byte) error
}

// isLosslessWebP reports whether data is a simple-format lossless WebP, which
// is how thumbnails were written before they were lossy.
func isLosslessWebP(data []byte) bool {
	return len(data) >= 16 && string(data[0:4]) == "RIFF" && string(data[8:12]) == "WEBP" && string(data[12:16]) == "VP8L"
}

// ReencodeThumbnail rewrites a lossless WebP thumbnail as lossy WebP under the
// same key. The picture is the same, so every URL to it stays valid; only the
// bytes shrink. A thumbnail that lossy would not make smaller (a few flat
// colours) and anything that is not a lossless WebP are left alone. With
// dryRun nothing is written, and a lossless thumbnail is reported without
// trying. Reports whether it was (or would be) rewritten.
func ReencodeThumbnail(ctx context.Context, objects ThumbnailObjects, key string, dryRun bool) (bool, error) {
	body, _, _, _, err := objects.GetObject(ctx, key)
	if err != nil {
		return false, fmt.Errorf("thumbnail: read %s: %w", key, err)
	}
	defer func() { _ = body.Close() }()
	data, err := io.ReadAll(io.LimitReader(body, maxThumbnailBytes+1))
	if err != nil {
		return false, fmt.Errorf("thumbnail: read %s: %w", key, err)
	}
	if len(data) > maxThumbnailBytes {
		return false, fmt.Errorf("thumbnail: %s is over %d bytes", key, maxThumbnailBytes)
	}
	if !isLosslessWebP(data) {
		return false, nil
	}
	if dryRun {
		return true, nil
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return false, fmt.Errorf("thumbnail: decode %s: %w", key, err)
	}
	var out bytes.Buffer
	mustEncode(webpEncode(&out, img, lossyWebP))
	if out.Len() >= len(data) {
		return false, nil
	}
	if err := objects.PutObject(ctx, key, "image/webp", out.Bytes()); err != nil {
		return false, fmt.Errorf("thumbnail: write %s: %w", key, err)
	}
	return true, nil
}
