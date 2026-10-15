package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	// Avatars arrive as JPEG, PNG or WebP; WebP's decoder comes with
	// github.com/gen2brain/webp (see attachment.go).
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log/slog"
	"time"

	"github.com/disintegration/imaging"

	"github.com/DigitalTolk/ex/internal/store"
)

// MaxAvatarSide is the longest side, in pixels, an avatar is kept at. Uploads
// are shrunk to fit. A camera photo kept at full size costs every browser that
// shows it ~50 MB of decoded pixels however small it is drawn, and a channel
// full of them is enough to run a phone out of memory.
const MaxAvatarSide = 1024

// MaxAvatarBytes caps an uploaded avatar file.
const MaxAvatarBytes = 2 << 20

// AvatarObjects reads uploaded avatars from storage and writes the copies that
// are kept.
type AvatarObjects interface {
	GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error)
	PutObject(ctx context.Context, key, contentType string, body []byte) error
	DeleteObject(ctx context.Context, key string) error
}

// avatarRejection is an avatar the server will not keep. Its text is the
// message the uploader sees, and it counts as ErrValidation.
type avatarRejection string

func (e avatarRejection) Error() string { return string(e) }

func (avatarRejection) Is(target error) bool { return target == ErrValidation }

const (
	errAvatarFormat = avatarRejection("Only JPEG, PNG, or WebP images are allowed")
	errAvatarBytes  = avatarRejection("Image must be smaller than 2MB")
	errAvatarPixels = avatarRejection("Image dimensions are too large")
)

var errAvatarStorage = errors.New("user: avatar storage is not configured")

// avatarDecodeCost is the decode budget an avatar holds: the decoded frame
// (see decodeBytesPerPixel) plus the upright NRGBA copy auto-orientation
// makes of it.
func avatarDecodeCost(cfg image.Config) int64 {
	return imageDecodeCost(cfg.Width, cfg.Height) + int64(cfg.Width)*int64(cfg.Height)*4
}

// readAvatar reads a stored avatar, refusing one over MaxAvatarBytes (a
// presigned PUT does not bind the size its caller declared).
func (s *UserService) readAvatar(ctx context.Context, key string) ([]byte, error) {
	body, _, _, _, err := s.avatarObjects.GetObject(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("user: read avatar: %w", err)
	}
	defer func() { _ = body.Close() }()
	data, err := io.ReadAll(io.LimitReader(body, MaxAvatarBytes+1))
	if err != nil {
		return nil, fmt.Errorf("user: read avatar: %w", err)
	}
	if len(data) > MaxAvatarBytes {
		return nil, errAvatarBytes
	}
	return data, nil
}

// avatarConfig reads an avatar's format and dimensions without decoding it.
func avatarConfig(data []byte) (image.Config, error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return cfg, errAvatarFormat
	}
	switch format {
	case "jpeg", "png", "webp":
	default:
		return cfg, errAvatarFormat
	}
	if avatarDecodeCost(cfg) > maxImageDecodeBytes {
		return cfg, errAvatarPixels
	}
	return cfg, nil
}

// shrinkAvatar turns an avatar file into the one that is kept: turned upright
// per its EXIF orientation, shrunk to fit MaxAvatarSide, and re-encoded as
// lossy WebP, which also drops its metadata (a phone photo's says where it
// was taken).
func shrinkAvatar(ctx context.Context, data []byte) ([]byte, error) {
	cfg, err := avatarConfig(data)
	if err != nil {
		return nil, err
	}
	cost := avatarDecodeCost(cfg)
	if err := imageDecodeBudget.Acquire(ctx, cost); err != nil {
		return nil, fmt.Errorf("user: wait for avatar decode: %w", err)
	}
	defer imageDecodeBudget.Release(cost)
	img, err := imaging.Decode(bytes.NewReader(data), imaging.AutoOrientation(true))
	if err != nil {
		return nil, errAvatarFormat
	}
	var out bytes.Buffer
	mustEncode(webpEncode(&out, imaging.Fit(img, MaxAvatarSide, MaxAvatarSide, imaging.Lanczos), lossyWebP))
	return out.Bytes(), nil
}

// keepAvatar stores a shrunk copy of an avatar file under a new key and
// returns that key.
func (s *UserService) keepAvatar(ctx context.Context, userID string, data []byte) (string, error) {
	encoded, err := shrinkAvatar(ctx, data)
	if err != nil {
		return "", err
	}
	key := "avatars/" + userID + "/" + store.NewID()
	if err := s.avatarObjects.PutObject(ctx, key, "image/webp", encoded); err != nil {
		return "", fmt.Errorf("user: store avatar: %w", err)
	}
	return key, nil
}

// storeUploadedAvatar keeps a shrunk copy of a freshly uploaded avatar and
// removes the upload, kept or not: a profile never points at an unprocessed
// file.
func (s *UserService) storeUploadedAvatar(ctx context.Context, userID, uploadKey string) (string, error) {
	if s.avatarObjects == nil {
		return "", errAvatarStorage
	}
	defer func() {
		if err := s.avatarObjects.DeleteObject(ctx, uploadKey); err != nil {
			slog.Warn("user: remove avatar upload", "key", uploadKey, "error", err)
		}
	}()
	data, err := s.readAvatar(ctx, uploadKey)
	if err != nil {
		return "", err
	}
	return s.keepAvatar(ctx, userID, data)
}

// ShrinkAvatar replaces a user's avatar with a copy that fits MaxAvatarSide
// when it is bigger. Avatars kept before uploads were shrunk are full-size
// photos. The original object stays, since clients may still hold its URL
// until user.updated reaches them. With dryRun nothing is written. Reports
// whether the avatar was (or would be) replaced.
func (s *UserService) ShrinkAvatar(ctx context.Context, userID string, dryRun bool) (bool, error) {
	if s.avatarObjects == nil {
		return false, errAvatarStorage
	}
	user, err := s.users.GetUser(ctx, userID)
	if err != nil {
		return false, fmt.Errorf("user: get: %w", err)
	}
	if user.AvatarKey == "" {
		return false, nil
	}
	data, err := s.readAvatar(ctx, user.AvatarKey)
	if err != nil {
		return false, err
	}
	cfg, err := avatarConfig(data)
	if err != nil {
		return false, err
	}
	if max(cfg.Width, cfg.Height) <= MaxAvatarSide {
		return false, nil
	}
	if dryRun {
		return true, nil
	}
	key, err := s.keepAvatar(ctx, userID, data)
	if err != nil {
		return false, err
	}
	s.urlCache.invalidate(user.AvatarKey)
	user.AvatarKey = key
	user.UpdatedAt = time.Now()
	if _, err := s.saveProfile(ctx, user); err != nil {
		return false, err
	}
	return true, nil
}
