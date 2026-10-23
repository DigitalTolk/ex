package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/service"
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
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
