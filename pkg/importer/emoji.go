package importer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	"github.com/gen2brain/webp"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// The limits and encoding of an uploaded custom emoji (internal/service/emoji.go).
const (
	maxEmojiImageBytes = 512 * 1024
	maxEmojiSide       = 256
	maxEmojiSourceSide = 2048
)

var emojiNameRE = regexp.MustCompile(`^[a-z0-9_+-]{1,32}$`)

// webpEncode is a seam over webp.Encode for the encode-failure arm.
var webpEncode = webp.Encode

// EmojiSpec describes a custom emoji to create.
type EmojiSpec struct {
	Name      string
	CreatedBy string // ex user ID
	CreatedAt time.Time
}

// UpsertEmoji creates a workspace custom emoji from image unless one with
// spec.Name exists; an existing emoji is left untouched. The image is checked
// and kept the way ex keeps an upload: a still picture is shrunk to 256px and
// re-encoded as lossless WebP, an animated one (GIF, animated WebP) is copied.
// Messages and reactions refer to custom emoji by name, so history imported
// with ":name:" shows the emoji once it exists. Connected clients see it after
// their next reload (no event is published). Returns whether it was created.
func (im *Importer) UpsertEmoji(ctx context.Context, spec EmojiSpec, img []byte) (bool, error) {
	if !emojiNameRE.MatchString(spec.Name) {
		return false, invalid("emoji name %q must be 1-32 chars of [a-z0-9_+-]", spec.Name)
	}
	if spec.CreatedBy == "" {
		return false, invalid("emoji %s: creator is required", spec.Name)
	}
	if im.objects == nil {
		return false, ErrNoObjectStore
	}
	if _, err := im.emojis.GetByName(ctx, spec.Name); err == nil {
		return false, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return false, fmt.Errorf("importer: get emoji: %w", err)
	}
	kept, contentType, err := keepEmojiImage(img)
	if err != nil {
		return false, fmt.Errorf("emoji %s: %w", spec.Name, err)
	}
	key := "emojis/" + store.NewID()
	sum := sha256.Sum256(kept)
	if _, err := im.objects.PutChecksummedObject(ctx, key, contentType, bytes.NewReader(kept), int64(len(kept)), hex.EncodeToString(sum[:])); err != nil {
		return false, fmt.Errorf("importer: store emoji image: %w", err)
	}
	created := spec.CreatedAt
	if created.IsZero() {
		created = time.Now()
	}
	// ImageURL stays empty: ex signs a URL from ImageKey whenever it lists emoji.
	err = im.emojis.Create(ctx, &model.CustomEmoji{Name: spec.Name, ImageKey: key, CreatedBy: spec.CreatedBy, CreatedAt: created})
	if err != nil {
		_ = im.objects.DeleteObject(ctx, key)
		if errors.Is(err, store.ErrAlreadyExists) {
			return false, nil // created concurrently
		}
		return false, fmt.Errorf("importer: create emoji: %w", err)
	}
	return true, nil
}

// keepEmojiImage applies ex's emoji upload rules (EmojiService.keepImage) and
// returns the bytes to store with their content type.
func keepEmojiImage(data []byte) ([]byte, string, error) {
	if len(data) == 0 || len(data) > maxEmojiImageBytes {
		return nil, "", invalid("image must be 1-%d bytes, got %d", maxEmojiImageBytes, len(data))
	}
	if detected := http.DetectContentType(data); !strings.HasPrefix(detected, "image/") || strings.HasPrefix(detected, "image/svg") {
		return nil, "", invalid("not a raster image (%s)", detected)
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, "", invalid("invalid image: %v", err)
	}
	if cfg.Width > maxEmojiSourceSide || cfg.Height > maxEmojiSourceSide {
		return nil, "", invalid("image must be at most %dx%d pixels", maxEmojiSourceSide, maxEmojiSourceSide)
	}
	if format == "gif" || isAnimatedWebP(data) {
		return data, "image/" + format, nil
	}
	pic, err := imaging.Decode(bytes.NewReader(data), imaging.AutoOrientation(true))
	if err != nil {
		return nil, "", invalid("invalid image: %v", err)
	}
	var out bytes.Buffer
	if err := webpEncode(&out, imaging.Fit(pic, maxEmojiSide, maxEmojiSide, imaging.Lanczos), webp.Options{Lossless: true}); err != nil {
		return nil, "", fmt.Errorf("encode image: %w", err)
	}
	return out.Bytes(), "image/webp", nil
}

// isAnimatedWebP reports whether data is an extended-format WebP whose VP8X
// header sets the animation flag.
func isAnimatedWebP(data []byte) bool {
	return len(data) > 20 && string(data[8:12]) == "WEBP" && string(data[12:16]) == "VP8X" && data[20]&0x02 != 0
}
