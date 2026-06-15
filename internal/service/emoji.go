package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	_ "golang.org/x/image/webp"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// EmojiStore defines the persistence operations the EmojiService depends on.
type EmojiStore interface {
	Create(ctx context.Context, e *model.CustomEmoji) error
	GetByName(ctx context.Context, name string) (*model.CustomEmoji, error)
	List(ctx context.Context) ([]*model.CustomEmoji, error)
	Delete(ctx context.Context, name string) error
}

// EmojiFrequencyStore records and ranks a user's emoji usage. RedisCache
// implements it; when unset the feature is simply inert (best-effort).
type EmojiFrequencyStore interface {
	IncrementEmojiFrequency(ctx context.Context, userID, shortcode string) error
	FrequentEmojis(ctx context.Context, userID string, limit int) ([]string, error)
}

// EmojiURLSigner re-signs short-lived GET URLs from a stored S3 key.
// AttachmentSigner already implements this shape; the narrower interface
// here just documents what EmojiService actually uses.
type EmojiURLSigner interface {
	PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error)
	GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error)
}

// EmojiURLTTL is how long re-signed emoji GET URLs remain valid. Short
// enough that a stale URL never lingers in caches forever, long enough
// to amortize the presign cost across a typical user session.
const EmojiURLTTL = 24 * time.Hour
const MaxEmojiImageBytes = 512 * 1024

// EmojiService manages workspace custom emojis.
type EmojiService struct {
	emojis    EmojiStore
	users     UserStore
	publisher Publisher
	signer    EmojiURLSigner
	// urlCache memoises presigned emoji image URLs so repeated List
	// calls return identical URLs — without it every reload would
	// hand out fresh signatures and the browser would re-download
	// every emoji on every page view.
	urlCache   *presignedURLCache
	mediaCache MediaURLCache
	frequency  EmojiFrequencyStore
}

// MaxFrequentEmoji caps how many frequently-used shortcodes the service will
// ever return, regardless of the requested limit.
const MaxFrequentEmoji = 50

// MaxEmojiShortcodeLen bounds a recorded shortcode so a malicious client
// can't store oversized members in the sorted set.
const MaxEmojiShortcodeLen = 128

// NewEmojiService constructs an EmojiService.
func NewEmojiService(emojis EmojiStore, users UserStore, publisher Publisher) *EmojiService {
	return &EmojiService{
		emojis:    emojis,
		users:     users,
		publisher: publisher,
		// The cache constructor caps this to a short safety window so
		// temporary AWS security tokens embedded in presigned URLs never
		// linger for hours after expiry.
		urlCache: newPresignedURLCache(20 * time.Hour),
	}
}

// SetSigner wires the URL re-signer. Optional — when unset, List returns
// stored URLs as-is. Production wiring always passes the S3 client.
func (s *EmojiService) SetSigner(signer EmojiURLSigner) { s.signer = signer }

func (s *EmojiService) SetMediaURLCache(c MediaURLCache) { s.mediaCache = c }

// SetFrequencyStore wires the per-user emoji-usage tracker. Optional — when
// unset, RecordEmojiUse is a no-op and FrequentEmojis returns an empty list.
func (s *EmojiService) SetFrequencyStore(f EmojiFrequencyStore) { s.frequency = f }

// RecordEmojiUse increments the usage count of a picked emoji shortcode for
// the given user. Best-effort: a nil store makes it a no-op.
func (s *EmojiService) RecordEmojiUse(ctx context.Context, userID, shortcode string) error {
	shortcode = strings.TrimSpace(shortcode)
	if shortcode == "" {
		return errors.New("emoji: shortcode is required")
	}
	if len(shortcode) > MaxEmojiShortcodeLen {
		return errors.New("emoji: shortcode is too long")
	}
	if s.frequency == nil {
		return nil
	}
	if err := s.frequency.IncrementEmojiFrequency(ctx, userID, shortcode); err != nil {
		return fmt.Errorf("emoji: record use: %w", err)
	}
	return nil
}

// FrequentEmojis returns up to limit of the user's most-used emoji shortcodes.
func (s *EmojiService) FrequentEmojis(ctx context.Context, userID string, limit int) ([]string, error) {
	if s.frequency == nil {
		return []string{}, nil
	}
	if limit <= 0 || limit > MaxFrequentEmoji {
		limit = MaxFrequentEmoji
	}
	out, err := s.frequency.FrequentEmojis(ctx, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("emoji: frequent: %w", err)
	}
	if out == nil {
		out = []string{}
	}
	return out, nil
}

var emojiNameRE = regexp.MustCompile(`^[a-z0-9_+-]{1,32}$`)

// ValidateName returns an error if name is not a valid emoji shortcode.
func ValidateEmojiName(name string) error {
	if !emojiNameRE.MatchString(name) {
		return errors.New("emoji name must be 1-32 chars of [a-z0-9_+-]")
	}
	return nil
}

