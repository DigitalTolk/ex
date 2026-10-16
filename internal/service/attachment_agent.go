package service

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"path"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// Agent uploads: an agent run stores a file it produced (a screenshot, a
// generated report) so it can attach it to a post. Unlike a browser upload the
// bytes come THROUGH the server — a runner holds no S3 credentials — and the
// whole file is bounded by model.UploadMaxBytes, so buffering it is fine.
//
// The row is bound to the run (Attachment.RunID) and owned by the agent user;
// ForRunPost is what lets exactly that run attach it. The same verification
// as a human upload runs on the stored object (ensureVerified: size, hash,
// content sniff, thumbnails), so an agent cannot get a file into chat that a
// person could not.

// agentUploadTypes is the output allow-list: the extension decides the
// content type, never the caller. No scripts, archives, SVG or media — the
// formats agents actually produce and viewers can open safely (HTML stays
// download-only in the media handler).
var agentUploadTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".pdf":  "application/pdf",
	".txt":  "text/plain",
	".md":   "text/markdown",
	".csv":  "text/csv",
	".json": "application/json",
	".html": "text/html",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

// ErrUnsupportedUploadType rejects an agent upload outside agentUploadTypes.
var ErrUnsupportedUploadType = errors.New("attachment: file type not allowed for agent uploads")

// ErrUploadTooLarge rejects an agent upload over model.UploadMaxBytes.
var ErrUploadTooLarge = errors.New("attachment: file exceeds the agent upload limit")

const maxUploadFilenameLen = 120

// AgentUploadParams is one run-scoped upload.
type AgentUploadParams struct {
	RunID    string
	AgentID  string // the agent user the run posts as (CreatedBy)
	Filename string // untrusted; sanitised to a base name
	Size     int64  // declared; the bytes must match exactly
	Body     io.Reader
}

// UploadForAgent stores and verifies one file for a run.
func (s *AttachmentService) UploadForAgent(ctx context.Context, p AgentUploadParams) (*model.Attachment, error) {
	if p.RunID == "" || p.AgentID == "" {
		return nil, errors.New("attachment: run and agent required")
	}
	if s.signer == nil {
		return nil, errors.New("attachment: storage not configured")
	}
	filename := sanitizeUploadFilename(p.Filename)
	contentType, ok := agentUploadTypes[strings.ToLower(path.Ext(filename))]
	if !ok {
		return nil, ErrUnsupportedUploadType
	}
	if p.Size <= 0 || p.Size > model.UploadMaxBytes {
		return nil, ErrUploadTooLarge
	}
	if s.limits != nil {
		if !s.limits.AllowsExtension(ctx, filename) {
			return nil, ErrUnsupportedUploadType
		}
		if !s.limits.AllowsSize(ctx, p.Size) {
			return nil, ErrUploadTooLarge
		}
	}
	// One byte past the declared size proves a lie without reading further.
	data, err := io.ReadAll(io.LimitReader(p.Body, p.Size+1))
	if err != nil {
		return nil, fmt.Errorf("attachment: read upload: %w", err)
	}
	if int64(len(data)) != p.Size {
		return nil, fmt.Errorf("attachment: upload size mismatch: got %d want %d", len(data), p.Size)
	}
	sum := sha256.Sum256(data)
	id := store.NewID()
	a := &model.Attachment{
		ID:          id,
		SHA256:      hex.EncodeToString(sum[:]),
		Size:        p.Size,
		ContentType: contentType,
		Filename:    filename,
		S3Key:       "attachments/" + id,
		CreatedBy:   p.AgentID,
		RunID:       p.RunID,
		CreatedAt:   time.Now(),
	}
	// The same content checks a browser upload gets at process time, on the
	// bytes in hand: a PNG must decode as a PNG, a PDF must start like one.
	cfg, _, release, err := inspectContent(ctx, a, contentType, bufio.NewReader(bytes.NewReader(data)), false)
	release()
	if err != nil {
		return nil, err
	}
	a.Width, a.Height = cfg.Width, cfg.Height
	if err := s.signer.PutObject(ctx, a.S3Key, contentType, data); err != nil {
		return nil, fmt.Errorf("attachment: store upload: %w", err)
	}
	if err := s.attachments.Create(ctx, a); err != nil {
		s.discardObject(ctx, a.S3Key)
		return nil, fmt.Errorf("attachment: create: %w", err)
	}
	// Records the verified ETag and writes thumbnails from the stored object,
	// exactly as ProcessUpload does for a browser upload.
	if err := s.ensureVerified(ctx, a); err != nil {
		s.discardObject(ctx, a.S3Key)
		if delErr := s.attachments.Delete(ctx, a.ID); delErr != nil {
			slog.Warn("agent upload: row cleanup failed", "attachmentID", a.ID, "error", delErr)
		}
		return nil, err
	}
	return a, nil
}

func (s *AttachmentService) discardObject(ctx context.Context, key string) {
	if err := s.signer.DeleteObject(ctx, key); err != nil {
		slog.Warn("agent upload: object cleanup failed", "key", key, "error", err)
	}
}

// sanitizeUploadFilename reduces an untrusted name to a plain base name: no
// directories, no control characters, no leading dots, bounded length, the
// extension kept intact so the type lookup sees it.
func sanitizeUploadFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(name)
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	name = strings.TrimLeft(strings.TrimSpace(b.String()), ".")
	if name == "" || name == "/" {
		return "file"
	}
	if len(name) > maxUploadFilenameLen {
		ext := path.Ext(name)
		name = name[:maxUploadFilenameLen-len(ext)] + ext
	}
	return name
}
