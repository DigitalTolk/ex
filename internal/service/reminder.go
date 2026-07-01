package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// reminderMaxHorizon caps how far in the future a reminder may be scheduled. A
// year is generous for "remind me" while rejecting obviously bogus timestamps.
const reminderMaxHorizon = 365 * 24 * time.Hour

// reminderClaimBatch bounds how many due reminders are claimed per poll
// iteration; the poller loops until a partial batch drains the queue.
const reminderClaimBatch = 100

// ErrReminderTimeInvalid is returned when a reminder's fire time is not strictly
// in the future, or is further out than reminderMaxHorizon.
var ErrReminderTimeInvalid = errors.New("reminder: remind time must be in the future")

// ReminderStore is the persistence the reminder service needs.
type ReminderStore interface {
	ScheduleReminder(ctx context.Context, r *model.Reminder) error
	CancelReminder(ctx context.Context, userID, id string) (bool, error)
	ListPendingReminders(ctx context.Context, userID string) ([]*model.Reminder, error)
	ClaimDueReminders(ctx context.Context, limit int) ([]*model.Reminder, error)
}

// ReminderMessageStore loads the source message so a reminder can carry a preview
// and be validated against an existing message.
type ReminderMessageStore interface {
	GetMessage(ctx context.Context, parentID, msgID string) (*model.Message, error)
}

// ReminderAccessChecker gates scheduling to parents the user can actually see.
type ReminderAccessChecker interface {
	CheckAccess(ctx context.Context, userID, parentID, parentType string) error
}

// ActivityAdder appends a fired reminder to the owner's activity stream.
type ActivityAdder interface {
	AddItem(ctx context.Context, userID string, item *model.ActivityItem)
}

// DirectNotifier delivers a self-targeted alert (desktop + mobile fallback).
type DirectNotifier interface {
	NotifyDirect(ctx context.Context, userID string, notif Notification)
}

// ReminderInput is the client-supplied request to schedule a reminder.
type ReminderInput struct {
	MessageID   string    `json:"messageID"`
	ParentID    string    `json:"parentID"`
	ParentType  string    `json:"parentType"`
	ChannelSlug string    `json:"channelSlug"`
	RemindAt    time.Time `json:"remindAt"`
}

// ReminderService schedules per-message reminders and fires them at their due
// time into the owner's activity stream + a desktop/mobile alert.
type ReminderService struct {
	store    ReminderStore
	messages ReminderMessageStore
	access   ReminderAccessChecker
	activity ActivityAdder
	notifier DirectNotifier
	now      func() time.Time
}

// NewReminderService builds a ReminderService. activity and notifier are wired
// after construction (SetDelivery) to avoid a constructor cycle with the
// activity/notification services.
func NewReminderService(s ReminderStore, messages ReminderMessageStore, access ReminderAccessChecker) *ReminderService {
	return &ReminderService{store: s, messages: messages, access: access, now: time.Now}
}

// SetDelivery wires the fired-reminder delivery channels.
func (s *ReminderService) SetDelivery(activity ActivityAdder, notifier DirectNotifier) {
	s.activity = activity
	s.notifier = notifier
}

// Schedule validates and persists a reminder for userID.
func (s *ReminderService) Schedule(ctx context.Context, userID string, in ReminderInput) (*model.Reminder, error) {
	if in.MessageID == "" || in.ParentID == "" {
		return nil, errors.New("reminder: message and parent required")
	}
	if in.ParentType != ParentChannel && in.ParentType != ParentConversation {
		return nil, errors.New("reminder: invalid parent type")
	}
	now := s.now()
	if !in.RemindAt.After(now) || in.RemindAt.After(now.Add(reminderMaxHorizon)) {
		return nil, ErrReminderTimeInvalid
	}
	if err := s.access.CheckAccess(ctx, userID, in.ParentID, in.ParentType); err != nil {
		return nil, err
	}
	msg, err := s.messages.GetMessage(ctx, in.ParentID, in.MessageID)
	if err != nil {
		return nil, fmt.Errorf("reminder: message: %w", err)
	}
	r := &model.Reminder{
		ID:             store.NewID(),
		UserID:         userID,
		MessageID:      in.MessageID,
		ParentID:       in.ParentID,
		ParentType:     in.ParentType,
		ChannelSlug:    in.ChannelSlug,
		MessagePreview: activityPreview(msg.Body),
		RemindAt:       in.RemindAt,
		CreatedAt:      now,
	}
	if err := s.store.ScheduleReminder(ctx, r); err != nil {
		return nil, err
	}
	return r, nil
}

// ListPending returns the user's not-yet-fired reminders.
func (s *ReminderService) ListPending(ctx context.Context, userID string) ([]*model.Reminder, error) {
	return s.store.ListPendingReminders(ctx, userID)
}

// Cancel removes a pending reminder. Returns store.ErrNotFound when there is no
// such pending reminder for the user.
func (s *ReminderService) Cancel(ctx context.Context, userID, id string) error {
	ok, err := s.store.CancelReminder(ctx, userID, id)
	if err != nil {
		return err
	}
	if !ok {
		return store.ErrNotFound
	}
	return nil
}

// ProcessDue claims and fires every reminder due at or before now. Returns the
// number fired. Safe to call concurrently across instances — claiming is atomic.
func (s *ReminderService) ProcessDue(ctx context.Context) (int, error) {
	fired := 0
	for {
		due, err := s.store.ClaimDueReminders(ctx, reminderClaimBatch)
		if err != nil {
			return fired, fmt.Errorf("reminder: claim due: %w", err)
		}
		for _, r := range due {
			s.fire(ctx, r)
			fired++
		}
		if len(due) < reminderClaimBatch {
			return fired, nil
		}
	}
}

// fire delivers a claimed reminder: an activity-stream entry plus a desktop +
// mobile alert.
func (s *ReminderService) fire(ctx context.Context, r *model.Reminder) {
	now := s.now()
	if s.activity != nil {
		s.activity.AddItem(ctx, r.UserID, &model.ActivityItem{
			ID:             store.NewID(),
			Type:           model.ActivityReminder,
			CreatedAt:      now,
			MessageID:      r.MessageID,
			ParentID:       r.ParentID,
			ParentType:     r.ParentType,
			ChannelSlug:    r.ChannelSlug,
			MessagePreview: r.MessagePreview,
		})
	}
	if s.notifier != nil {
		body := r.MessagePreview
		if body == "" {
			body = "You asked to be reminded about a message."
		}
		s.notifier.NotifyDirect(ctx, r.UserID, Notification{
			Kind:       NotificationKindReminder,
			Title:      "Reminder",
			Body:       body,
			DeepLink:   reminderDeepLink(r),
			ParentID:   r.ParentID,
			ParentType: r.ParentType,
			MessageID:  r.MessageID,
			CreatedAt:  now,
		})
	}
	slog.Info("reminder fired", "userID", r.UserID, "messageID", r.MessageID)
}

// reminderDeepLink builds the in-app URL the alert/activity row links to, matching
// the client's routes: channels by slug, conversations by id, both anchored to
// the message via the #msg- hash.
func reminderDeepLink(r *model.Reminder) string {
	anchor := "#msg-" + r.MessageID
	if r.ParentType == ParentConversation {
		return "/conversation/" + r.ParentID + anchor
	}
	target := r.ChannelSlug
	if target == "" {
		target = r.ParentID
	}
	return "/channel/" + target + anchor
}
