package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
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
	threadScanPageSize = 200
	maxThreadScanPages = 25
)

// ConversationActivator is implemented by ConversationService and lets
// MessageService activate a conversation on first message send.
type ConversationActivator interface {
	Activate(ctx context.Context, convID string) error
}

type ConversationUnreadTracker interface {
	MarkUnread(ctx context.Context, userID, convID string) error
}

// AttachmentRefManager is the AttachmentService capability MessageService uses
// to bind/unbind attachments to messages. Defined as an interface so tests can
// stub it without dragging in storage.
type AttachmentRefManager interface {
	ValidateForUse(ctx context.Context, attachmentID string) error
	AddRef(ctx context.Context, attachmentID, messageID string) error
	RemoveRef(ctx context.Context, attachmentID, messageID string) error
}

// MessageNotifier is the slice of NotificationService MessageService cares
// about. Defined as an interface so the dependency is explicit and tests
// can stub it without instantiating the real notifier.
type MessageNotifier interface {
	NotifyForMessage(ctx context.Context, msg *model.Message, parentType string)
}

type MessageIndexer interface {
	IndexMessage(ctx context.Context, msg *model.Message, parentType string) error
	DeleteMessage(ctx context.Context, id string) error
}

// MessageService handles sending, editing, deleting, and listing messages.
type MessageService struct {
	messages      MessageStore
	memberships   MembershipStore
	conversations ConversationStore
	publisher     Publisher
	broker        Broker
	activator     ConversationActivator
	unreadTracker ConversationUnreadTracker
	attachments   AttachmentRefManager
	notifier      MessageNotifier
	indexer       MessageIndexer
	threadFollows ThreadFollowStore
	userState     UserStateStore
	parentIndex   ParentPinFileIndexStore
	markdown      *MarkdownRenderer
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

func (s *MessageService) SetConversationUnreadTracker(t ConversationUnreadTracker) {
	s.unreadTracker = t
}

// SetAttachmentManager wires the attachment ref manager. Called from main
// wiring after both services are constructed to avoid a constructor cycle.
func (s *MessageService) SetAttachmentManager(a AttachmentRefManager) { s.attachments = a }

// SetNotifier wires the notification dispatcher. Optional — when nil, no
// alerts are produced and message sends still complete normally.
func (s *MessageService) SetNotifier(n MessageNotifier) { s.notifier = n }

func (s *MessageService) SetIndexer(i MessageIndexer) { s.indexer = i }

func (s *MessageService) SetThreadFollowStore(f ThreadFollowStore) { s.threadFollows = f }

func (s *MessageService) SetUserStateStore(userState UserStateStore) { s.userState = userState }

// SetParentIndex wires the per-parent pinned/file index. Required
// for ListPinned / ListFiles to return any data — those paths read
// exclusively from the index now. Production wiring (cmd/server/main.go)
// and every test helper (setupMessageService, setupChannelHandlerFull,
// etc.) wire a real implementation. Pre-rollout data must be backfilled
// once with `cmd/migrate-parent-index --apply` (see README).
//
// Write paths (Send / Edit / Delete / SetPinned) still guard with
// `if s.parentIndex != nil` so a misconfiguration logs a warning
// rather than panicking the request.
func (s *MessageService) SetParentIndex(p ParentPinFileIndexStore) { s.parentIndex = p }

// SetMarkdownRenderer wires the server-side markdown→hast renderer.
// When set, every Message returned by the service has its `Rendered`
// field populated so the frontend doesn't have to re-parse on each
// render. Optional — tests that don't care about rendered output
// leave it nil and the field stays empty (the frontend then falls
// back to its legacy client-side parser).
func (s *MessageService) SetMarkdownRenderer(m *MarkdownRenderer) { s.markdown = m }

// attachRendered populates the Rendered field on every supplied
// Message. Centralising this means every return path in the service
// (Send, Edit, List…, publishEvent) gets the hast tree without
// having to remember to call the renderer at each call site.
func (s *MessageService) attachRendered(msgs ...*model.Message) {
	if s.markdown == nil {
		return
	}
	for _, m := range msgs {
		if m == nil {
			continue
		}
		// Soft-deleted messages have empty Body; skip the parse and
		// leave Rendered nil (frontend renders the "(deleted)"
		// placeholder, not the body).
		if m.Deleted || m.Body == "" {
			continue
		}
		m.Rendered = s.markdown.RenderToHast(m.Body)
	}
}

func (s *MessageService) CheckAccess(ctx context.Context, userID, parentID, parentType string) error {
	return s.checkAccess(ctx, userID, parentID, parentType)
}

func (s *MessageService) CanAccessMessageAttachment(ctx context.Context, userID, parentID, parentType, messageID, attachmentID string) error {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return err
	}
	if messageID == "" {
		msgs, _, err := s.messages.ListMessages(ctx, parentID, "", 1000)
		if err != nil {
			return fmt.Errorf("message: list attachment parent messages: %w", err)
		}
		for _, msg := range msgs {
			for _, id := range msg.AttachmentIDs {
				if id == attachmentID {
					return nil
				}
			}
		}
		return errors.New("message: attachment is not referenced by parent")
	}
	msg, err := s.messages.GetMessage(ctx, parentID, messageID)
	if err != nil {
		return fmt.Errorf("message: get attachment owner message: %w", err)
	}
	for _, id := range msg.AttachmentIDs {
		if id == attachmentID {
			return nil
		}
	}
	return errors.New("message: attachment is not referenced by message")
}

