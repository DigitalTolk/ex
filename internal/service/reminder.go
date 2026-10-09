package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
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
	// CancelRemindersForParent returns how many it cancelled;
	// CancelRemindersForMessages and UpdateReminderPreview return the owners
	// whose reminders they touched.
	CancelRemindersForParent(ctx context.Context, userID, parentID string) (int, error)
	CancelRemindersForMessages(ctx context.Context, messageIDs []string) ([]string, error)
	UpdateReminderPreview(ctx context.Context, messageID, preview string) ([]string, error)
	// CancelAllRemindersForUser drops every reminder a user has queued, due or
	// not, returning how many there were.
	CancelAllRemindersForUser(ctx context.Context, userID string) (int, error)
}

// ReminderOwnerLookup resolves reminder owners, so a deactivated owner's
// reminders are dropped instead of fired. Implemented by the user store.
type ReminderOwnerLookup interface {
	GetUsersByIDs(ctx context.Context, ids []string) ([]*model.User, error)
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
	events   Publisher
	owners   ReminderOwnerLookup
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

// SetPublisher wires the reminders.changed event, so every tab and device
// keeps its pending list current.
func (s *ReminderService) SetPublisher(p Publisher) { s.events = p }

// SetOwnerLookup wires the owner check that drops a deactivated user's
// reminders when they come due — no alert, no mobile push job.
func (s *ReminderService) SetOwnerLookup(o ReminderOwnerLookup) { s.owners = o }

// CancelAllForUser stops every reminder a user has queued — on deactivation,
// so nothing is left to come due for an account that can't sign in.
func (s *ReminderService) CancelAllForUser(ctx context.Context, userID string) error {
	n, err := s.store.CancelAllRemindersForUser(ctx, userID)
	if n > 0 {
		slog.Info("reminders cancelled for deactivated user", "userID", userID, "count", n)
	}
	return err
}

// changed tells userID's tabs and devices to refetch their pending reminders.
func (s *ReminderService) changed(ctx context.Context, userID string) {
	if s.events != nil {
		events.Publish(ctx, s.events, pubsub.UserChannel(userID), events.EventRemindersChanged, map[string]any{})
	}
}

// A pending reminder carries a copy of its message's text, so losing access to
// the channel, or the message being deleted or edited, has to reach it. The
// channel and message services call these hooks (as they call the activity
// ones); the Redis work runs off the request path and each touched owner is
// told. A failure is logged — the due-time checks in fire still keep a
// reminder from alerting about a message its owner can no longer see.

// ParentLeft cancels userID's pending reminders in a channel or conversation
// they can no longer read (they left, were removed, or it was archived).
func (s *ReminderService) ParentLeft(ctx context.Context, userID, parentID string) {
	s.detached(ctx, func(bg context.Context) {
		n, err := s.store.CancelRemindersForParent(bg, userID, parentID)
		if err != nil {
			slog.Warn("reminder parent cleanup failed", "userID", userID, "parentID", parentID, "error", err)
			return
		}
		if n > 0 {
			s.changed(bg, userID)
		}
	})
}

// MessagesDeleted cancels every pending reminder about deleted messages,
// whoever set it.
func (s *ReminderService) MessagesDeleted(ctx context.Context, parentID, _ string, messageIDs []string) {
	if len(messageIDs) == 0 {
		return
	}
	s.detached(ctx, func(bg context.Context) {
		owners, err := s.store.CancelRemindersForMessages(bg, messageIDs)
		if err != nil {
			slog.Warn("reminder delete sync failed", "parentID", parentID, "error", err)
			return
		}
		for _, userID := range owners {
			s.changed(bg, userID)
		}
	})
}

// MessageEdited gives every pending reminder about an edited message its new
// preview — text edited out must not live on in a reminder.
func (s *ReminderService) MessageEdited(ctx context.Context, msg *model.Message, _ string) {
	msgID, preview := msg.ID, messagePreview(msg)
	s.detached(ctx, func(bg context.Context) {
		owners, err := s.store.UpdateReminderPreview(bg, msgID, preview)
		if err != nil {
			slog.Warn("reminder edit sync failed", "messageID", msgID, "error", err)
			return
		}
		for _, userID := range owners {
			s.changed(bg, userID)
		}
	})
}

// detached runs fn on its own goroutine with a context that outlives the
// request (bounded by detachedTimeout).
func (s *ReminderService) detached(ctx context.Context, fn func(context.Context)) {
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		fn(bg)
	})
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
	// A message deleted while the menu was open: say so now (404) rather than
	// confirm a reminder that would be dropped silently when it comes due.
	if msg.Deleted {
		return nil, fmt.Errorf("reminder: message deleted: %w", store.ErrNotFound)
	}
	r := &model.Reminder{
		ID:         store.NewID(),
		UserID:     userID,
		MessageID:  in.MessageID,
		ParentID:   in.ParentID,
		ParentType: in.ParentType,
		// The thread root comes from the stored message, not the client: a
		// reply only renders inside its thread, so the deep link needs it.
		ParentMessageID: msg.ParentMessageID,
		ChannelSlug:     in.ChannelSlug,
		MessagePreview:  messagePreview(msg),
		RemindAt:        in.RemindAt,
		CreatedAt:       now,
	}
	if err := s.store.ScheduleReminder(ctx, r); err != nil {
		return nil, err
	}
	s.changed(ctx, userID)
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
	s.changed(ctx, userID)
	return nil
}

