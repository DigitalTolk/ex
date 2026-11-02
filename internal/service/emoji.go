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
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/disintegration/imaging"
	"github.com/gen2brain/webp"

	"github.com/DigitalTolk/ex/internal/apperr"
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

// EmojiURLSigner reads an uploaded emoji, writes the copy that is served,
// and re-signs short-lived GET URLs from a stored S3 key (storage.S3Client).
type EmojiURLSigner interface {
	PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error)
	GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error)
	PutObject(ctx context.Context, key, contentType string, body []byte) error
	DeleteObject(ctx context.Context, key string) error
}

// EmojiURLTTL is how long re-signed emoji GET URLs remain valid. Short
// enough that a stale URL never lingers in caches forever, long enough
// to amortize the presign cost across a typical user session.
const EmojiURLTTL = 24 * time.Hour
const MaxEmojiImageBytes = 512 * 1024

// MaxEmojiSide is the longest side a re-encoded emoji is kept at: twice the
// largest size one is drawn at.
const MaxEmojiSide = 256

// MaxEmojiSourceSide bounds an uploaded emoji's canvas. Nothing drawn at
// emoji size needs more, and the copied animated formats are decoded by every
// viewer's browser.
const MaxEmojiSourceSide = 2048

// emojiWebP is how a still emoji is re-encoded: lossless, since emoji are
// small flat graphics whose edges lossy compression smears.
var emojiWebP = webp.Options{Lossless: true}

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
	catalog    Cache
}

// emojiCatalogKey holds the custom emoji catalog for emojiCatalogTTL, shared
// by all instances: every client loads it, and reloads it on each emoji
// change. Create and Delete drop it; emojis the history importer writes show
// within the TTL.
const (
	emojiCatalogKey = "emojis:catalog"
	emojiCatalogTTL = 15 * time.Minute
)

