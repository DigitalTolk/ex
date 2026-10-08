package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

const (
	// scheduledMaxHorizon caps how far ahead a message may be scheduled.
	scheduledMaxHorizon = 365 * 24 * time.Hour
	// scheduledClaimBatch bounds one due-queue read; the poller loops until a
	// partial batch drains the queue.
	scheduledClaimBatch = 50
	// scheduledLease is how long a claimed message is held before it comes
	// due again — the safety net for an instance dying mid-delivery.
	scheduledLease = 2 * time.Minute
	// scheduledGiveUpAfter: a delivery still failing for unknown (transient)
	// reasons this long after its time is marked failed instead of retried.
	scheduledGiveUpAfter = time.Hour
	// scheduledMaxDrainRounds bounds one ProcessDue pass.
	scheduledMaxDrainRounds = 20
)

// ErrScheduledTimeInvalid is returned when a send time isn't in the future,
// or is further out than scheduledMaxHorizon.
var ErrScheduledTimeInvalid = fmt.Errorf("%w: send time must be in the future", ErrValidation)

// ErrScheduledBusy is returned by SendNow when the message is being
// delivered at that very moment.
var ErrScheduledBusy = errors.New("scheduled message: already being sent")

// ScheduledMessageSender posts a scheduled message as its author through the
// normal send path (access, validation, notifications).
type ScheduledMessageSender interface {
	Send(ctx context.Context, userID, parentID, parentType, body, parentMessageID string, attachmentIDs ...string) (*model.Message, error)
	CheckAccess(ctx context.Context, userID, parentID, parentType string) error
}

// DraftAttachmentReleaser frees an attachment no message will use (a deleted
// scheduled message's files).
type DraftAttachmentReleaser interface {
	DeleteDraft(ctx context.Context, userID, attachmentID string) error
}

// ScheduledMessageInput is a message to schedule.
type ScheduledMessageInput struct {
	ParentID        string    `json:"parentID"`
	ParentType      string    `json:"parentType"`
	ParentMessageID string    `json:"parentMessageID"`
	Body            string    `json:"body"`
	AttachmentIDs   []string  `json:"attachmentIDs"`
	SendAt          time.Time `json:"sendAt"`
}

// ScheduledMessageUpdate edits a scheduled message's text and/or time.
type ScheduledMessageUpdate struct {
	Body   *string    `json:"body"`
	SendAt *time.Time `json:"sendAt"`
}

// ScheduledMessageService lets a user compose a message now and have it
// posted at a chosen time.
type ScheduledMessageService struct {
	store       store.ScheduledMessageStore
	sender      ScheduledMessageSender
	attachments DraftAttachmentReleaser
	publisher   Publisher
	now         func() time.Time
}

// NewScheduledMessageService builds a ScheduledMessageService. attachments
// and publisher may be nil.
func NewScheduledMessageService(st store.ScheduledMessageStore, sender ScheduledMessageSender, attachments DraftAttachmentReleaser, publisher Publisher) *ScheduledMessageService {
	return &ScheduledMessageService{store: st, sender: sender, attachments: attachments, publisher: publisher, now: time.Now}
}

