package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/oklog/ulid/v2"
)

// ActivityStore is the persistence the activity service needs.
type ActivityStore interface {
	AddActivityMany(ctx context.Context, adds []store.ActivityAdd) []store.ActivityAdded
	// ListActivity returns the stream newest-first with each item's read state
	// resolved.
	ListActivity(ctx context.Context, userID string) ([]*model.ActivityFeedItem, error)
	MarkActivitySeen(ctx context.Context, userID string) error
	// SetActivityRead / RemoveActivity return the ids that were in the stream.
	SetActivityRead(ctx context.Context, userID string, ids []string, read bool) ([]string, error)
	RemoveActivity(ctx context.Context, userID string, ids []string) ([]string, error)
	// RemoveActivityForMessages / UpdateActivityPreview return the touched ids
	// per user.
	RemoveActivityForMessages(ctx context.Context, userIDs, messageIDs []string) (map[string][]string, error)
	UpdateActivityPreview(ctx context.Context, userIDs []string, messageID, preview string) (map[string][]string, error)
	RemoveActivityForParent(ctx context.Context, userID, parentID string) ([]string, error)
	MarkActivityParentRead(ctx context.Context, userID, parentKey string, position time.Time) (bool, error)
}

// ChannelSlugResolver resolves a channel id to its slug so a reaction activity
// item can snapshot the slug server-side (matching the reminder/webhook paths)
// instead of the client re-deriving it — which breaks once the author leaves the
// channel. Optional; unset means the slug is left empty.
type ChannelSlugResolver interface {
	GetByID(ctx context.Context, id string) (*model.Channel, error)
}

// ParentMemberLister lists everyone who can read a channel or conversation —
// the users whose streams can hold items about its messages.
type ParentMemberLister interface {
	ParentMemberIDs(ctx context.Context, parentID, parentType string) ([]string, error)
}

// ReminderSync keeps pending reminders in step with access and messages.
// Implemented by ReminderService.
type ReminderSync interface {
	CancelForParent(ctx context.Context, userID, parentID string) ([]string, error)
	CancelForMessages(ctx context.Context, messageIDs []string) (map[string][]string, error)
	RefreshPreview(ctx context.Context, messageID, preview string) (map[string][]string, error)
}

// ActivityReadTracker is told how far a user has read a channel, conversation
// or thread, so the activity items there follow it: reading a DM reads its
// items, and marking a message unread there makes its item unread again.
type ActivityReadTracker interface {
	MarkParentRead(ctx context.Context, userID, parentID, threadRootID string, position time.Time)
}

// ActivityService owns the per-user activity stream (mentions, thread replies,
// DMs, reactions, channel adds and fired reminders) and notifies a user's own
// clients when it changes.
type ActivityService struct {
	store     ActivityStore
	publisher Publisher
	channels  ChannelSlugResolver
	members   ParentMemberLister
	reminders ReminderSync
}

// NewActivityService builds an ActivityService.
func NewActivityService(s ActivityStore, p Publisher) *ActivityService {
	return &ActivityService{store: s, publisher: p}
}

// SetChannelResolver wires the channel-slug resolver used to snapshot the slug
// onto reaction activity items.
func (s *ActivityService) SetChannelResolver(c ChannelSlugResolver) { s.channels = c }

// SetMemberLister wires the parent-member lookup that message edits and
// deletes use to find the streams holding items about the message. Without it
// those items keep their original preview and outlive their message.
func (s *ActivityService) SetMemberLister(m ParentMemberLister) { s.members = m }

// SetReminderSync wires pending reminders into the same access and message
// hooks, so losing a channel or a message also takes its reminders.
func (s *ActivityService) SetReminderSync(r ReminderSync) { s.reminders = r }

