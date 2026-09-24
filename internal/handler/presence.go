package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/service"
)

// PresenceHandler exposes HTTP endpoints for online presence.
type PresenceHandler struct {
	presenceSvc *service.PresenceService
	// alwaysOnlineIDs resolves user IDs that are unconditionally online —
	// the shared agents. Agents are services, not people: they hold no
	// WebSocket, so socket-derived presence would show them permanently
	// gray, which reads as breakage. Availability-for-YOU (is your runner
	// up) is a different question, answered by the Agents page badge.
	alwaysOnlineIDs func(r *http.Request) []string
}

// NewPresenceHandler creates a PresenceHandler.
func NewPresenceHandler(s *service.PresenceService) *PresenceHandler {
	return &PresenceHandler{presenceSvc: s}
}

// SetAlwaysOnline wires the always-online roster (agent user IDs). Optional.
func (h *PresenceHandler) SetAlwaysOnline(f func(r *http.Request) []string) {
	h.alwaysOnlineIDs = f
}

// List returns the user IDs currently considered online. Used by clients on
// connect to backfill presence state before subscribing to the presence
// pub/sub channel for live updates.
func (h *PresenceHandler) List(w http.ResponseWriter, r *http.Request) {
	ids := h.presenceSvc.OnlineUserIDs()
	if ids == nil {
		ids = []string{}
	}
	if h.alwaysOnlineIDs != nil {
		present := make(map[string]bool, len(ids))
		for _, id := range ids {
			present[id] = true
		}
		for _, id := range h.alwaysOnlineIDs(r) {
			if !present[id] {
				ids = append(ids, id)
			}
		}
	}
	writeJSON(w, http.StatusOK, JSON{"online": ids})
}
