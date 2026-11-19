package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
)

// Act clicks a button on a channel message. Body: {"blockID", "actionID"} —
// which button, nothing more: what the click does comes from the stored
// message (MessageService.Act).
func (h *ChannelHandler) Act(w http.ResponseWriter, r *http.Request) {
	act(w, r, h.messageSvc, service.ParentChannel)
}

// Act clicks a button on a conversation message (see ChannelHandler.Act).
func (h *ConversationHandler) Act(w http.ResponseWriter, r *http.Request) {
	act(w, r, h.messageSvc, service.ParentConversation)
}

func act(w http.ResponseWriter, r *http.Request, messages *service.MessageService, parentType string) {
	parentID := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if parentID == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "parent ID and message ID are required")
		return
	}
	var body struct {
		BlockID  string `json:"blockID"`
		ActionID string `json:"actionID"`
		// ClickID names the browser tab, so a form the app opens in
		// answer appears there alone. Optional.
		ClickID string `json:"clickID"`
		// Value is what was picked in a select or picker: a string, or a
		// list for multi-selects and checkboxes. Buttons send none.
		Value service.RawValue `json:"value"`
	}
	if err := readJSONLimit(r, &body, maxFormBodyBytes); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.BlockID == "" || body.ActionID == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "blockID and actionID are required")
		return
	}
	ctx := r.Context()
	if body.ClickID != "" {
		if !clickIDPattern.MatchString(body.ClickID) {
			writeError(w, http.StatusBadRequest, "invalid_body", "clickID must be 1-64 letters, digits, - or _")
			return
		}
		ctx = service.WithClickID(ctx, body.ClickID)
	}
	msg, err := messages.ActWithValue(ctx, middleware.UserIDFromContext(ctx), parentID, parentType, msgID, body.BlockID, body.ActionID, body.Value)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, msg)
}
