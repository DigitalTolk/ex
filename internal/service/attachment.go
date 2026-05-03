package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	// Register decoders for the formats the upload pipeline accepts.
	// image.DecodeConfig dispatches by format magic bytes; without
	// these blank imports it returns ErrFormat for everything but
	// the (decoder-less) base package.
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	// WebP support — common enough on the modern web that not handling
	// it would leave a noticeable backfill gap.
	_ "golang.org/x/image/webp"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// AttachmentStore is the persistence interface used by AttachmentService.
type AttachmentStore interface {
	Create(ctx context.Context, a *model.Attachment) error
	GetByID(ctx context.Context, id string) (*model.Attachment, error)
	GetByHash(ctx context.Context, sha256 string) (*model.Attachment, error)
	AddRef(ctx context.Context, attachmentID, messageID string) error
	RemoveRef(ctx context.Context, attachmentID, messageID string) (*model.Attachment, error)
	Delete(ctx context.Context, id string) error
	SetDimensions(ctx context.Context, id string, width, height int) error
}

// AttachmentSigner generates time-limited GET/PUT URLs for attachment objects
// and removes objects when GC'd. GetObjectRange is used by the lazy
// dimension-backfill path; we read just enough of the image header to
// decode width/height without downloading the full payload.
type AttachmentSigner interface {
	PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error)
	PresignedDownloadURL(ctx context.Context, key, filename string, expires time.Duration) (string, error)
	PresignedPutURL(ctx context.Context, key, contentType string, expires time.Duration) (string, error)
	DeleteObject(ctx context.Context, key string) error
	GetObjectRange(ctx context.Context, key string, maxBytes int64) ([]byte, error)
	GetObject(ctx context.Context, key string) (io.ReadCloser, string, int64, time.Time, error)
}

// AttachmentService manages message attachments: dedup-by-hash uploads, signed
// URL resolution, refcount tracking, and S3 GC when the last reference is
// dropped.
type uploadLimits interface {
	AllowsExtension(ctx context.Context, filename string) bool
	AllowsSize(ctx context.Context, size int64) bool
}

type AttachmentService struct {
	attachments AttachmentStore
	signer      AttachmentSigner
	publisher   Publisher
	limits      uploadLimits
	// urlCache memoises presigned GET / download URLs by S3 key for
	// the cache window so the browser sees the same URL across
	// renders — without it every signed URL is fresh and the image
	// cache misses on every fetch.
	urlCache *presignedURLCache
	// inFlightBackfills dedupes concurrent dimensions backfills so a
	// single hot list of legacy attachments doesn't fan out into N
	// duplicate S3 reads.
	backfillMu        sync.Mutex
	inFlightBackfills map[string]struct{}
	mediaCache        MediaURLCache
}

// NewAttachmentService constructs an AttachmentService.
func NewAttachmentService(attachments AttachmentStore, signer AttachmentSigner, publisher Publisher) *AttachmentService {
	return &AttachmentService{
		attachments: attachments,
		signer:      signer,
		publisher:   publisher,
		// The cache constructor caps this to a short safety window so
		// temporary AWS security tokens embedded in presigned URLs never
		// linger for hours after expiry.
		urlCache: newPresignedURLCache(20 * time.Hour),
	}
}

// SetUploadLimits wires the settings-based limit checker. Optional —
// when unset, no extra validation runs (useful for unit tests of the
// other paths). Production wiring always passes the SettingsService.
func (s *AttachmentService) SetUploadLimits(l uploadLimits) { s.limits = l }

// SetMediaURLCache enables stable app-hosted media URLs for attachment
// rendering. Without it, Get falls back to direct presigned S3 URLs.
func (s *AttachmentService) SetMediaURLCache(c MediaURLCache) { s.mediaCache = c }

// AttachmentURLTTL is how long signed GET URLs remain valid. Frontend resolves
// URLs on demand via the API so this can be relatively short.
const AttachmentURLTTL = 24 * time.Hour

// CreateUploadResult carries the result of a request for an upload URL. When
// AlreadyExists is true the caller should NOT upload — the attachment was
// dedupe-matched against a prior upload with the same SHA256 and they should
// just attach by ID.
type CreateUploadResult struct {
	Attachment    *model.Attachment
	UploadURL     string
	AlreadyExists bool
}

