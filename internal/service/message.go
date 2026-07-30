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
	"github.com/DigitalTolk/ex/internal/safe"
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
//
// Test-double policy: stateful fakes (in-memory maps mimicking store
// semantics) stay hand-written in mocks_test.go; purely mechanical stubs —
// a programmable func + call recording, like this one — are generated with
// moq (`go generate ./internal/service/`).
//
//go:generate go tool moq -out activator_moq_test.go -stub . ConversationActivator
type ConversationActivator interface {
	Activate(ctx context.Context, convID string) error
}

// UnreadSeqStore drives the per-parent unread counter shared by channels and
// conversations: a monotonic message seq on the parent, plus a per-user
// last-read stamp. unread = parent.MessageSeq - member.LastReadSeq. Adapters
// bind the underlying stores (for channels the two operations live on different
// stores; for conversations both live on the conversation store). Optional
// dependency — when unset (e.g. a narrow unit test) the bump is simply skipped.
type UnreadSeqStore interface {
	IncrementMessageSeq(ctx context.Context, parentID string) (int64, error)
	SetLastRead(ctx context.Context, parentID, userID string, seq int64) error
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
// can stub it without instantiating the real notifier. threadRoot is the
// authoritative root returned by IncrementReplyMetadata for a thread reply
// (nil otherwise, or when the bump failed) — the notifier derives the
// thread.updated fan-out from it alongside the notification decision, so
// the two audiences share one snapshot and can't drift.
type MessageNotifier interface {
	NotifyForMessage(ctx context.Context, msg *model.Message, parentType string, threadRoot *model.Message)
}

// WebhookAuthorID is the sentinel author stamped on incoming-webhook posts.
// It is not a real user: it has no membership rows and no read state, so
// per-user bookkeeping (e.g. the author last-read mark) must skip it.
const WebhookAuthorID = "webhook"

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
	attachments   AttachmentRefManager
	notifier      MessageNotifier
	indexer       MessageIndexer
	threadFollows ThreadFollowStore
	userState     UserStateStore
	parentIndex   ParentPinFileIndexStore
	markdown      *MarkdownRenderer
	channelSeq    UnreadSeqStore
	convSeq       UnreadSeqStore
	reactions     ReactionActivityRecorder
	bots          []registeredBot
	botDir        BotDirectory
}

// ReactionActivityRecorder records "someone reacted to your message" hints into
// the message author's activity stream. Implemented by ActivityService; wired
// optionally so the message service degrades gracefully when activity is off.
type ReactionActivityRecorder interface {
	RecordReaction(ctx context.Context, msg *model.Message, parentType, actorID, emoji string)
}

// MessageServiceDeps declares the full dependency surface of MessageService
// in one place, splitting hard requirements from optional capabilities. The
// production wiring (cmd/server) constructs through this so a half-wired
// service can't escape into the router; tests use NewMessageService with just
// the core five and opt into extras via the Set* methods.
type MessageServiceDeps struct {
	// Required core.
	Messages      MessageStore
	Memberships   MembershipStore
	Conversations ConversationStore
	Publisher     Publisher
	Broker        Broker

	// Required in production, optional in tests.
	ChannelSeq      UnreadSeqStore
	ConversationSeq UnreadSeqStore
	ThreadFollows   ThreadFollowStore
	UserState       UserStateStore
	ParentIndex     ParentPinFileIndexStore
	Markdown        *MarkdownRenderer
	Activator       ConversationActivator

	// Optional capabilities (nil degrades gracefully). AttachmentManager is
	// NOT here: attachments and messages reference each other, so that edge
	// is late-bound via SetAttachmentManager after both exist.
	Notifier  MessageNotifier
	Indexer   MessageIndexer
	Reactions ReactionActivityRecorder
}

// NewMessageServiceFromDeps constructs a fully-wired MessageService.
func NewMessageServiceFromDeps(d MessageServiceDeps) *MessageService {
	return &MessageService{
		messages:      d.Messages,
		memberships:   d.Memberships,
		conversations: d.Conversations,
		publisher:     d.Publisher,
		broker:        d.Broker,
		channelSeq:    d.ChannelSeq,
		convSeq:       d.ConversationSeq,
		threadFollows: d.ThreadFollows,
		userState:     d.UserState,
		parentIndex:   d.ParentIndex,
		markdown:      d.Markdown,
		activator:     d.Activator,
		notifier:      d.Notifier,
		indexer:       d.Indexer,
		reactions:     d.Reactions,
	}
}

