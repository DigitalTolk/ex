package importer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// AttachmentSpec describes a file to import.
type AttachmentSpec struct {
	ID          string
	Filename    string
	ContentType string // defaults to application/octet-stream
	// Size, when > 0, must match the bytes read.
	Size      int64
	Width     int
	Height    int
	CreatedBy string
	CreatedAt time.Time
}

// rewind is a seam over seeking the spool file back to its start.
var rewind = func(f *os.File) error {
	_, err := f.Seek(0, io.SeekStart)
	return err
}

// attachmentKey is ex's object key layout for attachments.
func attachmentKey(id string) string { return "attachments/" + id }

// PutAttachment stores a file and its attachment record. open is only called
// when the attachment does not exist yet, so re-runs skip the download. The
// body is spooled to a temporary file while its SHA-256 is computed, then
// uploaded in one checksummed PUT — the record is written already verified, so
// ex serves it without re-reading (image thumbnails are still generated
// lazily on first view). Returns whether it was created.
func (im *Importer) PutAttachment(ctx context.Context, spec AttachmentSpec, open func(context.Context) (io.ReadCloser, error)) (bool, error) {
	if im.objects == nil {
		return false, ErrNoObjectStore
	}
	if spec.ID == "" || spec.Filename == "" {
		return false, invalid("attachment ID and filename are required")
	}
	if _, err := im.attachments.GetByID(ctx, spec.ID); err == nil {
		return false, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return false, fmt.Errorf("importer: get attachment: %w", err)
	}
	body, err := open(ctx)
	if err != nil {
		return false, fmt.Errorf("importer: open attachment %s: %w", spec.ID, err)
	}
	defer func() { _ = body.Close() }()

	tmp, err := tempFile(im.tempDir, "ex-import-*")
	if err != nil {
		return false, fmt.Errorf("importer: temp file: %w", err)
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	h := sha256.New()
	size, err := io.Copy(io.MultiWriter(tmp, h), body)
	if err != nil {
		return false, fmt.Errorf("importer: read attachment %s: %w", spec.ID, err)
	}
	if spec.Size > 0 && size != spec.Size {
		return false, fmt.Errorf("importer: attachment %s: read %d bytes, expected %d", spec.ID, size, spec.Size)
	}
	if size == 0 {
		return false, invalid("attachment %s is empty", spec.ID)
	}
	if err := rewind(tmp); err != nil {
		return false, fmt.Errorf("importer: rewind attachment %s: %w", spec.ID, err)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	contentType := spec.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	etag, err := im.objects.PutChecksummedObject(ctx, attachmentKey(spec.ID), contentType, tmp, size, sum)
	if err != nil {
		return false, fmt.Errorf("importer: upload attachment %s: %w", spec.ID, err)
	}
	a := &model.Attachment{
		ID:           spec.ID,
		SHA256:       sum,
		Size:         size,
		ContentType:  contentType,
		Filename:     spec.Filename,
		S3Key:        attachmentKey(spec.ID),
		Width:        spec.Width,
		Height:       spec.Height,
		CreatedBy:    spec.CreatedBy,
		CreatedAt:    spec.CreatedAt,
		VerifiedETag: etag,
	}
	if err := im.attachments.Create(ctx, a); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return false, nil
		}
		return false, fmt.Errorf("importer: create attachment: %w", err)
	}
	return true, nil
}
