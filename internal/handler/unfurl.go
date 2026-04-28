package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/service"
)

// UnfurlHandler exposes /api/v1/unfurl?url=… so the client can render
// link previews without each browser hitting third-party sites
// directly (CORS would block most of them anyway).
type UnfurlHandler struct {
	svc *service.UnfurlService
}

// NewUnfurlHandler builds an UnfurlHandler.
func NewUnfurlHandler(svc *service.UnfurlService) *UnfurlHandler {
	return &UnfurlHandler{svc: svc}
}

// Get returns a JSON UnfurlPreview for the `url` query parameter.
// Failures (timeout, blocked host, non-HTML, network) return 204 No
// Content so the client can quietly skip the preview without surfacing
// an error to the user.
func (h *UnfurlHandler) Get(w http.ResponseWriter, r *http.Request) {
	raw := queryParam(r, "url", "")
	if raw == "" {
		writeError(w, http.StatusBadRequest, "missing_url", "url query parameter is required")
		return
	}
	preview, err := h.svc.Unfurl(r.Context(), raw)
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}
