package service

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// fakeActivityStore is an in-memory ActivityStore for service tests.
type fakeActivityStore struct {
	mu      sync.Mutex
	items   map[string][]*model.ActivityItem
	unread  int
	addErr  error
	listErr error
	unrErr  error
	seenErr error
	seenCnt int
}

func newFakeActivityStore() *fakeActivityStore {
	return &fakeActivityStore{items: map[string][]*model.ActivityItem{}}
}

func (f *fakeActivityStore) AddActivity(_ context.Context, userID string, item *model.ActivityItem) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.addErr != nil {
		return f.addErr
	}
	f.items[userID] = append(f.items[userID], item)
	return nil
}

func (f *fakeActivityStore) ListActivity(_ context.Context, userID string) ([]*model.ActivityItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.items[userID], nil
}

func (f *fakeActivityStore) UnreadActivityCount(context.Context, string) (int, error) {
	if f.unrErr != nil {
		return 0, f.unrErr
	}
	return f.unread, nil
}

func (f *fakeActivityStore) MarkActivitySeen(context.Context, string) error {
	f.seenCnt++
	return f.seenErr
}

func (f *fakeActivityStore) count(userID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.items[userID])
}

func reactedMessage(author string) *model.Message {
	return &model.Message{ID: "m-1", ParentID: "ch-1", AuthorID: author, Body: "hello world"}
}

func TestActivityService_RecordReactionSkips(t *testing.T) {
	store := newFakeActivityStore()
	svc := NewActivityService(store, newMockPublisher())
	ctx := context.Background()

	// nil message, empty author, self-reaction, and webhook bot all skip.
	svc.RecordReaction(ctx, nil, ParentChannel, "u-2", "👍")
	svc.RecordReaction(ctx, &model.Message{ID: "m", AuthorID: ""}, ParentChannel, "u-2", "👍")
	svc.RecordReaction(ctx, reactedMessage("u-1"), ParentChannel, "u-1", "👍")
	bot := reactedMessage("u-1")
	bot.WebhookUsername = "alertbot"
	svc.RecordReaction(ctx, bot, ParentChannel, "u-2", "👍")

	if got := store.count("u-1"); got != 0 {
		t.Fatalf("expected no activity recorded for skip cases, got %d", got)
	}

	// A service with no store also no-ops (guard on the reaction path).
	NewActivityService(nil, newMockPublisher()).RecordReaction(ctx, reactedMessage("u-1"), ParentChannel, "u-2", "👍")
}

func TestActivityService_RecordReactionAddsForAuthor(t *testing.T) {
	store := newFakeActivityStore()
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	svc.RecordReaction(context.Background(), reactedMessage("author-1"), ParentChannel, "reactor-2", "🎉")

	waitForCond(t, func() bool { return store.count("author-1") == 1 }, "reaction activity recorded")
	items := store.items["author-1"]
	if items[0].Type != model.ActivityReaction || items[0].ActorID != "reactor-2" || items[0].Emoji != "🎉" {
		t.Fatalf("unexpected activity item %+v", items[0])
	}
	if items[0].MessagePreview != "hello world" {
		t.Fatalf("preview = %q", items[0].MessagePreview)
	}
	waitForCond(t, func() bool { return activityPublishedFor(pub, "author-1") }, "activity.new published to author")
}

type fakeChannelResolver struct {
	ch  *model.Channel
	err error
}

func (f *fakeChannelResolver) GetByID(context.Context, string) (*model.Channel, error) {
	return f.ch, f.err
}

func TestActivityService_RecordReactionSnapshotsChannelSlug(t *testing.T) {
	store := newFakeActivityStore()
	svc := NewActivityService(store, newMockPublisher())
	svc.SetChannelResolver(&fakeChannelResolver{ch: &model.Channel{ID: "ch-1", Slug: "general"}})

	svc.RecordReaction(context.Background(), reactedMessage("author-1"), ParentChannel, "reactor-2", "🎉")

	waitForCond(t, func() bool { return store.count("author-1") == 1 }, "reaction recorded")
	if got := store.items["author-1"][0].ChannelSlug; got != "general" {
		t.Fatalf("ChannelSlug = %q, want general", got)
	}
}