// Create stores a new custom emoji and publishes a global event so connected
// clients can refresh their emoji catalog. The client supplies only the
// server-issued upload key; the URL is derived server-side so arbitrary or
// expired client URLs are never persisted.
func (s *EmojiService) Create(ctx context.Context, userID, name, imageKey string) (*model.CustomEmoji, error) {
	if err := ValidateEmojiName(name); err != nil {
		return nil, err
	}
	if imageKey == "" {
		return nil, errors.New("emoji: imageKey is required")
	}
	if !strings.HasPrefix(imageKey, "uploads/"+userID+"/") {
		return nil, errors.New("emoji: image key is not owned by this user")
	}
	if err := s.validateImageObject(ctx, imageKey); err != nil {
		return nil, err
	}

	u, err := s.users.GetUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("emoji: get user: %w", err)
	}
	if u.SystemRole == model.SystemRoleGuest {
		return nil, errors.New("emoji: guests cannot upload emojis")
	}
	imageURL, err := s.resolveCreateImageURL(ctx, name, imageKey)
	if err != nil {
		return nil, err
	}

	e := &model.CustomEmoji{
		Name:      name,
		ImageURL:  imageURL,
		ImageKey:  imageKey,
		CreatedBy: userID,
		CreatedAt: time.Now(),
	}
	if err := s.emojis.Create(ctx, e); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, errors.New("emoji: name already taken")
		}
		return nil, fmt.Errorf("emoji: create: %w", err)
	}

	events.Publish(ctx, s.publisher, pubsub.GlobalEmojiEvents(), events.EventEmojiAdded, e)
	return e, nil
}

func (s *EmojiService) validateImageObject(ctx context.Context, imageKey string) error {
	if s.signer == nil {
		return errors.New("emoji: storage signer not configured")
	}
	body, contentType, size, _, err := s.signer.GetObject(ctx, imageKey)
	if err != nil {
		return fmt.Errorf("emoji: image object missing: %w", err)
	}
	defer func() { _ = body.Close() }()
	if size <= 0 || size > MaxEmojiImageBytes {
		return fmt.Errorf("emoji: image must be 1-%d bytes", MaxEmojiImageBytes)
	}
	data, err := io.ReadAll(io.LimitReader(body, MaxEmojiImageBytes+1))
	if err != nil {
		return fmt.Errorf("emoji: read image: %w", err)
	}
	if len(data) == 0 || len(data) > MaxEmojiImageBytes {
		return fmt.Errorf("emoji: image must be 1-%d bytes", MaxEmojiImageBytes)
	}
	declared := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if declared == "image/svg+xml" {
		return errors.New("emoji: SVG images are not allowed")
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if !strings.HasPrefix(declared, "image/") || !strings.HasPrefix(detected, "image/") {
		return errors.New("emoji: object is not an image")
	}
	if _, _, err := image.DecodeConfig(bytes.NewReader(data)); err != nil {
		return errors.New("emoji: invalid image")
	}
	return nil
}

func (s *EmojiService) resolveCreateImageURL(ctx context.Context, name, imageKey string) (string, error) {
	if s.mediaCache != nil {
		if mediaURL, err := StableMediaURL(ctx, s.mediaCache, "emoji", name+":"+imageKey, imageKey, name, "", 0); err == nil && mediaURL != "" {
			return mediaURL, nil
		}
	}
	if s.signer == nil {
		return "", errors.New("emoji: storage signer not configured")
	}
	url, err := s.signer.PresignedGetURL(ctx, imageKey, EmojiURLTTL)
	if err != nil {
		return "", fmt.Errorf("emoji: sign image url: %w", err)
	}
	return url, nil
}

// List returns all custom emojis with freshly signed image URLs. Without
// re-signing, the stored URLs would expire after 7 days and every
// emoji on the workspace would silently break. Emojis missing ImageKey
// (created before the field existed) keep their stored URL — they'll
// need a one-time re-upload to self-heal.
func (s *EmojiService) List(ctx context.Context) ([]*model.CustomEmoji, error) {
	list, err := s.emojis.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("emoji: list: %w", err)
	}
	if s.signer != nil {
		for _, e := range list {
			if e.ImageKey == "" {
				continue
			}
			if s.mediaCache != nil {
				if mediaURL, err := StableMediaURL(ctx, s.mediaCache, "emoji", e.Name+":"+e.ImageKey, e.ImageKey, e.Name, "", 0); err == nil {
					e.ImageURL = mediaURL
					continue
				}
			}
			url, err := s.urlCache.getOrSign(ctx, presignedKey{op: "get", key: e.ImageKey},
				func(ctx context.Context) (string, error) {
					return s.signer.PresignedGetURL(ctx, e.ImageKey, EmojiURLTTL)
				})
			if err != nil {
				continue
			}
			e.ImageURL = url
		}
	}
	return list, nil
}

// Delete removes a custom emoji. Only admins or the creator may delete.
func (s *EmojiService) Delete(ctx context.Context, userID, name string) error {
	u, err := s.users.GetUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("emoji: get user: %w", err)
	}
	existing, err := s.emojis.GetByName(ctx, name)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return errors.New("emoji: not found")
		}
		return fmt.Errorf("emoji: lookup: %w", err)
	}
	if u.SystemRole != model.SystemRoleAdmin && existing.CreatedBy != userID {
		return errors.New("emoji: not authorized")
	}
	if err := s.emojis.Delete(ctx, name); err != nil {
		return fmt.Errorf("emoji: delete: %w", err)
	}
	if existing.ImageKey != "" {
		s.urlCache.invalidate(existing.ImageKey)
	}
	events.Publish(ctx, s.publisher, pubsub.GlobalEmojiEvents(), events.EventEmojiRemoved, map[string]string{"name": name})
	return nil
}
