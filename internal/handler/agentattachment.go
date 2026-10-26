package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// Run-scoped attachment endpoints: how a runner gets the bytes of a file a
// user attached (input) and stores a file the agent produced (output). Both
// ride the run token; the invoker's access decides what can be read, and the
// run binding decides what can be attached.

// SetAttachments wires the attachment service; the router registers the
// attachment routes only when set.
func (h *AgentRunToolHandler) SetAttachments(a *service.AttachmentService) { h.attachments = a }

// filenameHeader carries the upload's file name, percent-encoded so any
// Unicode name survives an HTTP header.
const filenameHeader = "X-Ex-Filename"

// DownloadAttachment streams one attachment the run's INVOKER can read:
// the invoking message's files by default, or any message in the run's chat
// named by messageID (the [m:<id>] labels in the transcript).
// GET /api/v1/agent/run/attachments/{id}?messageID=
func (h *AgentRunToolHandler) DownloadAttachment(w http.ResponseWriter, r *http.Request) {
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	messageID := r.URL.Query().Get("messageID")
	if messageID == "" {
		messageID = run.MessageID
	}
	id := r.PathValue("id")
	body, a, err := h.attachments.OpenForUser(r.Context(), claims.UserID, id, run.ParentID, run.ParentType, messageID)
	source := "message"
	// A run about a project may also read that project's reference
	// screenshots — they live on the Projects page, not in any message.
	if errors.Is(err, apperr.ErrNotFound) && h.orch.RunMayReadScreen(r.Context(), run, id) {
		body, a, err = h.attachments.OpenByID(r.Context(), id)
		source = "project_screen"
	}
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	defer func() { _ = body.Close() }()
	// The drawer's "files it took in" list: what the agent actually read.
	// The message it was read through rides along: the drawer re-checks the
	// invoker's access through it before listing the file.
	fetched := map[string]any{"attachmentID": a.ID, "filename": a.Filename, "size": a.Size, "source": source}
	if source == "message" {
		fetched["messageID"] = messageID
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "file_fetched", fetched)
	w.Header().Set("Content-Type", a.ContentType)
	w.Header().Set("Content-Length", strconv.FormatInt(a.Size, 10))
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(a.Filename))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	// A short read means the object changed under us; the client sees a
	// length mismatch and retries, which is the right outcome.
	_, _ = io.CopyN(w, body, a.Size)
}

// UploadAttachment stores a file the agent produced, for its own posts.
// Raw bytes in the body; Content-Length is the declared size; the file name
// rides X-Ex-Filename (percent-encoded). Counted against the run's upload cap
// BEFORE the bytes are read, so a capped run cannot even make the server
// buffer them.
// POST /api/v1/agent/run/attachments
func (h *AgentRunToolHandler) UploadAttachment(w http.ResponseWriter, r *http.Request) {
	run, claims := h.liveRun(w, r)
	if run == nil {
		return
	}
	filename, err := url.PathUnescape(r.Header.Get(filenameHeader))
	if err != nil || strings.TrimSpace(filename) == "" {
		writeError(w, http.StatusBadRequest, "bad_request", filenameHeader+" header required (percent-encoded file name)")
		return
	}
	if r.ContentLength <= 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "Content-Length required")
		return
	}
	if r.ContentLength > model.UploadMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", fmt.Sprintf("file exceeds %d bytes", model.UploadMaxBytes))
		return
	}
	remaining, err := h.orch.RecordAgentUpload(r.Context(), claims.RunID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	a, err := h.attachments.UploadForAgent(r.Context(), service.AgentUploadParams{
		RunID:    claims.RunID,
		AgentID:  claims.ActorID,
		Filename: filename,
		Size:     r.ContentLength,
		Body:     http.MaxBytesReader(w, r.Body, model.UploadMaxBytes+1),
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	h.orch.RecordWorkspaceAction(r.Context(), run, "file_uploaded", map[string]any{
		"attachmentID": a.ID, "filename": a.Filename, "size": a.Size,
	})
	writeJSON(w, http.StatusCreated, JSON{
		"attachment":       JSON{"id": a.ID, "filename": a.Filename, "contentType": a.ContentType, "size": a.Size},
		"remainingUploads": remaining,
	})
}

// runPostAttachments validates the attachment ids a post names: at most
// MaxAttachmentsPerMessage, each stored by THIS run. Anything else — another
// run's file, a user's file echoed from the transcript — is refused whole, so
// a post never goes out with a subset of what the model asked for.
func (h *AgentRunToolHandler) runPostAttachments(w http.ResponseWriter, r *http.Request, claims *model.TokenClaims, ids []string) ([]string, bool) {
	if len(ids) == 0 {
		return nil, true
	}
	if h.attachments == nil {
		writeError(w, http.StatusBadRequest, "bad_request", "attachments are not enabled")
		return nil, false
	}
	if len(ids) > service.MaxAttachmentsPerMessage {
		writeError(w, http.StatusBadRequest, "bad_request", fmt.Sprintf("at most %d attachments per message", service.MaxAttachmentsPerMessage))
		return nil, false
	}
	out := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if _, err := h.attachments.ForRunPost(r.Context(), id, claims.RunID, claims.ActorID); err != nil {
			writeServiceError(w, r, toolRejection("attachment rejected", err, "only files this run uploaded can be attached"))
			return nil, false
		}
		out = append(out, id)
	}
	return out, true
}