// ProcessDue claims and fires every reminder due at or before now. Returns the
// number claimed (a reminder its owner can no longer open, or whose owner was
// deactivated, is claimed but not delivered). Safe to call concurrently across
// instances — claiming is atomic.
//
// Every owner whose reminder left the queue is told their pending list
// changed, whether it fired or was dropped — an open Activity panel would
// otherwise keep listing it as scheduled.
func (s *ReminderService) ProcessDue(ctx context.Context) (int, error) {
	claimed := 0
	for {
		due, err := s.store.ClaimDueReminders(ctx, reminderClaimBatch)
		if err != nil {
			return claimed, fmt.Errorf("reminder: claim due: %w", err)
		}
		deactivated := s.deactivatedOwners(ctx, due)
		owners := map[string]bool{}
		for _, r := range due {
			claimed++
			if deactivated[r.UserID] {
				slog.Info("reminder dropped: owner deactivated", "userID", r.UserID, "reminderID", r.ID)
				continue
			}
			s.fire(ctx, r)
			owners[r.UserID] = true
		}
		for userID := range owners {
			s.changed(ctx, userID)
		}
		if len(due) < reminderClaimBatch {
			return claimed, nil
		}
	}
}

// deactivatedOwners reports which of a batch's owners are deactivated, in one
// batched lookup. A failed lookup reports none — the reminders fire, since a
// lost reminder is worse than one sent to an account that can't read it.
func (s *ReminderService) deactivatedOwners(ctx context.Context, due []*model.Reminder) map[string]bool {
	if s.owners == nil || len(due) == 0 {
		return nil
	}
	seen := map[string]bool{}
	ids := make([]string, 0, len(due))
	for _, r := range due {
		if !seen[r.UserID] {
			seen[r.UserID] = true
			ids = append(ids, r.UserID)
		}
	}
	users, err := s.owners.GetUsersByIDs(ctx, ids)
	if err != nil {
		slog.Warn("reminder owner lookup failed", "error", err)
		return nil
	}
	out := map[string]bool{}
	for _, u := range users {
		if u.Status == "deactivated" {
			out[u.ID] = true
		}
	}
	return out
}

// fire delivers a claimed reminder: an activity-stream entry plus a desktop +
// mobile alert.
func (s *ReminderService) fire(ctx context.Context, r *model.Reminder) {
	// The owner may have left the channel, been removed from it, or seen it
	// archived since setting this: the alert would link to a page they can
	// no longer open. Only a definitive denial drops it — a failed check
	// still fires, since a lost reminder is worse than a dead link.
	if err := s.access.CheckAccess(ctx, r.UserID, r.ParentID, r.ParentType); errors.Is(err, ErrForbidden) {
		slog.Info("reminder dropped: owner no longer has access", "userID", r.UserID, "parentID", r.ParentID)
		return
	}
	// The message as it is now: one deleted since drops the reminder, an
	// edited one fires with its current text. This also covers reminders the
	// delete/edit sync never reached (set before the message index existed, or
	// its run failed). A failed read fires with the stored preview — a lost
	// reminder is worse than a stale one.
	msg, err := s.messages.GetMessage(ctx, r.ParentID, r.MessageID)
	if errors.Is(err, store.ErrNotFound) || (err == nil && msg.Deleted) {
		slog.Info("reminder dropped: message deleted", "userID", r.UserID, "messageID", r.MessageID)
		return
	}
	if err == nil {
		r.MessagePreview = messagePreview(msg)
	}
	now := s.now()
	if s.activity != nil {
		s.activity.AddItem(ctx, r.UserID, &model.ActivityItem{
			ID:              store.NewID(),
			Type:            model.ActivityReminder,
			CreatedAt:       now,
			MessageID:       r.MessageID,
			ParentID:        r.ParentID,
			ParentType:      r.ParentType,
			ParentMessageID: r.ParentMessageID,
			ChannelSlug:     r.ChannelSlug,
			MessagePreview:  r.MessagePreview,
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
			// Keyed by the reminder, not the message: the user may have been
			// alerted about this message minutes ago (or reminded of it
			// before), and a message-keyed alert would be deduped on desktop
			// and its mobile push dropped as a duplicate.
			AlertID:   r.ID,
			CreatedAt: now,
		})
	}
	slog.Info("reminder fired", "userID", r.UserID, "messageID", r.MessageID)
}

// reminderDeepLink builds the in-app URL the alert/activity row links to, matching
// the client's routes (buildChannelHref / buildConversationHref): channels by
// slug, conversations by id, a thread reply opening its thread via ?thread=,
// all anchored to the message via the #msg- hash.
func reminderDeepLink(r *model.Reminder) string {
	path := "/channel/" + r.ChannelSlug
	switch {
	case r.ParentType == ParentConversation:
		path = "/conversation/" + r.ParentID
	case r.ChannelSlug == "":
		path = "/channel/" + r.ParentID
	}
	if r.ParentMessageID != "" {
		path += "?thread=" + url.QueryEscape(r.ParentMessageID)
	}
	return path + "#msg-" + r.MessageID
}
