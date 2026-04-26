package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// ConversationHandler exposes HTTP endpoints for conversation operations.
type ConversationHandler struct {
	convSvc    *service.ConversationService
	messageSvc *service.MessageService
}

// NewConversationHandler creates a ConversationHandler.
func NewConversationHandler(convSvc *service.ConversationService, messageSvc *service.MessageService) *ConversationHandler {
	return &ConversationHandler{convSvc: convSvc, messageSvc: messageSvc}
}

// Create starts a new direct message or group conversation.
func (h *ConversationHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	var body struct {
		Type           model.ConversationType `json:"type"`
		ParticipantIDs []string               `json:"participantIDs"`
		Name           string                 `json:"name"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	// Normalize participants: self-DMs are allowed (personal notepad), but
	// adding other participants always drops the caller from the list — they
	// participate by virtue of being the creator. This way clients can send
	// [me] for a self-DM or [me, other] / [other] interchangeably for a DM
	// with someone else without producing duplicate-self bugs.
	others := make([]string, 0, len(body.ParticipantIDs))
	seen := map[string]bool{}
	hasSelf := false
	for _, id := range body.ParticipantIDs {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if id == userID {
			hasSelf = true
			continue
		}
		others = append(others, id)
	}
	selfOnly := hasSelf && len(others) == 0 && len(body.ParticipantIDs) > 0

	switch body.Type {
	case model.ConversationTypeDM:
		// Self-DM: caller passed only themselves (or an empty list and self).
		if selfOnly || len(others) == 0 {
			conv, err := h.convSvc.GetOrCreateDM(r.Context(), userID, userID)
			if err != nil {
				writeError(w, http.StatusBadRequest, "dm_error", err.Error())
				return
			}
			writeJSON(w, http.StatusCreated, conv)
			return
		}
		if len(others) != 1 {
			writeError(w, http.StatusBadRequest, "invalid_body", "DM requires exactly one other participant")
			return
		}
		conv, err := h.convSvc.GetOrCreateDM(r.Context(), userID, others[0])
		if err != nil {
			writeError(w, http.StatusBadRequest, "dm_error", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, conv)

	case model.ConversationTypeGroup:
		// Single-other group → always a DM. Self-only group → self-DM.
		if selfOnly || len(others) == 0 {
			conv, err := h.convSvc.GetOrCreateDM(r.Context(), userID, userID)
			if err != nil {
				writeError(w, http.StatusBadRequest, "dm_error", err.Error())
				return
			}
			writeJSON(w, http.StatusCreated, conv)
			return
		}
		if len(others) == 1 {
			conv, err := h.convSvc.GetOrCreateDM(r.Context(), userID, others[0])
			if err != nil {
				writeError(w, http.StatusBadRequest, "dm_error", err.Error())
				return
			}
			writeJSON(w, http.StatusCreated, conv)
			return
		}
		conv, err := h.convSvc.CreateGroup(r.Context(), userID, others, body.Name)
		if err != nil {
			writeError(w, http.StatusBadRequest, "group_error", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, conv)

	default:
		writeError(w, http.StatusBadRequest, "invalid_body", "type must be \"dm\" or \"group\"")
	}
}

// List returns all conversations the authenticated user participates in.
func (h *ConversationHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	convs, err := h.convSvc.ListUserConversations(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return
	}
	if convs == nil {
		convs = []*model.UserConversation{}
	}

	writeJSON(w, http.StatusOK, convs)
}

// Get returns a single conversation by ID.
func (h *ConversationHandler) Get(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID is required")
		return
	}

	conv, err := h.convSvc.GetByID(r.Context(), userID, id)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, conv)
}

// ListMessages returns messages for a conversation with cursor-based pagination.
func (h *ConversationHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID is required")
		return
	}

	before := queryParam(r, "before", "")
	limit := queryInt(r, "limit", 50)

	msgs, hasMore, err := h.messageSvc.List(r.Context(), userID, id, service.ParentConversation, before, limit)
	if err != nil {
		writeError(w, http.StatusForbidden, "list_error", err.Error())
		return
	}

	if msgs == nil {
		msgs = []*model.Message{}
	}

	writeJSON(w, http.StatusOK, JSON{
		"items":   msgs,
		"hasMore": hasMore,
	})
}

// SendMessage creates a new message in a conversation.
func (h *ConversationHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID is required")
		return
	}

	var body struct {
		Body            string   `json:"body"`
		ParentMessageID string   `json:"parentMessageID"`
		AttachmentIDs   []string `json:"attachmentIDs"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Body == "" && len(body.AttachmentIDs) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_body", "body or attachments required")
		return
	}

	msg, err := h.messageSvc.Send(r.Context(), userID, id, service.ParentConversation, body.Body, body.ParentMessageID, body.AttachmentIDs...)
	if err != nil {
		writeError(w, http.StatusForbidden, "send_error", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, msg)
}

// GetThread returns all messages in the thread rooted at msgId for a conversation.
func (h *ConversationHandler) GetThread(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID and message ID are required")
		return
	}

	msgs, err := h.messageSvc.ListThreadMessages(r.Context(), userID, id, service.ParentConversation, msgID)
	if err != nil {
		writeError(w, http.StatusForbidden, "thread_error", err.Error())
		return
	}
	if msgs == nil {
		msgs = []*model.Message{}
	}

	writeJSON(w, http.StatusOK, msgs)
}

