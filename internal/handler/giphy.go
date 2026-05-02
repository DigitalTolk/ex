package handler

import (
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// GiphyHandler proxies search/trending requests to Giphy using the
// workspace-configured API key. Authenticated users only — we don't
// want anonymous traffic burning the workspace's rate budget.
//
// The wire shape is Giphy's raw `{data, meta, pagination}` envelope so
// the frontend can pass it straight to `@giphy/react-components`'
// `<Grid>` without any reshaping.
type GiphyHandler struct {
	svc *service.GiphyService
}

// NewGiphyHandler builds a GiphyHandler.
func NewGiphyHandler(svc *service.GiphyService) *GiphyHandler {
	return &GiphyHandler{svc: svc}
}

// Search proxies GET /api/v1/giphy/search?q=…&limit=…&offset=….
func (h *GiphyHandler) Search(w http.ResponseWriter, r *http.Request) {
	if middleware.UserIDFromContext(r.Context()) == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	q := queryParam(r, "q", "")
	limit := queryInt(r, "limit", 25)
	offset := queryInt(r, "offset", 0)
	body, err := h.svc.Search(r.Context(), q, limit, offset)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	h.writeRaw(w, body)
}

// Trending proxies GET /api/v1/giphy/trending?limit=…&offset=….
func (h *GiphyHandler) Trending(w http.ResponseWriter, r *http.Request) {
	if middleware.UserIDFromContext(r.Context()) == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	limit := queryInt(r, "limit", 25)
	offset := queryInt(r, "offset", 0)
	body, err := h.svc.Trending(r.Context(), limit, offset)
	if err != nil {
		h.writeErr(w, err)
		return
	}
	h.writeRaw(w, body)
}

func (h *GiphyHandler) writeRaw(w http.ResponseWriter, body []byte) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func (h *GiphyHandler) writeErr(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrGiphyNotConfigured) {
		writeError(w, http.StatusServiceUnavailable, "giphy_not_configured", "giphy is not configured")
		return
	}
	writeError(w, http.StatusBadGateway, "giphy_upstream", err.Error())
}
