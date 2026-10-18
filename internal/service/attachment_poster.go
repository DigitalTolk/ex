package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"io"

	"github.com/DigitalTolk/ex/internal/model"
)

// maxPosterBytes caps the poster an uploader sends for a video: one frame,
// scaled down in the browser, is tens of KB.
const maxPosterBytes = 4 << 20

// Refusals the uploader's browser gets.
var (
	errPosterNotVideo = fmt.Errorf("attachment: only an MP4 video takes a poster: %w", ErrValidation)
	errPosterTooBig   = fmt.Errorf("attachment: the poster is over %d bytes: %w", maxPosterBytes, ErrValidation)
	errPosterNotImage = fmt.Errorf("attachment: the poster is not a JPEG, PNG or WebP image: %w", ErrValidation)
	errPosterPixels   = fmt.Errorf("attachment: the poster is too large to decode: %w", ErrValidation)
	errPosterExists   = fmt.Errorf("attachment: the video has a poster already: %w", ErrAlreadyExists)
)

// SetVideoPoster keeps a frame of a video attachment, captured by the
// uploader's browser, as its thumbnails — the same lossy WebP pair an image
// gets — so the message list shows the video as a picture of a known size
// instead of a file card. Only the uploader may set one, only on an MP4, and
// only once: a poster can't be swapped for another picture after the video
// has been shared.
func (s *AttachmentService) SetVideoPoster(ctx context.Context, userID, attachmentID string, body io.Reader) (*model.Attachment, error) {
	if s.signer == nil {
		return nil, errors.New("attachment: storage not configured")
	}
	a, err := s.attachments.GetByID(ctx, attachmentID)
	if err != nil {
		return nil, fmt.Errorf("attachment: get for poster: %w", err)
	}
	if a.CreatedBy != userID {
		return nil, ErrForbidden
	}
	if k := claimedKindOf(a); k == nil || k.contentType != "video/mp4" {
		return nil, errPosterNotVideo
	}
	if a.ThumbnailS3Key != "" {
		return nil, errPosterExists
	}
	data, err := io.ReadAll(io.LimitReader(body, maxPosterBytes+1))
	if err != nil {
		return nil, fmt.Errorf("attachment: read poster: %w", err)
	}
	if len(data) > maxPosterBytes {
		return nil, errPosterTooBig
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "jpeg" && format != "png" && format != "webp") {
		return nil, errPosterNotImage
	}
	cost := imageDecodeCost(cfg.Width, cfg.Height)
	if cost > maxImageDecodeBytes {
		return nil, errPosterPixels
	}
	if err := imageDecodeBudget.Acquire(ctx, cost); err != nil {
		return nil, fmt.Errorf("attachment: wait for poster decode: %w", err)
	}
	released := false
	release := func() {
		if !released {
			released = true
			imageDecodeBudget.Release(cost)
		}
	}
	defer release()
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, errPosterNotImage
	}
	// The video's own size comes with its upload; a poster's stands in for
	// an uploader that sent none, so the list can still reserve its box.
	if a.Width == 0 || a.Height == 0 {
		if err := s.syncImageDimensions(ctx, a, cfg); err != nil {
			return nil, err
		}
	}
	if err := s.storeThumbnails(ctx, a, img, release); err != nil {
		return nil, err
	}
	s.resolveAttachmentURLs(ctx, a)
	return a, nil
}