// indexMessage / deleteFromIndex dispatch on a detached goroutine so a
// slow OpenSearch never adds to user-perceived send latency. Failures
// are logged; the admin reindex is the recovery path.
func (s *MessageService) indexMessage(ctx context.Context, m *model.Message, parentType string) {
	if s.indexer == nil || m == nil {
		return
	}
	go func() {
		if err := s.indexer.IndexMessage(context.WithoutCancel(ctx), m, parentType); err != nil {
			slog.Warn("search index message failed", "id", m.ID, "error", err)
		}
	}()
}

func (s *MessageService) deleteFromIndex(ctx context.Context, id string) {
	if s.indexer == nil {
		return
	}
	go func() {
		if err := s.indexer.DeleteMessage(context.WithoutCancel(ctx), id); err != nil {
			slog.Warn("search delete message failed", "id", id, "error", err)
		}
	}()
}

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
	if err := s.validateAttachmentsForUse(ctx, attachmentIDs); err != nil {
		return nil, err
	}

	// Thread replies may not be added to a deleted thread. The root is the
	// source of truth: once it's soft-deleted (which cascades to every
	// existing reply, see Delete) the thread is closed for good. Enforced
	// server-side so a stale client that still shows the composer can't
	// resurrect the thread.
	if parentMessageID != "" {
		root, err := s.messages.GetMessage(ctx, parentID, parentMessageID)
		if err != nil {
			return nil, fmt.Errorf("message: thread root: %w", err)
		}
		if root.Deleted {
			return nil, ErrThreadDeleted
		}
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

	if err := s.bindAttachments(ctx, msg.ID, attachmentIDs); err != nil {
		if delErr := s.messages.DeleteMessage(ctx, parentID, msg.ID); delErr != nil {
			slog.Warn("message rollback after attachment bind failed", "msgID", msg.ID, "error", delErr)
		}
		return nil, err
	}

	// Maintain the per-parent FILE# index. Each attached file gets one
	// row per parent — re-shares overwrite the existing row so the
	// index always tracks the most-recent message that referenced this
	// file. Best-effort: failure here is logged but doesn't block the
	// send (the file index is a UI-side affordance, not a correctness
	// invariant).
	if s.parentIndex != nil {
		for _, aid := range attachmentIDs {
			if aid == "" {
				continue
			}
			if err := s.parentIndex.SetFileIndex(ctx, parentID, aid, msg.ID, msg.AuthorID, msg.CreatedAt); err != nil {
				slog.Warn("file index set failed", "msgID", msg.ID, "attachmentID", aid, "error", err)
			}
		}
	}

	if parentType == ParentConversation {
		if conv, err := s.conversations.GetConversation(ctx, parentID); err == nil && conv != nil {
			if s.unreadTracker != nil {
				for _, participantID := range conv.ParticipantIDs {
					if participantID == userID {
						continue
					}
					if err := s.unreadTracker.MarkUnread(ctx, participantID, parentID); err != nil {
						slog.Warn("conversation unread mark failed", "convID", parentID, "userID", participantID, "error", err)
					}
				}
			}
			if err := s.conversations.TouchConversation(ctx, parentID, conv.ParticipantIDs, now); err != nil {
				slog.Warn("conversation activity touch failed", "convID", parentID, "error", err)
			} else {
				userChannels := make([]string, 0, len(conv.ParticipantIDs))
				for _, participantID := range conv.ParticipantIDs {
					userChannels = append(userChannels, pubsub.UserChannel(participantID))
				}
				events.PublishMany(ctx, s.publisher, userChannels, events.EventUserChannelUpdated, map[string]any{
					"conversationID": parentID,
					"updatedAt":      now,
				})
			}
			// Activate the conversation on first top-level message so non-creator
			// participants see it appear in their sidebars only after activity exists.
			if parentMessageID == "" && s.activator != nil {
				if err := s.activator.Activate(ctx, parentID); err != nil {
					slog.Warn("conversation activate failed", "convID", parentID, "error", err)
				}
			}
		}
	}

	var updatedThreadRoot *model.Message
	if parentMessageID != "" {
		// Update thread-derived state before publishing message.new. Clients
		// refetch /threads as soon as that event arrives; if the follow row or
		// root reply metadata is still missing, the list can stay stale until
		// the next cache invalidation.
		s.followMentionedThreadUsers(ctx, msg, parentType)
		if updated, err := s.messages.IncrementReplyMetadata(ctx, parentID, parentMessageID, msg.CreatedAt, userID); err == nil {
			updatedThreadRoot = updated
		}
	}

	s.publishEvent(ctx, parentID, parentType, events.EventMessageNew, msg)

	// Fire user-facing notifications (sound + popup) to recipients who
	// haven't muted the parent. Decoupled from event publishing so failure
	// here never affects state propagation.
	if s.notifier != nil {
		s.notifier.NotifyForMessage(ctx, msg, parentType)
	}

	s.indexMessage(ctx, msg, parentType)


	// Thread reply: republish the authoritative parent so subscribers see
	// the new replyCount / avatar stack without a re-fetch. The metadata
	// itself was already persisted before message.new to keep /threads
	// refetches from racing old state.
	if updatedThreadRoot != nil {
		s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, updatedThreadRoot)
	}

	s.attachRendered(msg)
	return msg, nil
}