// RecordReaction adds a "someone reacted to your message" hint to the message
// author's activity stream. No-op when the reactor is the author themselves, the
// message was posted by a webhook or an agent (a machine has no stream to read),
// or there is no author. Best-effort: failures are logged, never propagated to
// the reaction write that triggered them. Slug resolution + preview building run
// on a detached goroutine, off the reaction request path.
func (s *ActivityService) RecordReaction(ctx context.Context, msg *model.Message, parentType, actorID, emoji string) {
	if msg == nil || msg.AuthorID == "" || msg.AuthorID == actorID || msg.WebhookUsername != "" || msg.AgentRunID != "" || s.store == nil {
		return
	}
	// Snapshot only the small fields the goroutine needs (not the whole *Message)
	// so the closure doesn't pin the message for the store write's lifetime.
	author, msgID, parentID, threadRoot, preview := msg.AuthorID, msg.ID, msg.ParentID, msg.ParentMessageID, notificationBody(msg)
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
			MessagePreview:  activityPreview(preview),
			ActorID:         actorID,
			Emoji:           emoji,
		}
		s.addMany(bg, []store.ActivityAdd{{UserID: author, Item: item}})
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
// messagePreview is the preview text a message gets on an activity item or a
// reminder: its body, or a webhook post's attachment summary.
func messagePreview(msg *model.Message) string {
	return activityPreview(notificationBody(msg))
}

func activityPreview(body string) string {
	return collapseSpace(previewBody(body))
}

// collapseSpace trims s and collapses each whitespace run to one space.
func collapseSpace(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// AddItem appends a pre-built activity item to a user's stream and nudges their
// clients. Used by the reminder service when a reminder fires.
func (s *ActivityService) AddItem(ctx context.Context, userID string, item *model.ActivityItem) {
	s.add(ctx, []store.ActivityAdd{{UserID: userID, Item: item}})
}

// add writes items on a detached goroutine, off the caller's request path.
func (s *ActivityService) add(ctx context.Context, adds []store.ActivityAdd) {
	if s.store == nil {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		s.addMany(bg, adds)
	})
}

// addMany is the synchronous core of add, split out so it can be unit-tested
// without racing the detached goroutine. Writes every item in one pipelined
// batch, then sends each recipient their item (activity.new) in one publish; a
// failed write is logged and its nudge skipped.
func (s *ActivityService) addMany(ctx context.Context, adds []store.ActivityAdd) {
	results := s.store.AddActivityMany(ctx, adds)
	nudges := make([]events.PublishItem, 0, len(adds))
	for i, a := range adds {
		if err := results[i].Err; err != nil {
			slog.Warn("activity add failed", "userID", a.UserID, "type", a.Item.Type, "error", err)
			continue
		}
		// The payload is a plain struct; marshaling it cannot fail.
		if evt, err := events.NewEvent(events.EventActivityNew, model.ActivityNewEvent{
			Item: &model.ActivityFeedItem{ActivityItem: *a.Item, Read: results[i].Read},
		}); err == nil {
			nudges = append(nudges, events.PublishItem{Channel: pubsub.UserChannel(a.UserID), Event: evt})
		}
	}
	events.PublishEach(ctx, s.publisher, nudges)
}

// publishChanged tells the user's clients what changed in their stream.
func (s *ActivityService) publishChanged(ctx context.Context, userID string, change model.ActivityChangedEvent) {
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventActivityRead, change)
}

// publishChangedEach sends each user their own change in one publish.
func (s *ActivityService) publishChangedEach(ctx context.Context, byUser map[string]model.ActivityChangedEvent) {
	items := make([]events.PublishItem, 0, len(byUser))
	for userID, change := range byUser {
		if evt, err := events.NewEvent(events.EventActivityRead, change); err == nil {
			items = append(items, events.PublishItem{Channel: pubsub.UserChannel(userID), Event: evt})
		}
	}
	events.PublishEach(ctx, s.publisher, items)
}

// Feed returns the user's activity items plus the unread counts.
func (s *ActivityService) Feed(ctx context.Context, userID string) (model.ActivityFeed, error) {
	items, err := s.store.ListActivity(ctx, userID)
	if err != nil {
		return model.ActivityFeed{}, fmt.Errorf("activity feed: %w", err)
	}
	feed := model.ActivityFeed{Items: items, UnreadByType: map[model.ActivityType]int{}}
	for _, it := range items {
		if !it.Read {
			feed.Unread++
			feed.UnreadByType[it.Type]++
		}
	}
	return feed, nil
}

// MarkSeen marks every item read, then tells the user's clients so every
// device clears its badge instead of waiting for the next activity.new (SPEC
// GAP-3 / I-4).
func (s *ActivityService) MarkSeen(ctx context.Context, userID string) error {
	if err := s.store.MarkActivitySeen(ctx, userID); err != nil {
		return fmt.Errorf("activity mark seen: %w", err)
	}
	s.publishChanged(ctx, userID, model.ActivityChangedEvent{All: true})
	return nil
}

