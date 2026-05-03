package handler

import (
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

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
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	draft, err := h.draftSvc.Upsert(r.Context(), userID, body.ParentID, body.ParentType, body.ParentMessageID, body.Body, body.AttachmentIDs)
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
	if err := h.draftSvc.Delete(r.Context(), userID, pathParam(r, "id")); err != nil {
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