type WebhookMessageInput struct {
	ChannelID   string
	ParentID    string
	ParentType  string
	AuthorID    string
	Body        string
	Username    string
	AvatarURL   string
	IconEmoji   string
	Attachments []model.MessageAttachment
}

func (s *MessageService) SendWebhook(ctx context.Context, in WebhookMessageInput) (*model.Message, error) {
	parentID := in.ParentID
	if parentID == "" {
		parentID = in.ChannelID
	}
	parentType := in.ParentType
	if parentType == "" {
		parentType = ParentChannel
	}
	authorID := in.AuthorID
	if authorID == "" {
		authorID = "webhook"
	}
	if parentID == "" {
		return nil, errors.New("message: parent required")
	}
	if in.Body == "" && len(in.Attachments) == 0 {
		return nil, errors.New("message: body or attachments required")
	}
	if err := ValidateMessageBody(in.Body); err != nil {
		return nil, err
	}
	if err := ValidateAttachmentCount(len(in.Attachments)); err != nil {
		return nil, err
	}
	msg := &model.Message{
		ID:                 store.NewID(),
		ParentID:           parentID,
		AuthorID:           authorID,
		Body:               in.Body,
		WebhookUsername:    in.Username,
		WebhookAvatarURL:   in.AvatarURL,
		WebhookIconEmoji:   in.IconEmoji,
		MessageAttachments: in.Attachments,
		CreatedAt:          time.Now(),
	}
	if msg.WebhookUsername == "" {
		msg.WebhookUsername = "webhook"
	}
	if err := s.messages.CreateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("message: create webhook: %w", err)
	}
	s.publishEvent(ctx, parentID, parentType, events.EventMessageNew, msg)
	if s.notifier != nil {
		s.notifier.NotifyForMessage(ctx, msg, parentType)
	}
	s.indexMessage(ctx, msg, parentType)
	return msg, nil
}

func (s *MessageService) followMentionedThreadUsers(ctx context.Context, msg *model.Message, parentType string) {
	if s.threadFollows == nil || msg == nil || msg.ParentMessageID == "" {
		return
	}
	mentions := ParseMentions(msg.Body)
	if len(mentions.Users) == 0 {
		return
	}
	// Resolve access checks first, then issue a single batch write
	// instead of N point writes. A reply mentioning 5 teammates
	// previously cost 5 DynamoDB round-trips on the message-send path;
	// this drops it to 1.
	now := time.Now()
	follows := make([]*model.ThreadFollow, 0, len(mentions.Users))
	seen := make(map[string]struct{}, len(mentions.Users))
	for _, mention := range mentions.Users {
		if mention.UserID == "" || mention.UserID == msg.AuthorID {
			continue
		}
		if _, dup := seen[mention.UserID]; dup {
			continue
		}
		if err := s.checkAccess(ctx, mention.UserID, msg.ParentID, parentType); err != nil {
			continue
		}
		seen[mention.UserID] = struct{}{}
		follows = append(follows, &model.ThreadFollow{
			UserID:       mention.UserID,
			ParentID:     msg.ParentID,
			ParentType:   parentType,
			ThreadRootID: msg.ParentMessageID,
			Following:    true,
			UpdatedAt:    now,
		})
	}
	if len(follows) == 0 {
		return
	}
	if err := s.threadFollows.SetThreadFollowMany(ctx, follows); err != nil {
		slog.Warn("thread mention follow batch failed", "count", len(follows), "threadRootID", msg.ParentMessageID, "error", err)
	}
}

