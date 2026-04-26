package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// Parent type constants used by handlers to indicate whether the parent is a
// channel or a conversation.
const (
	ParentChannel      = "channel"
	ParentConversation = "conversation"
)

// ConversationActivator is implemented by ConversationService and lets
// MessageService activate a conversation on first message send.
type ConversationActivator interface {
	Activate(ctx context.Context, convID string) error
}

// AttachmentRefManager is the AttachmentService capability MessageService uses
// to bind/unbind attachments to messages. Defined as an interface so tests can
// stub it without dragging in storage.
type AttachmentRefManager interface {
	AddRef(ctx context.Context, attachmentID, messageID string) error
	RemoveRef(ctx context.Context, attachmentID, messageID string) error
}

// MessageNotifier is the slice of NotificationService MessageService cares
// about. Defined as an interface so the dependency is explicit and tests
// can stub it without instantiating the real notifier.
type MessageNotifier interface {
	NotifyForMessage(ctx context.Context, msg *model.Message, parentType string)
}

// MessageService handles sending, editing, deleting, and listing messages.
type MessageService struct {
	messages      MessageStore
	memberships   MembershipStore
	conversations ConversationStore
	publisher     Publisher
	broker        Broker
	activator     ConversationActivator
	attachments   AttachmentRefManager
	notifier      MessageNotifier
}

// NewMessageService creates a MessageService with the given dependencies.
func NewMessageService(
	messages MessageStore,
	memberships MembershipStore,
	conversations ConversationStore,
	publisher Publisher,
	broker Broker,
) *MessageService {
	return &MessageService{
		messages:      messages,
		memberships:   memberships,
		conversations: conversations,
		publisher:     publisher,
		broker:        broker,
	}
}

// SetActivator wires the conversation activator. Called from main wiring after
// both services are constructed to avoid a constructor cycle.
func (s *MessageService) SetActivator(a ConversationActivator) { s.activator = a }

// SetAttachmentManager wires the attachment ref manager. Called from main
// wiring after both services are constructed to avoid a constructor cycle.
func (s *MessageService) SetAttachmentManager(a AttachmentRefManager) { s.attachments = a }

// SetNotifier wires the notification dispatcher. Optional — when nil, no
// alerts are produced and message sends still complete normally.
func (s *MessageService) SetNotifier(n MessageNotifier) { s.notifier = n }

// Send creates a new message in the given parent (channel or conversation).
// If parentMessageID is non-empty, the message is a thread reply: the root
// message's ReplyCount is incremented and a message.edited event is published
// for the root so the UI updates the count.
//
// Attachments are bound by ID after the message row is persisted so dangling
// refs are impossible.
func (s *MessageService) Send(ctx context.Context, userID, parentID, parentType, body, parentMessageID string, attachmentIDs ...string) (*model.Message, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}

	if body == "" && len(attachmentIDs) == 0 {
		return nil, errors.New("message: body or attachments required")
	}

	now := time.Now()
	msg := &model.Message{
		ID:              store.NewID(),
		ParentID:        parentID,
		AuthorID:        userID,
		Body:            body,
		ParentMessageID: parentMessageID,
		AttachmentIDs:   attachmentIDs,
		CreatedAt:       now,
	}

	if err := s.messages.CreateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("message: create: %w", err)
	}

	// Bind each attachment to this message. Failures are logged but the
	// message is already persisted so we don't roll it back.
	s.bindAttachments(ctx, msg.ID, attachmentIDs)

	// Activate the conversation on first message so non-creator participants
	// see it appear in their sidebars only after activity exists.
	if parentType == ParentConversation && s.activator != nil && parentMessageID == "" {
		if err := s.activator.Activate(ctx, parentID); err != nil {
			slog.Warn("conversation activate failed", "convID", parentID, "error", err)
		}
	}

	s.publishEvent(ctx, parentID, parentType, events.EventMessageNew, msg)

	// Fire user-facing notifications (sound + popup) to recipients who
	// haven't muted the parent. Decoupled from event publishing so failure
	// here never affects state propagation.
	if s.notifier != nil {
		s.notifier.NotifyForMessage(ctx, msg, parentType)
	}

	// If this is a thread reply, bump the root message's ReplyCount and emit
	// an edited event so subscribed clients update the count.
	if parentMessageID != "" {
		if parent, err := s.messages.GetMessage(ctx, parentID, parentMessageID); err == nil && parent != nil {
			parent.ReplyCount++
			if err := s.messages.UpdateMessage(ctx, parent); err == nil {
				s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, parent)
			}
		}
	}

	return msg, nil
}

