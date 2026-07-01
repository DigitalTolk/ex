package handler

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

// ActivityService is the activity-stream behaviour the handler needs.
type ActivityService interface {
	Feed(ctx context.Context, userID string) (service.ActivityFeed, error)
	MarkSeen(ctx context.Context, userID string) error
}

// ReminderService is the reminder behaviour the handler needs.
type ReminderService interface {
	Schedule(ctx context.Context, userID string, in service.ReminderInput) (*model.Reminder, error)
	ListPending(ctx context.Context, userID string) ([]*model.Reminder, error)
	Cancel(ctx context.Context, userID, id string) error
}

// ActivityHandler exposes the activity-stream and reminder endpoints.
type ActivityHandler struct {
	activity ActivityService
	reminder ReminderService
}

// NewActivityHandler builds an ActivityHandler.
func NewActivityHandler(activity ActivityService, reminder ReminderService) *ActivityHandler {
	return &ActivityHandler{activity: activity, reminder: reminder}
}

// Feed returns the caller's activity stream + unread count.
func (h *ActivityHandler) Feed(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	feed, err := h.activity.Feed(r.Context(), userID)
	if err != nil {
		writeInternalError(w, r, "activity_feed_error", err)
		return
	}
	if feed.Items == nil {
		feed.Items = []*model.ActivityItem{}
	}
	writeJSON(w, http.StatusOK, feed)
}

// MarkRead advances the caller's activity read watermark, clearing the badge.
func (h *ActivityHandler) MarkRead(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	if err := h.activity.MarkSeen(r.Context(), userID); err != nil {
		writeInternalError(w, r, "activity_read_error", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// CreateReminder schedules a "remind me about this message" reminder.
func (h *ActivityHandler) CreateReminder(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	var body struct {
		MessageID   string    `json:"messageID"`
		ParentID    string    `json:"parentID"`
		ParentType  string    `json:"parentType"`
		ChannelSlug string    `json:"channelSlug"`
		RemindAt    time.Time `json:"remindAt"`
	}
	if err := readJSON(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_body", err.Error())
		return
	}
	reminder, err := h.reminder.Schedule(r.Context(), userID, service.ReminderInput{
		MessageID:   body.MessageID,
		ParentID:    body.ParentID,
		ParentType:  body.ParentType,
		ChannelSlug: body.ChannelSlug,
		RemindAt:    body.RemindAt,
	})
	if err != nil {
		writeReminderError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, reminder)
}

// ListReminders returns the caller's pending reminders.
func (h *ActivityHandler) ListReminders(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	reminders, err := h.reminder.ListPending(r.Context(), userID)
	if err != nil {
		writeInternalError(w, r, "reminders_list_error", err)
		return
	}
	if reminders == nil {
		reminders = []*model.Reminder{}
	}
	writeJSON(w, http.StatusOK, reminders)
}

// CancelReminder cancels a pending reminder.
func (h *ActivityHandler) CancelReminder(w http.ResponseWriter, r *http.Request) {
	userID := middleware.UserIDFromContext(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized", "authentication required")
		return
	}
	if err := h.reminder.Cancel(r.Context(), userID, pathParam(r, "id")); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "reminder not found")
			return
		}
		writeInternalError(w, r, "reminder_cancel_error", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// writeReminderError maps reminder validation failures to 4xx, falling back to a
// generic 500 for anything unexpected.
func writeReminderError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, service.ErrReminderTimeInvalid):
		writeError(w, http.StatusBadRequest, "invalid_time", err.Error())
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "message not found")
	case isReminderValidation(err):
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
	case isReminderAccessError(err):
		writeError(w, http.StatusForbidden, "forbidden", "you do not have access to this message")
	default:
		writeInternalError(w, r, "reminder_create_error", err)
	}
}

func isReminderValidation(err error) bool {
	msg := err.Error()
	return msg == "reminder: message and parent required" || msg == "reminder: invalid parent type"
}

// isReminderAccessError matches the membership-denied errors CheckAccess returns
// so scheduling a reminder for an inaccessible message is a 403, not a 500.
func isReminderAccessError(err error) bool {
	msg := err.Error()
	return msg == "message: not a channel member" || msg == "message: not a conversation participant"
}
