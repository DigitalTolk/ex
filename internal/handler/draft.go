package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
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
		writeServiceError(w, r, err)
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
		// BasisGen is the generation the client is acting on ("" = it
		// believes the scope has no draft). REQUIRED: a pointer so a missing
		// field — a stale pre-gen client — is distinguishable from an
		// explicit empty basis and rejected outright, never guessed at.
		BasisGen *string `json:"basisGen"`
		// Ts is the retired client-clock field. Parsed only so pre-gen
		// clients' requests still decode (readJSON rejects unknown fields);
		// its value is ignored — ordering is server-owned.
		Ts int64 `json:"ts"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.BasisGen == nil {
		writeError(w, http.StatusBadRequest, "missing_basis", "basisGen is required; reload to update the app")
		return
	}
	silent := body.Notify != nil && !*body.Notify
	draft, err := h.draftSvc.Upsert(r.Context(), userID, body.ParentID, body.ParentType, body.ParentMessageID, body.Body, body.AttachmentIDs, *body.BasisGen, service.WithSilent(silent))
	if err != nil {
		writeServiceError(w, r, err)
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
	// Explicit delete from the Drafts page. Still CAS-gated: the delete only
	// applies to the generation the user was looking at (?gen=), so a stale
	// page can't remove a draft that changed since it rendered — the 409
	// hands back the truth to re-render from.
	gen := r.URL.Query().Get("gen")
	if gen == "" {
		writeError(w, http.StatusBadRequest, "missing_basis", "gen is required; reload to update the app")
		return
	}
	if err := h.draftSvc.Delete(r.Context(), userID, pathParam(r, "id"), gen); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
