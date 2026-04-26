package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// EmojiHandler exposes HTTP endpoints for custom emoji management.
type EmojiHandler struct {
	emojiSvc *service.EmojiService
}

// NewEmojiHandler creates an EmojiHandler.
func NewEmojiHandler(s *service.EmojiService) *EmojiHandler {
	return &EmojiHandler{emojiSvc: s}
}

// List returns all custom emojis defined in the workspace.
func (h *EmojiHandler) List(w http.ResponseWriter, r *http.Request) {
	emojis, err := h.emojiSvc.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return
	}
	if emojis == nil {
		emojis = []*model.CustomEmoji{}
	}
	writeJSON(w, http.StatusOK, emojis)
}

// Create adds a new custom emoji. The image must already be uploaded; the
// caller passes the resulting fileURL.
func (h *EmojiHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	var body struct {
		Name     string `json:"name"`
		ImageURL string `json:"imageURL"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	emoji, err := h.emojiSvc.Create(r.Context(), userID, body.Name, body.ImageURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, "create_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, emoji)
}

// Delete removes a custom emoji. Only admins or the creator may delete.
func (h *EmojiHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	name := pathParam(r, "name")
	if name == "" {
		writeError(w, http.StatusBadRequest, "missing_name", "emoji name is required")
		return
	}
	if err := h.emojiSvc.Delete(r.Context(), userID, name); err != nil {
		writeError(w, http.StatusForbidden, "delete_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
