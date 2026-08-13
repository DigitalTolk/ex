package handler

import (
	"errors"
	"net/http"
	"strings"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// CommandHandler exposes the slash-command registry: discovery for the
// composer's "/" autocomplete and execution.
type CommandHandler struct {
	commands     *service.CommandService
	draftClearer DraftClearer
}

// NewCommandHandler creates a CommandHandler.
func NewCommandHandler(commands *service.CommandService) *CommandHandler {
	return &CommandHandler{commands: commands}
}

// SetDraftClearer wires the draft cleaner so a successful command run clears
// the scope's draft server-side (the composer held "/mstmeetings" as a draft
// until it ran), matching the message-send fold.
func (h *CommandHandler) SetDraftClearer(c DraftClearer) { h.draftClearer = c }

// List returns the commands available to this workspace. An empty list is
// valid (no integrations configured) — clients then offer no commands.
func (h *CommandHandler) List(w http.ResponseWriter, r *http.Request) {
	if middleware.UserIDFromContext(r.Context()) == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	writeJSON(w, http.StatusOK, JSON{"commands": h.commands.List(r.Context())})
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
		// Text is the command's arguments — everything the user typed after the
		// trigger. Built-in commands ignore it; external (MM-shaped) commands
		// receive it as MM's `text` field.
		Text string `json:"text"`
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

	result, err := h.commands.Run(r.Context(), body.Command, service.CommandRequest{
		UserID:     userID,
		ParentID:   body.ParentID,
		ParentType: body.ParentType,
		Text:       strings.TrimSpace(body.Text),
	})
	var userErr *service.CommandUserError
	switch {
	case err == nil:
		clearSentDraft(r.Context(), h.draftClearer, userID, body.ParentID, body.ParentType, "")
		// message stays top-level for the existing clients; ephemeral_text and
		// goto_location are the MM-shaped additions an external command can return.
		writeJSON(w, http.StatusOK, JSON{
			"message":        result.Message,
			"ephemeral_text": result.EphemeralText,
			"goto_location":  result.GotoLocation,
		})
	case errors.Is(err, service.ErrUnknownCommand):
		writeError(w, http.StatusNotFound, "unknown_command", "unknown command")
	case errors.As(err, &userErr):
		// A user-facing denial: the composer shows this message verbatim.
		writeError(w, http.StatusForbidden, "command_denied", userErr.Message)
	case errors.Is(err, service.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "you do not have access to this chat")
	case errors.Is(err, service.ErrCommandRunFailed):
		// The integration — not ex — failed. 502 says so, and the composer shows a
		// user-facing note instead of a generic error.
		writeError(w, http.StatusBadGateway, "command_integration_failed",
			"That command's integration didn't respond. Please try again.")
	default:
		writeInternalError(w, r, "command_error", err)
	}
}