// EditMessage updates a message in a conversation.
func (h *ConversationHandler) EditMessage(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID and message ID are required")
		return
	}

	var body struct {
		Body          string    `json:"body"`
		AttachmentIDs *[]string `json:"attachmentIDs"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Body == "" && body.AttachmentIDs == nil {
		writeError(w, http.StatusBadRequest, "invalid_body", "body or attachments required")
		return
	}

	var attIDs []string
	if body.AttachmentIDs != nil {
		attIDs = *body.AttachmentIDs
		if attIDs == nil {
			attIDs = []string{}
		}
	}
	msg, err := h.messageSvc.Edit(r.Context(), userID, id, service.ParentConversation, msgID, body.Body, attIDs)
	if err != nil {
		writeError(w, http.StatusForbidden, "edit_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, msg)
}

// ToggleReaction adds or removes the caller's reaction (emoji) on a message.
func (h *ConversationHandler) ToggleReaction(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID and message ID are required")
		return
	}

	var body struct {
		Emoji string `json:"emoji"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Emoji == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "emoji is required")
		return
	}

	msg, err := h.messageSvc.ToggleReaction(r.Context(), userID, id, service.ParentConversation, msgID, body.Emoji)
	if err != nil {
		writeError(w, http.StatusForbidden, "reaction_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, msg)
}

// SetPinned pins or unpins a message in a conversation.
func (h *ConversationHandler) SetPinned(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID and message ID are required")
		return
	}
	var body struct {
		Pinned bool `json:"pinned"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	msg, err := h.messageSvc.SetPinned(r.Context(), userID, id, service.ParentConversation, msgID, body.Pinned)
	if err != nil {
		writeError(w, http.StatusForbidden, "pin_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, msg)
}

// ListPinned returns the conversation's currently-pinned messages.
func (h *ConversationHandler) ListPinned(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID is required")
		return
	}
	pinned, err := h.messageSvc.ListPinned(r.Context(), userID, id, service.ParentConversation)
	if err != nil {
		writeError(w, http.StatusForbidden, "list_pinned_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, pinned)
}

// DeleteMessage removes a message from a conversation.
func (h *ConversationHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "conversation ID and message ID are required")
		return
	}

	if err := h.messageSvc.Delete(r.Context(), userID, id, service.ParentConversation, msgID); err != nil {
		writeError(w, http.StatusForbidden, "delete_error", err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
