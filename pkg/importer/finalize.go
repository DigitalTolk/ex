package importer

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/store"
)

// FinalizeSpec describes what PutMessages added to one parent.
type FinalizeSpec struct {
	ParentID   string
	ParentType string
	// NewTopLevel is PutResult.TopLevelInserted (summed over the calls).
	NewTopLevel int
	// ThreadRootIDs are the roots that received new replies.
	ThreadRootIDs []string
	// LastActivityAt is the newest imported message's time; a conversation's
	// sidebar position moves forward to it (never backward).
	LastActivityAt time.Time
}

// FinalizeResult summarizes a FinalizeParent call.
type FinalizeResult struct {
	ThreadsUpdated int
	// ThreadsMissingRoot counts roots that don't exist in the parent (their
	// replies stay without thread metadata).
	ThreadsMissingRoot int
	FollowsWritten     int
}

// recentAuthorsCap mirrors the size of the thread avatar stack.
const recentAuthorsCap = 3

// FinalizeParent brings a parent's derived state in line with imported
// messages (thread replies are read through ex's thread index, which is
// eventually consistent — finalize once the parent's writes are done):
//   - each touched thread root gets its reply count, last reply time and recent
//     reply authors recomputed from all its replies;
//   - the root author and every reply author follow the thread (an explicit
//     unfollow is never overwritten);
//   - the parent's unread counter and every member's read watermark advance by
//     NewTopLevel together, so imported history is read and existing unread
//     counts don't change;
//   - a conversation's activity time moves forward to LastActivityAt.
//
// Calling it twice for the same import advances both counters twice, which
// leaves unread counts unchanged.
func (im *Importer) FinalizeParent(ctx context.Context, spec FinalizeSpec) (FinalizeResult, error) {
	var res FinalizeResult
	if err := validParentType(spec.ParentType); err != nil {
		return res, err
	}
	for _, rootID := range spec.ThreadRootIDs {
		updated, follows, err := im.finalizeThread(ctx, spec.ParentID, spec.ParentType, rootID)
		if err != nil {
			return res, err
		}
		if updated {
			res.ThreadsUpdated++
		} else {
			res.ThreadsMissingRoot++
		}
		res.FollowsWritten += follows
	}
	if spec.ParentType == ParentChannel {
		return res, im.finalizeChannel(ctx, spec)
	}
	return res, im.finalizeConversation(ctx, spec)
}

func (im *Importer) finalizeThread(ctx context.Context, parentID, parentType, rootID string) (bool, int, error) {
	root, err := im.messages.GetMessage(ctx, parentID, rootID)
	if errors.Is(err, store.ErrNotFound) {
		return false, 0, nil
	}
	if err != nil {
		return false, 0, fmt.Errorf("importer: get thread root: %w", err)
	}
	replies, err := im.messages.ListThreadReplies(ctx, rootID)
	if err != nil {
		return false, 0, fmt.Errorf("importer: list thread replies: %w", err)
	}
	if len(replies) == 0 {
		return true, 0, nil
	}
	sort.Slice(replies, func(i, j int) bool { return replies[i].ID > replies[j].ID }) // newest first
	authors := make([]string, 0, recentAuthorsCap)
	participants := []string{root.AuthorID}
	seen := map[string]bool{root.AuthorID: true}
	for _, r := range replies {
		if len(authors) < recentAuthorsCap && !slices.Contains(authors, r.AuthorID) {
			authors = append(authors, r.AuthorID)
		}
		if !seen[r.AuthorID] {
			seen[r.AuthorID] = true
			participants = append(participants, r.AuthorID)
		}
	}
	if err := im.messages.SetReplyMetadata(ctx, parentID, rootID, len(replies), replies[0].CreatedAt, authors); err != nil {
		return false, 0, fmt.Errorf("importer: set reply metadata: %w", err)
	}
	follows := 0
	now := time.Now()
	for _, uid := range participants {
		if uid == "" || uid == SystemAuthorID || uid == WebhookAuthorID {
			continue
		}
		f := &model.ThreadFollow{UserID: uid, ParentID: parentID, ParentType: parentType, ThreadRootID: rootID, Following: true, UpdatedAt: now}
		if err := im.follows.SetThreadFollowIfAbsent(ctx, f); err != nil {
			return false, follows, fmt.Errorf("importer: thread follow: %w", err)
		}
		follows++
	}
	return true, follows, nil
}