// CreateUploadParams bundles the upload-init request fields. Width
// and Height are optional — when the client measures them on its
// side (e.g. via the browser's <img> intrinsic dimensions) they're
// persisted at create time so the message-list renderer can reserve
// the layout box on first paint. Server-side backfill picks up
// missing dimensions on first read.
type CreateUploadParams struct {
	UserID      string
	Filename    string
	ContentType string
	SHA256      string
	Size        int64
	Width       int
	Height      int
}

// CreateUploadURL either returns an existing attachment matching the SHA256
// hash (with no upload URL) or creates a new attachment record + presigned PUT
// URL the client uploads to.
func (s *AttachmentService) CreateUploadURL(ctx context.Context, p CreateUploadParams) (*CreateUploadResult, error) {
	if p.UserID == "" {
		return nil, errors.New("attachment: userID required")
	}
	if p.Filename == "" || p.ContentType == "" || p.SHA256 == "" {
		return nil, errors.New("attachment: filename, contentType, sha256 required")
	}
	if !validSHA256Hex(p.SHA256) {
		return nil, errors.New("attachment: invalid sha256")
	}
	if p.Width < 0 || p.Height < 0 {
		return nil, errors.New("attachment: invalid dimensions")
	}
	if s.signer == nil {
		return nil, errors.New("attachment: storage not configured")
	}
	if s.limits != nil {
		if !s.limits.AllowsExtension(ctx, p.Filename) {
			return nil, errors.New("attachment: file extension not allowed by workspace settings")
		}
		if !s.limits.AllowsSize(ctx, p.Size) {
			return nil, errors.New("attachment: file exceeds the workspace upload size limit")
		}
	}

	if existing, err := s.attachments.GetByHash(ctx, p.SHA256); err == nil && existing != nil {
		return &CreateUploadResult{Attachment: existing, AlreadyExists: true}, nil
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("attachment: lookup hash: %w", err)
	}

	id := store.NewID()
	key := "attachments/" + id
	a := &model.Attachment{
		ID:          id,
		SHA256:      p.SHA256,
		Size:        p.Size,
		ContentType: p.ContentType,
		Filename:    p.Filename,
		S3Key:       key,
		Width:       p.Width,
		Height:      p.Height,
		CreatedBy:   p.UserID,
		CreatedAt:   time.Now(),
	}
	if err := s.attachments.Create(ctx, a); err != nil {
		return nil, fmt.Errorf("attachment: create: %w", err)
	}

	uploadURL, err := s.signer.PresignedPutURL(ctx, key, p.ContentType, 1*time.Hour)
	if err != nil {
		return nil, fmt.Errorf("attachment: presign put: %w", err)
	}
	return &CreateUploadResult{Attachment: a, UploadURL: uploadURL}, nil
}

// Get returns an attachment with a signed GET URL. Used by clients to
// render an attachment. URLs are served from a per-S3-key cache so
// repeated lookups within the cache window hand out the SAME URL —
// the browser image cache hits on every subsequent render instead of
// re-downloading because the signature query string changed.
//
// As a side effect, image attachments missing width/height (uploaded
// before the upload pipeline started recording dimensions) get a
// background backfill: we fetch ~256 KB from S3, decode the image
// header, and persist the dimensions. Subsequent reads return the
// stored values; this read may race ahead with zeros, which the
// frontend treats as "no width/height attribute" — same as today.
func (s *AttachmentService) Get(ctx context.Context, id string) (*model.Attachment, error) {
	a, err := s.attachments.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("attachment: get: %w", err)
	}
	if s.signer != nil && a.S3Key != "" {
		s.resolveAttachmentURLs(ctx, a)
	}
	if a.IsImage() && a.Width == 0 && a.Height == 0 && a.S3Key != "" && s.signer != nil {
		s.scheduleDimensionsBackfill(a.ID, a.S3Key)
	}
	return a, nil
}

func (s *AttachmentService) resolveAttachmentURLs(ctx context.Context, a *model.Attachment) {
	if s.mediaCache != nil {
		if mediaURL, err := s.mediaURL(ctx, a); err == nil {
			a.URL = mediaURL
		}
	}
	if a.URL == "" {
		if url, err := s.urlCache.getOrSign(ctx, presignedKey{op: "get", key: a.S3Key},
			func(ctx context.Context) (string, error) {
				return s.signer.PresignedGetURL(ctx, a.S3Key, AttachmentURLTTL)
			}); err == nil {
			a.URL = url
		}
	}
	if dl, err := s.urlCache.getOrSign(ctx, presignedKey{op: "download", key: a.S3Key, extra: a.Filename},
		func(ctx context.Context) (string, error) {
			return s.signer.PresignedDownloadURL(ctx, a.S3Key, a.Filename, AttachmentURLTTL)
		}); err == nil {
		a.DownloadURL = dl
	}
}