// ListThreadMessages returns the root message followed by all reply messages
// for a thread, in chronological order (oldest first). ULIDs sort by timestamp,
// so we sort by ID ascending — the underlying ListMessages returns descending.
func (s *MessageService) ListThreadMessages(ctx context.Context, userID, parentID, parentType, threadRootID string) ([]*model.Message, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	msgs, _, err := s.messages.ListMessages(ctx, parentID, "", 1000)
	if err != nil {
		return nil, fmt.Errorf("message: list thread: %w", err)
	}
	thread := make([]*model.Message, 0)
	for _, m := range msgs {
		if m.ID == threadRootID || m.ParentMessageID == threadRootID {
			thread = append(thread, m)
		}
	}
	sort.Slice(thread, func(i, j int) bool { return thread[i].ID < thread[j].ID })
	return thread, nil
}

// List returns messages for a parent with cursor-based pagination.
// It returns the messages, a boolean indicating whether there are more
// results, and any error.
func (s *MessageService) List(ctx context.Context, userID, parentID, parentType, before string, limit int) ([]*model.Message, bool, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, false, err
	}

	msgs, hasMore, err := s.messages.ListMessages(ctx, parentID, before, limit)
	if err != nil {
		return nil, false, fmt.Errorf("message: list: %w", err)
	}
	return msgs, hasMore, nil
}

// Edit updates the body and (optionally) the attachment list of an existing
// message. Only the original author may edit. If attachmentIDs is nil, the
// existing attachments are preserved; if non-nil (even an empty slice) the
// attachments are replaced wholesale and add/remove refs are reconciled.
func (s *MessageService) Edit(ctx context.Context, userID, parentID, parentType, msgID, newBody string, attachmentIDs []string) (*model.Message, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}

	msg, err := s.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return nil, fmt.Errorf("message: get: %w", err)
	}

	if msg.AuthorID != userID {
		return nil, errors.New("message: only the author can edit")
	}

	finalAttachments := msg.AttachmentIDs
	if attachmentIDs != nil {
		finalAttachments = attachmentIDs
	}
	if newBody == "" && len(finalAttachments) == 0 {
		return nil, errors.New("message: body or attachments required")
	}

	msg.Body = newBody
	now := time.Now()
	msg.EditedAt = &now

	var added, removed []string
	if attachmentIDs != nil {
		prev := map[string]bool{}
		for _, id := range msg.AttachmentIDs {
			prev[id] = true
		}
		next := map[string]bool{}
		for _, id := range attachmentIDs {
			if id == "" || next[id] {
				continue
			}
			next[id] = true
			if !prev[id] {
				added = append(added, id)
			}
		}
		for id := range prev {
			if !next[id] {
				removed = append(removed, id)
			}
		}
		// Replace with deduped, ordered new list.
		clean := make([]string, 0, len(attachmentIDs))
		seen := map[string]bool{}
		for _, id := range attachmentIDs {
			if id == "" || seen[id] {
				continue
			}
			seen[id] = true
			clean = append(clean, id)
		}
		msg.AttachmentIDs = clean
	}

	if err := s.messages.UpdateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("message: update: %w", err)
	}

	// Reconcile attachment refcounts in parallel; failures are logged inside
	// bindAttachments / releaseAttachments and do not roll back the edit.
	s.bindAttachments(ctx, msgID, added)
	s.releaseAttachments(ctx, msgID, removed)

	s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, msg)

	return msg, nil
}

// Delete removes a message. The author or a channel admin (for channel
// messages) may delete.
func (s *MessageService) Delete(ctx context.Context, userID, parentID, parentType, msgID string) error {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return err
	}

	msg, err := s.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return fmt.Errorf("message: get: %w", err)
	}

	if msg.AuthorID != userID {
		// For channel messages, allow admins to delete.
		if parentType == ParentChannel {
			mem, err := s.memberships.GetMembership(ctx, parentID, userID)
			if err != nil || mem.Role < model.ChannelRoleAdmin {
				return errors.New("message: only the author or a channel admin can delete")
			}
		} else {
			return errors.New("message: only the author can delete")
		}
	}

	if err := s.messages.DeleteMessage(ctx, parentID, msgID); err != nil {
		return fmt.Errorf("message: delete: %w", err)
	}

	s.releaseAttachments(ctx, msgID, msg.AttachmentIDs)

	payload := struct {
		ID       string `json:"id"`
		ParentID string `json:"parentID"`
	}{ID: msgID, ParentID: parentID}
	s.publishEvent(ctx, parentID, parentType, events.EventMessageDeleted, payload)

	return nil
}

