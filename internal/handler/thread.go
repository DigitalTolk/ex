package handler

import (
	"net/http"
	"strconv"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// ThreadHandler exposes endpoints that span all parents (channels and
// conversations) for the authenticated user.
type ThreadHandler struct {
	messageSvc *service.MessageService
}

// NewThreadHandler creates a ThreadHandler.
func NewThreadHandler(messageSvc *service.MessageService) *ThreadHandler {
	return &ThreadHandler{messageSvc: messageSvc}
}

// List returns one page of the authenticated user's threads: unread ones
// first, then the rest, latest reply first. ?cursor= continues from the
// previous page's nextCursor; ?limit= sizes the page.
func (h *ThreadHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	limit := 0
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid limit")
			return
		}
		limit = n
	}
	page, err := h.messageSvc.ListThreadsPage(r.Context(), userID, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

// FollowState says whether the authenticated user follows one thread.
func (h *ThreadHandler) FollowState(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	parentID := r.PathValue("parentID")
	threadRootID := r.PathValue("threadRootID")
	parentType, ok := normalizeThreadParentType(r.PathValue("parentType"))
	if parentID == "" || threadRootID == "" || !ok {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid thread follow target")
		return
	}
	following, err := h.messageSvc.ThreadFollowing(r.Context(), userID, parentID, parentType, threadRootID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"following": following})
}

func (h *ThreadHandler) Follow(w http.ResponseWriter, r *http.Request) {
	h.setFollow(w, r, true)
}

func (h *ThreadHandler) Unfollow(w http.ResponseWriter, r *http.Request) {
	h.setFollow(w, r, false)
}

func (h *ThreadHandler) setFollow(w http.ResponseWriter, r *http.Request, following bool) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	parentID := r.PathValue("parentID")
	threadRootID := r.PathValue("threadRootID")
	parentType, ok := normalizeThreadParentType(r.PathValue("parentType"))
	if parentID == "" || threadRootID == "" || !ok {
		writeError(w, http.StatusBadRequest, "bad_request", "invalid thread follow target")
		return
	}
	if err := h.messageSvc.SetThreadFollow(r.Context(), userID, parentID, parentType, threadRootID, following); err != nil {
		writeServiceError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func normalizeThreadParentType(raw string) (string, bool) {
	switch raw {
	case "channel", "channels":
		return service.ParentChannel, true
	case "conversation", "conversations":
		return service.ParentConversation, true
	default:
		return "", false
	}
}
