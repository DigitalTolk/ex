package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// MessageActionHandler runs an interactive attachment action (a button or select
// menu on a message posted by an integration).
//
// The client sends only the action's id — never a URL or context. ex resolves the
// stored integration server-side, which is what keeps integration-internal config
// off the wire and makes the callback unforgeable (see service/messageactions.go).
type MessageActionHandler struct {
	actions MessageActionInvoker
}

// MessageActionInvoker is the one service call this endpoint makes. Declared as an
// interface (rather than taking *service.MessageService) so the HTTP contract is
// testable without standing up the whole message service and its stores.
// Satisfied by *service.MessageService.
type MessageActionInvoker interface {
	InvokeMessageAction(
		ctx context.Context,
		userID, parentID, parentType, messageID, actionID string,
		selectedOption string,
	) (service.ActionResult, error)
}

func NewMessageActionHandler(actions MessageActionInvoker) *MessageActionHandler {
	return &MessageActionHandler{actions: actions}
}

// Invoke returns the handler for one parent type, mirroring how channel and
// conversation message routes are registered separately.
func (h *MessageActionHandler) Invoke(parentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := middleware.UserIDFromContext(r.Context())
		if userID == "" {
			writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
			return
		}
		// A select's chosen value is the only client-supplied input, and it is
		// echoed to the integration inside its own context rather than trusted here.
		var body struct {
			SelectedOption string `json:"selected_option"`
		}
		if r.ContentLength > 0 {
			if err := readJSON(r, &body); err != nil {
				writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
				return
			}
		}

		result, err := h.actions.InvokeMessageAction(
			r.Context(), userID,
			pathParam(r, "id"), parentType, pathParam(r, "msgId"), pathParam(r, "actionId"),
			body.SelectedOption,
		)
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, result)
		case errors.Is(err, service.ErrActionNotFound):
			writeError(w, http.StatusNotFound, "not_found", "action not found")
		case errors.Is(err, service.ErrActionDisabled):
			writeError(w, http.StatusConflict, "action_disabled", "this action is no longer available")
		case errors.Is(err, service.ErrActionFailed):
			// The integration failed, not ex — 502 so the client can say so.
			writeError(w, http.StatusBadGateway, "action_failed",
				"That action's integration didn't respond. Please try again.")
		case errors.Is(err, service.ErrForbidden):
			writeError(w, http.StatusForbidden, "forbidden", "you do not have access to this chat")
		default:
			writeInternalError(w, r, "action_error", err)
		}
	}
}