func (s *AttachmentService) mediaURL(ctx context.Context, a *model.Attachment) (string, error) {
	return StableMediaURL(ctx, s.mediaCache, "attachment", a.ID, a.S3Key, a.Filename, a.ContentType, a.Size)
}

func (s *AttachmentService) OpenMedia(ctx context.Context, token string) (*MediaObject, error) {
	return OpenStableMedia(ctx, s.mediaCache, s.signer, token)
}

// scheduleDimensionsBackfill kicks off a one-shot goroutine that
// reads the image header from S3, decodes its dimensions, and
// persists them. Bounded via inFlightBackfills so a hot list of
// pre-feature attachments doesn't spawn N copies of the same fetch.
func (s *AttachmentService) scheduleDimensionsBackfill(id, s3Key string) {
	if id == "" || s3Key == "" {
		return
	}
	s.backfillMu.Lock()
	if s.inFlightBackfills == nil {
		s.inFlightBackfills = make(map[string]struct{})
	}
	if _, busy := s.inFlightBackfills[id]; busy {
		s.backfillMu.Unlock()
		return
	}
	s.inFlightBackfills[id] = struct{}{}
	s.backfillMu.Unlock()
	go func() {
		defer func() {
			s.backfillMu.Lock()
			delete(s.inFlightBackfills, id)
			s.backfillMu.Unlock()
		}()
		// New context: the request that triggered the backfill may
		// finish (and cancel its context) before we're done — we
		// don't want to drop the persistence write on its way out.
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		// 256 KB is enough for every common image format's header
		// (JPEG, PNG, GIF, WebP). Decoding configs reads only the
		// dimensions, not the pixel data.
		buf, err := s.signer.GetObjectRange(ctx, s3Key, 256*1024)
		if err != nil || len(buf) == 0 {
			return
		}
		cfg, _, err := image.DecodeConfig(bytes.NewReader(buf))
		if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
			return
		}
		_ = s.attachments.SetDimensions(ctx, id, cfg.Width, cfg.Height)
	}()
}

// GetMany resolves a list of attachment IDs in parallel. Missing IDs are
// skipped silently — the caller can detect them by comparing returned IDs.
// Order matches the input.
func (s *AttachmentService) GetMany(ctx context.Context, ids []string) ([]*model.Attachment, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	results := make([]*model.Attachment, len(ids))
	var wg sync.WaitGroup
	for i, id := range ids {
		if id == "" {
			continue
		}
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			if a, err := s.Get(ctx, id); err == nil {
				results[i] = a
			}
		}(i, id)
	}
	wg.Wait()
	out := make([]*model.Attachment, 0, len(ids))
	for _, a := range results {
		if a != nil {
			out = append(out, a)
		}
	}
	return out, nil
}

// AddRef binds an attachment to a message. Called by MessageService.Send.
func (s *AttachmentService) AddRef(ctx context.Context, attachmentID, messageID string) error {
	return s.attachments.AddRef(ctx, attachmentID, messageID)
}

// ValidateForUse proves that an attachment row points at an uploaded object
// whose immutable properties still match the metadata the row advertises.
// Message sends/edits call this before persisting attachment IDs supplied by
// the client, so a failed or tampered direct-to-S3 upload cannot become a
// message attachment.
func (s *AttachmentService) ValidateForUse(ctx context.Context, attachmentID string) error {
	if attachmentID == "" {
		return errors.New("attachment: id required")
	}
	a, err := s.attachments.GetByID(ctx, attachmentID)
	if err != nil {
		return fmt.Errorf("attachment: get for validation: %w", err)
	}
	if a.S3Key == "" {
		return errors.New("attachment: missing storage key")
	}
	if a.Size <= 0 {
		return errors.New("attachment: invalid size")
	}
	if s.signer == nil {
		return errors.New("attachment: storage not configured")
	}
	body, objectContentType, objectSize, _, err := s.signer.GetObject(ctx, a.S3Key)
	if err != nil {
		return fmt.Errorf("attachment: object missing: %w", err)
	}
	defer func() { _ = body.Close() }()
	if objectSize > 0 && objectSize != a.Size {
		return fmt.Errorf("attachment: object size mismatch: got %d want %d", objectSize, a.Size)
	}

	limited := io.LimitReader(body, a.Size+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("attachment: read object: %w", err)
	}
	if int64(len(data)) != a.Size {
		return fmt.Errorf("attachment: object size mismatch: got %d want %d", len(data), a.Size)
	}
	sum := sha256.Sum256(data)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), a.SHA256) {
		return errors.New("attachment: sha256 mismatch")
	}
	if err := validateAttachmentContentType(a, objectContentType, data); err != nil {
		return err
	}
	return nil
}

