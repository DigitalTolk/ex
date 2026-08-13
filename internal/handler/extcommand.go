package handler

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ExternalCommandHandler exposes admin CRUD for Mattermost-shaped slash commands
// plus the public delayed-response endpoint their `response_url` points at.
//
// Field names are snake_case, matching MM's /api/v4/commands, so tooling written
// against MM reads and writes these bodies unchanged.
type ExternalCommandHandler struct {
	svc *service.ExternalCommandService
}

func NewExternalCommandHandler(svc *service.ExternalCommandService) *ExternalCommandHandler {
	return &ExternalCommandHandler{svc: svc}
}

// commandCreatedResponse carries the one and only delivery of a command's shared
// token. The integration must verify it on every invocation, so it is shown here
// and never again by the read APIs (model.ExternalCommand keeps it json:"-").
type commandCreatedResponse struct {
	*model.ExternalCommand
	Token string `json:"token"`
}

func (h *ExternalCommandHandler) List(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	cmds, err := h.svc.ListAll(r.Context())
	if err != nil {
		writeInternalError(w, r, "list_error", err)
		return
	}
	writeJSON(w, http.StatusOK, cmds)
}

func (h *ExternalCommandHandler) Get(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	cmd, err := h.svc.GetCommand(r.Context(), pathParam(r, "id"))
	if err != nil {
		h.writeCommandError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, cmd)
}

// commandBody is the writable surface of an external command.
type commandBody struct {
	Trigger string `json:"trigger"`
	// TriggerWord is MM's spelling of the same field on some of its endpoints.
	TriggerWord      string `json:"trigger_word"`
	Title            string `json:"title"`
	DisplayName      string `json:"display_name"`
	Description      string `json:"description"`
	AutocompleteHint string `json:"autocomplete_hint"`
	RequestURL       string `json:"request_url"`
	Method           string `json:"method"`
	BotUserID        string `json:"bot_user_id"`
	Username         string `json:"username"`
	IconURL          string `json:"icon_url"`
}

func (b commandBody) toModel() *model.ExternalCommand {
	return &model.ExternalCommand{
		Trigger:          firstNonBlank(b.Trigger, b.TriggerWord),
		Title:            firstNonBlank(b.Title, b.DisplayName),
		Description:      b.Description,
		AutocompleteHint: b.AutocompleteHint,
		RequestURL:       b.RequestURL,
		Method:           b.Method,
		BotUserID:        b.BotUserID,
		Username:         b.Username,
		IconURL:          b.IconURL,
	}
}

func (h *ExternalCommandHandler) Create(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var body commandBody
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	actorID := middleware.UserIDFromContext(r.Context())
	cmd, err := h.svc.CreateCommand(r.Context(), actorID, body.toModel())
	if err != nil {
		h.writeCommandError(w, r, err)
		return
	}
	slog.Info("command audit: created", "actorID", actorID, "commandID", cmd.ID, "trigger", cmd.Trigger)
	writeJSON(w, http.StatusCreated, commandCreatedResponse{ExternalCommand: cmd, Token: cmd.Token})
}

func (h *ExternalCommandHandler) Update(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	var body commandBody
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	id := pathParam(r, "id")
	cmd, err := h.svc.UpdateCommand(r.Context(), id, body.toModel())
	if err != nil {
		h.writeCommandError(w, r, err)
		return
	}
	slog.Info("command audit: updated",
		"actorID", middleware.UserIDFromContext(r.Context()), "commandID", id)
	writeJSON(w, http.StatusOK, cmd)
}

func (h *ExternalCommandHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if !requireAdmin(w, r) {
		return
	}
	id := pathParam(r, "id")
	if err := h.svc.DeleteCommand(r.Context(), id); err != nil {
		h.writeCommandError(w, r, err)
		return
	}
	slog.Info("command audit: deleted",
		"actorID", middleware.UserIDFromContext(r.Context()), "commandID", id)
	w.WriteHeader(http.StatusNoContent)
}

// DeliverResponse is the public endpoint a command's `response_url` points at,
// letting an integration answer after its synchronous window closed.
//
// It is deliberately UNAUTHENTICATED: the opaque token in the path is the whole
// credential, which is MM's contract for response_url and what makes the URL
// usable from a worker that holds no ex session. Everything the post is allowed to
// do — which chat, as whom, on whose behalf — was pinned when the token was
// minted, so a stolen token can only do what the original invocation could, and
// only until the token expires.
func (h *ExternalCommandHandler) DeliverResponse(w http.ResponseWriter, r *http.Request) {
	token := pathParam(r, "token")
	if token == "" {
		writeError(w, http.StatusNotFound, "not_found", "unknown response URL")
		return
	}
	err := h.svc.DeliverDelayedResponse(r.Context(), token, r.Body)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, JSON{"ok": true})
	case errors.Is(err, service.ErrResponseURLExpired):
		// Undifferentiated from an unknown token on purpose: a client probing
		// tokens learns nothing about which ones existed.
		writeError(w, http.StatusNotFound, "not_found", "unknown or expired response URL")
	case errors.Is(err, service.ErrForbidden):
		// The invoking user lost access to the chat while the integration worked.
		writeError(w, http.StatusForbidden, "forbidden", "the invoking user can no longer post here")
	default:
		writeInternalError(w, r, "command_response_error", err)
	}
}

// writeCommandError maps a service error to a response.
func (h *ExternalCommandHandler) writeCommandError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "command not found")
	case errors.Is(err, service.ErrInvalidTrigger):
		writeError(w, http.StatusBadRequest, "invalid_trigger", err.Error())
	case errors.Is(err, service.ErrTriggerReserved):
		writeError(w, http.StatusConflict, "trigger_reserved", err.Error())
	case errors.Is(err, service.ErrTriggerTaken):
		writeError(w, http.StatusConflict, "trigger_taken", err.Error())
	case errors.Is(err, service.ErrInvalidRequestURL):
		writeError(w, http.StatusBadRequest, "invalid_request_url", err.Error())
	default:
		writeInternalError(w, r, "command_error", err)
	}
}
