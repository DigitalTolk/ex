package handler

import (
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
)

// UploadHandler exposes generic file-upload endpoints backed by S3 presigned URLs.
type UploadHandler struct {
	s3 *storage.S3Client
}

// NewUploadHandler creates an UploadHandler.
func NewUploadHandler(s3 *storage.S3Client) *UploadHandler {
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
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Filename == "" || body.ContentType == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "filename and contentType required")
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
