package search

import (
	"context"
	"regexp"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
)

// AttachmentResolver returns metadata for the given attachment IDs.
// IndexMessage no longer denormalizes filenames onto the message doc
// (file search runs against ex_files), but message ingestion still
// needs to know which files to push into the file index.
type AttachmentResolver interface {
	// ResolveFilenames is kept for tests and the legacy code path; it
	// just maps IDs → filenames best-effort.
	ResolveFilenames(ctx context.Context, ids []string) []string
	// ResolveAttachments returns the full attachment records for the
	// given IDs in the same order. Missing IDs are skipped.
	ResolveAttachments(ctx context.Context, ids []string) []*model.Attachment
}

// Indexer is the surface the rest of the codebase uses to keep the
// search index in sync. It's deliberately interface-shaped so
// service-layer hooks can take a no-op (nil-safe) implementation in
// tests and when search isn't configured.
type Indexer interface {
	IndexUser(ctx context.Context, u *model.User) error
	DeleteUser(ctx context.Context, id string) error
	IndexChannel(ctx context.Context, ch *model.Channel) error
	DeleteChannel(ctx context.Context, id string) error
	// IndexMessage records the message in ES. parentType ("channel"
	// or "conversation") is passed in because the Message model
	// doesn't carry it — service-layer callers know which parent
	// kind a message belongs to. Each attached file is also pushed
	// to ex_files via the AttachmentResolver wired on the indexer.
	IndexMessage(ctx context.Context, m *model.Message, parentType string) error
	DeleteMessage(ctx context.Context, id string) error
}

// docWriter abstracts the Client's index/delete methods so tests can
// stub it without driving HTTP through httptest. The live Client
// satisfies it directly.
type docWriter interface {
	IndexDoc(ctx context.Context, index, id string, doc any) error
	DeleteDoc(ctx context.Context, index, id string) error
	GetDoc(ctx context.Context, index, id string) (map[string]any, error)
}

// LiveIndexer is the production Indexer. Its methods are best-effort:
// failures are returned but callers are expected to log-and-continue
// rather than fail the underlying CRUD operation.
type LiveIndexer struct {
	w           docWriter
	attachments AttachmentResolver
}

// NewIndexer returns an Indexer backed by a search Client. Passing a
// nil client returns NoopIndexer so callers don't need a separate
// guard.
func NewIndexer(c *Client) Indexer {
	if c == nil {
		return NoopIndexer{}
	}
	return &LiveIndexer{w: c}
}

// SetAttachmentResolver wires filename lookup for message indexing.
// When unset the message doc still indexes; the attachmentNames field
// is just left empty.
func (l *LiveIndexer) SetAttachmentResolver(r AttachmentResolver) {
	l.attachments = r
}

// IndexUser upserts the user into ES. Email is included so the search
// box can match by partial address; nothing else from the User is
// searchable.
func (l *LiveIndexer) IndexUser(ctx context.Context, u *model.User) error {
	return l.w.IndexDoc(ctx, IndexUsers, u.ID, userDoc(u))
}

// DeleteUser removes the document. Idempotent (missing docs are OK).
func (l *LiveIndexer) DeleteUser(ctx context.Context, id string) error {
	return l.w.DeleteDoc(ctx, IndexUsers, id)
}

// IndexChannel upserts the channel.
func (l *LiveIndexer) IndexChannel(ctx context.Context, ch *model.Channel) error {
	return l.w.IndexDoc(ctx, IndexChannels, ch.ID, channelDoc(ch))
}

// DeleteChannel removes the channel.
func (l *LiveIndexer) DeleteChannel(ctx context.Context, id string) error {
	return l.w.DeleteDoc(ctx, IndexChannels, id)
}

// IndexMessage upserts the message and any attached files. System
// messages are skipped — they carry no user-authored content and just
// inflate the index.
func (l *LiveIndexer) IndexMessage(ctx context.Context, m *model.Message, parentType string) error {
	if m == nil || m.System {
		return nil
	}
	if err := l.w.IndexDoc(ctx, IndexMessages, m.ID, messageDoc(m, parentType)); err != nil {
		return err
	}
	if l.attachments != nil && len(m.AttachmentIDs) > 0 {
		atts := l.attachments.ResolveAttachments(ctx, m.AttachmentIDs)
		for _, a := range atts {
			if a == nil {
				continue
			}
			if err := l.upsertFile(ctx, a, m); err != nil {
				return err
			}
		}
	}
	return nil
}

