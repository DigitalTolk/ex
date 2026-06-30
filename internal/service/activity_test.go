package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// fakeActivityStore is an in-memory ActivityStore for service tests.
type fakeActivityStore struct {
	mu       sync.Mutex
	items    map[string][]*model.ActivityItem
	unread   int
	addErr   error
	listErr  error
	unrErr   error
	seenErr  error
	seenCnt  int
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

func TestPreviewText(t *testing.T) {
	if got := PreviewText("  hello   world\n\tfoo "); got != "hello world foo" {
		t.Fatalf("collapse = %q", got)
	}
	long := strings.Repeat("a", activityPreviewMax+50)
	got := PreviewText(long)
	if []rune(got)[len([]rune(got))-1] != '…' {
		t.Fatalf("long preview should end with ellipsis, got %q", got)
	}
	if utf8Len(got) != activityPreviewMax+1 {
		t.Fatalf("truncated length = %d", utf8Len(got))
	}
}

func utf8Len(s string) int { return len([]rune(s)) }

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
