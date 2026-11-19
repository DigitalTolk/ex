package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// UserGroupHandler is the user-group API (/api/v1/usergroups). Every member
// reads groups; admins edit their details and enable or disable them (the
// service decides). Groups themselves come from the Microsoft 365 department
// field. Guests are refused.
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

// HandleAvailable answers GET /api/v1/usergroup-handles/{handle}.
func (h *UserGroupHandler) HandleAvailable(w http.ResponseWriter, r *http.Request) {
	ok, err := h.svc.HandleAvailable(r.Context(), userGroupActor(r), r.PathValue("handle"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"available": ok})
}

// Permissions answers GET /api/v1/usergroup-permissions: whether the caller
// may edit groups (the directory shows its controls by it).
func (h *UserGroupHandler) Permissions(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"canManage": h.svc.CanManage(userGroupActor(r))})
}

// SyncStatus answers GET /api/v1/usergroup-sync: the last sweep's group sync
// and the department values it read only partly (admins).
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

// Update answers PATCH /api/v1/usergroups/{id}.
func (h *UserGroupHandler) Update(w http.ResponseWriter, r *http.Request) {
	var body service.UserGroupPatch
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	g, err := h.svc.Update(r.Context(), userGroupActor(r), r.PathValue("id"), body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
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
