package handler

import (
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// CommandHandler exposes the slash-command registry: discovery for the
// composer's "/" autocomplete and execution.
type CommandHandler struct {
	commands *service.CommandService
}

// NewCommandHandler creates a CommandHandler.
func NewCommandHandler(commands *service.CommandService) *CommandHandler {
	return &CommandHandler{commands: commands}
}

// List returns the commands available to this workspace. An empty list is
// valid (no integrations configured) — clients then offer no commands.
func (h *CommandHandler) List(w http.ResponseWriter, r *http.Request) {
	if middleware.UserIDFromContext(r.Context()) == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"commands": h.commands.List()})
}

// Run executes a slash command in a chat. The command posts its result into
// the chat itself (fanning out over WebSocket like any message); the response
// returns that message for the invoking client.
func (h *CommandHandler) Run(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	var body struct {
		Command    string `json:"command"`
		ParentType string `json:"parentType"`
		ParentID   string `json:"parentID"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	body.Command = strings.TrimPrefix(strings.TrimSpace(body.Command), "/")
	if body.Command == "" || body.ParentType == "" || body.ParentID == "" {
		writeError(w, http.StatusBadRequest, "missing_fields", "command, parentType and parentID are required")
		return
	}

	msg, err := h.commands.Run(r.Context(), body.Command, service.CommandRequest{
		UserID:     userID,
		ParentID:   body.ParentID,
		ParentType: body.ParentType,
	})
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, JSON{"message": msg})
}
