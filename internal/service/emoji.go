package service

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"

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

// EmojiURLSigner re-signs short-lived GET URLs from a stored S3 key.
// AttachmentSigner already implements this shape; the narrower interface
// here just documents what EmojiService actually uses.
type EmojiURLSigner interface {
	PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error)
}

// EmojiURLTTL is how long re-signed emoji GET URLs remain valid. Short
// enough that a stale URL never lingers in caches forever, long enough
// to amortize the presign cost across a typical user session.
const EmojiURLTTL = 6 * time.Hour

// EmojiService manages workspace custom emojis.
type EmojiService struct {
	emojis    EmojiStore
	users     UserStore
	publisher Publisher
	signer    EmojiURLSigner
}

// NewEmojiService constructs an EmojiService.
func NewEmojiService(emojis EmojiStore, users UserStore, publisher Publisher) *EmojiService {
	return &EmojiService{emojis: emojis, users: users, publisher: publisher}
}

// SetSigner wires the URL re-signer. Optional — when unset, List returns
// stored URLs as-is. Production wiring always passes the S3 client.
func (s *EmojiService) SetSigner(signer EmojiURLSigner) { s.signer = signer }

var emojiNameRE = regexp.MustCompile(`^[a-z0-9_+-]{1,32}$`)

// ValidateName returns an error if name is not a valid emoji shortcode.
func ValidateEmojiName(name string) error {
	if !emojiNameRE.MatchString(name) {
		return errors.New("emoji name must be 1-32 chars of [a-z0-9_+-]")
	}
	return nil
}

// Create stores a new custom emoji and publishes a global event so connected
// clients can refresh their emoji catalog. The imageKey is the persistent
// S3 key used for re-signing on List; imageURL is the initial presigned
// URL the client already has on hand.
func (s *EmojiService) Create(ctx context.Context, userID, name, imageURL, imageKey string) (*model.CustomEmoji, error) {
	if err := ValidateEmojiName(name); err != nil {
		return nil, err
	}
	if imageURL == "" {
		return nil, errors.New("emoji: imageURL is required")
	}

	u, err := s.users.GetUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("emoji: get user: %w", err)
	}
	if u.SystemRole == model.SystemRoleGuest {
		return nil, errors.New("emoji: guests cannot upload emojis")
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
			url, err := s.signer.PresignedGetURL(ctx, e.ImageKey, EmojiURLTTL)
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
	events.Publish(ctx, s.publisher, pubsub.GlobalEmojiEvents(), events.EventEmojiRemoved, map[string]string{"name": name})
	return nil
}
