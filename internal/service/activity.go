package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
)

// ActivityStore is the persistence the activity service needs.
type ActivityStore interface {
	AddActivity(ctx context.Context, userID string, item *model.ActivityItem) error
	// ListActivity returns the stream newest-first with each item's Read flag
	// resolved.
	ListActivity(ctx context.Context, userID string) ([]*model.ActivityItem, error)
	MarkActivitySeen(ctx context.Context, userID string) error
	SetActivityRead(ctx context.Context, userID string, ids []string, read bool) error
	RemoveActivity(ctx context.Context, userID string, ids []string) error
}

// ErrActivityIDsInvalid rejects a per-item request with no ids or more ids than
// a stream can hold.
var ErrActivityIDsInvalid = errors.New("activity: ids must list between 1 and 500 items")

// activityMaxIDs bounds a per-item request; it matches the stream's size cap.
const activityMaxIDs = 500

// ChannelSlugResolver resolves a channel id to its slug so a reaction activity
// item can snapshot the slug server-side (matching the reminder/webhook paths)
// instead of the client re-deriving it — which breaks once the author leaves the
// channel. Optional; unset means the slug is left empty.
type ChannelSlugResolver interface {
	GetByID(ctx context.Context, id string) (*model.Channel, error)
}

// ActivityFeed is the read model returned to a user's client. Unread counts
// every unread item; UnreadByType splits that count by item type so the client
// can mark which Activity tabs have something new.
type ActivityFeed struct {
	Items        []*model.ActivityItem      `json:"items"`
	Unread       int                        `json:"unread"`
	UnreadByType map[model.ActivityType]int `json:"unreadByType"`
}

// ActivityService owns the per-user activity stream (mentions, thread replies,
// DMs, reactions, channel adds and fired reminders) and notifies a user's own
// clients when it changes.
type ActivityService struct {
	store     ActivityStore
	publisher Publisher
	channels  ChannelSlugResolver
}

// NewActivityService builds an ActivityService.
func NewActivityService(s ActivityStore, p Publisher) *ActivityService {
	return &ActivityService{store: s, publisher: p}
}

// SetChannelResolver wires the channel-slug resolver used to snapshot the slug
// onto reaction activity items.
func (s *ActivityService) SetChannelResolver(c ChannelSlugResolver) { s.channels = c }

// RecordReaction adds a "someone reacted to your message" hint to the message
// author's activity stream. No-op when the reactor is the author themselves, the
// author is the webhook sentinel (a bot message has no human owner to notify), or
// there is no author. Best-effort: failures are logged, never propagated to the
// reaction write that triggered them. Slug resolution + preview building run on
// a detached goroutine, off the reaction request path.
func (s *ActivityService) RecordReaction(ctx context.Context, msg *model.Message, parentType, actorID, emoji string) {
	if msg == nil || msg.AuthorID == "" || msg.AuthorID == actorID || msg.WebhookUsername != "" || s.store == nil {
		return
	}
	// Snapshot only the small fields the goroutine needs (not the whole *Message)
	// so the closure doesn't pin the message for the store write's lifetime.
	author, msgID, parentID, threadRoot, body := msg.AuthorID, msg.ID, msg.ParentID, msg.ParentMessageID, msg.Body
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		item := &model.ActivityItem{
			ID:              store.NewID(),
			Type:            model.ActivityReaction,
			CreatedAt:       time.Now(),
			MessageID:       msgID,
			ParentID:        parentID,
			ParentType:      parentType,
			ParentMessageID: threadRoot,
			ChannelSlug:     s.resolveChannelSlug(bg, parentType, parentID),
			MessagePreview:  activityPreview(body),
			ActorID:         actorID,
			Emoji:           emoji,
		}
		s.addSync(bg, author, item)
	})
}

// resolveChannelSlug returns the channel's slug for a channel-parent reaction, or
// "" for conversations / when no resolver is wired / on lookup failure.
func (s *ActivityService) resolveChannelSlug(ctx context.Context, parentType, parentID string) string {
	if parentType != ParentChannel || s.channels == nil {
		return ""
	}
	ch, err := s.channels.GetByID(ctx, parentID)
	if err != nil || ch == nil {
		return ""
	}
	return ch.Slug
}

// activityPreview builds a single-line preview for an activity/reminder row.
// previewBody humanizes @-mentions and :emoji: shortcodes and clamps length;
// collapsing whitespace afterwards keeps tabs / newline-runs / leading space out
// of the row and lets a whitespace-only body collapse to "" so the client renders
// its fallback label.
func activityPreview(body string) string {
	return strings.Join(strings.Fields(previewBody(body)), " ")
}

