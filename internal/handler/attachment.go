package handler

import (
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// AttachmentHandler exposes HTTP endpoints for uploading and managing
// message attachments.
type AttachmentHandler struct {
	svc *service.AttachmentService
}

// NewAttachmentHandler creates an AttachmentHandler.
func NewAttachmentHandler(svc *service.AttachmentService) *AttachmentHandler {
	return &AttachmentHandler{svc: svc}
}

// CreateUploadURL handles POST /api/v1/attachments/url. The client posts
// {filename, contentType, size, sha256}; we either return an existing
// attachment (alreadyExists=true, no upload required) or create a new
// attachment record and return a presigned PUT URL.
func (h *AttachmentHandler) CreateUploadURL(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	var body struct {
		Filename    string `json:"filename"`
		ContentType string `json:"contentType"`
		Size        int64  `json:"size"`
		SHA256      string `json:"sha256"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	res, err := h.svc.CreateUploadURL(r.Context(), userID, body.Filename, body.ContentType, body.SHA256, body.Size)
	if err != nil {
		writeError(w, http.StatusBadRequest, "create_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, JSON{
		"id":            res.Attachment.ID,
		"uploadURL":     res.UploadURL,
		"alreadyExists": res.AlreadyExists,
		"filename":      res.Attachment.Filename,
		"contentType":   res.Attachment.ContentType,
		"size":          res.Attachment.Size,
	})
}

// List handles GET /api/v1/attachments?ids=a,b,c and returns metadata + freshly
// signed URLs for each requested ID. Missing IDs are silently skipped — the
// caller compares returned IDs to detect them. Used by message renderers to
// resolve N attachment refs in one round-trip instead of N.
func (h *AttachmentHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	raw := r.URL.Query().Get("ids")
	if raw == "" {
		writeJSON(w, http.StatusOK, []model.Attachment{})
		return
	}
	ids := strings.Split(raw, ",")
	atts, err := h.svc.GetMany(r.Context(), ids)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return
	}
	if atts == nil {
		atts = []*model.Attachment{}
	}
	writeJSON(w, http.StatusOK, atts)
}

// Get handles GET /api/v1/attachments/{id} and returns the attachment with a
// freshly signed URL — the previously signed URL may have expired.
func (h *AttachmentHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "attachment ID required")
		return
	}
	a, err := h.svc.Get(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// Delete removes a draft attachment (chip removed before sending). Refuses
// when other messages still reference the upload (SHA256 dedup case).
func (h *AttachmentHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "attachment ID required")
		return
	}
	if err := h.svc.DeleteDraft(r.Context(), userID, id); err != nil {
		writeError(w, http.StatusForbidden, "delete_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
