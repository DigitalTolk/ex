package handler

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/storage"
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
// attachment (alreadyExists=true, no upload required) or the attachment to
// upload: its object key, plus the multipart upload to resume when a previous
// attempt at the same file never finished. The bytes then go straight to S3
// through requests signed by SignUploadRequest.
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
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{
		"id":                res.Attachment.ID,
		"key":               res.Attachment.S3Key,
		"multipartUploadId": res.Attachment.MultipartUploadID,
		"alreadyExists":     res.AlreadyExists,
		"filename":          res.Attachment.Filename,
		"contentType":       res.Attachment.ContentType,
		"size":              res.Attachment.Size,
		"width":             res.Attachment.Width,
		"height":            res.Attachment.Height,
	})
}

// SignUploadRequest handles POST /api/v1/attachments/{id}/upload-request. The
// browser's uploader (Uppy) posts each S3 request it is about to make —
// {method, key, uploadId?, partNumber?} — and gets back a presigned URL plus
// the headers it was signed with.
func (h *AttachmentHandler) SignUploadRequest(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	var body struct {
		Method     string `json:"method"`
		Key        string `json:"key"`
		UploadID   string `json:"uploadId"`
		PartNumber int    `json:"partNumber"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	signed, err := h.svc.SignUploadRequest(r.Context(), userID, pathParam(r, "id"), service.UploadRequest{
		Method:     body.Method,
		Key:        body.Key,
		UploadID:   body.UploadID,
		PartNumber: body.PartNumber,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"url": signed.URL, "key": signed.Key, "headers": signed.Headers})
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
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, a)
}

// SetPoster handles POST /api/v1/attachments/{id}/poster: the uploader's
// browser sends a frame of the video it just uploaded (the request body, an
// image), kept as the video's thumbnails.
func (h *AttachmentHandler) SetPoster(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	a, err := h.svc.SetVideoPoster(r.Context(), userID, pathParam(r, "id"), r.Body)
	if err != nil {
		writeServiceError(w, r, err)
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
		writeServiceError(w, r, err)
		return
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
		writeServiceError(w, r, err)
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
	// A video player seeks by asking for byte ranges, and Safari won't play
	// a video at all unless the server answers them.
	w.Header().Set("Accept-Ranges", "bytes")
	// g is the grant binding a URL issued to a user (see service.MediaGrant).
	media, err := h.svc.OpenMedia(r.Context(), token, r.URL.Query().Get("g"), requestedByteRange(r))
	if err != nil {
		// An expired link is a 404 and an unsatisfiable range a 416; anything
		// else is logged (the path redacted — its token is the bearer
		// credential) and answered with a generic 500.
		writeServiceError(w, r, err)
		return
	}
	defer func() { _ = media.Body.Close() }()
	stored := media.ContentType
	if stored == "" {
		stored = "application/octet-stream"
	}
	// One parsed media type, never the stored value verbatim: a browser reads
	// "image/png, text/html" as HTML.
	contentType, inline := storage.ServedContentType(stored)
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
	if r.URL.Query().Get("download") == "1" || !inline {
		w.Header().Set("Content-Disposition", attachmentDisposition(media.Filename))
	}
	if media.Size > 0 {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", media.Size))
	}
	status := http.StatusOK
	if media.ContentRange != "" {
		w.Header().Set("Content-Range", media.ContentRange)
		status = http.StatusPartialContent
	}
	w.WriteHeader(status)
	_, _ = io.Copy(w, media.Body)
}

// singleByteRange is the one form of Range header the media route serves: a
// single byte range ("bytes=0-1023", "bytes=1024-", "bytes=-500"), which is
// what a video player sends.
var singleByteRange = regexp.MustCompile(`^bytes=(\d+-\d*|-\d+)$`)

// requestedByteRange returns the request's Range header when it is a single
// byte range the media route serves, else "" for the whole object. Several
// ranges in one request, or a Range conditional on If-Range, get the whole
// object — always a valid answer to a range request.
func requestedByteRange(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("Range"))
	if r.Header.Get("If-Range") != "" || !singleByteRange.MatchString(value) {
		return ""
	}
	return value
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
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
