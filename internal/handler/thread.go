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
