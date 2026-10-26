package importer

import (
	"context"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Read-side calls for validating an import and planning incremental
// re-syncs. They only read.

// Message is the current state of a stored message.
type Message struct {
	ID              string
	AuthorID        string
	Body            string
	CreatedAt       time.Time
	EditedAt        *time.Time
	Deleted         bool
	System          bool
	ParentMessageID string
	Reactions       map[string][]string
	Pinned          bool
	AttachmentIDs   []string
	ReplyCount      int
}

func fromModel(m *model.Message) Message {
	return Message{
		ID: m.ID, AuthorID: m.AuthorID, Body: m.Body, CreatedAt: m.CreatedAt, EditedAt: m.EditedAt,
		Deleted: m.Deleted, System: m.System, ParentMessageID: m.ParentMessageID, Reactions: m.Reactions,
		Pinned: m.Pinned, AttachmentIDs: m.AttachmentIDs, ReplyCount: m.ReplyCount,
	}
}

// GetMessages returns the given messages of one parent (batched reads).
// Missing IDs are absent from the result; order is not guaranteed.
func (im *Importer) GetMessages(ctx context.Context, parentID string, ids []string) ([]Message, error) {
	ms, err := im.messages.GetMessagesByIDs(ctx, parentID, dedupe(ids))
	if err != nil {
		return nil, fmt.Errorf("importer: get messages: %w", err)
	}
	out := make([]Message, len(ms))
	for i, m := range ms {
		out[i] = fromModel(m)
	}
	return out, nil
}

// ParentStats describes a channel or conversation as stored.
type ParentStats struct {
	TopLevel int // live, non-system top-level messages
	Replies  int // live thread replies
	System   int // live system messages
	Deleted  int // tombstoned messages
	Pinned   int // pin index rows
	Files    int // file index rows
	Members  int
	// MessageSeq is the parent's unread counter; MembersUnread counts members
	// whose read watermark is behind it.
	MessageSeq    int64
	MembersUnread int
	// ThreadsMismatched counts thread roots whose stored reply count differs
	// from the number of their replies. A deleted reply stays in its thread
	// as a placeholder and keeps counting, as it does in ex (a tombstoned
	// root likewise keeps its count).
	ThreadsMismatched int
}

// statsPageSize is a var so tests can force pagination.
var statsPageSize = 500

// ParentStats counts what a parent holds. It walks the parent's whole message
// partition (one Query page per statsPageSize messages) plus its pin and file
// index rows and members' read state, so it costs roughly one read unit per
// 4 KB of messages: use it for validation, not on a hot path.
func (im *Importer) ParentStats(ctx context.Context, parentID, parentType string) (ParentStats, error) {
	var st ParentStats
	if err := validParentType(parentType); err != nil {
		return st, err
	}
	msgs, err := im.allMessages(ctx, parentID)
	if err != nil {
		return st, err
	}
	stored := map[string]int{}  // root → stored ReplyCount
	replies := map[string]int{} // root → live replies
	for _, m := range msgs {
		if m.ParentMessageID != "" {
			replies[m.ParentMessageID]++
		}
		switch {
		case m.Deleted:
			st.Deleted++
		case m.ParentMessageID != "":
			st.Replies++
		case m.System:
			st.System++
		default:
			st.TopLevel++
		}
		if m.ParentMessageID == "" && m.ReplyCount > 0 {
			stored[m.ID] = m.ReplyCount
		}
	}
	for root, n := range replies {
		if stored[root] != n {
			st.ThreadsMismatched++
		}
	}
	for root := range stored {
		if _, ok := replies[root]; !ok {
			st.ThreadsMismatched++
		}
	}
	pins, err := im.parentIndex.ListPinIndex(ctx, parentID)
	if err != nil {
		return st, fmt.Errorf("importer: list pins: %w", err)
	}
	files, err := im.parentIndex.ListFileIndex(ctx, parentID)
	if err != nil {
		return st, fmt.Errorf("importer: list files: %w", err)
	}
	st.Pinned, st.Files = len(pins), len(files)

	var memberIDs []string
	var seqs map[string]int64
	if parentType == ParentChannel {
		ch, err := im.channels.GetChannel(ctx, parentID)
		if err != nil {
			return st, fmt.Errorf("importer: get channel: %w", err)
		}
		members, err := im.memberships.ListMembers(ctx, parentID)
		if err != nil {
			return st, fmt.Errorf("importer: list members: %w", err)
		}
		for _, m := range members {
			memberIDs = append(memberIDs, m.UserID)
		}
		st.MessageSeq = ch.MessageSeq
		seqs, err = im.memberships.LastReadSeqs(ctx, parentID, memberIDs)
		if err != nil {
			return st, fmt.Errorf("importer: read state: %w", err)
		}
	} else {
		conv, err := im.conversations.GetConversation(ctx, parentID)
		if err != nil {
			return st, fmt.Errorf("importer: get conversation: %w", err)
		}
		memberIDs, st.MessageSeq = conv.ParticipantIDs, conv.MessageSeq
		seqs, err = im.conversations.LastReadSeqs(ctx, parentID, memberIDs)
		if err != nil {
			return st, fmt.Errorf("importer: read state: %w", err)
		}
	}
	st.Members = len(memberIDs)
	for _, uid := range memberIDs {
		if seqs[uid] < st.MessageSeq {
			st.MembersUnread++
		}
	}
	return st, nil
}

// allMessages walks every message row of a parent, tombstones included.
func (im *Importer) allMessages(ctx context.Context, parentID string) ([]*model.Message, error) {
	var out []*model.Message
	cursor := ""
	for {
		page, more, err := im.messages.ListMessages(ctx, parentID, cursor, statsPageSize)
		if err != nil {
			return nil, fmt.Errorf("importer: list messages: %w", err)
		}
		out = append(out, page...)
		if !more || len(page) == 0 {
			return out, nil
		}
		cursor = page[len(page)-1].ID
	}
}

// AttachmentState says whether an attachment's record and stored body exist.
type AttachmentState struct {
	Record      bool // attachment row present
	Object      bool // body present in object storage
	Size        int64
	SHA256      string
	ContentType string
	References  int // messages referencing it
}

// AttachmentExists checks attachments' records and bodies (one batched read
// plus one HEAD per existing record). IDs without a record map to the zero
// state.
func (im *Importer) AttachmentExists(ctx context.Context, ids []string) (map[string]AttachmentState, error) {
	if im.objects == nil {
		return nil, ErrNoObjectStore
	}
	ids = dedupe(ids)
	atts, err := im.attachments.GetAttachmentsByIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("importer: get attachments: %w", err)
	}
	out := make(map[string]AttachmentState, len(ids))
	for _, id := range ids {
		out[id] = AttachmentState{}
	}
	for _, a := range atts {
		ok, err := im.objects.HeadObject(ctx, a.S3Key)
		if err != nil {
			return nil, fmt.Errorf("importer: head %s: %w", a.ID, err)
		}
		out[a.ID] = AttachmentState{Record: true, Object: ok, Size: a.Size, SHA256: a.SHA256,
			ContentType: a.ContentType, References: len(a.MessageIDs)}
	}
	return out, nil
}