// validateActivityIDs bounds a per-item request: at least one id, no more than
// a stream can hold, every one a well-formed item id.
func validateActivityIDs(ids []string) error {
	if len(ids) == 0 || len(ids) > store.ActivityMaxItems {
		return fmt.Errorf("%w: ids must list between 1 and %d items", ErrValidation, store.ActivityMaxItems)
	}
	for _, id := range ids {
		if _, err := ulid.ParseStrict(id); err != nil {
			return fmt.Errorf("%w: %q is not an activity item id", ErrValidation, id)
		}
	}
	return nil
}

// SetItemsRead marks specific items read or unread (the Activity tab's "Mark as
// read" / "Mark as unread"), then tells the user's clients which items flipped.
// Ids not in the stream are ignored.
func (s *ActivityService) SetItemsRead(ctx context.Context, userID string, ids []string, read bool) error {
	if err := validateActivityIDs(ids); err != nil {
		return err
	}
	applied, err := s.store.SetActivityRead(ctx, userID, ids, read)
	if err != nil {
		return fmt.Errorf("activity set read: %w", err)
	}
	if len(applied) > 0 {
		s.publishChanged(ctx, userID, model.ActivityChangedEvent{IDs: applied, Read: &read})
	}
	return nil
}

// RemoveItems deletes specific items from the user's stream ("Remove from
// activity"), then tells the user's clients which items are gone. Ids not in
// the stream are ignored.
func (s *ActivityService) RemoveItems(ctx context.Context, userID string, ids []string) error {
	if err := validateActivityIDs(ids); err != nil {
		return err
	}
	removed, err := s.store.RemoveActivity(ctx, userID, ids)
	if err != nil {
		return fmt.Errorf("activity remove: %w", err)
	}
	if len(removed) > 0 {
		s.publishChanged(ctx, userID, model.ActivityChangedEvent{Removed: removed})
	}
	return nil
}

// RecordForRecipients adds one pre-built item per recipient (userID → item) to
// their streams — the notification fan-out's hand-off for mentions, thread
// replies and DMs. Best-effort and off the send path: one detached goroutine
// writes them all in a pipelined batch.
func (s *ActivityService) RecordForRecipients(ctx context.Context, items map[string]*model.ActivityItem) {
	if len(items) == 0 {
		return
	}
	adds := make([]store.ActivityAdd, 0, len(items))
	for userID, item := range items {
		adds = append(adds, store.ActivityAdd{UserID: userID, Item: item})
	}
	s.add(ctx, adds)
}

// RecordChannelAdded tells a user that someone else added them to a channel.
// No-op when the user added themselves or the channel is unknown. Being added
// to the same channel again replaces the earlier item.
func (s *ActivityService) RecordChannelAdded(ctx context.Context, actorID, userID string, ch *model.Channel) {
	if ch == nil || actorID == "" || actorID == userID {
		return
	}
	s.add(ctx, []store.ActivityAdd{{UserID: userID, Item: &model.ActivityItem{
		ID:          store.NewID(),
		Type:        model.ActivityChannelAdded,
		CreatedAt:   time.Now(),
		ParentID:    ch.ID,
		ParentType:  ParentChannel,
		ChannelSlug: ch.Slug,
		ParentName:  ch.Name,
		ActorID:     actorID,
	}}})
}

// MarkParentRead records that the user has read a channel or conversation (or,
// with threadRootID, a thread) up to position, so the items there follow:
// mark-read passes now, mark-unread the instant before the message that became
// unread. Tells the user's clients when that can flip an item. Synchronous, so
// a quick read-then-unread can't land out of order; best-effort, because the
// read itself has already been saved.
func (s *ActivityService) MarkParentRead(ctx context.Context, userID, parentID, threadRootID string, position time.Time) {
	changed, err := s.store.MarkActivityParentRead(ctx, userID, store.ActivityParentKey(parentID, threadRootID), position)
	if err != nil {
		slog.Warn("activity parent read failed", "userID", userID, "parentID", parentID, "threadRootID", threadRootID, "error", err)
		return
	}
	if changed {
		s.publishChanged(ctx, userID, model.ActivityChangedEvent{ParentID: parentID, ThreadRootID: threadRootID})
	}
}

