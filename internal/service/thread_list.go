package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/sync/errgroup"
)

// ThreadPage is one page of the /threads list.
type ThreadPage struct {
	Threads []*ThreadSummary `json:"threads"`
	// NextCursor asks for the page after this one; empty at the end.
	NextCursor string `json:"nextCursor,omitempty"`
}

// The /threads list comes a page at a time: first the threads with unread
// replies (their unread markers, the latest alert first), then every other
// thread the user follows, latest reply first (the follow rows' activity
// order). A cursor says which part a page continues: "u:<marker key>" or
// "r:<follow cursor>". No page reads more threads than it returns.
const (
	DefaultThreadPageSize = 20
	MaxThreadPageSize     = 50
	threadCursorUnread    = "u:"
	threadCursorFollowed  = "r:"
	// A page passes over threads it can't show (a channel the user left, a
	// deleted root); threadPageRounds bounds the reads one page spends on that.
	threadPageRounds = 5
	// markerTimeLayout is fixed-width, so marker keys sort by time.
	markerTimeLayout = "2006-01-02T15:04:05.000000000Z"
)

// threadMarker is one of the user's unread-thread markers.
type threadMarker struct {
	parentID   string
	parentType string
	rootID     string
	key        string
}

// ListThreadsPage returns one page of userID's threads after cursor ("" for
// the first page), at most limit long.
func (s *MessageService) ListThreadsPage(ctx context.Context, userID, cursor string, limit int) (*ThreadPage, error) {
	if limit <= 0 {
		limit = DefaultThreadPageSize
	}
	limit = min(limit, MaxThreadPageSize)
	markers, err := s.unreadThreadMarkers(ctx, userID)
	if err != nil {
		return nil, err
	}
	switch {
	case cursor == "":
		s.maybeSeedThreadIndex(ctx, userID)
		return s.unreadThreadsPage(ctx, userID, markers, "", limit)
	case strings.HasPrefix(cursor, threadCursorUnread):
		return s.unreadThreadsPage(ctx, userID, markers, strings.TrimPrefix(cursor, threadCursorUnread), limit)
	case strings.HasPrefix(cursor, threadCursorFollowed):
		return s.followedThreadsPage(ctx, userID, markers, strings.TrimPrefix(cursor, threadCursorFollowed), limit)
	default:
		return nil, apperr.Invalid("thread list: bad cursor")
	}
}

// unreadThreadMarkers lists userID's unread-thread markers, the latest first.
func (s *MessageService) unreadThreadMarkers(ctx context.Context, userID string) ([]threadMarker, error) {
	if s.userState == nil {
		return nil, nil
	}
	items, err := s.userState.ListUserState(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("threads: list user state: %w", err)
	}
	var markers []threadMarker
	for _, item := range items {
		if item.Kind != model.UserStateThreadNotification || item.ParentID == "" || item.ThreadRootID == "" {
			continue
		}
		markers = append(markers, threadMarker{
			parentID:   item.ParentID,
			parentType: item.ParentType,
			rootID:     item.ThreadRootID,
			key:        item.UpdatedAt.UTC().Format(markerTimeLayout) + "#" + item.ThreadRootID,
		})
	}
	sort.Slice(markers, func(i, j int) bool { return markers[i].key > markers[j].key })
	return markers, nil
}