// NewMessageService creates a MessageService from the required core five —
// the test-oriented constructor; optional capabilities attach via Set*.
func NewMessageService(
	messages MessageStore,
	memberships MembershipStore,
	conversations ConversationStore,
	publisher Publisher,
	broker Broker,
) *MessageService {
	return NewMessageServiceFromDeps(MessageServiceDeps{
		Messages:      messages,
		Memberships:   memberships,
		Conversations: conversations,
		Publisher:     publisher,
		Broker:        broker,
	})
}

// SetActivator wires the conversation activator. Called from main wiring after
// both services are constructed to avoid a constructor cycle.
func (s *MessageService) SetActivator(a ConversationActivator) { s.activator = a }

// SetConversationSeqStore wires the conversation message-counter (the same
// seq-based unread mechanism channels use). Optional — left unset, conversation
// unread isn't persisted.
func (s *MessageService) SetConversationSeqStore(c UnreadSeqStore) { s.convSeq = c }

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

// SetChannelSeqStore wires the channel message-counter used for server-side
// unread tracking. Optional — left unset, channel unread isn't persisted.
func (s *MessageService) SetChannelSeqStore(c UnreadSeqStore) { s.channelSeq = c }

// SetReactionRecorder wires the activity recorder used to log reaction hints.
func (s *MessageService) SetReactionRecorder(r ReactionActivityRecorder) { s.reactions = r }

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
	ids, err := s.MessageAttachmentIDs(ctx, userID, parentID, parentType, messageID)
	if err != nil {
		return err
	}
	if !ids[attachmentID] {
		return fmt.Errorf("message: attachment is not referenced by message: %w", ErrForbidden)
	}
	return nil
}

// MessageAttachmentIDs returns the attachment-ID set referenced by messageID
// after verifying the caller's access to the parent — the batch form of
// CanAccessMessageAttachment: one membership read + one message read cover a
// whole attachment batch instead of repeating both per attachment. An empty
// messageID is a definitive denial (attachment reads are always anchored to a
// message; the old un-anchored fallback scanned up to 1000 messages and was
// unreachable from any caller).
func (s *MessageService) MessageAttachmentIDs(ctx context.Context, userID, parentID, parentType, messageID string) (map[string]bool, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	if messageID == "" {
		return nil, fmt.Errorf("message: attachment access requires a message: %w", ErrForbidden)
	}
	msg, err := s.messages.GetMessage(ctx, parentID, messageID)
	if err != nil {
		return nil, fmt.Errorf("message: get attachment owner message: %w", err)
	}
	out := make(map[string]bool, len(msg.AttachmentIDs))
	for _, id := range msg.AttachmentIDs {
		out[id] = true
	}
	return out, nil
}

// detachedTimeout bounds best-effort work that runs off the request path with a
// cancellation-free context. Without it a hung DynamoDB/OpenSearch could pin the
// goroutine indefinitely (the AWS SDK has no default per-call deadline), and
// under load those goroutines accumulate without bound.
const detachedTimeout = 30 * time.Second

// detachedContext returns a cancellation-free copy of ctx (so the work survives
// the request ending) but with a finite deadline so it can't hang forever.
func detachedContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return detachedContextTimeout(ctx, detachedTimeout)
}

// detachedContextTimeout is detachedContext with a caller-chosen deadline (e.g. a
// bot turn needs longer than the default bookkeeping timeout).
func detachedContextTimeout(ctx context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), d)
}

// indexMessage / deleteFromIndex dispatch on a detached goroutine so a
// slow OpenSearch never adds to user-perceived send latency. Failures
// are logged; the admin reindex is the recovery path.
func (s *MessageService) indexMessage(ctx context.Context, m *model.Message, parentType string) {
	if s.indexer == nil || m == nil {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		if err := s.indexer.IndexMessage(bg, m, parentType); err != nil {
			slog.Warn("search index message failed", "id", m.ID, "error", err)
		}
	})
}

