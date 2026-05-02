package handler

import (
	"context"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/service"
)

// SearchStatusReporter is the slim view AdminHandler needs to render
// the search status panel: cluster health + per-index docs/size. The
// concrete *search.Client satisfies this directly.
type SearchStatusReporter interface {
	ClusterHealth(ctx context.Context) (map[string]any, error)
	IndexStats(ctx context.Context) ([]search.IndexStat, error)
}

// AdminHandler exposes admin-only endpoints for workspace configuration.
// Authorization is enforced inside each handler — `middleware.Auth` only
// confirms the caller is signed in, not that they're an admin.
type AdminHandler struct {
	settings  *service.SettingsService
	searchSt  SearchStatusReporter
	reindexer *search.Reindexer
}

// NewAdminHandler constructs an AdminHandler.
func NewAdminHandler(settings *service.SettingsService) *AdminHandler {
	return &AdminHandler{settings: settings}
}

// SetSearch wires the optional search status reporter + reindexer.
// Production passes the live ones; tests can pass nil and the
// search-admin routes return 503.
func (h *AdminHandler) SetSearch(reporter SearchStatusReporter, reindexer *search.Reindexer) {
	h.searchSt = reporter
	h.reindexer = reindexer
}

// settingsResponse is the wire shape returned from GetSettings. It
// extends model.WorkspaceSettings with a derived `giphyEnabled` flag.
// GIPHY requires API and media requests to be made directly by the
// client, so authenticated members receive the configured browser key
// when the picker is enabled.
type settingsResponse struct {
	MaxUploadBytes    int64    `json:"maxUploadBytes"`
	AllowedExtensions []string `json:"allowedExtensions"`
	GiphyAPIKey       string   `json:"giphyAPIKey,omitempty"`
	GiphyEnabled      bool     `json:"giphyEnabled"`
}

// GetSettings returns the effective workspace settings (with defaults
// applied for any field the admin hasn't overridden). Available to all
// authenticated users so the upload UI can show the limits before
// attempting a request — the write side is admin-only.
func (h *AdminHandler) GetSettings(w http.ResponseWriter, r *http.Request) {
	claims := middleware.ClaimsFromContext(r.Context())
	if claims == nil {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	ws := h.settings.Effective(r.Context())
	resp := settingsResponse{
		MaxUploadBytes:    ws.MaxUploadBytes,
		AllowedExtensions: ws.AllowedExtensions,
		GiphyEnabled:      ws.GiphyAPIKey != "",
	}
	resp.GiphyAPIKey = ws.GiphyAPIKey
	writeJSON(w, http.StatusOK, resp)
}

// SearchStatus returns the search cluster's health, per-index doc
// counts/sizes, and the most recent reindex progress. Admin-only.
// Returns 503 with a structured payload (`configured: false`) when
// search isn't wired so the UI can render the panel without erroring.
func (h *AdminHandler) SearchStatus(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	if h.searchSt == nil || h.reindexer == nil {
		writeJSON(w, http.StatusOK, JSON{"configured": false})
		return
	}
	ctx := r.Context()
	resp := JSON{"configured": true}
	if health, err := h.searchSt.ClusterHealth(ctx); err == nil && health != nil {
		resp["cluster"] = health
	} else if err != nil {
		resp["clusterError"] = err.Error()
	}
	if stats, err := h.searchSt.IndexStats(ctx); err == nil {
		resp["indices"] = stats
	} else {
		resp["indicesError"] = err.Error()
	}
	resp["reindex"] = h.reindexer.Status()
	writeJSON(w, http.StatusOK, resp)
}

// StartSearchReindex kicks off a full rebuild in the background.
// Admin-only. Returns 202 if a fresh run started, 409 if one is
// already running, 503 if search isn't configured.
func (h *AdminHandler) StartSearchReindex(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	if h.reindexer == nil {
		writeError(w, http.StatusServiceUnavailable, "search_disabled", "search is not configured")
		return
	}
	// Detach the request context so the goroutine survives the HTTP
	// response. Reindexes routinely outlive the request timeout —
	// admins poll status via SearchStatus afterwards.
	if !h.reindexer.Start(context.Background(), nowUnix) {
		writeError(w, http.StatusConflict, "already_running", "a reindex is already running")
		return
	}
	writeJSON(w, http.StatusAccepted, h.reindexer.Status())
}

func nowUnix() int64 { return time.Now().Unix() }

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
	writeJSON(w, http.StatusOK, settingsResponse{
		MaxUploadBytes:    out.MaxUploadBytes,
		AllowedExtensions: out.AllowedExtensions,
		GiphyAPIKey:       out.GiphyAPIKey,
		GiphyEnabled:      out.GiphyAPIKey != "",
	})
}