// upsertFile read-modifies-writes the file doc so the parent/message
// reference sets stay deduped. Concurrent writes can race; the admin
// reindex is the recovery path for any divergence.
//
// messageIds and parentMessageIds are kept INDEX-ALIGNED — each
// messageId in messageIds[i] has its thread-root (or "" for top-
// level) at parentMessageIds[i]. The frontend uses this alignment
// to deep-link a file hit in a thread reply directly into the right
// thread panel.
func (l *LiveIndexer) upsertFile(ctx context.Context, a *model.Attachment, m *model.Message) error {
	existing, err := l.w.GetDoc(ctx, IndexFiles, a.ID)
	if err != nil {
		return err
	}
	parentIds := mergeStringSet(existing["parentIds"], m.ParentID)
	messageIds, parentMessageIds := mergeMessageRefs(
		existing["messageIds"],
		existing["parentMessageIds"],
		m.ID,
		m.ParentMessageID,
	)
	doc := map[string]any{
		"id":               a.ID,
		"filename":         a.Filename,
		"contentType":      a.ContentType,
		"size":             a.Size,
		"sharedBy":         a.CreatedBy,
		"parentIds":        parentIds,
		"messageIds":       messageIds,
		"parentMessageIds": parentMessageIds,
		"createdAt":        a.CreatedAt,
	}
	return l.w.IndexDoc(ctx, IndexFiles, a.ID, doc)
}

func mergeStringSet(prev any, add string) []string {
	out := []string{add}
	seen := map[string]bool{add: true}
	if list, ok := prev.([]any); ok {
		for _, v := range list {
			s, ok := v.(string)
			if !ok || seen[s] {
				continue
			}
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// mergeMessageRefs maintains a pair of parallel slices keyed by the
// messageId. If addMsgID is already present, the existing entry's
// parentMessageID is preserved (we don't ratchet over a corrected
// value with a stale one). Otherwise the new (msgID, parentMsgID)
// pair is appended at the same index. Legacy docs with only
// messageIds (no parentMessageIds) are tolerated by padding with
// empty strings.
func mergeMessageRefs(prevMsgIDs, prevParentMsgIDs any, addMsgID, addParentMsgID string) ([]string, []string) {
	msgIDs := stringsFromAny(prevMsgIDs)
	parentMsgIDs := stringsFromAny(prevParentMsgIDs)
	for len(parentMsgIDs) < len(msgIDs) {
		parentMsgIDs = append(parentMsgIDs, "")
	}
	for i, id := range msgIDs {
		if id == addMsgID {
			// Already there. Keep arrays as-is (with padding applied
			// above so callers always see aligned slices).
			_ = i
			return msgIDs, parentMsgIDs
		}
	}
	return append(msgIDs, addMsgID), append(parentMsgIDs, addParentMsgID)
}

func stringsFromAny(v any) []string {
	out := []string{}
	if list, ok := v.([]any); ok {
		for _, x := range list {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}

// DeleteMessage removes the message.
func (l *LiveIndexer) DeleteMessage(ctx context.Context, id string) error {
	return l.w.DeleteDoc(ctx, IndexMessages, id)
}

// NoopIndexer satisfies Indexer without doing anything. Returned by
// NewIndexer when the ES client is nil and used directly in tests.
type NoopIndexer struct{}

func (NoopIndexer) IndexUser(context.Context, *model.User) error      { return nil }
func (NoopIndexer) DeleteUser(context.Context, string) error          { return nil }
func (NoopIndexer) IndexChannel(context.Context, *model.Channel) error { return nil }
func (NoopIndexer) DeleteChannel(context.Context, string) error        { return nil }
func (NoopIndexer) IndexMessage(context.Context, *model.Message, string) error { return nil }
func (NoopIndexer) DeleteMessage(context.Context, string) error        { return nil }

// Document shapes — kept as private map builders so the wire format
// is local to this package and not leaked through the model types.
func userDoc(u *model.User) map[string]any {
	return map[string]any{
		"id":          u.ID,
		"displayName": u.DisplayName,
		"email":       u.Email,
		"systemRole":  string(u.SystemRole),
		"status":      string(u.Status),
	}
}

func channelDoc(ch *model.Channel) map[string]any {
	return map[string]any{
		"id":          ch.ID,
		"name":        ch.Name,
		"slug":        ch.Slug,
		"description": ch.Description,
		"type":        string(ch.Type),
		"archived":    ch.Archived,
	}
}

// hashtagPattern extracts `#tag` tokens from message bodies so we can
// store them as a separate keyword field (cheap exact-match lookup).
var hashtagPattern = regexp.MustCompile(`#([\p{L}\p{N}_-]{2,64})`)

func messageDoc(m *model.Message, parentType string) map[string]any {
	return map[string]any{
		"id":              m.ID,
		"parentId":        m.ParentID,
		"parentType":      parentType,
		"parentMessageID": m.ParentMessageID,
		"authorId":        m.AuthorID,
		"body":            m.Body,
		"tags":            extractHashtags(m.Body),
		"attachmentIds":   m.AttachmentIDs,
		"hasFiles":        len(m.AttachmentIDs) > 0,
		"reactions":       m.Reactions,
		"createdAt":       m.CreatedAt,
	}
}

func extractHashtags(body string) []string {
	matches := hashtagPattern.FindAllStringSubmatch(body, -1)
	if len(matches) == 0 {
		return []string{}
	}
	seen := make(map[string]bool, len(matches))
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		tag := strings.ToLower(m[1])
		if !seen[tag] {
			seen[tag] = true
			out = append(out, tag)
		}
	}
	return out
}
