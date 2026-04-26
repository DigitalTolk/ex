package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// AdminHandler exposes admin-only endpoints for workspace configuration.
// Authorization is enforced inside each handler — `middleware.Auth` only
// confirms the caller is signed in, not that they're an admin.
type AdminHandler struct {
	settings *service.SettingsService
}

// NewAdminHandler constructs an AdminHandler.
func NewAdminHandler(settings *service.SettingsService) *AdminHandler {
	return &AdminHandler{settings: settings}
}

// GetSettings returns the effective workspace settings (with defaults
// applied for any field the admin hasn't overridden). Available to all
// authenticated users so the upload UI can show the limits before
// attempting a request — the write side is admin-only.
func (h *AdminHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	if middleware.UserIDFromContext(r.Context()) == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	ws := h.settings.Effective(r.Context())
	writeJSON(w, http.StatusOK, ws)
}

// UpdateSettings replaces the workspace settings. Admin-only.
func (h *AdminHandler) UpdateSettings(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var body model.WorkspaceSettings
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	out, err := h.settings.Update(r.Context(), &body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "update_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}