// ListThreadMessages returns the root message followed by all reply messages
// for a thread, in chronological order (oldest first). ULIDs sort by timestamp,
// so we sort by ID ascending — the underlying ListMessages returns descending.
func (s *MessageService) ListThreadMessages(ctx context.Context, userID, parentID, parentType, threadRootID string) ([]*model.Message, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	// The root is fetched directly; only replies are indexed in GSI1.
	root, err := s.messages.GetMessage(ctx, parentID, threadRootID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("message: list thread root: %w", err)
	}
	replies, err := s.messages.ListThreadReplies(ctx, threadRootID)
	if err != nil {
		return nil, fmt.Errorf("message: list thread: %w", err)
	}
	// Fallback: a thread whose replies predate the GSI backfill returns zero
	// indexed replies even though the root records some — scan the parent so
	// historical threads stay complete until the migration runs. New replies
	// are always indexed; the eventual-consistency lag of the very latest reply
	// is covered by the client's WebSocket stream, so we don't scan for that.
	if len(replies) == 0 && root != nil && root.ReplyCount > 0 {
		return s.listThreadByScan(ctx, parentID, threadRootID)
	}
	thread := make([]*model.Message, 0, len(replies)+1)
	if root != nil {
		thread = append(thread, root)
	}
	thread = append(thread, replies...)
	sort.Slice(thread, func(i, j int) bool { return thread[i].ID < thread[j].ID })
	s.attachRendered(thread...)
	return thread, nil
}

// listThreadByScan is the pre-GSI fallback: scan the parent partition and
// filter for the thread root + its replies. Retained for threads whose replies
// haven't been backfilled into the GSI yet.
func (s *MessageService) listThreadByScan(ctx context.Context, parentID, threadRootID string) ([]*model.Message, error) {
	msgs, err := s.scanParentMessages(ctx, parentID)
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
	s.attachRendered(thread...)
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

func threadFollowKey(parentID, threadRootID string) string {
	return parentID + "#" + threadRootID
}

// SetThreadFollow records whether userID follows threadRootID. Following=true
// adds a thread to /threads without requiring the user to reply. Following=false
// suppresses implicit participation from authored roots/replies.
func (s *MessageService) SetThreadFollow(ctx context.Context, userID, parentID, parentType, threadRootID string, following bool) error {
	if parentType != ParentChannel && parentType != ParentConversation {
		return errors.New("thread: invalid parent type")
	}
	if s.threadFollows == nil {
		return errors.New("thread: follow store unavailable")
	}
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return err
	}
	root, err := s.messages.GetMessage(ctx, parentID, threadRootID)
	if err != nil {
		return fmt.Errorf("thread: get root: %w", err)
	}
	if root.ParentMessageID != "" {
		return errors.New("thread: root must be a top-level message")
	}
	return s.threadFollows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID:       userID,
		ParentID:     parentID,
		ParentType:   parentType,
		ThreadRootID: threadRootID,
		Following:    following,
		UpdatedAt:    time.Now(),
	})
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
	followOverrides := make(map[string]bool)
	notificationThreads := make(map[string]bool)
	if s.threadFollows != nil {
		follows, err := s.threadFollows.ListUserThreadFollows(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("threads: list follows: %w", err)
		}
		for _, f := range follows {
			followOverrides[threadFollowKey(f.ParentID, f.ThreadRootID)] = f.Following
		}
	}
	if s.userState != nil {
		items, err := s.userState.ListUserState(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("threads: list user state: %w", err)
		}
		for _, item := range items {
			if item.Kind != model.UserStateThreadNotification || item.ParentID == "" || item.ThreadRootID == "" {
				continue
			}
			notificationThreads[threadFollowKey(item.ParentID, item.ThreadRootID)] = true
		}
	}

	for _, p := range parents {
		msgs, err := s.scanParentMessages(ctx, p.id)
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
		for key, following := range followOverrides {
			if !strings.HasPrefix(key, p.id+"#") {
				continue
			}
			rootID := strings.TrimPrefix(key, p.id+"#")
			if following {
				participated[rootID] = true
			} else if !notificationThreads[key] {
				delete(participated, rootID)
			}
		}
		for key := range notificationThreads {
			if !strings.HasPrefix(key, p.id+"#") {
				continue
			}
			participated[strings.TrimPrefix(key, p.id+"#")] = true
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

func (s *MessageService) scanParentMessages(ctx context.Context, parentID string) ([]*model.Message, error) {
	out := make([]*model.Message, 0, threadScanPageSize)
	cursor := ""
	for page := 0; page < maxThreadScanPages; page++ {
		msgs, hasMore, err := s.messages.ListMessages(ctx, parentID, cursor, threadScanPageSize)
		if err != nil {
			return nil, err
		}
		if len(msgs) == 0 {
			return out, nil
		}
		out = append(out, msgs...)
		if !hasMore {
			return out, nil
		}
		cursor = msgs[len(msgs)-1].ID
	}
	return out, nil
}

// ListPinned returns all currently-pinned messages for a parent in
// reverse-chronological order (newest pin first by message ID).
// Membership is checked via the parent's access guard.
//
// Backed by the dedicated PIN# index in the same DDB partition — the
// query returns only the pinned rows, then we batch-fetch the full
// messages by ID. Previously this scanned up to 1000 messages and
// filtered in-memory, which broke past that cap and burned RCUs on
// every sidebar click.
func (s *MessageService) ListPinned(ctx context.Context, userID, parentID, parentType string) ([]*model.Message, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	// parentIndex is mandatory — wired in cmd/server/main.go and in
	// every test via setupMessageService. Pre-rollout legacy data
	// must be backfilled once after deploy with
	// `go run ./cmd/migrate-parent-index --apply` (see README).
	rows, err := s.parentIndex.ListPinIndex(ctx, parentID)
	if err != nil {
		return nil, fmt.Errorf("message: list pinned index: %w", err)
	}
	pinned := make([]*model.Message, 0, len(rows))
	for _, row := range rows {
		msg, err := s.messages.GetMessage(ctx, parentID, row.MessageID)
		if err != nil {
			// A row in the index that no longer resolves to a message
			// (deletion-cleanup race) is a soft inconsistency — drop
			// it from this response and best-effort the cleanup.
			_ = s.parentIndex.DeletePinIndex(ctx, parentID, row.MessageID)
			continue
		}
		if !msg.Pinned {
			// Index says pinned but message says no — stale index row.
			_ = s.parentIndex.DeletePinIndex(ctx, parentID, row.MessageID)
			continue
		}
		pinned = append(pinned, msg)
	}
	s.attachRendered(pinned...)
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
// Reads exclusively from the FILE# index. Pre-rollout data is invisible
// here until the operator runs `cmd/migrate-parent-index --apply`.
func (s *MessageService) ListFiles(ctx context.Context, userID, parentID, parentType string) ([]*FileEntry, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	// parentIndex is mandatory (see ListPinned).
	rows, err := s.parentIndex.ListFileIndex(ctx, parentID)
	if err != nil {
		return nil, fmt.Errorf("message: list file index: %w", err)
	}
	files := make([]*FileEntry, 0, len(rows))
	for _, row := range rows {
		files = append(files, &FileEntry{
			AttachmentID: row.AttachmentID,
			MessageID:    row.MessageID,
			AuthorID:     row.AuthorID,
			CreatedAt:    row.CreatedAt,
		})
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].CreatedAt.After(files[j].CreatedAt)
	})
	return files, nil
}

// maxListRounds caps the inner store-fetch loop so a channel that is
// 99% thread replies can't loop forever; 6 rounds ≈ 300 raw messages,
// after which the frontend's sentinel takes over from the cursor we
// returned.
const maxListRounds = 6

// List returns top-level messages for a parent with cursor-based
// pagination. Thread replies live in the thread panel and are filtered
// out by listTopLevel.
func (s *MessageService) List(ctx context.Context, userID, parentID, parentType, before string, limit int) ([]*model.Message, bool, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, false, err
	}
	return s.listTopLevel(ctx, parentID, before, limit)
}

