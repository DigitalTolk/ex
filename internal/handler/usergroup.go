package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// UserGroupHandler is the user-group API (/api/v1/usergroups). Every member
// reads groups; managing them is up to the service (admins, or every member
// when the workspace allows it). Guests are refused.
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
// may create and edit groups (the directory shows its controls by it).
func (h *UserGroupHandler) Permissions(w http.ResponseWriter, r *http.Request) {
	actor := userGroupActor(r)
	writeJSON(w, http.StatusOK, map[string]bool{
		"canManage":        h.svc.CanManage(r.Context(), actor),
		"canLinkMicrosoft": h.svc.CanLinkMicrosoft(actor),
	})
}

// SearchMicrosoft answers GET /api/v1/usergroup-sources/microsoft?q=.
func (h *UserGroupHandler) SearchMicrosoft(w http.ResponseWriter, r *http.Request) {
	groups, err := h.svc.SearchEntraGroups(r.Context(), userGroupActor(r), r.URL.Query().Get("q"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, groups)
}

// PreviewMicrosoft answers GET
// /api/v1/usergroup-sources/microsoft/{entraId}/preview?groupId=.
func (h *UserGroupHandler) PreviewMicrosoft(w http.ResponseWriter, r *http.Request) {
	preview, err := h.svc.PreviewLink(r.Context(), userGroupActor(r), r.PathValue("entraId"), r.URL.Query().Get("groupId"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}

// Link answers POST /api/v1/usergroups/{id}/link.
func (h *UserGroupHandler) Link(w http.ResponseWriter, r *http.Request) {
	var body struct {
		EntraGroupID string `json:"entraGroupId"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	g, err := h.svc.Link(r.Context(), userGroupActor(r), r.PathValue("id"), body.EntraGroupID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// Unlink answers POST /api/v1/usergroups/{id}/unlink.
func (h *UserGroupHandler) Unlink(w http.ResponseWriter, r *http.Request) {
	g, err := h.svc.Unlink(r.Context(), userGroupActor(r), r.PathValue("id"))
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// Sync answers POST /api/v1/usergroups/{id}/sync.
func (h *UserGroupHandler) Sync(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ApplyRemovals bool `json:"applyRemovals"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	g, err := h.svc.SyncNow(r.Context(), userGroupActor(r), r.PathValue("id"), body.ApplyRemovals)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
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

// Create answers POST /api/v1/usergroups.
func (h *UserGroupHandler) Create(w http.ResponseWriter, r *http.Request) {
	var body service.UserGroupInput
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	g, err := h.svc.Create(r.Context(), userGroupActor(r), body)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, g)
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

// AddMembers answers POST /api/v1/usergroups/{id}/members.
func (h *UserGroupHandler) AddMembers(w http.ResponseWriter, r *http.Request) {
	var body struct {
		UserIDs []string `json:"userIds"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	g, err := h.svc.AddMembers(r.Context(), userGroupActor(r), r.PathValue("id"), body.UserIDs)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, g)
}

// RemoveMember answers DELETE /api/v1/usergroups/{id}/members/{uid}.
func (h *UserGroupHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	g, err := h.svc.RemoveMember(r.Context(), userGroupActor(r), r.PathValue("id"), r.PathValue("uid"))
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
