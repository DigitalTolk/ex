package handler

import (
	"context"
	"errors"
	"net/http"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// scheduledMessages is the service behind the scheduled-message endpoints.
type scheduledMessages interface {
	Schedule(ctx context.Context, userID string, in service.ScheduledMessageInput) (*model.ScheduledMessage, error)
	List(ctx context.Context, userID string) ([]*model.ScheduledMessage, error)
	Update(ctx context.Context, userID, id string, upd service.ScheduledMessageUpdate) (*model.ScheduledMessage, error)
	Delete(ctx context.Context, userID, id string) error
	SendNow(ctx context.Context, userID, id string) (*model.Message, error)
}

// ScheduledMessageHandler serves /api/v1/scheduled-messages: compose now,
// deliver at a chosen time.
type ScheduledMessageHandler struct {
	svc          scheduledMessages
	draftClearer DraftClearer
}

// SetDraftClearer wires the draft cleaner: scheduling a message empties its
// composer's draft, exactly like sending it.
func (h *ScheduledMessageHandler) SetDraftClearer(c DraftClearer) { h.draftClearer = c }

// NewScheduledMessageHandler builds a ScheduledMessageHandler.
func NewScheduledMessageHandler(svc scheduledMessages) *ScheduledMessageHandler {
	return &ScheduledMessageHandler{svc: svc}
}

// Create schedules a message. POST /api/v1/scheduled-messages
func (h *ScheduledMessageHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID, ok := scheduledCaller(w, r)
	if !ok {
		return
	}
	var in service.ScheduledMessageInput
	if err := readJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	m, err := h.svc.Schedule(r.Context(), userID, in)
	if err != nil {
		writeScheduledError(w, r, err)
		return
	}
	clearSentDraft(r.Context(), h.draftClearer, userID, in.ParentID, in.ParentType, in.ParentMessageID)
	writeJSON(w, http.StatusCreated, m)
}

// List returns the caller's scheduled messages, soonest first.
// GET /api/v1/scheduled-messages
func (h *ScheduledMessageHandler) List(w http.ResponseWriter, r *http.Request) {
	userID, ok := scheduledCaller(w, r)
	if !ok {
		return
	}
	list, err := h.svc.List(r.Context(), userID)
	if err != nil {
		writeScheduledError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// Update edits a scheduled message's text and/or time.
// PATCH /api/v1/scheduled-messages/{id}
func (h *ScheduledMessageHandler) Update(w http.ResponseWriter, r *http.Request) {
	userID, ok := scheduledCaller(w, r)
	if !ok {
		return
	}
	var upd service.ScheduledMessageUpdate
	if err := readJSON(r, &upd); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	m, err := h.svc.Update(r.Context(), userID, pathParam(r, "id"), upd)
	if err != nil {
		writeScheduledError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, m)
}

// Delete drops a scheduled message. DELETE /api/v1/scheduled-messages/{id}
func (h *ScheduledMessageHandler) Delete(w http.ResponseWriter, r *http.Request) {
	userID, ok := scheduledCaller(w, r)
	if !ok {
		return
	}
	if err := h.svc.Delete(r.Context(), userID, pathParam(r, "id")); err != nil {
		writeScheduledError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// SendNow posts a scheduled message immediately (also retries a failed one).
// POST /api/v1/scheduled-messages/{id}/send
func (h *ScheduledMessageHandler) SendNow(w http.ResponseWriter, r *http.Request) {
	userID, ok := scheduledCaller(w, r)
	if !ok {
		return
	}
	msg, err := h.svc.SendNow(r.Context(), userID, pathParam(r, "id"))
	if err != nil {
		writeScheduledError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, msg)
}

func scheduledCaller(w http.ResponseWriter, r *http.Request) (string, bool) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return "", false
	}
	return userID, true
}

// writeScheduledError maps scheduled-message failures to their statuses.
func writeScheduledError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrValidation), errors.Is(err, service.ErrMessageTooLong),
		errors.Is(err, service.ErrTooManyAttachments), errors.Is(err, service.ErrThreadDeleted):
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
	case errors.Is(err, service.ErrForbidden):
		writeError(w, http.StatusForbidden, "forbidden", "you do not have access to this conversation")
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "scheduled message not found")
	case errors.Is(err, service.ErrScheduledBusy):
		writeError(w, http.StatusConflict, "being_sent", "this message is being sent right now")
	default:
		writeInternalError(w, r, "scheduled_message_error", err)
	}
}
