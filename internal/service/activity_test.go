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
	mu        sync.Mutex
	items     map[string][]*model.ActivityItem
	addErr    error
	listErr   error
	seenErr   error
	readErr   error
	removeErr error
	seenCnt   int
	readIDs   []string
	readAs    bool
	removed   []string
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

func (f *fakeActivityStore) SetActivityRead(_ context.Context, _ string, ids []string, read bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.readIDs, f.readAs = ids, read
	return f.readErr
}

func (f *fakeActivityStore) RemoveActivity(_ context.Context, _ string, ids []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.removed = ids
	return f.removeErr
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

// A reaction on a thread reply snapshots the thread root so the activity row
// can open the thread — the reply never renders in the main list.
func TestActivityService_RecordReactionCarriesThreadRoot(t *testing.T) {
	store := newFakeActivityStore()
	svc := NewActivityService(store, newMockPublisher())
	reply := reactedMessage("author-1")
	reply.ParentMessageID = "root-1"

	svc.RecordReaction(context.Background(), reply, ParentChannel, "reactor-2", "🎉")

	waitForCond(t, func() bool { return store.count("author-1") == 1 }, "reaction recorded")
	if got := store.items["author-1"][0].ParentMessageID; got != "root-1" {
		t.Fatalf("ParentMessageID = %q, want root-1", got)
	}
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
	store.items["u-1"] = []*model.ActivityItem{
		{ID: "a", Type: model.ActivityMention},
		{ID: "b", Type: model.ActivityMention},
		{ID: "c", Type: model.ActivityDM},
		{ID: "d", Type: model.ActivityReaction, Read: true},
	}
	svc := NewActivityService(store, newMockPublisher())
	ctx := context.Background()

	feed, err := svc.Feed(ctx, "u-1")
	if err != nil || len(feed.Items) != 4 || feed.Unread != 3 {
		t.Fatalf("Feed = %+v, %v", feed, err)
	}
	if feed.UnreadByType[model.ActivityMention] != 2 || feed.UnreadByType[model.ActivityDM] != 1 || feed.UnreadByType[model.ActivityReaction] != 0 {
		t.Fatalf("UnreadByType = %v", feed.UnreadByType)
	}
	if err := svc.MarkSeen(ctx, "u-1"); err != nil || store.seenCnt != 1 {
		t.Fatalf("MarkSeen = %v, seenCnt=%d", err, store.seenCnt)
	}
}

// A successful MarkSeen must nudge the user's other devices (activity.read) so
// their badges clear — the missing event was SPEC GAP-3 (mobile read left the
// desktop badge lit until the next activity.new).
func TestActivityService_MarkSeenPublishesActivityRead(t *testing.T) {
	pub := newMockPublisher()
	svc := NewActivityService(newFakeActivityStore(), pub)

	if err := svc.MarkSeen(context.Background(), "u-1"); err != nil {
		t.Fatalf("MarkSeen = %v", err)
	}
	if !activityEventPublished(pub, events.EventActivityRead) {
		t.Fatal("MarkSeen must publish activity.read to the user channel")
	}
}

// A failed watermark write must NOT claim the feed was read on other devices.
func TestActivityService_MarkSeenStoreErrorSkipsPublish(t *testing.T) {
	store := newFakeActivityStore()
	store.seenErr = errors.New("boom")
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	if err := svc.MarkSeen(context.Background(), "u-1"); err == nil {
		t.Fatal("expected seen error")
	}
	if activityEventPublished(pub, events.EventActivityRead) {
		t.Fatal("a store failure must skip the activity.read nudge")
	}
}

func TestActivityService_FeedErrors(t *testing.T) {
	listErrStore := newFakeActivityStore()
	listErrStore.listErr = errors.New("list boom")
	if _, err := NewActivityService(listErrStore, newMockPublisher()).Feed(context.Background(), "u-1"); err == nil {
		t.Error("expected list error")
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
	_ = userID
	return activityEventPublished(pub, events.EventActivityNew)
}

func activityEventPublished(pub *mockPublisher, eventType string) bool {
	pub.mu.Lock()
	defer pub.mu.Unlock()
	for _, p := range pub.published {
		if p.event.Type == eventType {
			return true
		}
	}
	return false
}

func TestActivityService_SetItemsRead(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	if err := svc.SetItemsRead(ctx, "u-1", []string{"a", "b"}, false); err != nil {
		t.Fatalf("SetItemsRead: %v", err)
	}
	if len(store.readIDs) != 2 || store.readAs {
		t.Fatalf("store got ids=%v read=%v", store.readIDs, store.readAs)
	}
	if !activityEventPublished(pub, events.EventActivityRead) {
		t.Fatal("SetItemsRead must publish activity.read")
	}

	// Empty and oversized id lists are rejected before the store.
	if err := svc.SetItemsRead(ctx, "u-1", nil, true); !errors.Is(err, ErrActivityIDsInvalid) {
		t.Fatalf("empty ids = %v", err)
	}
	if err := svc.SetItemsRead(ctx, "u-1", make([]string, activityMaxIDs+1), true); !errors.Is(err, ErrActivityIDsInvalid) {
		t.Fatalf("too many ids = %v", err)
	}

	// A store failure is returned and skips the nudge.
	failing := newFakeActivityStore()
	failing.readErr = errors.New("boom")
	failPub := newMockPublisher()
	if err := NewActivityService(failing, failPub).SetItemsRead(ctx, "u-1", []string{"a"}, true); err == nil {
		t.Fatal("expected store error")
	}
	if activityEventPublished(failPub, events.EventActivityRead) {
		t.Fatal("a store failure must skip the activity.read nudge")
	}
}

func TestActivityService_RemoveItems(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	if err := svc.RemoveItems(ctx, "u-1", []string{"a"}); err != nil {
		t.Fatalf("RemoveItems: %v", err)
	}
	if len(store.removed) != 1 || store.removed[0] != "a" {
		t.Fatalf("store removed %v", store.removed)
	}
	if !activityEventPublished(pub, events.EventActivityRead) {
		t.Fatal("RemoveItems must publish activity.read")
	}
	if err := svc.RemoveItems(ctx, "u-1", nil); !errors.Is(err, ErrActivityIDsInvalid) {
		t.Fatalf("empty ids = %v", err)
	}
	if err := svc.RemoveItems(ctx, "u-1", make([]string, activityMaxIDs+1)); !errors.Is(err, ErrActivityIDsInvalid) {
		t.Fatalf("too many ids = %v", err)
	}

	failing := newFakeActivityStore()
	failing.removeErr = errors.New("boom")
	failPub := newMockPublisher()
	if err := NewActivityService(failing, failPub).RemoveItems(ctx, "u-1", []string{"a"}); err == nil {
		t.Fatal("expected store error")
	}
	if activityEventPublished(failPub, events.EventActivityRead) {
		t.Fatal("a store failure must skip the activity.read nudge")
	}
}

func TestActivityService_RecordForRecipients(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	svc := NewActivityService(store, newMockPublisher())

	// Nothing to record, and no store, are both no-ops.
	svc.RecordForRecipients(ctx, nil)
	NewActivityService(nil, newMockPublisher()).RecordForRecipients(ctx, map[string]*model.ActivityItem{"u-1": {ID: "x"}})

	svc.RecordForRecipients(ctx, map[string]*model.ActivityItem{
		"u-1": {ID: "a", Type: model.ActivityMention},
		"u-2": {ID: "b", Type: model.ActivityDM},
	})
	waitForCond(t, func() bool { return store.count("u-1") == 1 && store.count("u-2") == 1 }, "recipient items recorded")
}

func TestActivityService_RecordChannelAdded(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	svc := NewActivityService(store, newMockPublisher())
	ch := &model.Channel{ID: "ch-1", Slug: "design-review", Name: "Design Review"}

	// Self-adds, a missing actor and an unknown channel record nothing.
	svc.RecordChannelAdded(ctx, "u-1", "u-1", ch)
	svc.RecordChannelAdded(ctx, "", "u-1", ch)
	svc.RecordChannelAdded(ctx, "u-2", "u-1", nil)

	svc.RecordChannelAdded(ctx, "u-2", "u-1", ch)
	waitForCond(t, func() bool { return store.count("u-1") == 1 }, "channel-added item recorded")
	store.mu.Lock()
	got := store.items["u-1"][0]
	store.mu.Unlock()
	if got.Type != model.ActivityChannelAdded || got.ActorID != "u-2" || got.ParentID != "ch-1" ||
		got.ChannelSlug != "design-review" || got.ParentName != "Design Review" || got.ParentType != ParentChannel {
		t.Fatalf("unexpected item %+v", got)
	}
}