// Schedule validates and stores a message to be sent at in.SendAt.
func (s *ScheduledMessageService) Schedule(ctx context.Context, userID string, in ScheduledMessageInput) (*model.ScheduledMessage, error) {
	if in.ParentID == "" || (in.ParentType != ParentChannel && in.ParentType != ParentConversation) {
		return nil, fmt.Errorf("%w: a channel or conversation is required", ErrValidation)
	}
	if err := s.validateTime(in.SendAt); err != nil {
		return nil, err
	}
	if err := validateScheduledContent(in.Body, in.AttachmentIDs); err != nil {
		return nil, err
	}
	if err := s.sender.CheckAccess(ctx, userID, in.ParentID, in.ParentType); err != nil {
		return nil, err
	}
	now := s.now()
	m := &model.ScheduledMessage{
		ID:              store.NewID(),
		UserID:          userID,
		ParentID:        in.ParentID,
		ParentType:      in.ParentType,
		ParentMessageID: in.ParentMessageID,
		Body:            in.Body,
		AttachmentIDs:   in.AttachmentIDs,
		SendAt:          in.SendAt,
		State:           model.ScheduledMessagePending,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if err := s.store.PutScheduledMessage(ctx, m); err != nil {
		return nil, err
	}
	s.changed(ctx, userID)
	return m, nil
}

// List returns the user's scheduled messages, soonest first.
func (s *ScheduledMessageService) List(ctx context.Context, userID string) ([]*model.ScheduledMessage, error) {
	list, err := s.store.ListScheduledMessages(ctx, userID)
	if err != nil {
		return nil, err
	}
	slices.SortFunc(list, func(a, b *model.ScheduledMessage) int { return a.SendAt.Compare(b.SendAt) })
	return list, nil
}

// Update edits a scheduled message's text and/or time. Giving a failed
// message a new time schedules it again.
func (s *ScheduledMessageService) Update(ctx context.Context, userID, id string, upd ScheduledMessageUpdate) (*model.ScheduledMessage, error) {
	m, err := s.store.GetScheduledMessage(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if err := s.validateUpdate(m, upd); err != nil {
		return nil, err
	}
	// Hold it first so a delivery can't be under way while it changes.
	if err := s.hold(ctx, m); err != nil {
		return nil, err
	}
	if upd.Body != nil {
		m.Body = *upd.Body
	}
	if upd.SendAt != nil {
		m.SendAt = *upd.SendAt
		m.State = model.ScheduledMessagePending
		m.FailReason = ""
	}
	m.UpdatedAt = s.now()
	if err := s.store.PutScheduledMessage(ctx, m); err != nil {
		return nil, err
	}
	s.changed(ctx, userID)
	return m, nil
}

// Delete drops a scheduled message and frees its files.
func (s *ScheduledMessageService) Delete(ctx context.Context, userID, id string) error {
	m, err := s.store.GetScheduledMessage(ctx, userID, id)
	if err != nil {
		return err
	}
	if err := s.hold(ctx, m); err != nil {
		return err
	}
	if err := s.store.DeleteScheduledMessage(ctx, userID, id); err != nil {
		return err
	}
	if s.attachments != nil {
		for _, aid := range m.AttachmentIDs {
			// Best-effort: an attachment some sent message also uses is
			// refused, which is exactly right.
			if err := s.attachments.DeleteDraft(ctx, userID, aid); err != nil {
				slog.Debug("scheduled message: attachment kept", "attachmentID", aid, "error", err)
			}
		}
	}
	s.changed(ctx, userID)
	return nil
}

// SendNow posts a scheduled message immediately — also how a failed one is
// retried.
func (s *ScheduledMessageService) SendNow(ctx context.Context, userID, id string) (*model.Message, error) {
	m, err := s.store.GetScheduledMessage(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if err := s.hold(ctx, m); err != nil {
		return nil, err
	}
	return s.deliver(ctx, m)
}

// hold claims m for a change or an immediate send, so the poller (or a second
// click) can't deliver it at the same time. ErrScheduledBusy when it is being
// sent right now.
func (s *ScheduledMessageService) hold(ctx context.Context, m *model.ScheduledMessage) error {
	dueKey := "" // a failed message isn't queued
	if m.State == model.ScheduledMessagePending {
		dueKey = store.ScheduledDueKey(m.SendAt, m.ID)
	}
	claimed, err := s.store.ClaimScheduledMessage(ctx, m.UserID, m.ID, dueKey, s.now().Add(scheduledLease))
	if err != nil {
		return err
	}
	if !claimed {
		return ErrScheduledBusy
	}
	return nil
}

func (s *ScheduledMessageService) validateUpdate(m *model.ScheduledMessage, upd ScheduledMessageUpdate) error {
	if upd.Body != nil {
		if err := validateScheduledContent(*upd.Body, m.AttachmentIDs); err != nil {
			return err
		}
	}
	if upd.SendAt != nil {
		return s.validateTime(*upd.SendAt)
	}
	return nil
}

// ProcessDue sends every message whose time has come. Safe across
// instances: each message is claimed by exactly one of them. Returns how
// many were sent.
func (s *ScheduledMessageService) ProcessDue(ctx context.Context) (int, error) {
	sent := 0
	for round := 0; round < scheduledMaxDrainRounds; round++ {
		now := s.now()
		due, err := s.store.ListDueScheduledMessages(ctx, now, scheduledClaimBatch)
		if err != nil {
			return sent, fmt.Errorf("scheduled message: list due: %w", err)
		}
		for _, d := range due {
			claimed, err := s.store.ClaimScheduledMessage(ctx, d.UserID, d.ID, d.DueKey, now.Add(scheduledLease))
			if err != nil {
				slog.Warn("scheduled message: claim failed", "id", d.ID, "error", err)
				continue
			}
			if !claimed {
				continue // another instance has it, or its author just changed it
			}
			if _, err := s.deliver(ctx, d.ScheduledMessage); err == nil {
				sent++
			}
		}
		if len(due) < scheduledClaimBatch {
			break
		}
	}
	return sent, nil
}

// deliver posts m as its author. Sent: the scheduled copy goes. A failure the
// author has to act on (no longer has access, thread deleted, …) keeps it as
// failed with the reason; anything else is retried when the claim lapses,
// until scheduledGiveUpAfter.
func (s *ScheduledMessageService) deliver(ctx context.Context, m *model.ScheduledMessage) (*model.Message, error) {
	msg, err := s.sender.Send(ctx, m.UserID, m.ParentID, m.ParentType, m.Body, m.ParentMessageID, m.AttachmentIDs...)
	if err == nil {
		if derr := s.store.DeleteScheduledMessage(ctx, m.UserID, m.ID); derr != nil {
			slog.Error("scheduled message: sent but not removed", "id", m.ID, "error", derr)
		}
		s.changed(ctx, m.UserID)
		return msg, nil
	}
	reason, final := scheduledFailReason(err)
	if !final && s.now().Sub(m.SendAt) < scheduledGiveUpAfter {
		slog.Warn("scheduled message: delivery failed, will retry", "id", m.ID, "error", err)
		return nil, err
	}
	m.State = model.ScheduledMessageFailed
	m.FailReason = reason
	m.UpdatedAt = s.now()
	if perr := s.store.PutScheduledMessage(ctx, m); perr != nil {
		slog.Error("scheduled message: failed delivery not recorded", "id", m.ID, "error", perr)
	}
	s.changed(ctx, m.UserID)
	return nil, err
}

// scheduledFailReason words a delivery error for its author, and says whether
// it is final (retrying won't help).
func scheduledFailReason(err error) (string, bool) {
	switch {
	case errors.Is(err, ErrForbidden):
		return "You no longer have access to this conversation.", true
	case errors.Is(err, ErrThreadDeleted):
		return "The thread was deleted.", true
	case errors.Is(err, store.ErrNotFound):
		return "The conversation or thread no longer exists.", true
	case errors.Is(err, ErrMessageTooLong), errors.Is(err, ErrTooManyAttachments), errors.Is(err, ErrValidation):
		return "The message can't be sent as it is — edit it and try again.", true
	default:
		return "It couldn't be sent. Try again.", false
	}
}

func (s *ScheduledMessageService) validateTime(at time.Time) error {
	now := s.now()
	if !at.After(now) || at.After(now.Add(scheduledMaxHorizon)) {
		return ErrScheduledTimeInvalid
	}
	return nil
}

func validateScheduledContent(body string, attachmentIDs []string) error {
	if strings.TrimSpace(body) == "" && len(attachmentIDs) == 0 {
		return fmt.Errorf("%w: message is empty", ErrValidation)
	}
	if err := ValidateMessageBody(body); err != nil {
		return fmt.Errorf("%w: %w", ErrValidation, err)
	}
	if err := ValidateAttachmentCount(len(attachmentIDs)); err != nil {
		return fmt.Errorf("%w: %w", ErrValidation, err)
	}
	return nil
}

// changed nudges the user's tabs and devices to refetch their scheduled list.
func (s *ScheduledMessageService) changed(ctx context.Context, userID string) {
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventScheduledMessagesChanged, map[string]any{})
}
