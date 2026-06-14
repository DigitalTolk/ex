package handler

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

const MaxGenericUploadBytes int64 = 512 * 1024

// uploadSigner is the slice of *storage.S3Client the upload handler depends on.
// Defining it as an interface lets tests inject a signer whose presign calls
// fail, exercising the handler's presign-error branches that a real
// *storage.S3Client (which presigns locally and never errors on a reachable
// endpoint) cannot reach.
type uploadSigner interface {
	PresignedPutURL(ctx context.Context, key, contentType string, expires time.Duration) (string, error)
	PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error)
}

// UploadHandler exposes generic file-upload endpoints backed by S3 presigned URLs.
type UploadHandler struct {
	s3 uploadSigner
}

// NewUploadHandler creates an UploadHandler.
func NewUploadHandler(s3 *storage.S3Client) *UploadHandler {
	if s3 == nil {
		// Preserve nil-interface semantics so the h.s3 == nil guard fires when
		// no storage is configured (a typed nil would slip past == nil).
		return &UploadHandler{}
	}
	return &UploadHandler{s3: s3}
}

// CreateUploadURL returns a presigned PUT URL the browser can use to upload a
// file directly to S3, plus a presigned GET URL the client can embed in a
// message.
func (h *UploadHandler) CreateUploadURL(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	if h.s3 == nil {
		writeError(w, http.StatusServiceUnavailable, "no_storage", "file storage not configured")
		return
	}

	var body struct {
		Filename    string `json:"filename"`
		ContentType string `json:"contentType"`
		Size        int64  `json:"size"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Filename == "" || body.ContentType == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "filename and contentType required")
		return
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(body.ContentType, ";")[0]))
	if !strings.HasPrefix(contentType, "image/") || contentType == "image/svg+xml" {
		writeError(w, http.StatusBadRequest, "invalid_type", "only raster image uploads are allowed")
		return
	}
	if body.Size <= 0 || body.Size > MaxGenericUploadBytes {
		writeError(w, http.StatusBadRequest, "invalid_size", "upload size is required and too large")
		return
	}

	key := "uploads/" + userID + "/" + store.NewID() + "/" + body.Filename
	uploadURL, err := h.s3.PresignedPutURL(r.Context(), key, body.ContentType, 10*time.Minute)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "presign_error", err.Error())
		return
	}
	fileURL, err := h.s3.PresignedGetURL(r.Context(), key, 7*24*time.Hour)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "presign_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, JSON{
		"uploadURL": uploadURL,
		"key":       key,
		"fileURL":   fileURL,
	})
}