// notify dispatches user-facing notifications off the send path. Like
// indexMessage it runs in a detached goroutine with a cancellation-free context:
// the recipient fan-out (member read + per-recipient prefs + mobile push) is
// best-effort and must never add to the sender's request latency, nor can a
// notify failure affect the already-committed message or its event publish.
func (s *MessageService) notify(ctx context.Context, msg *model.Message, parentType string, threadRoot *model.Message) {
	if s.notifier == nil || msg == nil {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		s.notifier.NotifyForMessage(bg, msg, parentType, threadRoot)
	})
}

// bumpUnreadSeq advances a parent's unread counter for a new top-level message
// and marks the author caught up (posting reads the parent for you, so your own
// message never shows as unread to you). The same mechanism serves channels and
// conversations — only the store differs. Like notify and indexMessage it runs
// detached with a cancellation-free context: the two row writes are best-effort
// unread bookkeeping that must never add to the sender's request latency, and
// the count only has to be durable before the recipient reloads — not before
// the send returns. No-op when the seq store isn't wired.
func (s *MessageService) bumpUnreadSeq(ctx context.Context, store UnreadSeqStore, parentID, authorID string) {
	if store == nil {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		s.writeUnreadSeq(bg, store, parentID, authorID)
	})
}

// writeUnreadSeq is the synchronous core of bumpUnreadSeq, split out so it can
// be unit-tested without racing the detached goroutine. O(1) — two row writes
// regardless of member count, unlike a per-member fan-out.
func (s *MessageService) writeUnreadSeq(ctx context.Context, store UnreadSeqStore, parentID, authorID string) {
	seq, err := store.IncrementMessageSeq(ctx, parentID)
	if err != nil {
		slog.Warn("unread seq increment failed", "parentID", parentID, "error", err)
		return
	}
	// The webhook sentinel and bots are not channel members and keep no read
	// state — marking them read can only fail ("store: item not found" WARN on
	// every post). Recipients' unread still bumps via the seq increment above.
	// (Bots have no unread UI, so skipping their own last-read is harmless.)
	if authorID == WebhookAuthorID || model.IsBotUserID(authorID) {
		return
	}
	if err := store.SetLastRead(ctx, parentID, authorID, seq); err != nil {
		slog.Warn("author last-read mark failed", "parentID", parentID, "userID", authorID, "error", err)
	}
}

func (s *MessageService) deleteFromIndex(ctx context.Context, id string) {
	if s.indexer == nil {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		if err := s.indexer.DeleteMessage(bg, id); err != nil {
			slog.Warn("search delete message failed", "id", id, "error", err)
		}
	})
}

// Send creates a new message in the given parent (channel or conversation).
// If parentMessageID is non-empty, the message is a thread reply: the root
// message's ReplyCount is incremented and a message.edited event is published
// for the root so the UI updates the count.
//
// Attachments are bound by ID after the message row is persisted so dangling
// refs are impossible.
func (s *MessageService) Send(ctx context.Context, userID, parentID, parentType, body, parentMessageID string, attachmentIDs ...string) (*model.Message, error) {
	return s.send(ctx, userID, parentID, parentType, body, parentMessageID, false, attachmentIDs...)
}

// SendNoIndex is Send for machine-posted ephemera (e.g. the /mstmeetings join
// link): the message behaves normally everywhere except the search index,
// which never sees it — live indexing and the admin reindex both honor the
// persisted NoIndex flag.
func (s *MessageService) SendNoIndex(ctx context.Context, userID, parentID, parentType, body, parentMessageID string, attachmentIDs ...string) (*model.Message, error) {
	return s.send(ctx, userID, parentID, parentType, body, parentMessageID, true, attachmentIDs...)
}