// ParentLeft drops a channel's or conversation's items from a user's stream,
// and cancels their pending reminders there, once they can no longer read it
// (they left or were removed) — neither may keep showing its messages.
func (s *ActivityService) ParentLeft(ctx context.Context, userID, parentID string) {
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		var change model.ActivityChangedEvent
		if removed, err := s.store.RemoveActivityForParent(bg, userID, parentID); err != nil {
			slog.Warn("activity parent cleanup failed", "userID", userID, "parentID", parentID, "error", err)
		} else {
			change.Removed = removed
		}
		if s.reminders != nil {
			cancelled, err := s.reminders.CancelForParent(bg, userID, parentID)
			if err != nil {
				slog.Warn("reminder parent cleanup failed", "userID", userID, "parentID", parentID, "error", err)
			}
			change.Reminders = len(cancelled) > 0
		}
		if len(change.Removed) > 0 || change.Reminders {
			s.publishChanged(bg, userID, change)
		}
	})
}

// RemindersChanged tells a user's clients their pending reminders changed (one
// was scheduled or cancelled).
func (s *ActivityService) RemindersChanged(ctx context.Context, userID string) {
	s.publishChanged(ctx, userID, model.ActivityChangedEvent{Reminders: true})
}

// MessagesDeleted drops the items about deleted messages from the streams of
// the parent's members, and cancels every pending reminder about them.
func (s *ActivityService) MessagesDeleted(ctx context.Context, parentID, parentType string, messageIDs []string) {
	if len(messageIDs) == 0 {
		return
	}
	s.syncMessage(ctx, parentID, parentType, messageSync{
		items: func(bg context.Context, userIDs []string) (map[string][]string, error) {
			return s.store.RemoveActivityForMessages(bg, userIDs, messageIDs)
		},
		mark: func(change *model.ActivityChangedEvent, ids []string) { change.Removed = ids },
		reminders: func(bg context.Context) (map[string][]string, error) {
			return s.reminders.CancelForMessages(bg, messageIDs)
		},
	})
}

// MessageEdited refreshes the preview on the items, and the pending reminders,
// about an edited message — text edited out must not live on in either.
func (s *ActivityService) MessageEdited(ctx context.Context, msg *model.Message, parentType string) {
	msgID, parentID, preview := msg.ID, msg.ParentID, messagePreview(msg)
	s.syncMessage(ctx, parentID, parentType, messageSync{
		items: func(bg context.Context, userIDs []string) (map[string][]string, error) {
			return s.store.UpdateActivityPreview(bg, userIDs, msgID, preview)
		},
		mark: func(change *model.ActivityChangedEvent, ids []string) { change.Updated = ids },
		reminders: func(bg context.Context) (map[string][]string, error) {
			return s.reminders.RefreshPreview(bg, msgID, preview)
		},
	})
}

// messageSync is one message change applied to activity items (over the
// parent's members) and to pending reminders (over their owners).
type messageSync struct {
	items     func(context.Context, []string) (map[string][]string, error)
	mark      func(*model.ActivityChangedEvent, []string)
	reminders func(context.Context) (map[string][]string, error)
}

// syncMessage applies a message change on a detached goroutine and tells each
// touched user what changed. A failure is logged; users whose part succeeded
// are still told.
func (s *ActivityService) syncMessage(ctx context.Context, parentID, parentType string, sync messageSync) {
	if s.members == nil && s.reminders == nil {
		return
	}
	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		byUser := map[string]model.ActivityChangedEvent{}
		if s.members != nil {
			if userIDs, err := s.members.ParentMemberIDs(bg, parentID, parentType); err != nil {
				slog.Warn("activity member lookup failed", "parentID", parentID, "error", err)
			} else {
				touched, err := sync.items(bg, userIDs)
				if err != nil {
					slog.Warn("activity message sync failed", "parentID", parentID, "error", err)
				}
				for userID, ids := range touched {
					change := byUser[userID]
					sync.mark(&change, ids)
					byUser[userID] = change
				}
			}
		}
		if s.reminders != nil {
			owners, err := sync.reminders(bg)
			if err != nil {
				slog.Warn("reminder message sync failed", "parentID", parentID, "error", err)
			}
			for userID := range owners {
				change := byUser[userID]
				change.Reminders = true
				byUser[userID] = change
			}
		}
		s.publishChangedEach(bg, byUser)
	})
}
