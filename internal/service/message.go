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
	if err := ValidateMessageBody(body); err != nil {
		return nil, err
	}
	if err := ValidateAttachmentCount(len(attachmentIDs)); err != nil {
		return nil, err
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

	// Mentioning a user who isn't yet in the channel surfaces a system
	// message inviting whoever can to add them. Channel-only — DMs and
	// groups can't mention "outsiders" since there's no concept of one.
	if parentType == ParentChannel {
		s.flagNonMemberMentions(ctx, msg)
	}

	// Thread reply: refresh the root's reply metadata so the action bar
	// (avatar stack + last-reply tooltip) updates without a re-fetch.
	if parentMessageID != "" {
		if parent, err := s.messages.GetMessage(ctx, parentID, parentMessageID); err == nil && parent != nil {
			parent.ReplyCount++
			lastReplyAt := msg.CreatedAt
			parent.LastReplyAt = &lastReplyAt
			parent.RecentReplyAuthorIDs = updateRecentAuthors(parent.RecentReplyAuthorIDs, userID)
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

// ThreadSummary describes a thread the user has participated in. It carries
// the metadata the sidebar needs (where to navigate, what to show, when the
// last activity was) without forcing the client to make N follow-up queries.
type ThreadSummary struct {
	ParentID         string    `json:"parentID"`
	ParentType       string    `json:"parentType"`
	ThreadRootID     string    `json:"threadRootID"`
	RootAuthorID     string    `json:"rootAuthorID"`
	RootBody         string    `json:"rootBody"`
	RootCreatedAt    time.Time `json:"rootCreatedAt"`
	ReplyCount       int       `json:"replyCount"`
	LatestActivityAt time.Time `json:"latestActivityAt"`
}

// ListUserThreads returns thread summaries for every thread the given user has
// participated in (authored the root or any reply). Sorted by latest activity,
// newest first.
//
// This walks the parents the user has access to (channels they're a member of
// and conversations they participate in) and inspects recent messages — the
// app targets small workspaces so this is acceptable. For larger scale this
// would move to a dedicated thread-participation index.
func (s *MessageService) ListUserThreads(ctx context.Context, userID string) ([]*ThreadSummary, error) {
	type parentRef struct {
		id  string
		typ string
	}
	parents := make([]parentRef, 0, 32)

	if s.memberships != nil {
		channels, err := s.memberships.ListUserChannels(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("threads: list channels: %w", err)
		}
		for _, c := range channels {
			parents = append(parents, parentRef{id: c.ChannelID, typ: ParentChannel})
		}
	}
	if s.conversations != nil {
		convs, err := s.conversations.ListUserConversations(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("threads: list conversations: %w", err)
		}
		for _, c := range convs {
			parents = append(parents, parentRef{id: c.ConversationID, typ: ParentConversation})
		}
	}

	out := make([]*ThreadSummary, 0)
	seen := make(map[string]bool)

	for _, p := range parents {
		msgs, _, err := s.messages.ListMessages(ctx, p.id, "", 1000)
		if err != nil {
			continue
		}
		// Index messages by ID so we can resolve thread roots without a second fetch.
		byID := make(map[string]*model.Message, len(msgs))
		for _, m := range msgs {
			byID[m.ID] = m
		}
		// Collect thread roots the user participates in for this parent.
		participated := make(map[string]bool)
		for _, m := range msgs {
			if m.AuthorID != userID {
				continue
			}
			if m.ParentMessageID != "" {
				participated[m.ParentMessageID] = true
			} else if m.ReplyCount > 0 {
				participated[m.ID] = true
			}
		}
		// Build summaries.
		for rootID := range participated {
			key := p.id + "#" + rootID
			if seen[key] {
				continue
			}
			seen[key] = true
			root := byID[rootID]
			if root == nil {
				continue
			}
			latest := root.CreatedAt
			for _, m := range msgs {
				if m.ParentMessageID == rootID && m.CreatedAt.After(latest) {
					latest = m.CreatedAt
				}
			}
			out = append(out, &ThreadSummary{
				ParentID:         p.id,
				ParentType:       p.typ,
				ThreadRootID:     rootID,
				RootAuthorID:     root.AuthorID,
				RootBody:         root.Body,
				RootCreatedAt:    root.CreatedAt,
				ReplyCount:       root.ReplyCount,
				LatestActivityAt: latest,
			})
		}
	}

	sort.Slice(out, func(i, j int) bool {
		return out[i].LatestActivityAt.After(out[j].LatestActivityAt)
	})
	return out, nil
}

// ListPinned returns all currently-pinned messages for a parent in
// reverse-chronological order (newest pin first by message ID). Membership
// is checked via the parent's access guard.
func (s *MessageService) ListPinned(ctx context.Context, userID, parentID, parentType string) ([]*model.Message, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	msgs, _, err := s.messages.ListMessages(ctx, parentID, "", 1000)
	if err != nil {
		return nil, fmt.Errorf("message: list pinned: %w", err)
	}
	pinned := make([]*model.Message, 0)
	for _, m := range msgs {
		if m.Pinned {
			pinned = append(pinned, m)
		}
	}
	return pinned, nil
}

// FileEntry is the per-attachment record returned by ListFiles. It
// captures who shared the file and when, plus the routing info the
// client needs to deep-link back into the originating message.
type FileEntry struct {
	AttachmentID string    `json:"attachmentID"`
	MessageID    string    `json:"messageID"`
	AuthorID     string    `json:"authorID"`
	CreatedAt    time.Time `json:"createdAt"`
}

// ListFiles returns every attachment shared in the parent in
// reverse-chronological order (newest first). The frontend hydrates the
// Attachment records via the existing batch endpoint.
//
// Re-shares of the same physical file collapse to one row keyed on the
// AttachmentID — the AttachmentService dedupes uploads by SHA-256, so
// the same content always resolves to the same ID, and the user only
// sees the latest message that referenced it.
//
// Like ListPinned, this walks recent messages — small workspaces only.
// At larger scale this would move to a dedicated index of attachments
// per parent.
func (s *MessageService) ListFiles(ctx context.Context, userID, parentID, parentType string) ([]*FileEntry, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	msgs, _, err := s.messages.ListMessages(ctx, parentID, "", 1000)
	if err != nil {
		return nil, fmt.Errorf("message: list files: %w", err)
	}
	latest := make(map[string]*FileEntry)
	for _, m := range msgs {
		for _, aid := range m.AttachmentIDs {
			if aid == "" {
				continue
			}
			if cur, ok := latest[aid]; ok && cur.CreatedAt.After(m.CreatedAt) {
				continue
			}
			latest[aid] = &FileEntry{
				AttachmentID: aid,
				MessageID:    m.ID,
				AuthorID:     m.AuthorID,
				CreatedAt:    m.CreatedAt,
			}
		}
	}
	files := make([]*FileEntry, 0, len(latest))
	for _, f := range latest {
		files = append(files, f)
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].CreatedAt.After(files[j].CreatedAt)
	})
	return files, nil
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
	if err := ValidateMessageBody(newBody); err != nil {
		return nil, err
	}
	if err := ValidateAttachmentCount(len(finalAttachments)); err != nil {
		return nil, err
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
		// Distinct-emoji cap. Adding a brand new emoji to a message that
		// already has the maximum is rejected; toggling an existing emoji
		// (path above) always works since it doesn't grow the map.
		if _, exists := msg.Reactions[emoji]; !exists && len(msg.Reactions) >= MaxDistinctReactions {
			return nil, ErrTooManyReactions
		}
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

// SetPinned toggles the pinned state of a message. Any participant in the
// channel/conversation may pin or unpin — pin authorship is captured on
// the message itself and serves as the audit trail.
func (s *MessageService) SetPinned(ctx context.Context, userID, parentID, parentType, msgID string, pinned bool) (*model.Message, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	msg, err := s.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return nil, fmt.Errorf("message: get: %w", err)
	}
	if msg.Pinned == pinned {
		return msg, nil
	}
	msg.Pinned = pinned
	if pinned {
		now := time.Now()
		msg.PinnedAt = &now
		msg.PinnedBy = userID
	} else {
		msg.PinnedAt = nil
		msg.PinnedBy = ""
	}
	if err := s.messages.UpdateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("message: update pinned: %w", err)
	}
	// Re-use message.edited so existing message-list invalidation paths
	// pick up the change without a new event handler. Pin is rare enough
	// that a dedicated event would be over-engineered.
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

// flagNonMemberMentions inspects the message body for @[id|name] markers
// and, for each mentioned user who is NOT a member of the channel, posts
// a system message in the channel announcing it so an admin can decide
// to invite them. No-op when nothing matches. Errors are swallowed —
// the user's send already succeeded and a missing audit message must
// not be allowed to cascade into a failed publish.
//
// We do per-mention GetMembership rather than scanning the whole channel
// (ListMembers): a typical message has 0–2 mentions, so 0–2 point reads
// is cheaper than one channel-wide scan. The notifier already pays for
// the channel-wide load on a different code path; reusing it would
// require cross-cutting plumbing not worth the few RCUs saved.
func (s *MessageService) flagNonMemberMentions(ctx context.Context, msg *model.Message) {
	if s.memberships == nil {
		return
	}
	mentions := ParseMentions(msg.Body)
	if len(mentions.Users) == 0 {
		return
	}
	for _, mention := range mentions.Users {
		if _, err := s.memberships.GetMembership(ctx, msg.ParentID, mention.UserID); err == nil {
			continue
		}
		body := "@" + mention.DisplayName + " was mentioned but isn't a member of this channel — an admin can invite them via the channel members list."
		s.postSystemMessage(ctx, msg.ParentID, body)
	}
}

// postSystemMessage persists a synthetic message attributed to "system" and
// publishes a message.new event so connected clients render it inline.
// Used for join/leave/audit-style notices and the non-member-mention flag.
func (s *MessageService) postSystemMessage(ctx context.Context, channelID, body string) {
	sysMsg := &model.Message{
		ID:        store.NewID(),
		ParentID:  channelID,
		AuthorID:  "system",
		Body:      body,
		System:    true,
		CreatedAt: time.Now(),
	}
	if err := s.messages.CreateMessage(ctx, sysMsg); err != nil {
		return
	}
	events.Publish(ctx, s.publisher, pubsub.ChannelName(channelID), events.EventMessageNew, sysMsg)
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

// updateRecentAuthors prepends authorID to the list, deduping, and trims
// to at most maxAuthors entries newest-first. Drives the thread-action
// avatar stack without a per-render thread fetch.
func updateRecentAuthors(prev []string, authorID string) []string {
	const maxAuthors = 3
	out := make([]string, 0, maxAuthors)
	out = append(out, authorID)
	for _, id := range prev {
		if id == authorID {
			continue
		}
		out = append(out, id)
		if len(out) >= maxAuthors {
			break
		}
	}
	return out
}
