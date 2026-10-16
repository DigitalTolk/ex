package handler

import (
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ProjectHandler serves the Projects page (plan-projects-design.md): products
// with their design references and reference screenshots.
type ProjectHandler struct {
	projects *service.ProjectService
}

// NewProjectHandler wires the handler.
func NewProjectHandler(p *service.ProjectService) *ProjectHandler {
	return &ProjectHandler{projects: p}
}

// projectBodyLimit bounds a project or screen body (design notes ≤ 8 KB plus
// the rest of the fields, with headroom).
const projectBodyLimit = 64 << 10

func projectCaller(r *http.Request) service.ProjectCaller {
	c := service.ProjectCaller{ID: middleware.UserIDFromContext(r.Context())}
	if claims := middleware.ClaimsFromContext(r.Context()); claims != nil {
		c.Role = claims.SystemRole
	}
	return c
}

func writeProjectError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "project or screen not found")
		return
	}
	writeServiceError(w, err, http.StatusInternalServerError, "internal")
}

// List returns every project with gallery counts.
// GET /api/v1/projects
func (h *ProjectHandler) List(w http.ResponseWriter, r *http.Request) {
	projects, err := h.projects.List(r.Context(), projectCaller(r))
	if err != nil {
		writeProjectError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"projects": projects})
}

// Get returns one project with its screens.
// GET /api/v1/projects/{key}
func (h *ProjectHandler) Get(w http.ResponseWriter, r *http.Request) {
	detail, err := h.projects.Get(r.Context(), projectCaller(r), r.PathValue("key"))
	if err != nil {
		writeProjectError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

// Create registers a project.
// POST /api/v1/projects
func (h *ProjectHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.ProjectInput
	if err := readJSONLimit(r, &in, projectBodyLimit); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	p, err := h.projects.Create(r.Context(), projectCaller(r), in)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"project": p})
}

// Update patches a project.
// PATCH /api/v1/projects/{key}
func (h *ProjectHandler) Update(w http.ResponseWriter, r *http.Request) {
	var in service.ProjectInput
	if err := readJSONLimit(r, &in, projectBodyLimit); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	p, err := h.projects.Update(r.Context(), projectCaller(r), r.PathValue("key"), in)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"project": p})
}

// Delete removes a project and its screens.
// DELETE /api/v1/projects/{key}
func (h *ProjectHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.projects.Delete(r.Context(), projectCaller(r), r.PathValue("key")); err != nil {
		writeProjectError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// AddScreen adds a reference screenshot (the image is uploaded first through
// the normal attachment flow).
// POST /api/v1/projects/{key}/screens
func (h *ProjectHandler) AddScreen(w http.ResponseWriter, r *http.Request) {
	var in service.ScreenInput
	if err := readJSONLimit(r, &in, projectBodyLimit); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	sc, err := h.projects.AddScreen(r.Context(), projectCaller(r), r.PathValue("key"), in)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, JSON{"screen": sc})
}

// UpdateScreen edits a screen's labels or replaces its image.
// PATCH /api/v1/projects/{key}/screens/{id}
func (h *ProjectHandler) UpdateScreen(w http.ResponseWriter, r *http.Request) {
	var in service.ScreenInput
	if err := readJSONLimit(r, &in, projectBodyLimit); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	sc, err := h.projects.UpdateScreen(r.Context(), projectCaller(r), r.PathValue("key"), r.PathValue("id"), in)
	if err != nil {
		writeProjectError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"screen": sc})
}

// DeleteScreen removes a screen.
// DELETE /api/v1/projects/{key}/screens/{id}
func (h *ProjectHandler) DeleteScreen(w http.ResponseWriter, r *http.Request) {
	if err := h.projects.DeleteScreen(r.Context(), projectCaller(r), r.PathValue("key"), r.PathValue("id")); err != nil {
		writeProjectError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
