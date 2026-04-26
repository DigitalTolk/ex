package handler

import (
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// ChannelHandler exposes HTTP endpoints for channel operations.
type ChannelHandler struct {
	channelSvc *service.ChannelService
	messageSvc *service.MessageService
}

// NewChannelHandler creates a ChannelHandler.
func NewChannelHandler(channelSvc *service.ChannelService, messageSvc *service.MessageService) *ChannelHandler {
	return &ChannelHandler{channelSvc: channelSvc, messageSvc: messageSvc}
}

// Create creates a new channel.
func (h *ChannelHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	var body struct {
		Name        string           `json:"name"`
		Type        model.ChannelType `json:"type"`
		Description string           `json:"description"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.Name == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "name is required")
		return
	}
	if body.Type == "" {
		body.Type = model.ChannelTypePublic
	}

	ch, err := h.channelSvc.Create(r.Context(), userID, body.Name, body.Type, body.Description)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create_error", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, ch)
}

// List returns all channels the authenticated user belongs to.
func (h *ChannelHandler) List(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}

	channels, err := h.channelSvc.ListUserChannels(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return
	}
	if channels == nil {
		channels = []*model.UserChannel{}
	}

	writeJSON(w, http.StatusOK, channels)
}

// BrowsePublic returns a paginated list of public channels.
func (h *ChannelHandler) BrowsePublic(w http.ResponseWriter, r *http.Request) {
	limit := queryInt(r, "limit", 50)
	cursor := queryParam(r, "cursor", "")

	channels, _, err := h.channelSvc.BrowsePublic(r.Context(), limit, cursor)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "browse_error", err.Error())
		return
	}
	if channels == nil {
		channels = []*model.Channel{}
	}

	writeJSON(w, http.StatusOK, channels)
}

// isULID returns true if s looks like a ULID (26 chars, Crockford base32).
func isULID(s string) bool {
	if len(s) != 26 {
		return false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'A' || c > 'Z') && (c < 'a' || c > 'z') {
			return false
		}
	}
	return true
}

// Get returns a channel by ID or slug. If the path param is a 26-char ULID it
// looks up by ID; otherwise it treats the value as a slug.
func (h *ChannelHandler) Get(w http.ResponseWriter, r *http.Request) {
	val := pathParam(r, "id")
	if val == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID or slug is required")
		return
	}

	var ch *model.Channel
	var err error
	if isULID(val) {
		ch, err = h.channelSvc.GetByID(r.Context(), val)
	} else {
		ch, err = h.channelSvc.GetBySlug(r.Context(), val)
	}
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, ch)
}

// Update modifies a channel's name or description.
func (h *ChannelHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}

	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	ch, err := h.channelSvc.Update(r.Context(), userID, id, body.Name, body.Description)
	if err != nil {
		writeError(w, http.StatusForbidden, "update_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, ch)
}

// Archive marks a channel as archived.
func (h *ChannelHandler) Archive(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}

	if err := h.channelSvc.Archive(r.Context(), userID, id); err != nil {
		writeError(w, http.StatusForbidden, "archive_error", err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// Join adds the authenticated user to a public channel.
func (h *ChannelHandler) Join(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}

	if err := h.channelSvc.Join(r.Context(), userID, id); err != nil {
		writeError(w, http.StatusBadRequest, "join_error", err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// SetMute toggles the muted flag for the authenticated user on a channel.
// Body: { "muted": true|false }. Mute is a per-user preference and only
// affects notification dispatch, not real-time event delivery.
func (h *ChannelHandler) SetMute(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}

	var body struct {
		Muted bool `json:"muted"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	if err := h.channelSvc.SetMute(r.Context(), userID, id, body.Muted); err != nil {
		writeError(w, http.StatusBadRequest, "mute_error", err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// Leave removes the authenticated user from a channel.
func (h *ChannelHandler) Leave(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}

	if err := h.channelSvc.Leave(r.Context(), userID, id); err != nil {
		writeError(w, http.StatusBadRequest, "leave_error", err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListMembers returns all members of a channel.
func (h *ChannelHandler) ListMembers(w http.ResponseWriter, r *http.Request) {
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}

	members, err := h.channelSvc.ListMembers(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list_error", err.Error())
		return
	}
	if members == nil {
		members = []*model.ChannelMembership{}
	}

	writeJSON(w, http.StatusOK, members)
}

// AddMember adds a user to a channel with a given role.
func (h *ChannelHandler) AddMember(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}

	var body struct {
		UserID string `json:"userID"`
		Role   string `json:"role"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	if body.UserID == "" {
		writeError(w, http.StatusBadRequest, "invalid_body", "userID is required")
		return
	}

	role := model.ParseChannelRole(body.Role)
	if err := h.channelSvc.AddMember(r.Context(), userID, id, body.UserID, role); err != nil {
		writeError(w, http.StatusForbidden, "add_member_error", err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// RemoveMember removes a user from a channel.
func (h *ChannelHandler) RemoveMember(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	uid := pathParam(r, "uid")
	if id == "" || uid == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID and user ID are required")
		return
	}

	if err := h.channelSvc.RemoveMember(r.Context(), userID, id, uid); err != nil {
		writeError(w, http.StatusForbidden, "remove_member_error", err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// UpdateMemberRole changes a member's role in a channel.
func (h *ChannelHandler) UpdateMemberRole(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	uid := pathParam(r, "uid")
	if id == "" || uid == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID and user ID are required")
		return
	}

	var body struct {
		Role string `json:"role"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}

	role := model.ParseChannelRole(body.Role)
	if err := h.channelSvc.UpdateMemberRole(r.Context(), userID, id, uid, role); err != nil {
		writeError(w, http.StatusForbidden, "role_error", err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// ListMessages returns messages for a channel with cursor-based pagination.
func (h *ChannelHandler) ListMessages(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
		return
	}

	before := queryParam(r, "before", "")
	limit := queryInt(r, "limit", 50)

	msgs, hasMore, err := h.messageSvc.List(r.Context(), userID, id, service.ParentChannel, before, limit)
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

// SendMessage creates a new message in a channel.
func (h *ChannelHandler) SendMessage(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	if id == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID is required")
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

	msg, err := h.messageSvc.Send(r.Context(), userID, id, service.ParentChannel, body.Body, body.ParentMessageID, body.AttachmentIDs...)
	if err != nil {
		writeError(w, http.StatusForbidden, "send_error", err.Error())
		return
	}

	writeJSON(w, http.StatusCreated, msg)
}

// GetThread returns all messages in the thread rooted at msgId.
func (h *ChannelHandler) GetThread(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID and message ID are required")
		return
	}

	msgs, err := h.messageSvc.ListThreadMessages(r.Context(), userID, id, service.ParentChannel, msgID)
	if err != nil {
		writeError(w, http.StatusForbidden, "thread_error", err.Error())
		return
	}
	if msgs == nil {
		msgs = []*model.Message{}
	}

	writeJSON(w, http.StatusOK, msgs)
}

// EditMessage updates a message in a channel.
func (h *ChannelHandler) EditMessage(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID and message ID are required")
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
	msg, err := h.messageSvc.Edit(r.Context(), userID, id, service.ParentChannel, msgID, body.Body, attIDs)
	if err != nil {
		writeError(w, http.StatusForbidden, "edit_error", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, msg)
}

// ToggleReaction adds or removes the caller's reaction (emoji) on a message.
func (h *ChannelHandler) ToggleReaction(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID and message ID are required")
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

	msg, err := h.messageSvc.ToggleReaction(r.Context(), userID, id, service.ParentChannel, msgID, body.Emoji)
	if err != nil {
		writeError(w, http.StatusForbidden, "reaction_error", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, msg)
}

// DeleteMessage removes a message from a channel.
func (h *ChannelHandler) DeleteMessage(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	id := pathParam(r, "id")
	msgID := pathParam(r, "msgId")
	if id == "" || msgID == "" {
		writeError(w, http.StatusBadRequest, "missing_id", "channel ID and message ID are required")
		return
	}

	if err := h.messageSvc.Delete(r.Context(), userID, id, service.ParentChannel, msgID); err != nil {
		writeError(w, http.StatusForbidden, "delete_error", err.Error())
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