// unreadThreadsPage lists the unread threads after the marker key `after`.
// Markers the user can no longer open are dropped on the way, so the
// sidebar's unread dot doesn't point at nothing.
func (s *MessageService) unreadThreadsPage(ctx context.Context, userID string, markers []threadMarker, after string, limit int) (*ThreadPage, error) {
	i := 0
	if after != "" {
		i = sort.Search(len(markers), func(i int) bool { return markers[i].key < after })
	}
	page := &ThreadPage{Threads: []*ThreadSummary{}}
	access := &parentAccess{seen: map[string]bool{}}
	var gone []threadEntry
	for i < len(markers) && len(page.Threads) < limit {
		batch := markers[i:min(i+limit-len(page.Threads), len(markers))]
		i += len(batch)
		entries := make([]threadEntry, len(batch))
		for j, m := range batch {
			entries[j] = threadEntry{parentID: m.parentID, parentType: m.parentType, rootID: m.rootID}
		}
		summaries, missing, err := s.threadSummaries(ctx, userID, entries, access)
		if err != nil {
			return nil, err
		}
		if err := s.setFollowing(ctx, userID, summaries); err != nil {
			return nil, err
		}
		for _, sum := range summaries {
			sum.Unread = true
		}
		page.Threads = append(page.Threads, summaries...)
		gone = append(gone, missing...)
	}
	page.NextCursor = threadCursorFollowed
	if i < len(markers) {
		page.NextCursor = threadCursorUnread + markers[i-1].key
	}
	s.dropThreadMarkers(ctx, userID, gone)
	return page, nil
}

// followedThreadsPage lists the followed threads after the follow cursor
// `after`, leaving out the unread ones (listed before them).
func (s *MessageService) followedThreadsPage(ctx context.Context, userID string, markers []threadMarker, after string, limit int) (*ThreadPage, error) {
	unread := make(map[string]bool, len(markers))
	for _, m := range markers {
		unread[m.rootID] = true
	}
	page := &ThreadPage{Threads: []*ThreadSummary{}}
	access := &parentAccess{seen: map[string]bool{}}
	cursor := after
	for round := 0; round < threadPageRounds && len(page.Threads) < limit; round++ {
		follows, next, err := s.threadFollows.ListFollowedThreadsByActivity(ctx, userID, cursor, limit-len(page.Threads))
		if err != nil {
			return nil, fmt.Errorf("threads: list followed: %w", err)
		}
		cursor = next
		entries := make([]threadEntry, 0, len(follows))
		for _, f := range follows {
			if !unread[f.ThreadRootID] {
				entries = append(entries, threadEntry{parentID: f.ParentID, parentType: f.ParentType, rootID: f.ThreadRootID})
			}
		}
		summaries, _, err := s.threadSummaries(ctx, userID, entries, access)
		if err != nil {
			return nil, err
		}
		for _, sum := range summaries {
			sum.Following = true
		}
		page.Threads = append(page.Threads, summaries...)
		if next == "" {
			break
		}
	}
	if cursor != "" {
		page.NextCursor = threadCursorFollowed + cursor
	}
	return page, nil
}

// threadEntry is a thread a page may list.
type threadEntry struct {
	parentID   string
	parentType string
	rootID     string
}

// parentAccess remembers, within one page, which parents the user can read.
type parentAccess struct {
	mu   sync.Mutex
	seen map[string]bool
}