// emojiCatalogEntry is one cached emoji. model.CustomEmoji hides ImageKey
// from JSON, and image URLs are signed from it on every read, so it is stored
// beside it.
type emojiCatalogEntry struct {
	Emoji    model.CustomEmoji `json:"emoji"`
	ImageKey string            `json:"imageKey,omitempty"`
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

// SetCatalogCache wires the shared catalog copy (emojiCatalogKey).
func (s *EmojiService) SetCatalogCache(c Cache) { s.catalog = c }

// readCatalog returns the catalog from the shared copy, or from the store
// (filling the copy) when there is none.
func (s *EmojiService) readCatalog(ctx context.Context) ([]*model.CustomEmoji, error) {
	var entries []emojiCatalogEntry
	if s.catalog != nil && s.catalog.Get(ctx, emojiCatalogKey, &entries) == nil {
		list := make([]*model.CustomEmoji, len(entries))
		for i := range entries {
			list[i] = &entries[i].Emoji
			list[i].ImageKey = entries[i].ImageKey
		}
		return list, nil
	}
	list, err := s.emojis.List(ctx)
	if err != nil {
		return nil, fmt.Errorf("emoji: list: %w", err)
	}
	if s.catalog != nil {
		entries = make([]emojiCatalogEntry, len(list))
		for i, e := range list {
			entries[i] = emojiCatalogEntry{Emoji: *e, ImageKey: e.ImageKey}
		}
		_ = s.catalog.Set(ctx, emojiCatalogKey, entries, emojiCatalogTTL)
	}
	return list, nil
}

// dropCatalog makes the next List read the changed catalog.
func (s *EmojiService) dropCatalog(ctx context.Context) {
	if s.catalog != nil {
		_ = s.catalog.Delete(ctx, emojiCatalogKey)
	}
}

// RecordEmojiUse increments the usage count of a picked emoji shortcode for
// the given user. Best-effort: a nil store makes it a no-op.
func (s *EmojiService) RecordEmojiUse(ctx context.Context, userID, shortcode string) error {
	shortcode = strings.TrimSpace(shortcode)
	if shortcode == "" {
		return apperr.Invalid("emoji: shortcode is required")
	}
	if len(shortcode) > MaxEmojiShortcodeLen {
		return apperr.Invalid("emoji: shortcode is too long")
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
		return apperr.Invalid("emoji name must be 1-32 chars of [a-z0-9_+-]")
	}
	return nil
}

// Create stores a new custom emoji and publishes a global event so connected
// clients can refresh their emoji catalog. The client supplies only the
// server-issued upload key; the URL is derived server-side so arbitrary or
// expired client URLs are never persisted.
func (s *EmojiService) Create(ctx context.Context, userID, name, imageKey string, gettingWorkDone bool) (*model.CustomEmoji, error) {
	if err := ValidateEmojiName(name); err != nil {
		return nil, err
	}
	if imageKey == "" {
		return nil, apperr.Invalid("emoji: imageKey is required")
	}
	if !strings.HasPrefix(imageKey, "uploads/"+userID+"/") {
		return nil, apperr.Forbidden("emoji: image key is not owned by this user")
	}
	if s.signer == nil {
		return nil, errors.New("emoji: storage signer not configured")
	}

	u, err := s.users.GetUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("emoji: get user: %w", err)
	}
	if u.SystemRole == model.SystemRoleGuest {
		return nil, apperr.Forbidden("emoji: guests cannot upload emojis")
	}
	// The "Getting Work Done" shelf is workspace-curated: only admins may
	// pin emojis into it. Members can still upload unpinned emojis.
	if gettingWorkDone && u.SystemRole != model.SystemRoleAdmin {
		return nil, apperr.Forbidden("emoji: only admins can pin emojis to the Getting Work Done shelf")
	}
	keptKey, err := s.keepImage(ctx, imageKey)
	if err != nil {
		return nil, err
	}
	imageURL, err := s.resolveCreateImageURL(ctx, name, keptKey)
	if err != nil {
		s.discardKept(ctx, keptKey)
		return nil, err
	}

	e := &model.CustomEmoji{
		Name:            name,
		ImageURL:        imageURL,
		ImageKey:        keptKey,
		CreatedBy:       userID,
		CreatedAt:       time.Now(),
		GettingWorkDone: gettingWorkDone,
	}
	if err := s.emojis.Create(ctx, e); err != nil {
		s.discardKept(ctx, keptKey)
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, fmt.Errorf("emoji: name already taken: %w", ErrAlreadyExists)
		}
		return nil, fmt.Errorf("emoji: create: %w", err)
	}
	s.dropCatalog(ctx)

	events.Publish(ctx, s.publisher, pubsub.GlobalEmojiEvents(), events.EventEmojiAdded, e)
	return e, nil
}

// keepImage validates an uploaded emoji and stores the copy that is served,
// under a server-owned key, then removes the upload. The upload's PUT URL
// stays valid for its whole lifetime, so serving the upload key would serve
// whatever is written there after this check. A still picture is re-encoded
// (shrunk to MaxEmojiSide, as lossless WebP, metadata and any trailing bytes
// gone); an animated one (any GIF, an animated WebP) is copied as validated,
// since decoding every frame of a small file can take gigabytes.
func (s *EmojiService) keepImage(ctx context.Context, uploadKey string) (string, error) {
	data, err := s.readUpload(ctx, uploadKey)
	if err != nil {
		return "", err
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return "", apperr.Invalid("emoji: invalid image")
	}
	if cfg.Width > MaxEmojiSourceSide || cfg.Height > MaxEmojiSourceSide {
		return "", apperr.Invalid("emoji: image must be at most %dx%d pixels", MaxEmojiSourceSide, MaxEmojiSourceSide)
	}
	kept, contentType := data, "image/"+format
	if format != "gif" && !isAnimatedWebP(data) {
		if kept, err = reencodeEmoji(ctx, data, format, cfg); err != nil {
			return "", err
		}
		contentType = "image/webp"
	}
	key := "emojis/" + store.NewID()
	if err := s.signer.PutObject(ctx, key, contentType, kept); err != nil {
		return "", fmt.Errorf("emoji: store image: %w", err)
	}
	if err := s.signer.DeleteObject(ctx, uploadKey); err != nil {
		slog.WarnContext(ctx, "emoji: remove upload", "key", uploadKey, "error", err)
	}
	return key, nil
}