func (im *Importer) finalizeChannel(ctx context.Context, spec FinalizeSpec) error {
	if spec.NewTopLevel <= 0 {
		return nil
	}
	n := int64(spec.NewTopLevel)
	members, err := im.memberships.ListMembers(ctx, spec.ParentID)
	if err != nil {
		return fmt.Errorf("importer: list members: %w", err)
	}
	if _, err := im.channels.AddMessageSeq(ctx, spec.ParentID, n); err != nil {
		return fmt.Errorf("importer: channel message seq: %w", err)
	}
	for _, m := range members {
		if err := im.memberships.AddChannelLastRead(ctx, spec.ParentID, m.UserID, n); err != nil && !errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("importer: member %s read state: %w", m.UserID, err)
		}
	}
	return nil
}

func (im *Importer) finalizeConversation(ctx context.Context, spec FinalizeSpec) error {
	conv, err := im.conversations.GetConversation(ctx, spec.ParentID)
	if err != nil {
		return fmt.Errorf("importer: get conversation: %w", err)
	}
	if n := int64(spec.NewTopLevel); n > 0 {
		if _, err := im.conversations.AddMessageSeq(ctx, conv.ID, n); err != nil {
			return fmt.Errorf("importer: conversation message seq: %w", err)
		}
		for _, uid := range conv.ParticipantIDs {
			if err := im.conversations.AddConversationLastRead(ctx, conv.ID, uid, n); err != nil && !errors.Is(err, store.ErrNotFound) {
				return fmt.Errorf("importer: participant %s read state: %w", uid, err)
			}
		}
	}
	if conv.UpdatedAt.Before(spec.LastActivityAt) {
		if err := im.conversations.TouchConversation(ctx, conv.ID, conv.ParticipantIDs, spec.LastActivityAt); err != nil {
			return fmt.Errorf("importer: touch conversation: %w", err)
		}
	}
	return nil
}

// indexPageSize is a var so tests can force pagination.
var indexPageSize = 500

// IndexParent writes a parent's messages and the files they reference to the
// search index (tombstoned, system and no-index messages are skipped). No-op
// without search. Returns how many message and file documents were written.
func (im *Importer) IndexParent(ctx context.Context, parentID, parentType string) (int, int, error) {
	if err := validParentType(parentType); err != nil {
		return 0, 0, err
	}
	if im.search == nil {
		return 0, 0, nil
	}
	var msgs []*model.Message
	cursor := ""
	for {
		page, more, err := im.messages.ListMessages(ctx, parentID, cursor, indexPageSize)
		if err != nil {
			return 0, 0, fmt.Errorf("importer: list messages: %w", err)
		}
		for _, m := range page {
			if !m.Deleted {
				msgs = append(msgs, m)
			}
		}
		if !more || len(page) == 0 {
			break
		}
		cursor = page[len(page)-1].ID
	}
	n, f, err := search.IndexParentMessages(ctx, im.search, msgs, parentType, attachmentResolver{im})
	if err != nil {
		return n, f, fmt.Errorf("importer: index parent: %w", err)
	}
	return n, f, nil
}

// attachmentResolver adapts the attachment store for search documents.
type attachmentResolver struct{ im *Importer }

func (r attachmentResolver) ResolveAttachments(ctx context.Context, ids []string) []*model.Attachment {
	atts, err := r.im.attachments.GetAttachmentsByIDs(ctx, ids)
	if err != nil {
		return nil
	}
	return atts
}

func (r attachmentResolver) ResolveFilenames(ctx context.Context, ids []string) []string {
	var out []string
	for _, a := range r.ResolveAttachments(ctx, ids) {
		out = append(out, a.Filename)
	}
	return out
}