func TestActivityService_ResolveChannelSlug(t *testing.T) {
	ctx := context.Background()
	// No resolver → "".
	bare := NewActivityService(newFakeActivityStore(), newMockPublisher())
	if got := bare.resolveChannelSlug(ctx, ParentChannel, "ch-1"); got != "" {
		t.Fatalf("no resolver = %q, want empty", got)
	}
	// Conversation parent → "" even with a resolver.
	conv := NewActivityService(newFakeActivityStore(), newMockPublisher())
	conv.SetChannelResolver(&fakeChannelResolver{ch: &model.Channel{Slug: "x"}})
	if got := conv.resolveChannelSlug(ctx, ParentConversation, "conv-1"); got != "" {
		t.Fatalf("conversation = %q, want empty", got)
	}
	// Resolver error → "".
	errSvc := NewActivityService(newFakeActivityStore(), newMockPublisher())
	errSvc.SetChannelResolver(&fakeChannelResolver{err: errors.New("boom")})
	if got := errSvc.resolveChannelSlug(ctx, ParentChannel, "ch-1"); got != "" {
		t.Fatalf("resolver error = %q, want empty", got)
	}
	// Resolver returns no channel (nil, nil) → "".
	nilCh := NewActivityService(newFakeActivityStore(), newMockPublisher())
	nilCh.SetChannelResolver(&fakeChannelResolver{})
	if got := nilCh.resolveChannelSlug(ctx, ParentChannel, "ch-1"); got != "" {
		t.Fatalf("nil channel = %q, want empty", got)
	}
}

func TestActivityPreview(t *testing.T) {
	// Collapses whitespace runs / tabs / leading-trailing.
	if got := activityPreview("  hello\t\tthere  "); got != "hello there" {
		t.Fatalf("collapse = %q", got)
	}
	// Whitespace-only body collapses to "" so the client shows its fallback.
	if got := activityPreview(" \n\t "); got != "" {
		t.Fatalf("whitespace-only = %q, want empty", got)
	}
}

func TestActivityService_AddItem(t *testing.T) {
	store := newFakeActivityStore()
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)
	svc.AddItem(context.Background(), "u-9", &model.ActivityItem{ID: "a", Type: model.ActivityReminder})
	waitForCond(t, func() bool { return store.count("u-9") == 1 }, "AddItem persisted")
	waitForCond(t, func() bool { return activityPublishedFor(pub, "u-9") }, "AddItem published")
}

func TestActivityService_AddSyncStoreErrorSkipsPublish(t *testing.T) {
	store := newFakeActivityStore()
	store.addErr = errors.New("boom")
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	svc.addSync(context.Background(), "u-1", &model.ActivityItem{ID: "a", Type: model.ActivityReminder})

	pub.mu.Lock()
	defer pub.mu.Unlock()
	if len(pub.published) != 0 {
		t.Fatalf("a store failure must skip the nudge, got %d publishes", len(pub.published))
	}
}

func TestActivityService_FeedAndMarkSeen(t *testing.T) {
	store := newFakeActivityStore()
	store.items["u-1"] = []*model.ActivityItem{{ID: "a"}, {ID: "b"}}
	store.unread = 2
	svc := NewActivityService(store, newMockPublisher())
	ctx := context.Background()

	feed, err := svc.Feed(ctx, "u-1")
	if err != nil || len(feed.Items) != 2 || feed.Unread != 2 {
		t.Fatalf("Feed = %+v, %v", feed, err)
	}
	if err := svc.MarkSeen(ctx, "u-1"); err != nil || store.seenCnt != 1 {
		t.Fatalf("MarkSeen = %v, seenCnt=%d", err, store.seenCnt)
	}
}

func TestActivityService_FeedErrors(t *testing.T) {
	listErrStore := newFakeActivityStore()
	listErrStore.listErr = errors.New("list boom")
	if _, err := NewActivityService(listErrStore, newMockPublisher()).Feed(context.Background(), "u-1"); err == nil {
		t.Error("expected list error")
	}
	unrErrStore := newFakeActivityStore()
	unrErrStore.unrErr = errors.New("unread boom")
	if _, err := NewActivityService(unrErrStore, newMockPublisher()).Feed(context.Background(), "u-1"); err == nil {
		t.Error("expected unread error")
	}
	seenErrStore := newFakeActivityStore()
	seenErrStore.seenErr = errors.New("seen boom")
	if err := NewActivityService(seenErrStore, newMockPublisher()).MarkSeen(context.Background(), "u-1"); err == nil {
		t.Error("expected seen error")
	}
}

func TestActivityService_AddItemNilStore(t *testing.T) {
	// A service with no store no-ops rather than panicking.
	svc := NewActivityService(nil, newMockPublisher())
	svc.AddItem(context.Background(), "u-1", &model.ActivityItem{ID: "a"})
}

func activityPublishedFor(pub *mockPublisher, userID string) bool {
	pub.mu.Lock()
	defer pub.mu.Unlock()
	for _, p := range pub.published {
		if p.event.Type == events.EventActivityNew {
			return true
		}
	}
	_ = userID
	return false
}
