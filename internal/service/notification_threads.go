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
	summary := &ThreadSummary{
		ParentID:         msg.ParentID,
		ParentType:       parentType,
		ThreadRootID:     root.ID,
		RootAuthorID:     root.AuthorID,
		RootBody:         root.Body,
		RootCreatedAt:    root.CreatedAt,
		ReplyCount:       root.ReplyCount,
		LatestActivityAt: latest,
	}
	channels := make([]string, 0, len(audience))
	for uid := range audience {
		channels = append(channels, pubsub.UserChannel(uid))
	}
	events.PublishMany(ctx, s.publisher, channels, events.EventThreadUpdated, summary)
}

func (s *NotificationService) markThreadNotification(ctx context.Context, userID string, msg *model.Message, parentType string) {
	if s.userState == nil || msg == nil || msg.ParentMessageID == "" {
		return
	}
	if err := s.userState.MarkThreadNotificationUnread(ctx, userID, msg.ParentID, parentType, msg.ParentMessageID); err != nil {
		slog.Warn("thread notification state failed", "threadRootID", msg.ParentMessageID, "userID", userID, "error", err)
	}
}

// resolveThreadRecipients returns the user IDs that should receive a
// thread-reply notification: the thread root's author plus everyone
// who has already replied in this thread. The current message's author
// is excluded; duplicates are removed.
func (s *NotificationService) resolveThreadRecipients(ctx context.Context, msg *model.Message, snap memberSnapshot) []string {
	if s.messages == nil || msg.ParentMessageID == "" {
		return nil
	}
	unfollowed := make(map[string]bool)
	explicitFollowers := make([]string, 0)
	if s.follows != nil {
		follows, err := s.follows.ListThreadFollows(ctx, msg.ParentID, msg.ParentMessageID)
		if err == nil {
			for _, f := range follows {
				if f.Following {
					explicitFollowers = append(explicitFollowers, f.UserID)
				} else {
					unfollowed[f.UserID] = true
				}
			}
		}
	}
	// Fetch the thread's replies via the GSI1 thread index (one Query, exactly
	// this thread) rather than scanning up to 1000 of the parent's recent
	// messages, and resolve the root author with a direct GetMessage.
	replies, err := s.messages.ListThreadReplies(ctx, msg.ParentMessageID)
	if err != nil {
		return nil
	}
	repliers := make([]string, 0)
	seen := make(map[string]bool)
	currentMembers := make(map[string]bool, len(snap.memberIDs))
	for _, uid := range snap.memberIDs {
		currentMembers[uid] = true
	}
	var rootAuthor string
	if root, err := s.messages.GetMessage(ctx, msg.ParentID, msg.ParentMessageID); err == nil && root != nil &&
		root.AuthorID != "" && root.AuthorID != msg.AuthorID && !unfollowed[root.AuthorID] && currentMembers[root.AuthorID] {
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
		return repliers
	}
	return append([]string{rootAuthor}, repliers...)
}
