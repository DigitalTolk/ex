package importer

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/sync/errgroup"
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

// finalizeConcurrency bounds how many threads of one parent are finalized at
// once.
const finalizeConcurrency = 8

// FinalizeParent brings a parent's derived state in line with imported
// messages. Thread roots and replies are read from the parent's partition with
// strongly consistent reads (one pass for all touched threads), so replies
// written just before are counted — the thread index (GSI1) can lag behind
// a bulk write and would leave threads with too low a reply count:
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
	threads, err := im.loadThreads(ctx, spec.ParentID, spec.ThreadRootIDs)
	if err != nil {
		return res, err
	}
	// Threads are independent: finalize them concurrently, bounded.
	var mu sync.Mutex
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(finalizeConcurrency)
	for _, rootID := range spec.ThreadRootIDs {
		g.Go(func() error {
			updated, follows, err := im.finalizeThread(gctx, spec.ParentID, spec.ParentType, threads[rootID])
			mu.Lock()
			defer mu.Unlock()
			if updated {
				res.ThreadsUpdated++
			} else if err == nil {
				res.ThreadsMissingRoot++
			}
			res.FollowsWritten += follows
			return err
		})
	}
	if err := g.Wait(); err != nil {
		return res, err
	}
	if spec.ParentType == ParentChannel {
		return res, im.finalizeChannel(ctx, spec)
	}
	return res, im.finalizeConversation(ctx, spec)
}

// thread is a root and all its replies (deleted ones included, as the thread
// index lists them), read consistently from the parent.
type thread struct {
	root    *model.Message
	replies []*model.Message
}

// loadThreads reads the parent once and collects the given roots with their
// replies. Roots absent from the parent have no entry.
func (im *Importer) loadThreads(ctx context.Context, parentID string, rootIDs []string) (map[string]*thread, error) {
	if len(rootIDs) == 0 {
		return nil, nil
	}
	want := make(map[string]bool, len(rootIDs))
	for _, id := range rootIDs {
		want[id] = true
	}
	msgs, err := im.messages.ListParentMessagesConsistent(ctx, parentID)
	if err != nil {
		return nil, fmt.Errorf("importer: read threads: %w", err)
	}
	replies := map[string][]*model.Message{}
	out := map[string]*thread{}
	for _, m := range msgs {
		switch {
		case want[m.ID]:
			out[m.ID] = &thread{root: m}
		case want[m.ParentMessageID]:
			replies[m.ParentMessageID] = append(replies[m.ParentMessageID], m)
		}
	}
	for id, t := range out {
		t.replies = replies[id]
	}
	return out, nil
}

func (im *Importer) finalizeThread(ctx context.Context, parentID, parentType string, t *thread) (bool, int, error) {
	if t == nil {
		return false, 0, nil
	}
	root, replies := t.root, t.replies
	rootID := root.ID
	if len(replies) == 0 {
		return true, 0, nil
	}
	authors, participants := summarizeThread(root.AuthorID, replies)
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

// summarizeThread sorts replies newest first and returns the recent reply
// authors (the avatar stack) and every participant (root author first).
func summarizeThread(rootAuthorID string, replies []*model.Message) (authors, participants []string) {
	sort.Slice(replies, func(i, j int) bool { return replies[i].ID > replies[j].ID })
	authors = make([]string, 0, recentAuthorsCap)
	participants = []string{rootAuthorID}
	seen := map[string]bool{rootAuthorID: true}
	for _, r := range replies {
		if len(authors) < recentAuthorsCap && !slices.Contains(authors, r.AuthorID) {
			authors = append(authors, r.AuthorID)
		}
		if !seen[r.AuthorID] {
			seen[r.AuthorID] = true
			participants = append(participants, r.AuthorID)
		}
	}
	return authors, participants
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
