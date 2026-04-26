package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/service"
)

// PresenceHandler exposes HTTP endpoints for online presence.
type PresenceHandler struct {
	presenceSvc *service.PresenceService
}

// NewPresenceHandler creates a PresenceHandler.
func NewPresenceHandler(s *service.PresenceService) *PresenceHandler {
	return &PresenceHandler{presenceSvc: s}
}

// List returns the user IDs currently considered online. Used by clients on
// connect to backfill presence state before subscribing to the presence
// pub/sub channel for live updates.
func (h *PresenceHandler) List(w http.ResponseWriter, r *http.Request) {
	ids := h.presenceSvc.OnlineUserIDs()
	if ids == nil {
		ids = []string{}
	}
	writeJSON(w, http.StatusOK, JSON{"online": ids})
}