// readUpload reads an uploaded emoji, refusing anything that is not a raster
// image of 1..MaxEmojiImageBytes.
func (s *EmojiService) readUpload(ctx context.Context, key string) ([]byte, error) {
	body, contentType, size, _, err := s.signer.GetObject(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("emoji: image object missing: %w", err)
	}
	defer func() { _ = body.Close() }()
	if size <= 0 || size > MaxEmojiImageBytes {
		return nil, apperr.Invalid("emoji: image must be 1-%d bytes", MaxEmojiImageBytes)
	}
	data, err := io.ReadAll(io.LimitReader(body, MaxEmojiImageBytes+1))
	if err != nil {
		return nil, fmt.Errorf("emoji: read image: %w", err)
	}
	if len(data) == 0 || len(data) > MaxEmojiImageBytes {
		return nil, apperr.Invalid("emoji: image must be 1-%d bytes", MaxEmojiImageBytes)
	}
	declared := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if declared == "image/svg+xml" {
		return nil, apperr.Invalid("emoji: SVG images are not allowed")
	}
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if !strings.HasPrefix(declared, "image/") || !strings.HasPrefix(detected, "image/") {
		return nil, apperr.Invalid("emoji: object is not an image")
	}
	return data, nil
}

// reencodeEmoji decodes a still emoji upright, shrinks it to fit
// MaxEmojiSide and encodes it as lossless WebP, under the shared decode
// budget.
func reencodeEmoji(ctx context.Context, data []byte, format string, cfg image.Config) ([]byte, error) {
	cost := imageDecodeCostFor(format, cfg.Width, cfg.Height)
	if err := imageDecodeBudget.Acquire(ctx, cost); err != nil {
		return nil, fmt.Errorf("emoji: wait for image decode: %w", err)
	}
	defer imageDecodeBudget.Release(cost)
	img, err := imaging.Decode(bytes.NewReader(data), imaging.AutoOrientation(true))
	if err != nil {
		return nil, apperr.Invalid("emoji: invalid image")
	}
	var out bytes.Buffer
	mustEncode(webpEncode(&out, imaging.Fit(img, MaxEmojiSide, MaxEmojiSide, imaging.Lanczos), emojiWebP))
	return out.Bytes(), nil
}

// isAnimatedWebP reports whether data is an extended-format WebP whose VP8X
// header sets the animation flag (RIFF size WEBP, then "VP8X", its chunk size
// and the flags byte, animation = 0x02).
func isAnimatedWebP(data []byte) bool {
	return len(data) > 20 && string(data[8:12]) == "WEBP" && string(data[12:16]) == "VP8X" && data[20]&0x02 != 0
}

// discardKept removes a kept copy that no emoji ended up pointing at.
func (s *EmojiService) discardKept(ctx context.Context, key string) {
	if err := s.signer.DeleteObject(ctx, key); err != nil {
		slog.WarnContext(ctx, "emoji: remove unused image", "key", key, "error", err)
	}
}

func (s *EmojiService) resolveCreateImageURL(ctx context.Context, name, imageKey string) (string, error) {
	if s.mediaCache != nil {
		if mediaURL, err := StableMediaURL(ctx, s.mediaCache, "emoji", name+":"+imageKey, imageKey, name, "", 0); err == nil && mediaURL != "" {
			return mediaURL, nil
		}
	}
	// Create checked the signer before keeping the image this signs.
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
	list, err := s.readCatalog(ctx)
	if err != nil {
		return nil, err
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
			return apperr.NotFound("emoji: not found")
		}
		return fmt.Errorf("emoji: lookup: %w", err)
	}
	if u.SystemRole != model.SystemRoleAdmin && existing.CreatedBy != userID {
		return apperr.Forbidden("emoji: not authorized")
	}
	if err := s.emojis.Delete(ctx, name); err != nil {
		return fmt.Errorf("emoji: delete: %w", err)
	}
	s.dropCatalog(ctx)
	if existing.ImageKey != "" {
		s.urlCache.invalidate(existing.ImageKey)
	}
	events.Publish(ctx, s.publisher, pubsub.GlobalEmojiEvents(), events.EventEmojiRemoved, map[string]string{"name": name})
	return nil
}
