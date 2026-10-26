// Thread-notification concerns: the /threads live patch, the durable
// per-user thread-unread marker, and thread-reply recipient resolution.
// Split out of notification.go (2026-08-12).

package service

import (
	"context"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// publishThreadUpdate fans a thread.updated event out to everyone whose
// /threads list shows this thread, so the list patches live from the
// reply's authoritative root instead of a race-prone refetch. The
// audience is computed by NotifyForMessage from the same member snapshot
// and thread reads that gate notifications — keep it that way; a second
// implementation of the participation rules WILL drift (the last one
// missed follow-all-threads users and notification-pulled bystanders).
func (s *NotificationService) publishThreadUpdate(ctx context.Context, msg *model.Message, parentType string, root *model.Message, audience map[string]bool) {
	if s.publisher == nil {
		return
	}
	latest := root.CreatedAt
	if root.LastReplyAt != nil {
		latest = *root.LastReplyAt
	}
	// audience maps each recipient to whether they follow the thread: an
	// alert can list a thread for someone who doesn't (a keyword, or an
	// @here past their unfollow), and their row must say so.
	for _, following := range []bool{true, false} {
		channels := make([]string, 0, len(audience))
		for uid, f := range audience {
			if f == following {
				channels = append(channels, pubsub.UserChannel(uid))
			}
		}
		if len(channels) == 0 {
			continue
		}
		events.PublishMany(ctx, s.publisher, channels, events.EventThreadUpdated, &ThreadSummary{
			ParentID:         msg.ParentID,
			ParentType:       parentType,
			ThreadRootID:     root.ID,
			RootAuthorID:     root.AuthorID,
			RootBody:         root.Body,
			RootCreatedAt:    root.CreatedAt,
			ReplyCount:       root.ReplyCount,
			LatestActivityAt: latest,
			Following:        following,
		})
	}
}

func (s *NotificationService) markThreadNotification(ctx context.Context, userID string, msg *model.Message, parentType string) {
	if s.userState == nil || msg == nil || msg.ParentMessageID == "" {
		return
	}
	if err := s.userState.MarkThreadNotificationUnread(ctx, userID, msg.ParentID, parentType, msg.ParentMessageID); err != nil {
		slog.WarnContext(ctx, "thread notification state failed", "threadRootID", msg.ParentMessageID, "userID", userID, "error", err)
	}
}

// threadFullyIndexed reports whether every participant of the thread rooted
// at root has a follow row: true for a thread rooted after the write-time
// participation index existed (recordThreadParticipation writes a row for
// every replier; the importer's FinalizeParent does the same for imported
// threads). An unknown root is treated as legacy.
func threadFullyIndexed(root *model.Message) bool {
	return root != nil && !root.CreatedAt.Before(threadIndexEpoch)
}

// resolveThreadRecipients returns the user IDs that should receive a
// thread-reply notification: the thread root's author plus everyone
// who has already replied in this thread or follows it. The current
// message's author is excluded; duplicates are removed. It also returns who
// unfollowed the thread: nothing implicit (a DM, follow-all, their own
// earlier replies) puts them back.
//
// root is the thread root the caller already holds (nil when it could not be
// read). For a fully indexed thread the follow rows ARE the participant set,
// so the reply is answered from one follow-index query instead of re-reading
// every reply of the thread (O(replies) per reply, O(replies²) per thread).
// A legacy thread — or a follow index that couldn't be read — still reads the
// replies: an unindexed replier must never silently stop being alerted.
func (s *NotificationService) resolveThreadRecipients(ctx context.Context, msg *model.Message, snap memberSnapshot, root *model.Message) ([]string, map[string]bool) {
	unfollowed := make(map[string]bool)
	if s.messages == nil || msg.ParentMessageID == "" {
		return nil, unfollowed
	}
	explicitFollowers := make([]string, 0)
	followsRead := false
	if s.follows != nil {
		follows, err := s.follows.ListThreadFollows(ctx, msg.ParentID, msg.ParentMessageID)
		if err == nil {
			followsRead = true
			for _, f := range follows {
				if f.Following {
					explicitFollowers = append(explicitFollowers, f.UserID)
				} else {
					unfollowed[f.UserID] = true
				}
			}
		} else {
			slog.WarnContext(ctx, "thread follow index read failed; reading the thread's replies instead",
				"threadRootID", msg.ParentMessageID, "error", err)
		}
	}
	var replies []*model.Message
	if !followsRead || !threadFullyIndexed(root) {
		// Legacy path: the thread's replies via the GSI1 thread index (one
		// paged Query, exactly this thread). A failed read still alerts the
		// root author and the followers below — never nobody.
		if r, err := s.messages.ListThreadReplies(ctx, msg.ParentMessageID); err == nil {
			replies = r
		} else {
			slog.WarnContext(ctx, "thread replies read failed; alerting root author and followers only",
				"threadRootID", msg.ParentMessageID, "error", err)
		}
	}
	repliers := make([]string, 0)
	seen := make(map[string]bool)
	currentMembers := make(map[string]bool, len(snap.memberIDs))
	for _, uid := range snap.memberIDs {
		currentMembers[uid] = true
	}
	var rootAuthor string
	if root != nil && root.AuthorID != "" && root.AuthorID != msg.AuthorID && !unfollowed[root.AuthorID] && currentMembers[root.AuthorID] {
		rootAuthor = root.AuthorID
		seen[root.AuthorID] = true
	}
	// For channel parents this set gates who is NOTIFIED about the reply.
	// Conversations always notify every participant, so there it only feeds
	// the thread.updated audience (whose /threads list shows the thread).
	add := func(dst *[]string, uid string) {
		if uid == "" || uid == msg.AuthorID || seen[uid] || unfollowed[uid] {
			return
		}
		if !currentMembers[uid] {
			return
		}
		seen[uid] = true
		*dst = append(*dst, uid)
	}
	for _, m := range replies {
		if m.ID == msg.ID {
			continue
		}
		add(&repliers, m.AuthorID)
	}
	for _, uid := range explicitFollowers {
		add(&repliers, uid)
	}
	if rootAuthor == "" {
		return repliers, unfollowed
	}
	return append([]string{rootAuthor}, repliers...), unfollowed
}
