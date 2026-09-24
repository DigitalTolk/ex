package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
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
		h.writeContextError(w, r, err)
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
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	item, err := h.ctxSvc.Write(r.Context(), service.ContextWrite{
		// A human's own item: no invoking agent to attribute.
		AuthorID: userID, AccessorID: userID,
		ParentID: r.PathValue("parentID"), ParentType: r.PathValue("parentType"),
		Body: body.Body, Pinned: body.Pinned,
	})
	if err != nil {
		h.writeContextError(w, r, err)
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
	if err := readAgentJSON(r, &body, maxAgentBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid body")
		return
	}
	item, err := h.ctxSvc.SetPinned(r.Context(), userID, r.PathValue("parentID"), r.PathValue("parentType"), r.PathValue("itemID"), body.Pinned)
	if err != nil {
		h.writeContextError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"item": item})
}

// Delete removes an item.
// DELETE /api/v1/context/{parentType}/{parentID}/{itemID}
func (h *ContextHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if err := h.ctxSvc.Delete(r.Context(), userID, r.PathValue("parentID"), r.PathValue("parentType"), r.PathValue("itemID")); err != nil {
		h.writeContextError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"ok": true})
}

func (h *ContextHandler) writeContextError(w http.ResponseWriter, r *http.Request, err error) {
	// "internal" keeps the wire code the SPA already switches on; the operation
	// is identified in the server log by method + path.
	writeAgentError(w, r, err, "internal")
}
