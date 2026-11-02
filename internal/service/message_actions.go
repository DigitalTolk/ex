package service

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

var (
	// ErrCardChanged: the button clicked is no longer on the message (the
	// app replaced the card meanwhile). The clicker sees the new card.
	ErrCardChanged = errors.New("card changed")
	// ErrAppNotSetUp: the button calls an app that isn't set up to receive
	// clicks.
	ErrAppNotSetUp = errors.New("app not set up for buttons")
)

// actionAttempts bounds how often a click retries after losing a race with
// another change to the same message.
const actionAttempts = 4

// AppClicker sends a click on an app button to the app (InteractionService).
type AppClicker interface {
	Click(ctx context.Context, msg *model.Message, parentType string, element model.BlockElement, blockID, userID string, value RawValue) (*AppClickResult, error)
}

// SetAppClicker wires the service that sends app buttons' clicks.
func (s *MessageService) SetAppClicker(c AppClicker) { s.apps = c }

// ActResult is a click's outcome: the message as it now is, and a notice
// for the clicker alone (an app's word, or why nothing happened).
type ActResult struct {
	Message *model.Message `json:"message"`
	Notice  string         `json:"notice,omitempty"`
	// Failed: the click didn't go through; the notice says why.
	Failed bool `json:"failed,omitempty"`
}

// ButtonAt finds the element named (blockID, actionID) — a button, or a
// picker the app gave the message — among its blocks and its cards'.
func ButtonAt(m *model.Message, blockID, actionID string) (model.BlockElement, bool) {
	find := func(blocks model.Blocks) (model.BlockElement, bool) {
		for _, b := range blocks {
			if b.BlockID != blockID {
				continue
			}
			if b.Accessory != nil && b.Accessory.ActionID == actionID {
				return *b.Accessory, true
			}
			for _, e := range b.Elements {
				if (e.Type == model.ElementButton || model.IsMessageInteractive(e.Type)) && e.ActionID == actionID {
					return e, true
				}
			}
		}
		return model.BlockElement{}, false
	}
	if e, ok := find(m.Blocks); ok {
		return e, true
	}
	for _, a := range m.MessageAttachments {
		if e, ok := find(a.Blocks); ok {
			return e, true
		}
	}
	return model.BlockElement{}, false
}

// MayClick reports whether userID may see and click e: anyone, unless the
// app named who may.
func MayClick(e model.BlockElement, userID string) bool {
	return len(e.AllowedUsers) == 0 || slices.Contains(e.AllowedUsers, userID)
}

// Act applies userID's click on the button (blockID, actionID) of a message.
// Everything that decides the outcome — which button, its action, who may
// click it — comes from the stored message, never from the request: the
// client names the button and nothing else. Built-in actions (ack, vote)
// are applied here; the result is broadcast like any change to the message,
// but marks it neither edited nor unread.
func (s *MessageService) Act(ctx context.Context, userID, parentID, parentType, msgID, blockID, actionID string) (*ActResult, error) {
	return s.ActWithValue(ctx, userID, parentID, parentType, msgID, blockID, actionID, nil)
}

