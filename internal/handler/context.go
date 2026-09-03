package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ContextHandler serves the human side of shared context (plan-v2 §8):
// listing, adding, pinning and deleting the curated items agents read into
// every bundle for a channel/conversation.
type ContextHandler struct {
	ctxSvc *service.ContextService
}

// NewContextHandler wires the handler.
func NewContextHandler(ctxSvc *service.ContextService) *ContextHandler {
	return &ContextHandler{ctxSvc: ctxSvc}
}

// List returns a parent's shared-context items.
// GET /api/v1/context/{parentType}/{parentID}
func (h *ContextHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	items, err := h.ctxSvc.List(r.Context(), userID, r.PathValue("parentID"), r.PathValue("parentType"))
	if err != nil {
		h.writeContextError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"items": items})
}

type createContextBody struct {
	Body   string `json:"body"`
	Pinned bool   `json:"pinned"`
}

// Create appends one item authored by the caller.
// POST /api/v1/context/{parentType}/{parentID}
func (h *ContextHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	var body createContextBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	item, err := h.ctxSvc.Write(r.Context(), userID, "", userID, r.PathValue("parentID"), r.PathValue("parentType"), body.Body, body.Pinned)
	if err != nil {
		h.writeContextError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"item": item})
}

type pinContextBody struct {
	Pinned bool `json:"pinned"`
}

// SetPinned toggles an item's trim priority.
// PATCH /api/v1/context/{parentType}/{parentID}/{itemID}
func (h *ContextHandler) SetPinned(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	var body pinContextBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	item, err := h.ctxSvc.SetPinned(r.Context(), userID, r.PathValue("parentID"), r.PathValue("parentType"), r.PathValue("itemID"), body.Pinned)
	if err != nil {
		h.writeContextError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"item": item})
}

// Delete removes an item.
// DELETE /api/v1/context/{parentType}/{parentID}/{itemID}
func (h *ContextHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if err := h.ctxSvc.Delete(r.Context(), userID, r.PathValue("parentID"), r.PathValue("parentType"), r.PathValue("itemID")); err != nil {
		h.writeContextError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"ok": true})
}

func (h *ContextHandler) writeContextError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, service.ErrValidation):
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
	case errors.Is(err, service.ErrContextFull):
		writeError(w, http.StatusConflict, "context_full", "shared context is full for this channel")
	case errors.Is(err, service.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "no access")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "context item not found")
	default:
		writeError(w, http.StatusInternalServerError, "internal", "context operation failed")
	}
}
