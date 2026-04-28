package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

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
}

// AttachmentSigner generates time-limited GET/PUT URLs for attachment objects
// and removes objects when GC'd.
type AttachmentSigner interface {
	PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error)
	PresignedDownloadURL(ctx context.Context, key, filename string, expires time.Duration) (string, error)
	PresignedPutURL(ctx context.Context, key, contentType string, expires time.Duration) (string, error)
	DeleteObject(ctx context.Context, key string) error
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
}

// NewAttachmentService constructs an AttachmentService.
func NewAttachmentService(attachments AttachmentStore, signer AttachmentSigner, publisher Publisher) *AttachmentService {
	return &AttachmentService{attachments: attachments, signer: signer, publisher: publisher}
}

// SetUploadLimits wires the settings-based limit checker. Optional —
// when unset, no extra validation runs (useful for unit tests of the
// other paths). Production wiring always passes the SettingsService.
func (s *AttachmentService) SetUploadLimits(l uploadLimits) { s.limits = l }

// AttachmentURLTTL is how long signed GET URLs remain valid. Frontend resolves
// URLs on demand via the API so this can be relatively short.
const AttachmentURLTTL = 6 * time.Hour

// CreateUploadResult carries the result of a request for an upload URL. When
// AlreadyExists is true the caller should NOT upload — the attachment was
// dedupe-matched against a prior upload with the same SHA256 and they should
// just attach by ID.
type CreateUploadResult struct {
	Attachment    *model.Attachment
	UploadURL     string
	AlreadyExists bool
}

// CreateUploadURL either returns an existing attachment matching the SHA256
// hash (with no upload URL) or creates a new attachment record + presigned PUT
// URL the client uploads to.
func (s *AttachmentService) CreateUploadURL(ctx context.Context, userID, filename, contentType, sha256 string, size int64) (*CreateUploadResult, error) {
	if userID == "" {
		return nil, errors.New("attachment: userID required")
	}
	if filename == "" || contentType == "" || sha256 == "" {
		return nil, errors.New("attachment: filename, contentType, sha256 required")
	}
	if s.signer == nil {
		return nil, errors.New("attachment: storage not configured")
	}
	if s.limits != nil {
		if !s.limits.AllowsExtension(ctx, filename) {
			return nil, errors.New("attachment: file extension not allowed by workspace settings")
		}
		if !s.limits.AllowsSize(ctx, size) {
			return nil, errors.New("attachment: file exceeds the workspace upload size limit")
		}
	}

	if existing, err := s.attachments.GetByHash(ctx, sha256); err == nil && existing != nil {
		return &CreateUploadResult{Attachment: existing, AlreadyExists: true}, nil
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("attachment: lookup hash: %w", err)
	}

	id := store.NewID()
	key := "attachments/" + id
	a := &model.Attachment{
		ID:          id,
		SHA256:      sha256,
		Size:        size,
		ContentType: contentType,
		Filename:    filename,
		S3Key:       key,
		CreatedBy:   userID,
		CreatedAt:   time.Now(),
	}
	if err := s.attachments.Create(ctx, a); err != nil {
		return nil, fmt.Errorf("attachment: create: %w", err)
	}

	uploadURL, err := s.signer.PresignedPutURL(ctx, key, contentType, 1*time.Hour)
	if err != nil {
		return nil, fmt.Errorf("attachment: presign put: %w", err)
	}
	return &CreateUploadResult{Attachment: a, UploadURL: uploadURL}, nil
}

// Get returns an attachment with a freshly signed GET URL. Used by clients to
// render an attachment whose previously-signed URL has expired.
func (s *AttachmentService) Get(ctx context.Context, id string) (*model.Attachment, error) {
	a, err := s.attachments.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("attachment: get: %w", err)
	}
	if s.signer != nil && a.S3Key != "" {
		if url, err := s.signer.PresignedGetURL(ctx, a.S3Key, AttachmentURLTTL); err == nil {
			a.URL = url
		}
		if dl, err := s.signer.PresignedDownloadURL(ctx, a.S3Key, a.Filename, AttachmentURLTTL); err == nil {
			a.DownloadURL = dl
		}
	}
	return a, nil
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
	if err := s.attachments.Delete(ctx, attachmentID); err != nil {
		return fmt.Errorf("attachment: delete: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.GlobalChannelEvents(), events.EventAttachmentDeleted, map[string]any{
		"id": attachmentID,
	})
	return nil
}