// ActWithValue is Act for an element that takes a value — a select, a
// picker, checkboxes: value is what the person picked, which the app gets
// only once it is checked against the stored element.
func (s *MessageService) ActWithValue(ctx context.Context, userID, parentID, parentType, msgID, blockID, actionID string, value RawValue) (*ActResult, error) {
	if err := s.checkWriteAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	for attempt := 1; ; attempt++ {
		stored, err := s.messages.GetMessage(ctx, parentID, msgID)
		if err != nil {
			return nil, fmt.Errorf("message: get: %w", err)
		}
		// The click changes a copy: what was read stays what was read, so a
		// lost race retries from the store's state, not from this attempt's.
		msg := withOwnTallies(stored)
		if msg.Deleted {
			return nil, apperr.Reject(ErrCardChanged, "this message was deleted")
		}
		button, ok := ButtonAt(msg, blockID, actionID)
		if !ok {
			return nil, apperr.Reject(ErrCardChanged, "this card changed, try again")
		}
		if !MayClick(button, userID) {
			return nil, apperr.Forbidden("this button isn't for you")
		}
		switch {
		case button.Type == model.ElementImage:
			return nil, apperr.Invalid("an image isn't something to click")
		case button.URL != "":
			return nil, apperr.Invalid("a link button opens its link")
		case button.ExAction == "":
			return s.clickApp(ctx, msg, parentType, button, blockID, userID, value)
		}
		prev := msg.Version
		if !applyBuiltInAction(msg, blockID, actionID, button.ExAction, userID, time.Now()) {
			s.attachRendered(ctx, msg)
			return &ActResult{Message: msg}, nil
		}
		msg.Version = prev + 1
		err = s.messages.UpdateMessageIfVersion(ctx, msg, prev)
		if errors.Is(err, store.ErrVersionConflict) && attempt < actionAttempts {
			continue
		}
		if errors.Is(err, store.ErrVersionConflict) {
			return nil, apperr.Conflict("this card is busy, try again")
		}
		if err != nil {
			return nil, fmt.Errorf("message: update: %w", err)
		}
		s.attachRendered(ctx, msg)
		s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, msg)
		return &ActResult{Message: msg}, nil
	}
}

// clickApp hands a click on an app button to the app. The answer is the
// message as the app left it, or as it was when the app changed nothing.
func (s *MessageService) clickApp(ctx context.Context, msg *model.Message, parentType string, button model.BlockElement, blockID, userID string, value RawValue) (*ActResult, error) {
	if s.apps == nil {
		return nil, apperr.Reject(ErrAppNotSetUp, "this app isn't set up for buttons")
	}
	res, err := s.apps.Click(ctx, msg, parentType, button, blockID, userID, value)
	if err != nil {
		return nil, err
	}
	out := res.Message
	if out == nil {
		out = msg
	}
	s.attachRendered(ctx, out)
	return &ActResult{Message: out, Notice: res.Notice, Failed: res.Failed}, nil
}

// withOwnTallies copies m with tallies it alone owns, so changing them
// leaves m as it was.
func withOwnTallies(m *model.Message) *model.Message {
	out := *m
	out.ActionTallies = make([]model.ActionTally, len(m.ActionTallies))
	for i, t := range m.ActionTallies {
		t.UserIDs = slices.Clone(t.UserIDs)
		out.ActionTallies[i] = t
	}
	return &out
}

// applyBuiltInAction changes msg's tallies for one click and reports whether
// anything changed. ack keeps the first clicker for good; vote toggles the
// clicker's vote.
func applyBuiltInAction(msg *model.Message, blockID, actionID, action, userID string, now time.Time) bool {
	i := slices.IndexFunc(msg.ActionTallies, func(t model.ActionTally) bool {
		return t.BlockID == blockID && t.ActionID == actionID
	})
	if action == model.ExActionAck {
		if i >= 0 {
			return false
		}
		msg.ActionTallies = append(msg.ActionTallies, model.ActionTally{BlockID: blockID, ActionID: actionID, UserIDs: []string{userID}, At: now})
		return true
	}
	if i < 0 {
		msg.ActionTallies = append(msg.ActionTallies, model.ActionTally{BlockID: blockID, ActionID: actionID, UserIDs: []string{userID}, At: now})
		return true
	}
	t := &msg.ActionTallies[i]
	if j := slices.Index(t.UserIDs, userID); j >= 0 {
		t.UserIDs = slices.Delete(t.UserIDs, j, j+1)
	} else {
		t.UserIDs = append(t.UserIDs, userID)
	}
	t.At = now
	if len(t.UserIDs) == 0 {
		msg.ActionTallies = slices.Delete(msg.ActionTallies, i, i+1)
	}
	if len(msg.ActionTallies) == 0 {
		msg.ActionTallies = nil
	}
	return true
}
