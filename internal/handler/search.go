package handler

import (
	"context"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
)

// SearchAccess resolves the parent IDs (channels + conversations) the
// caller is allowed to see, so the message-search endpoint can apply
// the same RBAC the read paths do. Returning an empty slice means "no
// access" and the handler short-circuits with an empty result.
type SearchAccess interface {
	AllowedParentIDs(ctx context.Context, userID string) ([]string, error)
}

// UserResolver batch-loads users by ID so the user-search endpoint can
// drop hits whose canonical store row no longer exists (deleted users
// that still linger in a stale search index — "ghosts"). Missing IDs are
// simply omitted from the returned slice.
type UserResolver interface {
	GetUsersByIDs(ctx context.Context, ids []string) ([]*model.User, error)
}

// SearchHandler exposes the public search endpoints. Searcher may be a
// noop implementation when search isn't configured — in that case the
// endpoints return empty results rather than 503 so the UI can show
// "no results" cleanly.
type SearchHandler struct {
	searcher search.Searcher
	access   SearchAccess
	users    UserResolver
}

// NewSearchHandler builds a handler. Either argument may be nil; when
// either is, the handler degrades to empty responses.
func NewSearchHandler(s search.Searcher, a SearchAccess) *SearchHandler {
	return &SearchHandler{searcher: s, access: a}
}

// SetUserResolver wires the canonical user store so SearchUsers can drop
// ghost hits (index rows whose user no longer exists). When unset the
// endpoint returns raw hits — used by tests and the search-disabled path.
func (h *SearchHandler) SetUserResolver(u UserResolver) {
	if h != nil {
		h.users = u
	}
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
		writeInternalError(w, r, "search_failed", err)
		return
	}
	res, err = h.dropGhostUsers(r.Context(), res)
	if err != nil {
		writeInternalError(w, r, "search_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// dropGhostUsers filters the raw user-search hits down to those whose
// canonical store row still exists, preserving the relevance ordering
// from OpenSearch. This makes the index a hint, not the source of truth:
// a user deleted straight from DynamoDB (there is no user hard-delete
// service method that could de-index) never surfaces even while a stale
// doc lingers. No resolver wired (or no hits) → results pass through
// unchanged.
func (h *SearchHandler) dropGhostUsers(ctx context.Context, res *search.SearchResult) (*search.SearchResult, error) {
	if h.users == nil || res == nil || len(res.Hits) == 0 {
		return res, nil
	}
	ids := make([]string, len(res.Hits))
	for i, hit := range res.Hits {
		ids[i] = hit.ID
	}
	users, err := h.users.GetUsersByIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	live := make(map[string]bool, len(users))
	for _, u := range users {
		if u != nil {
			live[u.ID] = true
		}
	}
	kept := make([]search.SearchHit, 0, len(res.Hits))
	for _, hit := range res.Hits {
		if live[hit.ID] {
			kept = append(kept, hit)
		}
	}
	return &search.SearchResult{Total: len(kept), Hits: kept, Aggs: res.Aggs}, nil
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
		writeInternalError(w, r, "access_failed", err)
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
		writeInternalError(w, r, "search_failed", err)
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
			writeInternalError(w, r, "access_failed", err)
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
		writeInternalError(w, r, "search_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func emptyResults() *search.SearchResult {
	return &search.SearchResult{Hits: []search.SearchHit{}}
}