// ToggleReaction adds the given emoji from the user to a message, or removes
// it if the user has already reacted with that emoji. The updated message is
// persisted and a message.edited event is published so all clients refresh.
func (s *MessageService) ToggleReaction(ctx context.Context, userID, parentID, parentType, msgID, emoji string) (*model.Message, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	if emoji == "" {
		return nil, errors.New("message: emoji required")
	}

	msg, err := s.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return nil, fmt.Errorf("message: get: %w", err)
	}

	if msg.Reactions == nil {
		msg.Reactions = map[string][]string{}
	}
	users := msg.Reactions[emoji]
	idx := -1
	for i, u := range users {
		if u == userID {
			idx = i
			break
		}
	}
	if idx >= 0 {
		users = append(users[:idx], users[idx+1:]...)
		if len(users) == 0 {
			delete(msg.Reactions, emoji)
		} else {
			msg.Reactions[emoji] = users
		}
	} else {
		msg.Reactions[emoji] = append(users, userID)
	}
	if len(msg.Reactions) == 0 {
		msg.Reactions = nil
	}

	if err := s.messages.UpdateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("message: update: %w", err)
	}

	s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, msg)
	return msg, nil
}

// checkAccess verifies the user is a member of the channel or a participant
// in the conversation.
func (s *MessageService) checkAccess(ctx context.Context, userID, parentID, parentType string) error {
	switch parentType {
	case ParentChannel:
		_, err := s.memberships.GetMembership(ctx, parentID, userID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return errors.New("message: not a channel member")
			}
			return fmt.Errorf("message: check channel membership: %w", err)
		}
	case ParentConversation:
		conv, err := s.conversations.GetConversation(ctx, parentID)
		if err != nil {
			return fmt.Errorf("message: get conversation: %w", err)
		}
		found := false
		for _, id := range conv.ParticipantIDs {
			if id == userID {
				found = true
				break
			}
		}
		if !found {
			return errors.New("message: not a conversation participant")
		}
	default:
		return fmt.Errorf("message: unknown parent type %q", parentType)
	}
	return nil
}

// bindAttachments fans out AddRef calls in parallel and logs (but does not
// surface) any per-attachment failure — the message is already persisted.
func (s *MessageService) bindAttachments(ctx context.Context, msgID string, ids []string) {
	if s.attachments == nil || len(ids) == 0 {
		return
	}
	var wg sync.WaitGroup
	for _, aid := range ids {
		if aid == "" {
			continue
		}
		wg.Add(1)
		go func(aid string) {
			defer wg.Done()
			if err := s.attachments.AddRef(ctx, aid, msgID); err != nil {
				slog.Warn("attachment add ref failed", "attID", aid, "msgID", msgID, "error", err)
			}
		}(aid)
	}
	wg.Wait()
}

// releaseAttachments mirrors bindAttachments but for RemoveRef. Run on message
// delete so unreferenced uploads are GC'd from S3.
func (s *MessageService) releaseAttachments(ctx context.Context, msgID string, ids []string) {
	if s.attachments == nil || len(ids) == 0 {
		return
	}
	var wg sync.WaitGroup
	for _, aid := range ids {
		if aid == "" {
			continue
		}
		wg.Add(1)
		go func(aid string) {
			defer wg.Done()
			if err := s.attachments.RemoveRef(ctx, aid, msgID); err != nil {
				slog.Warn("attachment remove ref failed", "attID", aid, "msgID", msgID, "error", err)
			}
		}(aid)
	}
	wg.Wait()
}

// publishEvent sends a real-time event to the appropriate pub/sub channel.
func (s *MessageService) publishEvent(ctx context.Context, parentID, parentType, eventType string, data any) {
	var channel string
	switch parentType {
	case ParentChannel:
		channel = pubsub.ChannelName(parentID)
	case ParentConversation:
		channel = pubsub.ConversationName(parentID)
	default:
		return
	}
	events.Publish(ctx, s.publisher, channel, eventType, data)
}