// threadSummaries builds the summaries of entries, in order, from their root
// messages. gone lists the entries the user can't open any more: a parent
// they left, or a root that no longer exists.
func (s *MessageService) threadSummaries(ctx context.Context, userID string, entries []threadEntry, access *parentAccess) ([]*ThreadSummary, []threadEntry, error) {
	parentTypes := map[string]string{}
	for _, e := range entries {
		parentTypes[e.parentID] = e.parentType
	}
	var g errgroup.Group
	g.SetLimit(threadRootReaders)
	for parentID, parentType := range parentTypes {
		access.mu.Lock()
		_, known := access.seen[parentID]
		access.mu.Unlock()
		if known {
			continue
		}
		g.Go(func() error {
			err := s.checkAccess(ctx, userID, parentID, parentType)
			if err != nil && !errors.Is(err, ErrForbidden) {
				return err
			}
			access.mu.Lock()
			access.seen[parentID] = err == nil
			access.mu.Unlock()
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, nil, err
	}

	readable := map[string][]string{}
	for _, e := range entries {
		if access.seen[e.parentID] {
			readable[e.parentID] = append(readable[e.parentID], e.rootID)
		}
	}
	var mu sync.Mutex
	roots := map[string]*model.Message{}
	var reads errgroup.Group
	reads.SetLimit(threadRootReaders)
	for parentID, ids := range readable {
		reads.Go(func() error {
			defer safe.Recover()
			msgs, err := s.threadRoots(ctx, parentID, ids)
			mu.Lock()
			defer mu.Unlock()
			for _, m := range msgs {
				roots[parentID+"#"+m.ID] = m
			}
			return err
		})
	}
	if err := reads.Wait(); err != nil {
		return nil, nil, err
	}

	out := make([]*ThreadSummary, 0, len(entries))
	var gone []threadEntry
	for _, e := range entries {
		root := roots[e.parentID+"#"+e.rootID]
		if root == nil {
			gone = append(gone, e)
			continue
		}
		latest := root.CreatedAt
		if root.LastReplyAt != nil && root.LastReplyAt.After(latest) {
			latest = *root.LastReplyAt
		}
		out = append(out, &ThreadSummary{
			ParentID:         e.parentID,
			ParentType:       e.parentType,
			ThreadRootID:     root.ID,
			RootAuthorID:     root.AuthorID,
			RootBody:         root.Body,
			RootCreatedAt:    root.CreatedAt,
			ReplyCount:       root.ReplyCount,
			LatestActivityAt: latest,
		})
	}
	return out, gone, nil
}

// setFollowing fills in whether the user follows each of summaries: their
// follow row decides; without one, a DM's threads are followed and a
// channel's are not.
func (s *MessageService) setFollowing(ctx context.Context, userID string, summaries []*ThreadSummary) error {
	refs := make([]model.ThreadRef, len(summaries))
	for i, sum := range summaries {
		refs[i] = model.ThreadRef{ParentID: sum.ParentID, ThreadRootID: sum.ThreadRootID}
	}
	rows, err := s.threadFollows.GetUserThreadFollows(ctx, userID, refs)
	if err != nil {
		return fmt.Errorf("threads: read follows: %w", err)
	}
	following := make(map[string]bool, len(rows))
	for _, f := range rows {
		following[threadFollowKey(f.ParentID, f.ThreadRootID)] = f.Following
	}
	for _, sum := range summaries {
		f, ok := following[threadFollowKey(sum.ParentID, sum.ThreadRootID)]
		sum.Following = f || (!ok && sum.ParentType == ParentConversation)
	}
	return nil
}

// dropThreadMarkers deletes the unread markers of threads the user can no
// longer open, in the background, and tells their clients.
func (s *MessageService) dropThreadMarkers(ctx context.Context, userID string, gone []threadEntry) {
	if len(gone) == 0 {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		if s.afterThreadMarkersDropped != nil {
			defer s.afterThreadMarkersDropped(userID)
		}
		for _, e := range gone {
			if err := s.userState.DeleteUserState(bg, userID, model.UserStateThreadNotification, e.rootID); err != nil {
				slog.WarnContext(bg, "threads: drop stale unread marker failed", "userID", userID, "threadRootID", e.rootID, "error", err)
				return
			}
		}
		events.Publish(bg, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
			"userState": true,
		})
	})
}

// ThreadFollowing reports whether userID follows the thread — what the
// thread panel's Follow button shows. One row read: the user's follow row
// decides; without one, a DM's threads are followed and a channel's are not.
func (s *MessageService) ThreadFollowing(ctx context.Context, userID, parentID, parentType, threadRootID string) (bool, error) {
	if parentType != ParentChannel && parentType != ParentConversation {
		return false, apperr.Invalid("thread: invalid parent type")
	}
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return false, err
	}
	f, err := s.threadFollows.GetThreadFollow(ctx, userID, parentID, threadRootID)
	if errors.Is(err, store.ErrNotFound) {
		return parentType == ParentConversation, nil
	}
	if err != nil {
		return false, fmt.Errorf("thread: get follow: %w", err)
	}
	return f.Following, nil
}
