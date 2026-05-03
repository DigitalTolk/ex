package handler

import (
	"net/http"

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

// List returns thread summaries the authenticated user has participated in,
// sorted newest-activity first.
func (h *ThreadHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	summaries, err := h.messageSvc.ListUserThreads(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return
	}
	if summaries == nil {
		summaries = []*service.ThreadSummary{}
	}
	writeJSON(w, http.StatusOK, summaries)
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
		writeError(w, http.StatusBadRequest, "follow_error", err.Error())
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