// ListAfter returns top-level messages strictly newer than `after`.
func (s *MessageService) ListAfter(ctx context.Context, userID, parentID, parentType, after string, limit int) ([]*model.Message, bool, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, false, err
	}
	return s.listTopLevelAfter(ctx, parentID, after, limit)
}

// ListAround returns a top-level window centered on msgID so a deep-
// link can load only the messages near the target instead of paging
// back from the live tail. The three sub-fetches run concurrently —
// this is on the user-perceived "Jump to message" path so latency
// multiplies if they serialize.
func (s *MessageService) ListAround(ctx context.Context, userID, parentID, parentType, msgID string, before, after int) ([]*model.Message, bool, bool, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, false, false, err
	}
	var (
		wg                            sync.WaitGroup
		target                        *model.Message
		older, newer                  []*model.Message
		hasMoreOlder, hasMoreNewer    bool
		errTarget, errOlder, errNewer error
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		target, errTarget = s.messages.GetMessage(ctx, parentID, msgID)
	}()
	go func() {
		defer wg.Done()
		older, hasMoreOlder, errOlder = s.listTopLevel(ctx, parentID, msgID, before)
	}()
	go func() {
		defer wg.Done()
		newer, hasMoreNewer, errNewer = s.listTopLevelAfter(ctx, parentID, msgID, after)
	}()
	wg.Wait()
	if errTarget != nil && !errors.Is(errTarget, store.ErrNotFound) {
		return nil, false, false, fmt.Errorf("message: list around: %w", errTarget)
	}
	if errOlder != nil {
		return nil, false, false, errOlder
	}
	if errNewer != nil {
		return nil, false, false, errNewer
	}
	out := make([]*model.Message, 0, len(older)+len(newer)+1)
	out = append(out, newer...)
	if target != nil {
		out = append(out, target)
	}
	out = append(out, older...)
	s.attachRendered(out...)
	return out, hasMoreOlder, hasMoreNewer, nil
}