func validateAttachmentContentType(a *model.Attachment, objectContentType string, data []byte) error {
	declared := a.ContentType
	declared = strings.ToLower(strings.TrimSpace(strings.Split(declared, ";")[0]))
	objectContentType = strings.ToLower(strings.TrimSpace(strings.Split(objectContentType, ";")[0]))
	if objectContentType != "" && declared != "" && objectContentType != declared && declared != "application/octet-stream" {
		return fmt.Errorf("attachment: object content type %q does not match declared %q", objectContentType, declared)
	}
	if !strings.HasPrefix(declared, "image/") {
		return nil
	}
	detected := http.DetectContentType(data)
	if detected == "application/octet-stream" {
		return errors.New("attachment: could not detect image content type")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return errors.New("attachment: invalid image")
	}
	if a.Width > 0 && a.Width != cfg.Width {
		return fmt.Errorf("attachment: image width mismatch: got %d want %d", cfg.Width, a.Width)
	}
	if a.Height > 0 && a.Height != cfg.Height {
		return fmt.Errorf("attachment: image height mismatch: got %d want %d", cfg.Height, a.Height)
	}
	expectedFormat := strings.TrimPrefix(declared, "image/")
	if expectedFormat == "jpg" {
		expectedFormat = "jpeg"
	}
	if format != expectedFormat {
		return fmt.Errorf("attachment: image format %q does not match declared %q", format, declared)
	}
	return nil
}

func validSHA256Hex(v string) bool {
	if len(v) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(v)
	return err == nil && len(decoded) == sha256.Size
}

// RemoveRef releases a message's claim on an attachment. When the last
// reference is removed the underlying S3 object and Attachment row are GC'd.
func (s *AttachmentService) RemoveRef(ctx context.Context, attachmentID, messageID string) error {
	updated, err := s.attachments.RemoveRef(ctx, attachmentID, messageID)
	if err != nil {
		return err
	}
	if updated != nil && len(updated.MessageIDs) == 0 {
		// Last reference gone — GC.
		if s.signer != nil && updated.S3Key != "" {
			_ = s.signer.DeleteObject(ctx, updated.S3Key)
		}
		s.urlCache.invalidate(updated.S3Key)
		_ = s.attachments.Delete(ctx, attachmentID)
		events.Publish(ctx, s.publisher, pubsub.GlobalChannelEvents(), events.EventAttachmentDeleted, map[string]any{
			"id": attachmentID,
		})
	}
	return nil
}

// DeleteDraft removes an unattached (draft) attachment — invoked when the user
// removes the chip in the message composer before sending. Refuses to delete
// if any message references it (i.e. the same hash is in use elsewhere).
func (s *AttachmentService) DeleteDraft(ctx context.Context, userID, attachmentID string) error {
	a, err := s.attachments.GetByID(ctx, attachmentID)
	if err != nil {
		return fmt.Errorf("attachment: get for delete: %w", err)
	}
	if a.CreatedBy != userID {
		return errors.New("attachment: not authorized")
	}
	if len(a.MessageIDs) > 0 {
		return errors.New("attachment: still referenced by sent messages")
	}
	if s.signer != nil && a.S3Key != "" {
		_ = s.signer.DeleteObject(ctx, a.S3Key)
	}
	s.urlCache.invalidate(a.S3Key)
	if err := s.attachments.Delete(ctx, attachmentID); err != nil {
		return fmt.Errorf("attachment: delete: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.GlobalChannelEvents(), events.EventAttachmentDeleted, map[string]any{
		"id": attachmentID,
	})
	return nil
}
