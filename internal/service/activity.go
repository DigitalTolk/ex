package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
)

// activityPreviewMax bounds the plain-text excerpt stored on an activity item.
const activityPreviewMax = 140

// ActivityStore is the persistence the activity service needs.
type ActivityStore interface {
	AddActivity(ctx context.Context, userID string, item *model.ActivityItem) error
	ListActivity(ctx context.Context, userID string) ([]*model.ActivityItem, error)
	UnreadActivityCount(ctx context.Context, userID string) (int, error)
	MarkActivitySeen(ctx context.Context, userID string) error
}

// ActivityFeed is the read model returned to a user's client.
type ActivityFeed struct {
	Items  []*model.ActivityItem `json:"items"`
	Unread int                   `json:"unread"`
}

// ActivityService owns the per-user activity stream (reaction hints + fired
// reminders) and notifies a user's own clients when it changes.
type ActivityService struct {
	store     ActivityStore
	publisher Publisher
}

// NewActivityService builds an ActivityService.
func NewActivityService(s ActivityStore, p Publisher) *ActivityService {
	return &ActivityService{store: s, publisher: p}
}

// RecordReaction adds a "someone reacted to your message" hint to the message
// author's activity stream. No-op when the reactor is the author themselves, the
// author is the webhook sentinel (a bot message has no human owner to notify), or
// there is no author. Best-effort: failures are logged, never propagated to the
// reaction write that triggered them.
func (s *ActivityService) RecordReaction(ctx context.Context, msg *model.Message, parentType, actorID, emoji string) {
	if msg == nil || msg.AuthorID == "" || msg.AuthorID == actorID || msg.WebhookUsername != "" {
		return
	}
	item := &model.ActivityItem{
		ID:             store.NewID(),
		Type:           model.ActivityReaction,
		CreatedAt:      time.Now(),
		MessageID:      msg.ID,
		ParentID:       msg.ParentID,
		ParentType:     parentType,
		MessagePreview: PreviewText(msg.Body),
		ActorID:        actorID,
		Emoji:          emoji,
	}
	s.add(ctx, msg.AuthorID, item)
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

// Feed returns the user's activity items plus the unread count.
func (s *ActivityService) Feed(ctx context.Context, userID string) (ActivityFeed, error) {
	items, err := s.store.ListActivity(ctx, userID)
	if err != nil {
		return ActivityFeed{}, fmt.Errorf("activity feed: %w", err)
	}
	unread, err := s.store.UnreadActivityCount(ctx, userID)
	if err != nil {
		return ActivityFeed{}, fmt.Errorf("activity unread: %w", err)
	}
	return ActivityFeed{Items: items, Unread: unread}, nil
}

// MarkSeen advances the user's read watermark so the unread badge clears.
func (s *ActivityService) MarkSeen(ctx context.Context, userID string) error {
	if err := s.store.MarkActivitySeen(ctx, userID); err != nil {
		return fmt.Errorf("activity mark seen: %w", err)
	}
	return nil
}

// PreviewText produces a short, single-line plain-text excerpt of a message body
// for an activity row or reminder. Collapses whitespace and truncates on a rune
// boundary with an ellipsis.
func PreviewText(body string) string {
	collapsed := strings.Join(strings.Fields(body), " ")
	if utf8.RuneCountInString(collapsed) <= activityPreviewMax {
		return collapsed
	}
	runes := []rune(collapsed)
	return string(runes[:activityPreviewMax]) + "…"
}