// listTopLevel pages OLDER from `before` (or the live tail if empty),
// accumulating top-level messages until we have `limit` of them.
func (s *MessageService) listTopLevel(ctx context.Context, parentID, before string, limit int) ([]*model.Message, bool, error) {
	collected := make([]*model.Message, 0, limit)
	cursor := before
	storeHasMore := true
	for round := 0; round < maxListRounds && storeHasMore && len(collected) <= limit; round++ {
		raw, hasMore, err := s.messages.ListMessages(ctx, parentID, cursor, limit)
		if err != nil {
			return nil, false, fmt.Errorf("message: list: %w", err)
		}
		storeHasMore = hasMore
		if len(raw) == 0 {
			break
		}
		for _, m := range raw {
			if m.ParentMessageID == "" {
				collected = append(collected, m)
			}
		}
		cursor = raw[len(raw)-1].ID
	}
	hasMore := false
	if len(collected) > limit {
		collected = collected[:limit]
		hasMore = true
	} else if storeHasMore {
		hasMore = true
	}
	s.attachRendered(collected...)
	return collected, hasMore, nil
}

// listTopLevelAfter pages NEWER from `after`. Cursor advances via the
// newest raw ID seen so pure-reply stretches don't loop forever.
// Accumulates oldest-first (closer-to-cursor wins on trim), then
// reverses at the end to match List's newest-first contract.
func (s *MessageService) listTopLevelAfter(ctx context.Context, parentID, after string, limit int) ([]*model.Message, bool, error) {
	collected := make([]*model.Message, 0, limit)
	cursor := after
	storeHasMore := true
	for round := 0; round < maxListRounds && storeHasMore && len(collected) <= limit; round++ {
		raw, hasMore, err := s.messages.ListMessagesAfter(ctx, parentID, cursor, limit)
		if err != nil {
			return nil, false, fmt.Errorf("message: list after: %w", err)
		}
		storeHasMore = hasMore
		if len(raw) == 0 {
			break
		}
		for i := len(raw) - 1; i >= 0; i-- {
			m := raw[i]
			if m.ParentMessageID == "" {
				collected = append(collected, m)
			}
		}
		cursor = raw[0].ID
	}
	hasMore := false
	if len(collected) > limit {
		collected = collected[:limit]
		hasMore = true
	} else if storeHasMore {
		hasMore = true
	}
	for i, j := 0, len(collected)-1; i < j; i, j = i+1, j-1 {
		collected[i], collected[j] = collected[j], collected[i]
	}
	s.attachRendered(collected...)
	return collected, hasMore, nil
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
	if attachmentIDs != nil {
		if err := s.validateAttachmentsForUse(ctx, attachmentIDs); err != nil {
			return nil, err
		}
	}

	edited := *msg
	edited.AttachmentIDs = append([]string(nil), msg.AttachmentIDs...)
	edited.Body = newBody
	now := time.Now()
	edited.EditedAt = &now

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
		edited.AttachmentIDs = clean
	}

	if err := s.bindAttachments(ctx, msgID, added); err != nil {
		return nil, err
	}
	if err := s.messages.UpdateMessage(ctx, &edited); err != nil {
		s.releaseAttachments(ctx, msgID, added)
		return nil, fmt.Errorf("message: update: %w", err)
	}
	s.releaseAttachments(ctx, msgID, removed)

	// Reflect attachment changes onto the FILE# index. The edited
	// message keeps its original CreatedAt, so when *adding* an
	// attachment we only overwrite an existing row if the row points
	// at an *older* share — otherwise the newer share already owns
	// the row and must survive. *Removing* an attachment drops the
	// row only when it still points at this message.
	if s.parentIndex != nil && (len(added) > 0 || len(removed) > 0) {
		existing, err := s.parentIndex.ListFileIndex(ctx, parentID)
		if err != nil {
			slog.Warn("file index lookup on edit failed", "msgID", edited.ID, "error", err)
			existing = nil
		}
		existingByAtt := make(map[string]FileIndexEntry, len(existing))
		for _, row := range existing {
			existingByAtt[row.AttachmentID] = row
		}
		for _, aid := range added {
			if cur, ok := existingByAtt[aid]; ok && cur.CreatedAt.After(edited.CreatedAt) {
				continue
			}
			if err := s.parentIndex.SetFileIndex(ctx, parentID, aid, edited.ID, edited.AuthorID, edited.CreatedAt); err != nil {
				slog.Warn("file index set on edit failed", "msgID", edited.ID, "attachmentID", aid, "error", err)
			}
		}
		for _, aid := range removed {
			cur, ok := existingByAtt[aid]
			if !ok || cur.MessageID != edited.ID {
				continue
			}
			if err := s.parentIndex.DeleteFileIndex(ctx, parentID, aid); err != nil {
				slog.Warn("file index delete on edit failed", "msgID", edited.ID, "attachmentID", aid, "error", err)
			}
		}
	}

	s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, &edited)

	s.indexMessage(ctx, &edited, parentType)

	s.attachRendered(&edited)
	return &edited, nil
}

