package handler

import (
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// SidebarHandler exposes the per-user sidebar customisation endpoints:
// favorite/unfavorite, assign-to-category (for both channels and
// conversations), and category CRUD.
type SidebarHandler struct {
	channelSvc  *service.ChannelService
	convSvc     *service.ConversationService
	categorySvc *service.CategoryService
}

func NewSidebarHandler(channelSvc *service.ChannelService, convSvc *service.ConversationService, categorySvc *service.CategoryService) *SidebarHandler {
	return &SidebarHandler{channelSvc: channelSvc, convSvc: convSvc, categorySvc: categorySvc}
}

// SetFavorite toggles the favorite flag on a channel for the calling user.
func (h *SidebarHandler) SetFavorite(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	channelID := pathParam(r, "id")
	if channelID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}
	var body struct {
		Favorite bool `json:"favorite"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if err := h.channelSvc.SetFavorite(r.Context(), userID, channelID, body.Favorite); err != nil {
		writeError(w, http.StatusForbidden, "favorite_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// validateUserCategory short-circuits when the categoryID is empty
// (clearing the assignment is always valid) or when no category service
// is wired. Otherwise it confirms the categoryID belongs to the calling
// user, writing a 4xx and returning false on rejection.
func (h *SidebarHandler) validateUserCategory(w http.ResponseWriter, r *http.Request, userID, categoryID string) bool {
	if categoryID == "" || h.categorySvc == nil {
		return true
	}
	cats, err := h.categorySvc.List(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return false
	}
	for _, c := range cats {
		if c.ID == categoryID {
			return true
		}
	}
	writeError(w, http.StatusBadRequest, "invalid_category", "category does not belong to this user")
	return false
}

// SetCategory assigns the channel to a sidebar category (or clears the
// assignment when categoryID is empty).
func (h *SidebarHandler) SetCategory(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	channelID := pathParam(r, "id")
	if channelID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}
	var body struct {
		CategoryID string `json:"categoryID"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if !h.validateUserCategory(w, r, userID, body.CategoryID) {
		return
	}
	if err := h.channelSvc.SetCategory(r.Context(), userID, channelID, body.CategoryID); err != nil {
		writeError(w, http.StatusForbidden, "category_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ListCategories returns the user's sidebar categories.
func (h *SidebarHandler) ListCategories(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	cats, err := h.categorySvc.List(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cats)
}

// CreateCategory adds a new category for the calling user.
func (h *SidebarHandler) CreateCategory(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	var body struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	cat, err := h.categorySvc.Create(r.Context(), userID, body.Name)
	if err != nil {
		writeError(w, http.StatusBadRequest, "create_error", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, cat)
}

// UpdateCategory renames or repositions a category. Body fields are
// optional; only the ones supplied are applied.
func (h *SidebarHandler) UpdateCategory(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "category ID is required")
		return
	}
	var body struct {
		Name     *string `json:"name"`
		Position *int    `json:"position"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	cat, err := h.categorySvc.Update(r.Context(), userID, id, body.Name, body.Position)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "category not found")
			return
		}
		writeError(w, http.StatusBadRequest, "update_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, cat)
}

// DeleteCategory removes a category.
func (h *SidebarHandler) DeleteCategory(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "category ID is required")
		return
	}
	if err := h.categorySvc.Delete(r.Context(), userID, id); err != nil {
		writeError(w, http.StatusInternalServerError, "delete_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SetConversationFavorite toggles the favorite flag on a DM/group for
// the calling user. Same wire shape as the channel version.
func (h *SidebarHandler) SetConversationFavorite(w http.ResponseWriter, r *http.Request) {
	if h.convSvc == nil {
		writeError(w, http.StatusServiceUnavailable, "no_service", "conversation service unavailable")
		return
	}
	userID := middleware.UserIDFromContext(r.Context())
	convID := pathParam(r, "id")
	if convID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID is required")
		return
	}
	var body struct {
		Favorite bool `json:"favorite"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if err := h.convSvc.SetFavorite(r.Context(), userID, convID, body.Favorite); err != nil {
		writeError(w, http.StatusForbidden, "favorite_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SetConversationCategory assigns the DM/group to a sidebar category
// (or clears it when categoryID is empty). The same SidebarCategory
// namespace is shared with channels.
func (h *SidebarHandler) SetConversationCategory(w http.ResponseWriter, r *http.Request) {
	if h.convSvc == nil {
		writeError(w, http.StatusServiceUnavailable, "no_service", "conversation service unavailable")
		return
	}
	userID := middleware.UserIDFromContext(r.Context())
	convID := pathParam(r, "id")
	if convID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID is required")
		return
	}
	var body struct {
		CategoryID string `json:"categoryID"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if !h.validateUserCategory(w, r, userID, body.CategoryID) {
		return
	}
	if err := h.convSvc.SetCategory(r.Context(), userID, convID, body.CategoryID); err != nil {
		writeError(w, http.StatusForbidden, "category_error", err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