// AddItem appends a pre-built activity item to a user's stream and nudges their
// clients. Used by the reminder service when a reminder fires.
func (s *ActivityService) AddItem(ctx context.Context, userID string, item *model.ActivityItem) {
	s.add(ctx, userID, item)
}

func (s *ActivityService) add(ctx context.Context, userID string, item *model.ActivityItem) {
	if s.store == nil {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		s.addSync(bg, userID, item)
	})
}

// addSync is the synchronous core of add, split out so it can be unit-tested
// without racing the detached goroutine. Persists the item then nudges the
// user's clients; a store failure is logged and skips the nudge.
func (s *ActivityService) addSync(ctx context.Context, userID string, item *model.ActivityItem) {
	if err := s.store.AddActivity(ctx, userID, item); err != nil {
		slog.Warn("activity add failed", "userID", userID, "type", item.Type, "error", err)
		return
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventActivityNew, map[string]any{})
}

// Feed returns the user's activity items plus the unread counts.
func (s *ActivityService) Feed(ctx context.Context, userID string) (ActivityFeed, error) {
	items, err := s.store.ListActivity(ctx, userID)
	if err != nil {
		return ActivityFeed{}, fmt.Errorf("activity feed: %w", err)
	}
	feed := ActivityFeed{Items: items, UnreadByType: map[model.ActivityType]int{}}
	for _, it := range items {
		if !it.Read {
			feed.Unread++
			feed.UnreadByType[it.Type]++
		}
	}
	return feed, nil
}

// MarkSeen advances the user's read watermark so the unread badge clears,
// then nudges the user's OTHER devices (activity.read) so their badges clear
// too instead of lingering until the next activity.new (SPEC GAP-3 / I-4).
func (s *ActivityService) MarkSeen(ctx context.Context, userID string) error {
	if err := s.store.MarkActivitySeen(ctx, userID); err != nil {
		return fmt.Errorf("activity mark seen: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventActivityRead, map[string]any{})
	return nil
}

// SetItemsRead marks specific items read or unread (the Activity tab's "Mark as
// read" / "Mark as unread"), then nudges the user's other devices to refresh.
func (s *ActivityService) SetItemsRead(ctx context.Context, userID string, ids []string, read bool) error {
	if len(ids) == 0 || len(ids) > activityMaxIDs {
		return ErrActivityIDsInvalid
	}
	if err := s.store.SetActivityRead(ctx, userID, ids, read); err != nil {
		return fmt.Errorf("activity set read: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventActivityRead, map[string]any{})
	return nil
}

// RemoveItems deletes specific items from the user's stream ("Remove from
// activity"), then nudges the user's other devices to refresh.
func (s *ActivityService) RemoveItems(ctx context.Context, userID string, ids []string) error {
	if len(ids) == 0 || len(ids) > activityMaxIDs {
		return ErrActivityIDsInvalid
	}
	if err := s.store.RemoveActivity(ctx, userID, ids); err != nil {
		return fmt.Errorf("activity remove: %w", err)
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventActivityRead, map[string]any{})
	return nil
}

// RecordForRecipients adds one pre-built item per recipient (userID → item) to
// their streams — the notification fan-out's hand-off for mentions, thread
// replies and DMs. Best-effort and off the send path: the writes run on one
// detached goroutine, and a failed write is logged and skipped.
func (s *ActivityService) RecordForRecipients(ctx context.Context, items map[string]*model.ActivityItem) {
	if s.store == nil || len(items) == 0 {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		for userID, item := range items {
			s.addSync(bg, userID, item)
		}
	})
}

// RecordChannelAdded tells a user that someone else added them to a channel.
// No-op when the user added themselves or the channel is unknown.
func (s *ActivityService) RecordChannelAdded(ctx context.Context, actorID, userID string, ch *model.Channel) {
	if ch == nil || actorID == "" || actorID == userID {
		return
	}
	s.add(ctx, userID, &model.ActivityItem{
		ID:          store.NewID(),
		Type:        model.ActivityChannelAdded,
		CreatedAt:   time.Now(),
		ParentID:    ch.ID,
		ParentType:  ParentChannel,
		ChannelSlug: ch.Slug,
		ParentName:  ch.Name,
		ActorID:     actorID,
	})
}