// Delete soft-deletes a message: the row stays in the list (so replies
// referencing it can still resolve their thread root) but Body /
// AttachmentIDs / Reactions are cleared and the row is flagged
// Deleted=true so clients render a "(Message deleted)" placeholder.
// The author or a channel admin (for channel messages) may delete.
func (s *MessageService) Delete(ctx context.Context, userID, parentID, parentType, msgID string) error {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return err
	}

	msg, err := s.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return fmt.Errorf("message: get: %w", err)
	}

	if msg.AuthorID != userID {
		if parentType == ParentChannel {
			mem, err := s.memberships.GetMembership(ctx, parentID, userID)
			if err != nil || mem.Role < model.ChannelRoleAdmin {
				return errors.New("message: only the author or a channel admin can delete")
			}
		} else {
			return errors.New("message: only the author can delete")
		}
	}

	if err := s.softDeleteMessage(ctx, msg, parentID, parentType); err != nil {
		return err
	}

	// Cascade: deleting a thread root closes the whole thread. Every
	// existing reply is tombstoned too, and Send refuses new replies once
	// the root is gone (see ErrThreadDeleted). Only top-level messages are
	// thread roots — deleting a reply (ParentMessageID != "") never
	// cascades. Best-effort: a reply that fails to delete is logged but
	// doesn't fail the root delete, since the root tombstone already
	// closed the thread to new replies.
	if msg.ParentMessageID == "" {
		s.cascadeDeleteThreadReplies(ctx, parentID, parentType, msgID)
	}

	return nil
}

// softDeleteMessage tombstones a single message: clears its body /
// attachments / reactions / pin state, persists the Deleted=true row (so
// replies referencing it can still resolve their root), releases attachment
// refs, tears down the PIN# / FILE# index rows it owned, publishes the
// deleted event, and drops it from the search index. Shared by Delete (the
// target) and its thread-reply cascade.
func (s *MessageService) softDeleteMessage(ctx context.Context, msg *model.Message, parentID, parentType string) error {
	originalAttachments := msg.AttachmentIDs
	wasPinned := msg.Pinned
	msg.Tombstone()
	if err := s.messages.UpdateMessage(ctx, msg); err != nil {
		return fmt.Errorf("message: soft-delete: %w", err)
	}

	s.releaseAttachments(ctx, msg.ID, originalAttachments)

	// Tear down the index rows that pointed at this message.
	// - Pin index: drop unconditionally if the message was pinned.
	// - File index: only drop the row if its current MessageID is
	//   THIS message — otherwise the row already points at a more
	//   recent share that should survive.
	if s.parentIndex != nil {
		if wasPinned {
			if err := s.parentIndex.DeletePinIndex(ctx, parentID, msg.ID); err != nil {
				slog.Warn("pin index delete on message-delete failed", "msgID", msg.ID, "error", err)
			}
		}
		if len(originalAttachments) > 0 {
			rows, err := s.parentIndex.ListFileIndex(ctx, parentID)
			if err != nil {
				slog.Warn("file index lookup on message-delete failed", "msgID", msg.ID, "error", err)
			} else {
				attached := make(map[string]struct{}, len(originalAttachments))
				for _, aid := range originalAttachments {
					attached[aid] = struct{}{}
				}
				for _, row := range rows {
					if row.MessageID != msg.ID {
						continue
					}
					if _, hit := attached[row.AttachmentID]; !hit {
						continue
					}
					if err := s.parentIndex.DeleteFileIndex(ctx, parentID, row.AttachmentID); err != nil {
						slog.Warn("file index delete on message-delete failed", "msgID", msg.ID, "attachmentID", row.AttachmentID, "error", err)
					}
				}
			}
		}
	}

	// Publish the deleted tombstone so other clients can patch their
	// visible cache without waiting for a refetch. parentMessageID is
	// included by the model and lets clients refresh the right thread.
	s.publishEvent(ctx, parentID, parentType, events.EventMessageDeleted, msg)

	s.deleteFromIndex(ctx, msg.ID)

	return nil
}

