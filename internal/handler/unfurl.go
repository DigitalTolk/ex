package handler

import (
	"context"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// unfurlService is the slice of *service.UnfurlService the handler depends on.
// As an interface it lets tests inject a fake that returns a preview, covering
// the success path a real UnfurlService cannot reach in a unit test (its SSRF
// guard blocks the loopback hosts httptest binds to).
type unfurlService interface {
	Unfurl(ctx context.Context, rawURL string) (*service.UnfurlPreview, error)
}

// messageLinkResolver turns a deep link to a message inside this workspace into
// a rich preview, gated by the viewer's access. Optional — wired via
// SetMessageLinks. The bool reports whether the URL is one of our message
// links at all (so the handler doesn't web-scrape our own host).
type messageLinkResolver interface {
	Preview(ctx context.Context, viewerID, rawURL string) (*service.UnfurlPreview, bool)
}

// UnfurlHandler exposes /api/v1/unfurl?url=… so the client can render
// link previews without each browser hitting third-party sites
// directly (CORS would block most of them anyway).
type UnfurlHandler struct {
	svc      unfurlService
	msgLinks messageLinkResolver
}

// NewUnfurlHandler builds an UnfurlHandler.
func NewUnfurlHandler(svc *service.UnfurlService) *UnfurlHandler {
	return &UnfurlHandler{svc: svc}
}

// SetMessageLinks wires the internal message-link resolver so links to other
// messages in this workspace unfurl as rich previews.
func (h *UnfurlHandler) SetMessageLinks(r messageLinkResolver) {
	h.msgLinks = r
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
	// A link to another message in this workspace unfurls as a rich, access-
	// gated message card — and never gets web-scraped, even if the viewer
	// can't see it (preview is nil → 204).
	if h.msgLinks != nil {
		if preview, internal := h.msgLinks.Preview(r.Context(), middleware.UserIDFromContext(r.Context()), raw); internal {
			if preview == nil {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			writeJSON(w, http.StatusOK, preview)
			return
		}
	}
	preview, err := h.svc.Unfurl(r.Context(), raw)
	if err != nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, preview)
}