func (s *MessageService) send(ctx context.Context, userID, parentID, parentType, body, parentMessageID string, noIndex bool, attachmentIDs ...string) (*model.Message, error) {
	// For conversations the access check already loads the conversation row —
	// keep it so the activity block below doesn't re-read the same entity.
	var sendConv *model.Conversation
	if parentType == ParentConversation {
		conv, err := s.conversationAccess(ctx, userID, parentID)
		if err != nil {
			return nil, err
		}
		sendConv = conv
	} else if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
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
		NoIndex:         noIndex,
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

	// Conversation activity: only a top-level message counts as new
	// conversation activity. A thread-only reply must NOT bump the unread
	// counter, re-touch/re-order the conversation, or fan out
	// userchannel.updated — otherwise the DM lights up as if a fresh top-level
	// message arrived. Thread replies still reach participants via message.new
	// (conversation topic) and notification.new (thread participants). This
	// mirrors the channel rule below and the frontend gate in onMessageNew.
	if parentType == ParentConversation && parentMessageID == "" {
		if conv := sendConv; conv != nil {
			// Unread is tracked with the same per-parent seq counter channels use
			// — one increment + the author's last-read, instead of a Redis write
			// per recipient. The author is marked caught up so their own message
			// never shows as unread to them.
			s.bumpUnreadSeq(ctx, s.convSeq, parentID, userID)
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
			if s.activator != nil {
				if err := s.activator.Activate(ctx, parentID); err != nil {
					slog.Warn("conversation activate failed", "convID", parentID, "error", err)
				}
			}
		}
	}

	// Channel unread: only a top-level human message bumps the channel's
	// unread counter (thread replies surface via thread notifications; system
	// join/leave events aren't "new activity"). Mirrors the conversation rule
	// above and the frontend rule in onMessageNew so live and persisted counts agree.
	if parentType == ParentChannel && parentMessageID == "" && !msg.System {
		s.bumpUnreadSeq(ctx, s.channelSeq, parentID, userID)
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
		} else {
			// The reply is saved but the root's replyCount/lastReplyAt didn't
			// advance, so the thread shows a stale count until the next refetch.
			// Log it rather than dropping the error silently.
			slog.Warn("thread reply metadata increment failed", "rootID", parentMessageID, "replyID", msg.ID, "error", err)
		}
		// Record write-time participation (reply author + root author) so
		// /threads reads the index instead of scanning message history. Same
		// before-message.new ordering rationale as the mention follows above.
		s.recordThreadParticipation(ctx, msg, parentType, updatedThreadRoot)
	}

	s.publishEvent(ctx, parentID, parentType, events.EventMessageNew, msg)

	// Fire user-facing notifications (sound + popup) to recipients who
	// haven't muted the parent, and — for a thread reply with a fresh root —
	// the participant-scoped thread.updated fan-out that live-patches each
	// /threads list. Decoupled from event publishing (and run off the send
	// path) so failure or latency here never affects state propagation.
	s.notify(ctx, msg, parentType, updatedThreadRoot)

	s.indexMessage(ctx, msg, parentType)

	// If the message @mentions a registered bot (or continues a bot's thread),
	// dispatch it off the send path. Fully detached — never adds latency.
	s.maybeDispatchToBots(ctx, msg, parentType)

	// Thread reply: republish the authoritative parent so subscribers see
	// the new replyCount / avatar stack without a re-fetch. The metadata
	// itself was already persisted before message.new to keep /threads
	// refetches from racing old state. (The participant-scoped thread.updated
	// fan-out rides with notify() above — the notifier computes its audience
	// from the same snapshot as the notification decision.)
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
	// ParentMessageID (optional) threads the post as a reply under that root —
	// used by in-chat Cliffy so a back-and-forth stays in one thread. External
	// webhooks leave it empty (always top-level).
	ParentMessageID string
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
		authorID = WebhookAuthorID
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
	// A threaded post (Cliffy replying in a thread) must reference a live root.
	if in.ParentMessageID != "" {
		root, err := s.messages.GetMessage(ctx, parentID, in.ParentMessageID)
		if err != nil {
			return nil, fmt.Errorf("message: thread root: %w", err)
		}
		if root.Deleted {
			return nil, ErrThreadDeleted
		}
	}
	msg := &model.Message{
		ID:                 store.NewID(),
		ParentID:           parentID,
		AuthorID:           authorID,
		Body:               in.Body,
		ParentMessageID:    in.ParentMessageID,
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
	// Only a top-level post is new conversation/channel activity; a thread reply
	// updates its root's metadata instead (mirrors Send).
	var updatedThreadRoot *model.Message
	if in.ParentMessageID == "" {
		switch parentType {
		case ParentChannel:
			s.bumpUnreadSeq(ctx, s.channelSeq, parentID, authorID)
		case ParentConversation:
			s.bumpUnreadSeq(ctx, s.convSeq, parentID, authorID)
		}
	} else {
		if updated, err := s.messages.IncrementReplyMetadata(ctx, parentID, in.ParentMessageID, msg.CreatedAt, authorID); err == nil {
			updatedThreadRoot = updated
			s.recordThreadParticipation(ctx, msg, parentType, updated)
		} else {
			slog.Warn("webhook thread reply metadata increment failed", "rootID", in.ParentMessageID, "replyID", msg.ID, "error", err)
		}
	}
	s.publishEvent(ctx, parentID, parentType, events.EventMessageNew, msg)
	s.notify(ctx, msg, parentType, updatedThreadRoot)
	s.indexMessage(ctx, msg, parentType)
	if updatedThreadRoot != nil {
		s.publishEvent(ctx, parentID, parentType, events.EventMessageEdited, updatedThreadRoot)
	}
	return msg, nil
}

