package handler

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// SharePointService is the SharePoint-link behaviour the handler needs.
type SharePointService interface {
	Link(ctx context.Context, viewerID, parentID, parentType, rawURL string) (*model.SharePointLink, error)
	RetryLink(ctx context.Context, userID, parentID, parentType, rawURL string) error
	Preview(ctx context.Context, viewerID, parentID, parentType, fileID string) (string, error)
	UploadOfficeFile(ctx context.Context, userID, parentID, parentType, name string, body io.Reader, size int64) (*service.OfficeUpload, error)
}

// maxSharePointURL caps the link a request names; real ones are far shorter.
const maxSharePointURL = 4096

// SharePointHandler exposes posted SharePoint links: their card, retrying
// one that failed to share, and a shared file's preview.
type SharePointHandler struct {
	svc SharePointService
}

func NewSharePointHandler(svc SharePointService) *SharePointHandler {
	return &SharePointHandler{svc: svc}
}

type sharePointLinkRef struct {
	ParentType string `json:"parentType"`
	ParentID   string `json:"parentID"`
	URL        string `json:"url"`
}

func (ref sharePointLinkRef) valid() bool {
	return (ref.ParentType == service.ParentChannel || ref.ParentType == service.ParentConversation) &&
		ref.ParentID != "" && ref.URL != "" && len(ref.URL) <= maxSharePointURL
}

// Link returns a posted link's card: GET /api/v1/sharepoint/link?parentType=
// channel|conversation&parentID=…&url=…. 204 when the link was never shared.
func (h *SharePointHandler) Link(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ref := sharePointLinkRef{ParentType: q.Get("parentType"), ParentID: q.Get("parentID"), URL: q.Get("url")}
	if !ref.valid() {
		writeError(w, http.StatusBadRequest, "invalid_link", "parentType, parentID and url are required")
		return
	}
	link, err := h.svc.Link(r.Context(), middleware.UserIDFromContext(r.Context()), ref.ParentID, ref.ParentType, ref.URL)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	if link == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, link)
}

// Retry shares a link that failed again, as its poster: POST
// /api/v1/sharepoint/link/retry with {parentType, parentID, url}.
func (h *SharePointHandler) Retry(w http.ResponseWriter, r *http.Request) {
	var ref sharePointLinkRef
	if err := readJSON(r, &ref); err != nil || !ref.valid() {
		writeError(w, http.StatusBadRequest, "invalid_link", "parentType, parentID and url are required")
		return
	}
	if err := h.svc.RetryLink(r.Context(), middleware.UserIDFromContext(r.Context()), ref.ParentID, ref.ParentType, ref.URL); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

// sharePointPreview is the address that shows a file in the lightbox.
type sharePointPreview struct {
	URL string `json:"url"`
}

// Preview returns a short-lived address showing a shared file as it is, for
// the caller only: GET /api/v1/sharepoint/preview?parentType=channel|
// conversation&parentID=…&fileID=….
func (h *SharePointHandler) Preview(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	ref := sharePointLinkRef{ParentType: q.Get("parentType"), ParentID: q.Get("parentID"), URL: q.Get("fileID")}
	if !ref.valid() {
		writeError(w, http.StatusBadRequest, "invalid_file", "parentType, parentID and fileID are required")
		return
	}
	u, err := h.svc.Preview(r.Context(), middleware.UserIDFromContext(r.Context()), ref.ParentID, ref.ParentType, ref.URL)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	// It carries the caller's access: never kept by a cache.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, sharePointPreview{URL: u})
}

// maxOfficeFileName caps the file name a request names (OneDrive's own
// limit is lower still).
const maxOfficeFileName = 255

// officeUploadDeadline is how long an Office file may take to come in and go
// on to OneDrive: far past the server's own read timeout, which is sized for
// JSON bodies, not files.
const officeUploadDeadline = 10 * time.Minute

// UploadOfficeFile puts an Office file posted in a channel into the
// caller's OneDrive: PUT /api/v1/channels/{id}/office-files?name=…, the file
// as the body. 409 when they have no working Microsoft sign-in; any refusal
// tells the client to attach it the ordinary way instead.
func (h *SharePointHandler) UploadOfficeFile(w http.ResponseWriter, r *http.Request) {
	h.uploadOfficeFile(w, r, service.ParentChannel)
}

// UploadConversationOfficeFile is UploadOfficeFile for a DM or group DM:
// PUT /api/v1/conversations/{id}/office-files?name=….
func (h *SharePointHandler) UploadConversationOfficeFile(w http.ResponseWriter, r *http.Request) {
	h.uploadOfficeFile(w, r, service.ParentConversation)
}

func (h *SharePointHandler) uploadOfficeFile(w http.ResponseWriter, r *http.Request, parentType string) {
	name := r.URL.Query().Get("name")
	if name == "" || len(name) > maxOfficeFileName {
		writeError(w, http.StatusBadRequest, "invalid_name", "name is required")
		return
	}
	if r.ContentLength <= 0 {
		writeError(w, http.StatusLengthRequired, "length_required", "the file's size is required")
		return
	}
	// Best effort: a writer that can't move its deadlines keeps the server's.
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Now().Add(officeUploadDeadline))
	_ = rc.SetWriteDeadline(time.Now().Add(officeUploadDeadline))
	body := http.MaxBytesReader(w, r.Body, r.ContentLength)
	up, err := h.svc.UploadOfficeFile(r.Context(), middleware.UserIDFromContext(r.Context()), pathParam(r, "id"), parentType, name, body, r.ContentLength)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, up)
}
