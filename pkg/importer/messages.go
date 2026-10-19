package importer

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/oklog/ulid/v2"
)

// Parent types.
const (
	ParentChannel      = "channel"
	ParentConversation = "conversation"
)

// SystemAuthorID and WebhookAuthorID are the author sentinels ex uses for
// system notices (join/leave) and incoming-webhook posts. Neither is a user:
// they never follow threads or keep read state.
const (
	SystemAuthorID  = "system"
	WebhookAuthorID = "webhook"
)

// MessageSpec describes one message. ID must be a ULID whose timestamp is
// CreatedAt (to the millisecond): ex orders messages by ID.
type MessageSpec struct {
	ID              string
	AuthorID        string
	Body            string
	CreatedAt       time.Time
	EditedAt        *time.Time
	ParentMessageID string // thread root, for replies
	AttachmentIDs   []string
	// Reactions maps an emoji key (unicode or ":shortcode:") to user IDs.
	Reactions map[string][]string
	Pinned    bool
	PinnedAt  *time.Time
	PinnedBy  string
	// System marks a system notice (AuthorID should be SystemAuthorID).
	System             bool
	WebhookUsername    string
	WebhookAvatarURL   string
	WebhookIconEmoji   string
	MessageAttachments []model.MessageAttachment
}

// PutResult summarizes a PutMessages call.
type PutResult struct {
	Inserted int
	Existing int
	// TopLevelInserted counts inserted top-level, non-system messages — the
	// number FinalizeParent adds to the unread counters.
	TopLevelInserted int
	// ThreadRootIDs lists the roots that received inserted replies.
	ThreadRootIDs []string
	// LastCreatedAt is the newest inserted message's time (zero if none).
	LastCreatedAt time.Time
}

// validateMessage checks one spec against ex's message rules.
func validateMessage(m MessageSpec) error {
	id, err := ulid.ParseStrict(m.ID)
	if err != nil {
		return invalid("message ID %q is not a ULID", m.ID)
	}
	if int64(id.Time()) != m.CreatedAt.UnixMilli() {
		return invalid("message %s: ID time %d does not match createdAt %d", m.ID, id.Time(), m.CreatedAt.UnixMilli())
	}
	if m.AuthorID == "" {
		return invalid("message %s has no author", m.ID)
	}
	if err := limits.ValidateMessageBody(m.Body); err != nil {
		return invalid("message %s: %v", m.ID, err)
	}
	if err := limits.ValidateAttachmentCount(len(m.AttachmentIDs)); err != nil {
		return invalid("message %s: %v", m.ID, err)
	}
	if m.ParentMessageID == m.ID {
		return invalid("message %s replies to itself", m.ID)
	}
	return nil
}

func validParentType(parentType string) error {
	if parentType != ParentChannel && parentType != ParentConversation {
		return invalid("parent type %q", parentType)
	}
	return nil
}

// PutMessages inserts the messages that don't exist yet into a parent.
// Messages already present (by ID) are skipped untouched — use UpdateMessage
// or TombstoneMessage to change them. For each inserted message the thread
// index, attachment references, the parent's file index and pin index are
// written before the message row, so a crash midway leaves nothing a re-run
// won't complete. Every spec is validated before anything is written.
func (im *Importer) PutMessages(ctx context.Context, parentID, parentType string, specs []MessageSpec) (PutResult, error) {
	var res PutResult
	if err := validParentType(parentType); err != nil {
		return res, err
	}
	if parentID == "" {
		return res, invalid("parent ID is required")
	}
	ids := make([]string, 0, len(specs))
	seen := make(map[string]bool, len(specs))
	for _, m := range specs {
		if err := validateMessage(m); err != nil {
			return res, err
		}
		if !seen[m.ID] { // BatchGetItem rejects duplicate keys
			seen[m.ID] = true
			ids = append(ids, m.ID)
		}
	}
	existing, err := im.messages.GetMessagesByIDs(ctx, parentID, ids)
	if err != nil {
		return res, fmt.Errorf("importer: get messages: %w", err)
	}
	have := make(map[string]bool, len(existing))
	for _, m := range existing {
		have[m.ID] = true
	}
	roots := map[string]bool{}
	for _, spec := range specs {
		if have[spec.ID] {
			res.Existing++
			continue
		}
		have[spec.ID] = true // duplicates within one call
		msg := toMessage(parentID, spec)
		if err := im.writeIndexes(ctx, msg); err != nil {
			return res, err
		}
		if err := im.messages.CreateMessage(ctx, msg); err != nil {
			if errors.Is(err, store.ErrAlreadyExists) {
				res.Existing++
				continue
			}
			return res, fmt.Errorf("importer: create message %s: %w", spec.ID, err)
		}
		res.Inserted++
		if msg.ParentMessageID == "" && !msg.System {
			res.TopLevelInserted++
		}
		if msg.ParentMessageID != "" && !roots[msg.ParentMessageID] {
			roots[msg.ParentMessageID] = true
			res.ThreadRootIDs = append(res.ThreadRootIDs, msg.ParentMessageID)
		}
		if msg.CreatedAt.After(res.LastCreatedAt) {
			res.LastCreatedAt = msg.CreatedAt
		}
	}
	return res, nil
}