// SendBotCard posts a bot-authored card into a channel or conversation on a
// user's behalf — e.g. the "share to conversation" action, so both participants
// see something a bot created. It first verifies the REQUESTING user may post to
// the scope (so a user can't make a bot speak into a conversation they aren't
// in), then posts under the given bot identity. Generic: the caller supplies the
// bot's author id / display name / icon — this service holds no bot branding.
func (s *MessageService) SendBotCard(
	ctx context.Context,
	requestUserID, authorID, username, iconEmoji, parentID, parentType, parentMessageID, body string,
	attachments []model.MessageAttachment,
) (*model.Message, error) {
	if requestUserID == "" {
		return nil, fmt.Errorf("message: requester required: %w", ErrForbidden)
	}
	if err := s.checkAccess(ctx, requestUserID, parentID, parentType); err != nil {
		return nil, err
	}
	return s.SendWebhook(ctx, WebhookMessageInput{
		ParentID:        parentID,
		ParentType:      parentType,
		ParentMessageID: parentMessageID,
		AuthorID:        authorID,
		Body:            body,
		Username:        username,
		IconEmoji:       iconEmoji,
		Attachments:     attachments,
	})
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
		// ParseMentions already de-duplicates users, so no dup-check here.
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
	// Fallback: if the GSI returns fewer replies than the root records, some
	// replies aren't indexed — either the thread predates the backfill, or it's
	// partially migrated (old replies unindexed + newer ones indexed). Scan the
	// parent so historical threads stay complete until the migration runs.
	// (Tombstoned replies keep their index key, so a fully-indexed thread has
	// len(replies) >= ReplyCount and never trips this.) The transient case where
	// the very latest reply lags the GSI also scans here — correct, just slower
	// for that sub-second window; already-open clients got it over the WebSocket.
	if root != nil && len(replies) < root.ReplyCount {
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

// threadParticipationIndex is the optional write-time /threads index the
// follow store exposes (adapter-backed by conditional puts + a per-user seed
// marker). Asserted so plain test stores keep the legacy scan behavior.
type threadParticipationIndex interface {
	SetThreadFollowIfAbsent(ctx context.Context, follow *model.ThreadFollow) error
	IsThreadIndexSeeded(ctx context.Context, userID string) (bool, error)
	MarkThreadIndexSeeded(ctx context.Context, userID string) error
}

// recordThreadParticipation keeps the /threads index warm at write time: a
// reply makes both its author and the thread's root author participants, so
// their /threads lists no longer need to rediscover that by scanning message
// history. Conditional writes — a deliberate unfollow is never clobbered by
// an implicit re-follow. Best-effort: a failed write is logged and the lazy
// seed path remains the safety net for pre-index history.
func (s *MessageService) recordThreadParticipation(ctx context.Context, msg *model.Message, parentType string, root *model.Message) {
	idx, ok := s.threadFollows.(threadParticipationIndex)
	if !ok || msg == nil || msg.ParentMessageID == "" {
		return
	}
	now := time.Now()
	ids := []string{msg.AuthorID}
	if root != nil && root.AuthorID != "" && root.AuthorID != msg.AuthorID {
		ids = append(ids, root.AuthorID)
	}
	for _, uid := range ids {
		if uid == "" {
			continue
		}
		follow := &model.ThreadFollow{
			UserID:       uid,
			ParentID:     msg.ParentID,
			ParentType:   parentType,
			ThreadRootID: msg.ParentMessageID,
			Following:    true,
			UpdatedAt:    now,
		}
		if err := idx.SetThreadFollowIfAbsent(ctx, follow); err != nil {
			slog.Warn("thread participation record failed", "userID", uid, "rootID", msg.ParentMessageID, "error", err)
		}
	}
}

// ListUserThreads returns thread summaries for every thread the given user has
// participated in (authored the root or any reply). Sorted by latest activity,
// newest first.
//
// Fast path: participation lives in follow rows maintained at WRITE time
// (replies, mentions, explicit follows), so the list is a handful of user-
// partition queries plus one batched root read per parent — instead of the
// legacy path below, which re-scans recent messages of EVERY channel and
// conversation the user belongs to (the 70+ DynamoDB queries per request
// Datadog flagged). The legacy scan still runs ONCE per user to seed the
// index with pre-index history, then marks the user seeded.
func (s *MessageService) ListUserThreads(ctx context.Context, userID string) ([]*ThreadSummary, error) {
	type parentRef struct {
		id  string
		typ string
	}
	parents := make([]parentRef, 0, 32)
	parentTypes := make(map[string]string, 32)

	if s.memberships != nil {
		channels, err := s.memberships.ListUserChannels(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("threads: list channels: %w", err)
		}
		for _, c := range channels {
			parents = append(parents, parentRef{id: c.ChannelID, typ: ParentChannel})
			parentTypes[c.ChannelID] = ParentChannel
		}
	}
	if s.conversations != nil {
		convs, err := s.conversations.ListUserConversations(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("threads: list conversations: %w", err)
		}
		for _, c := range convs {
			parents = append(parents, parentRef{id: c.ConversationID, typ: ParentConversation})
			parentTypes[c.ConversationID] = ParentConversation
		}
	}

	out := make([]*ThreadSummary, 0)
	seen := make(map[string]bool)
	var follows []*model.ThreadFollow
	followOverrides := make(map[string]bool)
	notificationThreads := make(map[string]bool)
	if s.threadFollows != nil {
		fs, err := s.threadFollows.ListUserThreadFollows(ctx, userID)
		if err != nil {
			return nil, fmt.Errorf("threads: list follows: %w", err)
		}
		follows = fs
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

	// Fast path: this user's participation is fully indexed — serve from the
	// follow rows + notification pulls and batch-read only the root messages.
	if idx, ok := s.threadFollows.(threadParticipationIndex); ok {
		if seeded, err := idx.IsThreadIndexSeeded(ctx, userID); err == nil && seeded {
			return s.listUserThreadsFromIndex(ctx, parentTypes, follows, notificationThreads)
		}
	}

	// Fetch each parent's messages concurrently (bounded to 8 in flight) — the
	// per-parent scans are the dominant, independent I/O cost. The in-memory
	// aggregation below stays serial (it mutates shared maps), so only the scans
	// are parallelized.
	parentMsgs := make([][]*model.Message, len(parents))
	{
		sem := make(chan struct{}, 8)
		var wg sync.WaitGroup
		for i, p := range parents {
			wg.Add(1)
			sem <- struct{}{}
			go func(i int, id string) {
				defer wg.Done()
				defer safe.Recover()
				defer func() { <-sem }()
				if msgs, err := s.scanParentMessages(ctx, id); err == nil {
					parentMsgs[i] = msgs
				}
			}(i, p.id)
		}
		wg.Wait()
	}

	for i, p := range parents {
		msgs := parentMsgs[i]
		if msgs == nil {
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
	// One-time backfill: persist the scan-derived participation so every
	// subsequent /threads request takes the index path above.
	s.seedThreadIndex(ctx, userID, out, followOverrides)
	return out, nil
}

// batchMessageStore is the optional batched-read capability of the message
// store (one parent, many IDs). Asserted with a per-ID fallback.
type batchMessageStore interface {
	GetMessagesByIDs(ctx context.Context, parentID string, ids []string) ([]*model.Message, error)
}

// listUserThreadsFromIndex builds summaries from the write-time participation
// index: follows (explicit and implicit) plus notification-pulled threads,
// scoped to parents the user can still access, with the root messages batch-
// read per parent. The root row carries everything a summary needs
// (ReplyCount, LastReplyAt) because IncrementReplyMetadata maintains it.
func (s *MessageService) listUserThreadsFromIndex(ctx context.Context, parentTypes map[string]string, follows []*model.ThreadFollow, notificationThreads map[string]bool) ([]*ThreadSummary, error) {
	roots := make(map[string]map[string]bool) // parentID → thread root IDs
	add := func(parentID, rootID string) {
		if parentTypes[parentID] == "" || rootID == "" {
			return
		}
		if roots[parentID] == nil {
			roots[parentID] = make(map[string]bool)
		}
		roots[parentID][rootID] = true
	}
	for _, f := range follows {
		if f.Following {
			add(f.ParentID, f.ThreadRootID)
		}
	}
	// Notification pulls surface a thread even when unfollowed — same
	// precedence as the legacy scan.
	for key := range notificationThreads {
		if parentID, rootID, ok := strings.Cut(key, "#"); ok {
			add(parentID, rootID)
		}
	}

	out := make([]*ThreadSummary, 0)
	for parentID, set := range roots {
		ids := make([]string, 0, len(set))
		for id := range set {
			ids = append(ids, id)
		}
		var msgs []*model.Message
		if bs, ok := s.messages.(batchMessageStore); ok {
			m, err := bs.GetMessagesByIDs(ctx, parentID, ids)
			if err != nil {
				return nil, fmt.Errorf("threads: batch roots: %w", err)
			}
			msgs = m
		} else {
			for _, id := range ids {
				if m, err := s.messages.GetMessage(ctx, parentID, id); err == nil {
					msgs = append(msgs, m)
				}
			}
		}
		for _, root := range msgs {
			latest := root.CreatedAt
			if root.LastReplyAt != nil && root.LastReplyAt.After(latest) {
				latest = *root.LastReplyAt
			}
			out = append(out, &ThreadSummary{
				ParentID:         parentID,
				ParentType:       parentTypes[parentID],
				ThreadRootID:     root.ID,
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

// seedThreadIndex backfills the write-time index from the scan-derived
// summaries ONCE per user, then marks them seeded so subsequent /threads
// requests skip the scan. Rows are filtered against explicit follow records
// (a deliberate unfollow survives the backfill), which makes the remainder
// safe for a blind batched write. Best-effort: a failed seed just means the
// next request scans (and retries) again.
func (s *MessageService) seedThreadIndex(ctx context.Context, userID string, summaries []*ThreadSummary, followOverrides map[string]bool) {
	idx, ok := s.threadFollows.(threadParticipationIndex)
	if !ok {
		return
	}
	now := time.Now()
	rows := make([]*model.ThreadFollow, 0, len(summaries))
	for _, sum := range summaries {
		if _, has := followOverrides[threadFollowKey(sum.ParentID, sum.ThreadRootID)]; has {
			continue
		}
		rows = append(rows, &model.ThreadFollow{
			UserID:       userID,
			ParentID:     sum.ParentID,
			ParentType:   sum.ParentType,
			ThreadRootID: sum.ThreadRootID,
			Following:    true,
			UpdatedAt:    now,
		})
	}
	if len(rows) > 0 {
		if err := s.threadFollows.SetThreadFollowMany(ctx, rows); err != nil {
			slog.Warn("thread index seed failed", "userID", userID, "rows", len(rows), "error", err)
			return // not marked seeded — the next request retries
		}
	}
	if err := idx.MarkThreadIndexSeeded(ctx, userID); err != nil {
		slog.Warn("thread index seed marker failed", "userID", userID, "error", err)
	}
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
	// Resolve the pinned messages in ONE batched read rather than a GetItem
	// per pin (a channel can have dozens). Results are kept index-aligned so
	// the pin order from the index is preserved; stale rows are cleaned up
	// after. Falls back to the bounded fan-out when the store can't batch.
	resolved := make([]*model.Message, len(rows))
	stale := make([]bool, len(rows))
	if bs, ok := s.messages.(batchMessageStore); ok {
		ids := make([]string, len(rows))
		for i, row := range rows {
			ids[i] = row.MessageID
		}
		msgs, err := bs.GetMessagesByIDs(ctx, parentID, ids)
		if err != nil {
			return nil, fmt.Errorf("message: batch get pinned: %w", err)
		}
		byID := make(map[string]*model.Message, len(msgs))
		for _, m := range msgs {
			byID[m.ID] = m
		}
		for i, row := range rows {
			msg := byID[row.MessageID]
			switch {
			case msg == nil:
				// A row that no longer resolves to a message (deletion-cleanup
				// race) is a soft inconsistency — drop it and clean up below.
				stale[i] = true
			case !msg.Pinned:
				// Index says pinned but the message says no — stale index row.
				stale[i] = true
			default:
				resolved[i] = msg
			}
		}
	} else {
		sem := make(chan struct{}, 16)
		var wg sync.WaitGroup
		for i, row := range rows {
			wg.Add(1)
			sem <- struct{}{}
			go func(i int, msgID string) {
				defer wg.Done()
				defer safe.Recover()
				defer func() { <-sem }()
				msg, err := s.messages.GetMessage(ctx, parentID, msgID)
				switch {
				case err != nil:
					stale[i] = true
				case !msg.Pinned:
					stale[i] = true
				default:
					resolved[i] = msg
				}
			}(i, row.MessageID)
		}
		wg.Wait()
	}

	pinned := make([]*model.Message, 0, len(rows))
	for i, row := range rows {
		if stale[i] {
			_ = s.parentIndex.DeletePinIndex(ctx, parentID, row.MessageID)
			continue
		}
		pinned = append(pinned, resolved[i])
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
		defer safe.Recover()
		target, errTarget = s.messages.GetMessage(ctx, parentID, msgID)
	}()
	go func() {
		defer wg.Done()
		defer safe.Recover()
		older, hasMoreOlder, errOlder = s.listTopLevel(ctx, parentID, msgID, before)
	}()
	go func() {
		defer wg.Done()
		defer safe.Recover()
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

	// Only validate attachments newly added by this edit. Files already on the
	// message were validated when first attached; re-validating them here would
	// pointlessly re-download + re-decode the object (and fail for non-image or
	// otherwise un-re-validatable attachments), which surfaced as a 403 on any
	// edit of a message that carries an attachment.
	if err := s.validateAttachmentsForUse(ctx, added); err != nil {
		return nil, err
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
	}
	added := idx < 0
	if added {
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
	// Only a freshly-ADDED reaction (not an un-react) is worth an activity hint;
	// the recorder itself drops self-reactions and bot messages.
	if added && s.reactions != nil {
		s.reactions.RecordReaction(ctx, msg, parentType, userID, emoji)
	}
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
// conversationAccess loads the conversation and verifies userID participates.
// Returned so callers that need the row (Send's activity block) reuse it
// instead of a second GetConversation for the same request.
func (s *MessageService) conversationAccess(ctx context.Context, userID, parentID string) (*model.Conversation, error) {
	conv, err := s.conversations.GetConversation(ctx, parentID)
	if err != nil {
		return nil, fmt.Errorf("message: get conversation: %w", err)
	}
	for _, id := range conv.ParticipantIDs {
		if id == userID {
			return conv, nil
		}
	}
	return nil, fmt.Errorf("message: not a conversation participant: %w", ErrForbidden)
}

func (s *MessageService) checkAccess(ctx context.Context, userID, parentID, parentType string) error {
	// Denials wrap ErrForbidden so callers can tell "you are not allowed"
	// (definitive — safe to filter/reject) apart from "the check could not
	// run" (transient store failure — must fail the request, never be
	// treated as a verdict).
	switch parentType {
	case ParentChannel:
		_, err := s.memberships.GetMembership(ctx, parentID, userID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return fmt.Errorf("message: not a channel member: %w", ErrForbidden)
			}
			return fmt.Errorf("message: check channel membership: %w", err)
		}
	case ParentConversation:
		if _, err := s.conversationAccess(ctx, userID, parentID); err != nil {
			return err
		}
	default:
		return fmt.Errorf("message: unknown parent type %q: %w", parentType, ErrForbidden)
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
			defer safe.Recover()
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
			defer safe.Recover()
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
