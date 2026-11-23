package handler

import (
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// UserGroupHandler is the user-group API (/api/v1/usergroups). Every member
// reads groups; admins enable or disable them and run the sync (the service
// decides). Groups themselves come from Microsoft 365. Guests are refused.
type UserGroupHandler struct {
	svc *service.UserGroupService
}

// NewUserGroupHandler returns the user-group handler.
func NewUserGroupHandler(svc *service.UserGroupService) *UserGroupHandler {
	return &UserGroupHandler{svc: svc}
}

func userGroupActor(r *http.Request) service.UserGroupActor {
	claims := middleware.ClaimsFromContext(r.Context())
	if claims == nil {
		return service.UserGroupActor{}
	}
	return service.UserGroupActor{ID: claims.UserID, Role: claims.SystemRole}
}

// List answers GET /api/v1/usergroups?includeDisabled=true.
func (h *UserGroupHandler) List(w http.ResponseWriter, r *http.Request) {
	groups, err := h.svc.List(r.Context(), userGroupActor(r), r.URL.Query().Get("includeDisabled") == "true")
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

// Get answers GET /api/v1/usergroups/{id}.
func (h *UserGroupHandler) Get(w http.ResponseWriter, r *http.Request) {
	g, err := h.svc.Get(r.Context(), userGroupActor(r), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// Permissions answers GET /api/v1/usergroup-permissions: whether the caller
// may manage groups (the directory shows its controls by it).
func (h *UserGroupHandler) Permissions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"canManage": h.svc.CanManage(userGroupActor(r))})
}

// SyncStatus answers GET /api/v1/usergroup-sync: how the sync went (admins).
func (h *UserGroupHandler) SyncStatus(w http.ResponseWriter, r *http.Request) {
	status, err := h.svc.SyncStatus(r.Context(), userGroupActor(r))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

// ForUser answers GET /api/v1/users/{id}/usergroups.
func (h *UserGroupHandler) ForUser(w http.ResponseWriter, r *http.Request) {
	groups, err := h.svc.GroupsForUser(r.Context(), userGroupActor(r), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

// SyncNow answers POST /api/v1/usergroup-sync: starts a sync (admins). 202
// with the status when one started or was already running; 429 with the
// status right after a run.
func (h *UserGroupHandler) SyncNow(w http.ResponseWriter, r *http.Request) {
	status, err := h.svc.SyncNow(r.Context(), userGroupActor(r))
	switch {
	case errors.Is(err, service.ErrUserGroupSyncCooldown):
		writeJSON(w, http.StatusTooManyRequests, status)
	case err != nil:
		writeServiceError(w, r, err)
	default:
		writeJSON(w, http.StatusAccepted, status)
	}
}

// Enable answers POST /api/v1/usergroups/{id}/enable.
func (h *UserGroupHandler) Enable(w http.ResponseWriter, r *http.Request) { h.setEnabled(w, r, true) }

// Disable answers POST /api/v1/usergroups/{id}/disable.
func (h *UserGroupHandler) Disable(w http.ResponseWriter, r *http.Request) {
	h.setEnabled(w, r, false)
}

func (h *UserGroupHandler) setEnabled(w http.ResponseWriter, r *http.Request, enabled bool) {
	g, err := h.svc.SetEnabled(r.Context(), userGroupActor(r), r.PathValue("id"), enabled)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}