func toMessage(parentID string, s MessageSpec) *model.Message {
	m := &model.Message{
		ID:                 s.ID,
		ParentID:           parentID,
		AuthorID:           s.AuthorID,
		Body:               s.Body,
		System:             s.System,
		ParentMessageID:    s.ParentMessageID,
		AttachmentIDs:      s.AttachmentIDs,
		Reactions:          s.Reactions,
		EditedAt:           s.EditedAt,
		WebhookUsername:    s.WebhookUsername,
		WebhookAvatarURL:   s.WebhookAvatarURL,
		WebhookIconEmoji:   s.WebhookIconEmoji,
		MessageAttachments: s.MessageAttachments,
		CreatedAt:          s.CreatedAt,
	}
	if s.Pinned {
		m.Pinned = true
		m.PinnedBy = s.PinnedBy
		m.PinnedAt = s.PinnedAt
		if m.PinnedAt == nil {
			at := s.CreatedAt
			m.PinnedAt = &at
		}
	}
	return m
}

// writeIndexes writes the rows that hang off a message: attachment
// references, the parent's file index and the pin index. All are idempotent.
func (im *Importer) writeIndexes(ctx context.Context, m *model.Message) error {
	for _, aid := range m.AttachmentIDs {
		if err := im.attachments.AddRef(ctx, aid, m.ID); err != nil {
			return fmt.Errorf("importer: attachment %s of message %s: %w", aid, m.ID, err)
		}
		if err := im.parentIndex.SetFileIndex(ctx, m.ParentID, aid, m.ID, m.AuthorID, m.CreatedAt); err != nil {
			return fmt.Errorf("importer: file index: %w", err)
		}
	}
	if m.Pinned {
		if err := im.parentIndex.SetPinIndex(ctx, m.ParentID, m.ID, m.PinnedBy, *m.PinnedAt); err != nil {
			return fmt.Errorf("importer: pin index: %w", err)
		}
	}
	return nil
}

// MessagePatch lists the fields an incremental re-sync may change. Nil fields
// are left as they are.
type MessagePatch struct {
	Body     *string
	EditedAt *time.Time
	// Reactions, when non-nil, replaces the whole reaction map.
	Reactions map[string][]string
	Pinned    *bool
	PinnedBy  string
	PinnedAt  *time.Time
}

// ErrMessageDeleted is returned when patching a tombstoned message.
var ErrMessageDeleted = errors.New("importer: message is deleted")

// UpdateMessage applies a patch to an existing message, keeping the pin index
// in step. Returns store.ErrNotFound (wrapped) for an unknown message.
func (im *Importer) UpdateMessage(ctx context.Context, parentID, msgID string, p MessagePatch) error {
	m, err := im.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return fmt.Errorf("importer: get message: %w", err)
	}
	if m.Deleted {
		return ErrMessageDeleted
	}
	if p.Body != nil {
		if err := limits.ValidateMessageBody(*p.Body); err != nil {
			return invalid("message %s: %v", msgID, err)
		}
		m.Body = *p.Body
	}
	if p.EditedAt != nil {
		m.EditedAt = p.EditedAt
	}
	if p.Reactions != nil {
		m.Reactions = p.Reactions
	}
	if p.Pinned != nil && *p.Pinned != m.Pinned {
		if *p.Pinned {
			at := time.Now()
			if p.PinnedAt != nil {
				at = *p.PinnedAt
			}
			m.Pinned, m.PinnedBy, m.PinnedAt = true, p.PinnedBy, &at
			if err := im.parentIndex.SetPinIndex(ctx, parentID, msgID, m.PinnedBy, at); err != nil {
				return fmt.Errorf("importer: pin index: %w", err)
			}
		} else {
			m.Pinned, m.PinnedBy, m.PinnedAt = false, "", nil
			if err := im.parentIndex.DeletePinIndex(ctx, parentID, msgID); err != nil {
				return fmt.Errorf("importer: pin index: %w", err)
			}
		}
	}
	if err := im.messages.UpdateMessage(ctx, m); err != nil {
		return fmt.Errorf("importer: update message: %w", err)
	}
	return nil
}

// TombstoneMessage soft-deletes a message the way ex does (the row stays so
// threads keep their shape; body, attachments, reactions and pin are
// cleared), drops its attachment references, file and pin index rows, and
// removes it from search. Already-deleted or unknown messages are a no-op.
func (im *Importer) TombstoneMessage(ctx context.Context, parentID, msgID string) error {
	m, err := im.messages.GetMessage(ctx, parentID, msgID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("importer: get message: %w", err)
	}
	if m.Deleted {
		return nil
	}
	for _, aid := range m.AttachmentIDs {
		if _, err := im.attachments.RemoveRef(ctx, aid, msgID); err != nil {
			return fmt.Errorf("importer: attachment %s: %w", aid, err)
		}
		if err := im.parentIndex.DeleteFileIndex(ctx, parentID, aid); err != nil {
			return fmt.Errorf("importer: file index: %w", err)
		}
	}
	if m.Pinned {
		if err := im.parentIndex.DeletePinIndex(ctx, parentID, msgID); err != nil {
			return fmt.Errorf("importer: pin index: %w", err)
		}
	}
	m.Tombstone()
	if err := im.messages.UpdateMessage(ctx, m); err != nil {
		return fmt.Errorf("importer: tombstone message: %w", err)
	}
	if im.search != nil {
		if err := im.search.DeleteDoc(ctx, search.IndexMessages, msgID); err != nil {
			return fmt.Errorf("importer: unindex message: %w", err)
		}
	}
	return nil
}