// cascadeDeleteThreadReplies soft-deletes every reply belonging to a thread
// whose root (rootID) was just deleted. Each reply gets the same tombstone
// treatment + deleted event as a directly-deleted message, so connected
// clients patch the thread in real time. Best-effort per reply.
func (s *MessageService) cascadeDeleteThreadReplies(ctx context.Context, parentID, parentType, rootID string) {
	msgs, err := s.scanParentMessages(ctx, parentID)
	if err != nil {
		slog.Warn("thread cascade scan failed", "rootID", rootID, "error", err)
		return
	}
	for _, m := range msgs {
		if m.ParentMessageID != rootID || m.Deleted {
			continue
		}
		if err := s.softDeleteMessage(ctx, m, parentID, parentType); err != nil {
			slog.Warn("thread reply cascade delete failed", "msgID", m.ID, "rootID", rootID, "error", err)
		}
	}
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
	s.indexMessage(ctx, msg, parentType)
	s.attachRendered(msg)
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
		s.attachRendered(msg)
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
	// Mirror to the dedicated PIN# index so ListPinned doesn't have
	// to rescan messages. Best-effort: the message itself remains the
	// source of truth (msg.Pinned), and ListPinned reconciles drift.
	if s.parentIndex != nil {
		if pinned {
			if err := s.parentIndex.SetPinIndex(ctx, parentID, msg.ID, userID, *msg.PinnedAt); err != nil {
				slog.Warn("pin index set failed", "msgID", msg.ID, "error", err)
			}
		} else {
			if err := s.parentIndex.DeletePinIndex(ctx, parentID, msg.ID); err != nil {
				slog.Warn("pin index delete failed", "msgID", msg.ID, "error", err)
			}
		}
	}
	// Re-use message.edited so existing message-list invalidation paths
	// pick up the change without a new event handler. Pin is rare enough
	// that a dedicated event would be over-engineered.
	s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, msg)
	s.attachRendered(msg)
	return msg, nil
}

// SetNoUnfurl toggles the per-message link-preview suppression flag.
// Only the author may dismiss — the unfurl is content the author
// effectively chose to show, so they own the dismissal.
func (s *MessageService) SetNoUnfurl(ctx context.Context, userID, parentID, parentType, msgID string, noUnfurl bool) (*model.Message, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	msg, err := s.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return nil, fmt.Errorf("message: get: %w", err)
	}
	if msg.AuthorID != userID {
		return nil, errors.New("message: only the author can dismiss the link preview")
	}
	if msg.NoUnfurl == noUnfurl {
		s.attachRendered(msg)
		return msg, nil
	}
	msg.NoUnfurl = noUnfurl
	if err := s.messages.UpdateMessage(ctx, msg); err != nil {
		return nil, fmt.Errorf("message: update no-unfurl: %w", err)
	}
	s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, msg)
	s.attachRendered(msg)
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

func (s *MessageService) validateAttachmentsForUse(ctx context.Context, ids []string) error {
	if len(ids) == 0 || s.attachments == nil {
		return nil
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if err := s.attachments.ValidateForUse(ctx, id); err != nil {
			return fmt.Errorf("message: invalid attachment %q: %w", id, err)
		}
	}
	return nil
}

func (s *MessageService) bindAttachments(ctx context.Context, msgID string, ids []string) error {
	if s.attachments == nil || len(ids) == 0 {
		return nil
	}
	var wg sync.WaitGroup
	errCh := make(chan error, len(ids))
	for _, aid := range ids {
		if aid == "" {
			continue
		}
		wg.Add(1)
		go func(aid string) {
			defer wg.Done()
			if err := s.attachments.AddRef(ctx, aid, msgID); err != nil {
				errCh <- fmt.Errorf("message: bind attachment %q: %w", aid, err)
			}
		}(aid)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		return err
	}
	return nil
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

// postSystemMessage persists a synthetic message attributed to "system" and
// publishes a message.new event so connected clients render it inline.
// Used for join/leave/audit-style notices and the non-member-mention flag.
func (s *MessageService) postSystemMessage(ctx context.Context, channelID, body string) {
	sysMsg := &model.Message{
		ID:         store.NewID(),
		ParentID:   channelID,
		ParentType: ParentChannel,
		AuthorID:   "system",
		Body:       body,
		System:     true,
		CreatedAt:  time.Now(),
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
	if msg, ok := data.(*model.Message); ok && msg != nil {
		cp := *msg
		cp.ParentType = parentType
		// Make sure every broadcast frame carries the rendered hast
		// — the message-edited / message-new events ship the full
		// model.Message and recipients shouldn't have to parse on
		// receipt.
		s.attachRendered(&cp)
		data = &cp
	}
	events.Publish(ctx, s.publisher, channel, eventType, data)
}
