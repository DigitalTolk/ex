package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// DraftClearer clears the composer draft for a scope when its message is sent —
// folding the draft cleanup into the message-create call so the client makes no
// separate request. Implemented by *service.DraftService.
type DraftClearer interface {
	DeleteForScope(ctx context.Context, userID, parentID, parentType, parentMessageID string, ts int64) error
}

// clearSentDraft removes the scope's draft after a successful send. Best-effort
// and OFF the hot path: like the notify/index side effects of a send, it runs in
// a detached goroutine so the response doesn't wait on the draft store + pub/sub.
// A failure is only logged (the message is already created). ts is the client's
// send time, used for last-write-wins so a keystroke save still in flight can't
// resurrect the just-sent draft.
func clearSentDraft(ctx context.Context, clearer DraftClearer, userID, parentID, parentType, parentMessageID string, ts int64) {
	if clearer == nil {
		return
	}
	bg := context.WithoutCancel(ctx)
	go func() {
		if err := clearer.DeleteForScope(bg, userID, parentID, parentType, parentMessageID, ts); err != nil {
			slog.Warn("clear sent draft failed", "userID", userID, "parentID", parentID, "parentType", parentType, "error", err)
		}
	}()
}

// DraftHandler exposes server-side message draft endpoints.
type DraftHandler struct {
	draftSvc *service.DraftService
}

func NewDraftHandler(draftSvc *service.DraftService) *DraftHandler {
	return &DraftHandler{draftSvc: draftSvc}
}

func (h *DraftHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	drafts, err := h.draftSvc.List(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return
	}
	if drafts == nil {
		drafts = []*model.MessageDraft{}
	}
	writeJSON(w, http.StatusOK, drafts)
}

func (h *DraftHandler) Upsert(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	var body struct {
		ParentID        string   `json:"parentID"`
		ParentType      string   `json:"parentType"`
		ParentMessageID string   `json:"parentMessageID"`
		Body            string   `json:"body"`
		AttachmentIDs   []string `json:"attachmentIDs"`
		// Notify controls whether saving broadcasts the draft.updated event
		// (which surfaces the sidebar "draft available" indicator on this
		// and other devices). Omitted/true → broadcast, preserving legacy
		// behavior. The composer sends false for keystroke saves so the
		// indicator only appears once the field loses focus, then a final
		// save with notify=true (or omitted) surfaces it.
		Notify *bool `json:"notify"`
		// Ts is the client edit-time (epoch ms) used for last-write-wins
		// ordering in the store. Omitted (0) → the server uses its own clock.
		Ts int64 `json:"ts"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	silent := body.Notify != nil && !*body.Notify
	draft, err := h.draftSvc.Upsert(r.Context(), userID, body.ParentID, body.ParentType, body.ParentMessageID, body.Body, body.AttachmentIDs, service.WithSilent(silent), service.WithClientTs(body.Ts))
	if err != nil {
		writeDraftError(w, err)
		return
	}
	if draft == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, draft)
}

func (h *DraftHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	// Explicit delete from the Drafts page — a deliberate latest action, so the
	// server clock (ts=0 → now) wins LWW; no concurrent-save race here.
	if err := h.draftSvc.Delete(r.Context(), userID, pathParam(r, "id"), 0); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "draft not found")
			return
		}
		writeDraftError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeDraftError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "draft target not found")
		return
	}
	msg := err.Error()
	if msg == "draft: not a channel member" || msg == "draft: not a conversation participant" {
		writeError(w, http.StatusForbidden, "forbidden", msg)
		return
	}
	writeServiceError(w, err, http.StatusInternalServerError, "draft_error")
}
