package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
	"github.com/DigitalTolk/ex/internal/store"
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
		Width       int    `json:"width"`
		Height      int    `json:"height"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	res, err := h.svc.CreateUploadURL(r.Context(), service.CreateUploadParams{
		UserID:      userID,
		Filename:    body.Filename,
		ContentType: body.ContentType,
		SHA256:      body.SHA256,
		Size:        body.Size,
		Width:       body.Width,
		Height:      body.Height,
	})
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
		"width":         res.Attachment.Width,
		"height":        res.Attachment.Height,
	})
}

// ProcessUpload handles POST /api/v1/attachments/{id}/process after the
// browser has finished the direct-to-S3 PUT. It validates the uploaded object
// and generates server-owned thumbnails before the attachment is sent.
func (h *AttachmentHandler) ProcessUpload(w http.ResponseWriter, r *http.Request) {
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
	a, err := h.svc.ProcessUpload(r.Context(), userID, id)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, service.ErrForbidden) {
			status = http.StatusForbidden
		} else if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeError(w, status, "process_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, a)
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
	if len(ids) > service.MaxAttachmentBatchIDs {
		writeError(w, http.StatusBadRequest, "too_many_ids", "too many attachment IDs")
		return
	}
	parentID := queryParam(r, "parentID", "")
	parentType := queryParam(r, "parentType", "")
	messageID := queryParam(r, "messageID", "")
	atts, err := h.svc.GetManyForUser(r.Context(), userID, ids, parentID, parentType, messageID)
	if err != nil {
		// Transient failure resolving/authorizing an id — fail the batch
		// (client keeps previously fetched data and retries) instead of
		// returning a silently shrunken 200 the client would cache as truth.
		writeInternalError(w, r, "list_error", err)
		return
	}
	if atts == nil { // coverage-ignore: GetManyForUser returns a make()-initialized slice that is never nil; coercion is defensive against a future contract change.
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
	a, err := h.svc.GetForUser(
		r.Context(),
		userID,
		id,
		queryParam(r, "parentID", ""),
		queryParam(r, "parentType", ""),
		queryParam(r, "messageID", ""),
	)
	if err != nil {
		// Missing or denied reads 404; a transient failure (the access check
		// could not run) must not masquerade as "gone" — clients would cache
		// the disappearance.
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "attachment not found")
			return
		}
		writeInternalError(w, r, "get_error", err)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// Media handles public capability URLs generated by AttachmentService. The
// random token is the authorization boundary, same as a presigned S3 URL, but
// the URL stays stable for the Redis TTL so browser caching can work.
func (h *AttachmentHandler) Media(w http.ResponseWriter, r *http.Request) {
	token := pathParam(r, "token")
	if token == "" {
		writeError(w, http.StatusBadRequest, "missing_token", "media token is required")
		return
	}
	media, err := h.svc.OpenMedia(r.Context(), token)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "media URL expired or not found")
			return
		}
		writeError(w, http.StatusBadGateway, "media_error", err.Error())
		return
	}
	defer func() { _ = media.Body.Close() }()
	contentType := media.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", storage.BrowserObjectCacheControl)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Defense-in-depth: sandbox any object the browser might still try to render
	// so attacker-uploaded markup can't run script in the app origin.
	w.Header().Set("Content-Security-Policy", "sandbox")
	lastModified := media.LastModified.Truncate(time.Second)
	if !lastModified.IsZero() {
		w.Header().Set("Last-Modified", lastModified.UTC().Format(http.TimeFormat))
		if notModifiedSince(r, lastModified) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	// Force a download for scriptable content types (text/html, SVG, XML, …) so a
	// same-origin /api/v1/media/{token} URL can't be used to land stored XSS by
	// uploading HTML and luring a victim to open it. ?download=1 always forces it.
	if r.URL.Query().Get("download") == "1" || isInlineUnsafeContentType(contentType) {
		w.Header().Set("Content-Disposition", attachmentDisposition(media.Filename))
	}
	if media.Size > 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", media.Size))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, media.Body)
}

// isInlineUnsafeContentType reports whether a content type can carry executable
// markup (and so must never be served inline from the same-origin media route).
func isInlineUnsafeContentType(ct string) bool {
	base := strings.ToLower(strings.TrimSpace(ct))
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = strings.TrimSpace(base[:i])
	}
	switch base {
	case "text/html", "application/xhtml+xml", "image/svg+xml", "application/xml", "text/xml":
		return true
	}
	return strings.HasSuffix(base, "+xml")
}

func notModifiedSince(r *http.Request, lastModified time.Time) bool {
	header := r.Header.Get("If-Modified-Since")
	if header == "" || lastModified.IsZero() {
		return false
	}
	t, err := http.ParseTime(header)
	if err != nil {
		return false
	}
	return !lastModified.After(t)
}

func attachmentDisposition(filename string) string {
	filename = strings.Map(func(r rune) rune {
		switch r {
		case '"', '\r', '\n':
			return '_'
		}
		if r < 0x20 || r > 0x7e {
			return '_'
		}
		return r
	}, filename)
	if filename == "" {
		return "attachment"
	}
	return fmt.Sprintf(`attachment; filename="%s"`, filename)
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
