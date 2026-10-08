package handler

import (
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// MarkUnread makes a channel message (and everything after it) unread again
// for the caller — or, for a thread reply, re-opens the thread as unread.
// PUT /api/v1/channels/{id}/messages/{msgId}/unread
func (h *ChannelHandler) MarkUnread(w http.ResponseWriter, r *http.Request) {
	markMessageUnread(w, r, h.messageSvc, service.ParentChannel)
}

// MarkUnread is the conversation (DM / group / self-DM) counterpart.
// PUT /api/v1/conversations/{id}/messages/{msgId}/unread
func (h *ConversationHandler) MarkUnread(w http.ResponseWriter, r *http.Request) {
	markMessageUnread(w, r, h.messageSvc, service.ParentConversation)
}

func markMessageUnread(w http.ResponseWriter, r *http.Request, svc *service.MessageService, parentType string) {
	userID := middleware.UserIDFromContext(r.Context())
	id, msgID := pathParam(r, "id"), pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "parent ID and message ID are required")
		return
	}
	res, err := svc.MarkUnread(r.Context(), userID, id, parentType, msgID)
	switch {
	case err == nil:
		writeJSON(w, http.StatusOK, res)
	case errors.Is(err, service.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "you do not have access to this message")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "message not found")
	default:
		writeInternalError(w, r, "mark_unread_error", err)
	}
}
