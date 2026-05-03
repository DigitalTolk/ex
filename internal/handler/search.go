package handler

import (
	"context"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/search"
)

// SearchAccess resolves the parent IDs (channels + conversations) the
// caller is allowed to see, so the message-search endpoint can apply
// the same RBAC the read paths do. Returning an empty slice means "no
// access" and the handler short-circuits with an empty result.
type SearchAccess interface {
	AllowedParentIDs(ctx context.Context, userID string) ([]string, error)
}

// SearchHandler exposes the public search endpoints. Searcher may be a
// noop implementation when search isn't configured — in that case the
// endpoints return empty results rather than 503 so the UI can show
// "no results" cleanly.
type SearchHandler struct {
	searcher search.Searcher
	access   SearchAccess
}

// NewSearchHandler builds a handler. Either argument may be nil; when
// either is, the handler degrades to empty responses.
func NewSearchHandler(s search.Searcher, a SearchAccess) *SearchHandler {
	return &SearchHandler{searcher: s, access: a}
}

// SearchUsers handles GET /api/v1/search/users?q=&limit=
func (h *SearchHandler) SearchUsers(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.searcher == nil {
		writeJSON(w, http.StatusOK, emptyResults())
		return
	}
	q := queryParam(r, "q", "")
	limit := queryInt(r, "limit", 10)
	res, err := h.searcher.Users(r.Context(), q, limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "search_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// SearchChannels handles GET /api/v1/search/channels?q=&limit=
func (h *SearchHandler) SearchChannels(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.searcher == nil {
		writeJSON(w, http.StatusOK, emptyResults())
		return
	}
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	var allowed []string
	if h.access == nil {
		writeJSON(w, http.StatusOK, emptyResults())
		return
	}
	ids, err := h.access.AllowedParentIDs(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "access_failed", err.Error())
		return
	}
	allowed = ids
	q := queryParam(r, "q", "")
	limit := queryInt(r, "limit", 10)
	res, err := h.searcher.Channels(r.Context(), search.ChannelQuery{
		Q:                 q,
		AllowedChannelIDs: allowed,
		Limit:             limit,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "search_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// SearchMessages handles GET /api/v1/search/messages
// Query params: q, limit, from, in, sort. RBAC filters by membership.
func (h *SearchHandler) SearchMessages(w http.ResponseWriter, r *http.Request) {
	h.searchOver(w, r, false)
}

// SearchFiles handles GET /api/v1/search/files — same shape as
// SearchMessages but matches against attachment filenames.
func (h *SearchHandler) SearchFiles(w http.ResponseWriter, r *http.Request) {
	h.searchOver(w, r, true)
}

// searchOver shares the q/limit/from/in/sort plumbing between
// /search/messages and /search/files; the only difference is which
// underlying searcher method is dispatched.
func (h *SearchHandler) searchOver(w http.ResponseWriter, r *http.Request, files bool) {
	if h == nil || h.searcher == nil {
		writeJSON(w, http.StatusOK, emptyResults())
		return
	}
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	var allowed []string
	if h.access != nil {
		ids, err := h.access.AllowedParentIDs(r.Context(), userID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "access_failed", err.Error())
			return
		}
		allowed = ids
	}
	opts := search.MessageQuery{
		Q:                queryParam(r, "q", ""),
		AllowedParentIDs: allowed,
		FromUserID:       queryParam(r, "from", ""),
		InParentID:       queryParam(r, "in", ""),
		Sort:             queryParam(r, "sort", ""),
		Limit:            queryInt(r, "limit", 20),
	}
	var (
		res *search.SearchResult
		err error
	)
	if files {
		res, err = h.searcher.Files(r.Context(), opts)
	} else {
		res, err = h.searcher.Messages(r.Context(), opts)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "search_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func emptyResults() *search.SearchResult {
	return &search.SearchResult{Hits: []search.SearchHit{}}
}
