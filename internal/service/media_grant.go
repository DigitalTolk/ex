package service

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"

	"github.com/DigitalTolk/ex/internal/store"
)

// Media URLs for attachments are fetched by <img>/<video> tags, which carry
// no credential, so the URL itself is the capability. A plain stable token
// (StableMediaURL) is one per file, shared by every viewer and valid for
// mediaURLTTL — a user removed from a channel kept every file URL they had
// seen for 30 days.
//
// The URLs AttachmentService hands to a user (GetForUser, GetManyForUser) are
// therefore scoped: the shared token names the file, and a grant — signed by
// the server, naming the user and the message context their access was proved
// in — rides along as ?g=. The media route re-runs that user's access check,
// so the URL dies with the access. The trade-off, chosen to keep media loads
// fast: the check is cached per user/file/context for mediaAccessTTL, so a
// revocation takes up to that long to bite (plus whatever the browser already
// cached, which is true of any URL); a URL is per user, so browsers cache per
// user (they did anyway); and no Redis row per user is needed, since the
// grant is stateless. URLs the server hands out with no user in view (link
// previews, project screens, agent runs, upload processing) keep the plain
// capability.

// MediaGrant is who a scoped media URL was issued to and where their access
// to the file was proved.
type MediaGrant struct {
	UserID     string `json:"u"`
	ParentID   string `json:"p,omitempty"`
	ParentType string `json:"t,omitempty"`
	MessageID  string `json:"m,omitempty"`
}

const (
	// mediaAccessTTL is how long a media load trusts an earlier access check
	// for the same user, file and context.
	mediaAccessTTL  = time.Minute
	mediaAccessSize = 1 << 16
	// scopedMediaSuffix keeps scoped records (and their tokens) apart from the
	// plain ones for the same file: a plain token opens without a grant.
	scopedMediaSuffix = "-scoped"
)

var mediaGrantContext = []byte("ex/media-grant/v1")

// newMediaGrantKey is a per-process key: enough for a single instance and for
// tests. Servers behind a load balancer share one via SetMediaGrantKey.
func newMediaGrantKey() []byte {
	key := make([]byte, sha256.Size)
	// crypto/rand.Read never returns an error (it aborts the process instead).
	_, _ = rand.Read(key)
	return key
}

func newMediaAccessCache() *expirable.LRU[string, bool] {
	return expirable.NewLRU[string, bool](mediaAccessSize, nil, mediaAccessTTL)
}

// SetMediaGrantKey derives the key media grants are signed with from a server
// secret. Every instance serving media must use the same one.
func (s *AttachmentService) SetMediaGrantKey(secret []byte) {
	mac := hmac.New(sha256.New, secret)
	mac.Write(mediaGrantContext)
	s.mediaGrantKey = mac.Sum(nil)
}

func encodeGrantPayload(g MediaGrant) string {
	return base64.RawURLEncoding.EncodeToString(mustJSONBody(json.Marshal(g)))
}

// grantMAC signs payload for the record behind token.
func (s *AttachmentService) grantMAC(token, payload string) string {
	mac := hmac.New(sha256.New, s.mediaGrantKey)
	mac.Write([]byte(token + "." + payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// signGrant is the ?g= value binding token to g.
func (s *AttachmentService) signGrant(token string, g MediaGrant) string {
	payload := encodeGrantPayload(g)
	return payload + "." + s.grantMAC(token, payload)
}

// verifyGrant returns the grant a ?g= value carries when the server signed it
// for token.
func (s *AttachmentService) verifyGrant(token, grant string) (MediaGrant, bool) {
	payload, sig, ok := strings.Cut(grant, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(s.grantMAC(token, payload))) {
		return MediaGrant{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return MediaGrant{}, false
	}
	var g MediaGrant
	if err := json.Unmarshal(raw, &g); err != nil || g.UserID == "" {
		return MediaGrant{}, false
	}
	return g, true
}

// scopedMediaURL is the media URL of an attachment object (the file, or one of
// its thumbnails) for the user in g.
func (s *AttachmentService) scopedMediaURL(ctx context.Context, namespace, attachmentID, s3Key, filename, contentType string, size int64, g MediaGrant) (string, error) {
	rec, err := stableMediaRecord(ctx, s.mediaCache, namespace+scopedMediaSuffix, attachmentID, mediaRecord{
		S3Key:        s3Key,
		Filename:     filename,
		ContentType:  contentType,
		Size:         size,
		Scoped:       true,
		AttachmentID: attachmentID,
	})
	if err != nil {
		return "", err
	}
	return mediaPath(rec.Token, rec.Filename) + "?g=" + s.signGrant(rec.Token, g), nil
}

// authorizeMedia lets a scoped record open only for a grant the server signed
// for its token, whose user may still read the attachment right now.
func (s *AttachmentService) authorizeMedia(ctx context.Context, rec mediaRecord, token, grant string) error {
	g, ok := s.verifyGrant(token, grant)
	if !ok {
		return store.ErrNotFound
	}
	key := strings.Join([]string{rec.AttachmentID, g.UserID, g.ParentType, g.ParentID, g.MessageID}, "\x00")
	allowed, hit := s.mediaAccess.Get(key)
	if !hit {
		var err error
		if allowed, err = s.mediaAccessAllowed(ctx, rec.AttachmentID, g); err != nil {
			// The check could not run: not a verdict, so not cached.
			return err
		}
		s.mediaAccess.Add(key, allowed)
	}
	if !allowed {
		return store.ErrNotFound
	}
	return nil
}

// mediaAccessAllowed is GetForUser's access rule for the grant's user and
// context: the URL works exactly while the API would hand it out again.
func (s *AttachmentService) mediaAccessAllowed(ctx context.Context, attachmentID string, g MediaGrant) (bool, error) {
	a, err := s.attachments.GetByID(ctx, attachmentID)
	if errors.Is(err, store.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("media: load attachment: %w", err)
	}
	return s.canAccessAttachment(ctx, g.UserID, a, g.ParentID, g.ParentType, g.MessageID)
}
