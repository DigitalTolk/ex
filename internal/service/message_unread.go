package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// markUnreadPageSize / markUnreadMaxPages bound the walk that counts how many
// messages a mark-unread puts back. Marking something from thousands of
// messages ago is rare; past the cap the count (and so the badge) undercounts
// rather than the request scanning the whole history.
const (
	markUnreadPageSize = 100
	markUnreadMaxPages = 20
)

// ErrMarkUnreadUnavailable is returned when the read-state stores mark-unread
// needs aren't wired.
var ErrMarkUnreadUnavailable = errors.New("message: mark unread unavailable")

// MarkUnread makes msgID and everything after it unread again for userID.
//
// Parent read state is a sequence watermark (unread = MessageSeq -
// LastReadSeq) and messages don't carry their seq, so a top-level message is
// mapped by counting the messages that bumped the counter from it onward —
// the same rule bumpUnreadSeq applies — and the watermark is set that far
// behind the current counter. A thread reply instead rewinds the thread's
// seen time to just before the reply and flags the thread, so it shows unread
// in Threads.
//
// Publishes userchannel.updated to the caller's own topic so their other tabs
// and devices pick the change up.
func (s *MessageService) MarkUnread(ctx context.Context, userID, parentID, parentType, msgID string) (*model.MarkUnreadResult, error) {
	if err := s.checkAccess(ctx, userID, parentID, parentType); err != nil {
		return nil, err
	}
	msg, err := s.messages.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return nil, fmt.Errorf("message: get: %w", err)
	}
	if msg.ParentMessageID != "" {
		return s.markThreadUnread(ctx, userID, parentID, parentType, msg)
	}
	seqStore := s.channelSeq
	parentKey := "channelID"
	if parentType == ParentConversation {
		seqStore = s.convSeq
		parentKey = "conversationID"
	}
	if seqStore == nil {
		return nil, ErrMarkUnreadUnavailable
	}
	unread, err := s.countUnreadFrom(ctx, parentID, parentType, msg)
	if err != nil {
		return nil, err
	}
	current, err := seqStore.CurrentMessageSeq(ctx, parentID)
	if err != nil {
		return nil, fmt.Errorf("message: mark unread: current seq: %w", err)
	}
	if err := seqStore.SetLastRead(ctx, parentID, userID, max(current-unread, 0)); err != nil {
		return nil, fmt.Errorf("message: mark unread: set last read: %w", err)
	}
	// `unread` (not a bare {channelID}, which means "read elsewhere — clear
	// the badge") tells the other tabs to refetch the row.
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		parentKey: parentID,
		"unread":  true,
	})
	return &model.MarkUnreadResult{
		ParentID:    parentID,
		ParentType:  parentType,
		MessageID:   msg.ID,
		UnreadCount: min(unread, current),
	}, nil
}

// markThreadUnread rewinds the thread's seen time to just before the reply and
// sets the thread's notification flag, so it lists as unread in Threads. The
// seen row is flagged Rewound so List can report the mark (see
// model.UserState.ThreadMarkedUnread); the next ordinary "seen" clears it.
func (s *MessageService) markThreadUnread(ctx context.Context, userID, parentID, parentType string, reply *model.Message) (*model.MarkUnreadResult, error) {
	if s.userState == nil {
		return nil, ErrMarkUnreadUnavailable
	}
	now := time.Now()
	seenAt := reply.CreatedAt.Add(-time.Millisecond)
	root := reply.ParentMessageID
	for _, item := range []*model.UserStateItem{
		{Kind: model.UserStateThreadSeen, SeenAt: &seenAt, Rewound: true},
		{Kind: model.UserStateThreadNotification},
	} {
		item.UserID, item.TargetID, item.ThreadRootID = userID, root, root
		item.ParentID, item.ParentType, item.UpdatedAt = parentID, parentType, now
		if err := s.userState.SetUserState(ctx, item); err != nil {
			return nil, fmt.Errorf("message: mark thread unread: %w", err)
		}
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventUserChannelUpdated, map[string]any{
		"userState": true,
	})
	return &model.MarkUnreadResult{
		ParentID:     parentID,
		ParentType:   parentType,
		MessageID:    reply.ID,
		ThreadRootID: root,
		SeenAt:       &seenAt,
	}, nil
}

// countUnreadFrom counts the messages from `from` onward that advanced the
// parent's unread counter.
func (s *MessageService) countUnreadFrom(ctx context.Context, parentID, parentType string, from *model.Message) (int64, error) {
	var n int64
	if countsTowardUnread(from, parentType) {
		n++
	}
	cursor := from.ID
	for range markUnreadMaxPages {
		page, hasMore, err := s.messages.ListMessagesAfter(ctx, parentID, cursor, markUnreadPageSize)
		if err != nil {
			return 0, fmt.Errorf("message: mark unread: count: %w", err)
		}
		for _, m := range page {
			if countsTowardUnread(m, parentType) {
				n++
			}
		}
		if !hasMore || len(page) == 0 {
			break
		}
		cursor = page[0].ID // pages are newest-first
	}
	return n, nil
}

// countsTowardUnread mirrors which sends bump the parent's unread counter: a
// top-level message — in a channel, not a system join/leave event. Thread
// replies never count; deleted messages still do (deleting never decrements).
func countsTowardUnread(m *model.Message, parentType string) bool {
	if m.ParentMessageID != "" {
		return false
	}
	return parentType != ParentChannel || !m.System
}
