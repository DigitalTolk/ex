package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// fakeActivityStore is an in-memory ActivityStore for service tests. The
// per-item and per-message methods answer with the canned results below and
// record what they were asked.
type fakeActivityStore struct {
	mu      sync.Mutex
	items   map[string][]*model.ActivityItem
	readFor map[string]bool // item id → already read on add
	addErr  map[string]error

	listItems []*model.ActivityFeedItem
	listErr   error
	seenErr   error
	seenCnt   int

	readIDs []string
	readAs  bool
	applied []string
	readErr error

	removed   []string
	gone      []string
	removeErr error

	msgUsers   []string
	msgIDs     []string
	preview    string
	touched    map[string][]string
	perUserErr error

	parentUser, parentID string
	parentGone           []string
	parentErr            error

	parentKey string
	position  time.Time
	changed   bool
	posErr    error
}

func newFakeActivityStore() *fakeActivityStore {
	return &fakeActivityStore{items: map[string][]*model.ActivityItem{}, readFor: map[string]bool{}, addErr: map[string]error{}}
}

func (f *fakeActivityStore) AddActivityMany(_ context.Context, adds []store.ActivityAdd) []store.ActivityAdded {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]store.ActivityAdded, len(adds))
	for i, a := range adds {
		if err := f.addErr[a.UserID]; err != nil {
			out[i].Err = err
			continue
		}
		f.items[a.UserID] = append(f.items[a.UserID], a.Item)
		out[i].Read = f.readFor[a.Item.ID]
	}
	return out
}

func (f *fakeActivityStore) ListActivity(context.Context, string) ([]*model.ActivityFeedItem, error) {
	return f.listItems, f.listErr
}

func (f *fakeActivityStore) MarkActivitySeen(context.Context, string) error {
	f.seenCnt++
	return f.seenErr
}

func (f *fakeActivityStore) SetActivityRead(_ context.Context, _ string, ids []string, read bool) ([]string, error) {
	f.readIDs, f.readAs = ids, read
	return f.applied, f.readErr
}

func (f *fakeActivityStore) RemoveActivity(_ context.Context, _ string, ids []string) ([]string, error) {
	f.removed = ids
	return f.gone, f.removeErr
}

func (f *fakeActivityStore) RemoveActivityForMessages(_ context.Context, userIDs, messageIDs []string) (map[string][]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgUsers, f.msgIDs = userIDs, messageIDs
	return f.touched, f.perUserErr
}

func (f *fakeActivityStore) UpdateActivityPreview(_ context.Context, userIDs []string, messageID, preview string) (map[string][]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.msgUsers, f.msgIDs, f.preview = userIDs, []string{messageID}, preview
	return f.touched, f.perUserErr
}

func (f *fakeActivityStore) RemoveActivityForParent(_ context.Context, userID, parentID string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.parentUser, f.parentID = userID, parentID
	return f.parentGone, f.parentErr
}

func (f *fakeActivityStore) MarkActivityParentRead(_ context.Context, _ string, parentKey string, position time.Time) (bool, error) {
	f.parentKey, f.position = parentKey, position
	return f.changed, f.posErr
}

func (f *fakeActivityStore) count(userID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.items[userID])
}

func (f *fakeActivityStore) first(userID string) *model.ActivityItem {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.items[userID][0]
}

func (f *fakeActivityStore) lastMessageCall() (users, ids []string, preview string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.msgUsers, f.msgIDs, f.preview
}

// fakeMemberLister answers ParentMemberIDs.
type fakeMemberLister struct {
	ids []string
	err error
}

func (f *fakeMemberLister) ParentMemberIDs(context.Context, string, string) ([]string, error) {
	return f.ids, f.err
}

func reactedMessage(author string) *model.Message {
	return &model.Message{ID: "m-1", ParentID: "ch-1", AuthorID: author, Body: "hello world"}
}

// activityEvents returns the payloads of every eventType event published to
// userID's channel, decoded into T.
func activityEvents[T any](t *testing.T, pub *mockPublisher, userID, eventType string) []T {
	t.Helper()
	pub.mu.Lock()
	defer pub.mu.Unlock()
	var out []T
	for _, p := range pub.published {
		if p.channel != pubsub.UserChannel(userID) || p.event.Type != eventType {
			continue
		}
		var v T
		if err := json.Unmarshal(p.event.Data, &v); err != nil {
			t.Fatalf("decode %s: %v", eventType, err)
		}
		out = append(out, v)
	}
	return out
}

func changes(t *testing.T, pub *mockPublisher, userID string) []model.ActivityChangedEvent {
	t.Helper()
	return activityEvents[model.ActivityChangedEvent](t, pub, userID, events.EventActivityRead)
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

func TestActivityService_RecordReactionSkips(t *testing.T) {
	store := newFakeActivityStore()
	svc := NewActivityService(store, newMockPublisher())
	ctx := context.Background()

	// nil message, empty author, self-reaction, a webhook post and an agent
	// post all skip: a machine has nobody to read its stream.
	svc.RecordReaction(ctx, nil, ParentChannel, "u-2", "👍")
	svc.RecordReaction(ctx, &model.Message{ID: "m", AuthorID: ""}, ParentChannel, "u-2", "👍")
	svc.RecordReaction(ctx, reactedMessage("u-1"), ParentChannel, "u-1", "👍")
	bot := reactedMessage("u-1")
	bot.WebhookUsername = "alertbot"
	svc.RecordReaction(ctx, bot, ParentChannel, "u-2", "👍")
	agent := reactedMessage("u-1")
	agent.AgentRunID = "run-1"
	svc.RecordReaction(ctx, agent, ParentChannel, "u-2", "👍")

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
	item := store.first("author-1")
	if item.Type != model.ActivityReaction || item.ActorID != "reactor-2" || item.Emoji != "🎉" {
		t.Fatalf("unexpected activity item %+v", item)
	}
	if item.MessagePreview != "hello world" {
		t.Fatalf("preview = %q", item.MessagePreview)
	}
	waitForCond(t, func() bool { return activityEventPublished(pub, events.EventActivityNew) }, "activity.new published to author")
}

// A reaction on an attachment-only message previews the attachment, like the
// notification for it did.
func TestActivityService_RecordReactionPreviewsAttachment(t *testing.T) {
	store := newFakeActivityStore()
	svc := NewActivityService(store, newMockPublisher())
	msg := reactedMessage("author-1")
	msg.Body = ""
	msg.MessageAttachments = []model.MessageAttachment{{Fallback: "Deploy finished"}}

	svc.RecordReaction(context.Background(), msg, ParentChannel, "reactor-2", "🎉")

	waitForCond(t, func() bool { return store.count("author-1") == 1 }, "reaction recorded")
	if got := store.first("author-1").MessagePreview; got != "Deploy finished" {
		t.Fatalf("preview = %q", got)
	}
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
	if got := store.first("author-1").ParentMessageID; got != "root-1" {
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
	if got := store.first("author-1").ChannelSlug; got != "general" {
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
	waitForCond(t, func() bool { return activityEventPublished(pub, events.EventActivityNew) }, "AddItem published")
}

func TestActivityService_AddItemNilStore(t *testing.T) {
	// A service with no store no-ops rather than panicking.
	svc := NewActivityService(nil, newMockPublisher())
	svc.AddItem(context.Background(), "u-1", &model.ActivityItem{ID: "a"})
}

// Each recipient is sent their own item with its read state; a recipient
// whose write failed is sent nothing.
func TestActivityService_AddManyPublishesEachItem(t *testing.T) {
	fake := newFakeActivityStore()
	fake.addErr["u-3"] = errors.New("boom")
	fake.readFor["b"] = true
	pub := newMockPublisher()
	svc := NewActivityService(fake, pub)

	svc.addMany(context.Background(), []store.ActivityAdd{
		{UserID: "u-1", Item: &model.ActivityItem{ID: "a", Type: model.ActivityMention, MessageID: "m-1"}},
		{UserID: "u-2", Item: &model.ActivityItem{ID: "b", Type: model.ActivityDM}},
		{UserID: "u-3", Item: &model.ActivityItem{ID: "c", Type: model.ActivityDM}},
	})

	got1 := activityEvents[model.ActivityNewEvent](t, pub, "u-1", events.EventActivityNew)
	if len(got1) != 1 || got1[0].Item.ID != "a" || got1[0].Item.MessageID != "m-1" || got1[0].Item.Read {
		t.Fatalf("u-1 activity.new = %+v", got1)
	}
	got2 := activityEvents[model.ActivityNewEvent](t, pub, "u-2", events.EventActivityNew)
	if len(got2) != 1 || !got2[0].Item.Read {
		t.Fatalf("u-2 must be told the item arrived read, got %+v", got2)
	}
	if got := activityEvents[model.ActivityNewEvent](t, pub, "u-3", events.EventActivityNew); len(got) != 0 {
		t.Fatalf("a failed write must skip its nudge, got %+v", got)
	}
}

func TestActivityService_Feed(t *testing.T) {
	store := newFakeActivityStore()
	store.listItems = []*model.ActivityFeedItem{
		{ActivityItem: model.ActivityItem{ID: "a", Type: model.ActivityMention}},
		{ActivityItem: model.ActivityItem{ID: "b", Type: model.ActivityMention}},
		{ActivityItem: model.ActivityItem{ID: "c", Type: model.ActivityDM}},
		{ActivityItem: model.ActivityItem{ID: "d", Type: model.ActivityReaction}, Read: true},
	}
	svc := NewActivityService(store, newMockPublisher())

	feed, err := svc.Feed(context.Background(), "u-1")
	if err != nil || len(feed.Items) != 4 || feed.Unread != 3 {
		t.Fatalf("Feed = %+v, %v", feed, err)
	}
	if feed.UnreadByType[model.ActivityMention] != 2 || feed.UnreadByType[model.ActivityDM] != 1 || feed.UnreadByType[model.ActivityReaction] != 0 {
		t.Fatalf("UnreadByType = %v", feed.UnreadByType)
	}

	store.listErr = errors.New("list boom")
	if _, err := svc.Feed(context.Background(), "u-1"); err == nil {
		t.Error("expected list error")
	}
}

// A successful MarkSeen must tell the user's other devices (activity.read) so
// their badges clear — the missing event was SPEC GAP-3 (mobile read left the
// desktop badge lit until the next activity.new).
func TestActivityService_MarkSeenPublishesAll(t *testing.T) {
	store := newFakeActivityStore()
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	if err := svc.MarkSeen(context.Background(), "u-1"); err != nil || store.seenCnt != 1 {
		t.Fatalf("MarkSeen = %v, seenCnt=%d", err, store.seenCnt)
	}
	if got := changes(t, pub, "u-1"); len(got) != 1 || !got[0].All {
		t.Fatalf("activity.read = %+v, want {all:true}", got)
	}
}

// A failed watermark write must NOT claim the feed was read on other devices.
func TestActivityService_MarkSeenStoreErrorSkipsPublish(t *testing.T) {
	store := newFakeActivityStore()
	store.seenErr = errors.New("boom")
	pub := newMockPublisher()

	if err := NewActivityService(store, pub).MarkSeen(context.Background(), "u-1"); err == nil {
		t.Fatal("expected seen error")
	}
	if activityEventPublished(pub, events.EventActivityRead) {
		t.Fatal("a store failure must skip the activity.read nudge")
	}
}

const (
	itemA = "01J0000000000000000000000A"
	itemB = "01J0000000000000000000000B"
)

// The per-item endpoints accept only real item ids, and no more of them than
// a stream can hold — anything else is a validation error before the store.
func TestValidateActivityIDs(t *testing.T) {
	tooMany := make([]string, store.ActivityMaxItems+1)
	for i := range tooMany {
		tooMany[i] = itemA
	}
	for name, ids := range map[string][]string{
		"empty":     nil,
		"too many":  tooMany,
		"not ulid":  {itemA, "activity:u-1"},
		"too long":  {itemA + "Z"},
		"lowercase": {strings.ToLower(itemA)[:25] + "!"},
	} {
		if err := validateActivityIDs(ids); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: err = %v, want ErrValidation", name, err)
		}
	}
	if err := validateActivityIDs(tooMany[:store.ActivityMaxItems]); err != nil {
		t.Fatalf("a full stream's worth of ids must pass: %v", err)
	}
}

func TestActivityService_SetItemsRead(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	store.applied = []string{itemA}
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	if err := svc.SetItemsRead(ctx, "u-1", []string{itemA, itemB}, false); err != nil {
		t.Fatalf("SetItemsRead: %v", err)
	}
	if len(store.readIDs) != 2 || store.readAs {
		t.Fatalf("store got ids=%v read=%v", store.readIDs, store.readAs)
	}
	got := changes(t, pub, "u-1")
	if len(got) != 1 || len(got[0].IDs) != 1 || got[0].IDs[0] != itemA || got[0].Read == nil || *got[0].Read {
		t.Fatalf("activity.read = %+v, want the applied id marked unread", got)
	}

	// Nothing applied (ids no longer in the stream) → nothing to tell.
	store.applied = nil
	if err := svc.SetItemsRead(ctx, "u-1", []string{itemB}, true); err != nil {
		t.Fatalf("SetItemsRead: %v", err)
	}
	if got := changes(t, pub, "u-1"); len(got) != 1 {
		t.Fatalf("no-op mark must not publish, got %+v", got)
	}

	if err := svc.SetItemsRead(ctx, "u-1", []string{"bogus"}, true); !errors.Is(err, ErrValidation) {
		t.Fatalf("invalid ids = %v", err)
	}

	// A store failure is returned and skips the nudge.
	failing := newFakeActivityStore()
	failing.readErr = errors.New("boom")
	failPub := newMockPublisher()
	if err := NewActivityService(failing, failPub).SetItemsRead(ctx, "u-1", []string{itemA}, true); err == nil {
		t.Fatal("expected store error")
	}
	if activityEventPublished(failPub, events.EventActivityRead) {
		t.Fatal("a store failure must skip the activity.read nudge")
	}
}

func TestActivityService_RemoveItems(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	store.gone = []string{itemA}
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	if err := svc.RemoveItems(ctx, "u-1", []string{itemA}); err != nil {
		t.Fatalf("RemoveItems: %v", err)
	}
	if len(store.removed) != 1 || store.removed[0] != itemA {
		t.Fatalf("store removed %v", store.removed)
	}
	if got := changes(t, pub, "u-1"); len(got) != 1 || len(got[0].Removed) != 1 || got[0].Removed[0] != itemA {
		t.Fatalf("activity.read = %+v, want removed [a]", got)
	}

	store.gone = nil
	if err := svc.RemoveItems(ctx, "u-1", []string{itemB}); err != nil {
		t.Fatalf("RemoveItems: %v", err)
	}
	if got := changes(t, pub, "u-1"); len(got) != 1 {
		t.Fatalf("removing nothing must not publish, got %+v", got)
	}

	if err := svc.RemoveItems(ctx, "u-1", nil); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty ids = %v", err)
	}

	failing := newFakeActivityStore()
	failing.removeErr = errors.New("boom")
	failPub := newMockPublisher()
	if err := NewActivityService(failing, failPub).RemoveItems(ctx, "u-1", []string{itemA}); err == nil {
		t.Fatal("expected store error")
	}
	if activityEventPublished(failPub, events.EventActivityRead) {
		t.Fatal("a store failure must skip the activity.read nudge")
	}
}

func TestActivityService_RecordForRecipients(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	// Nothing to record, and no store, are both no-ops.
	svc.RecordForRecipients(ctx, nil)
	NewActivityService(nil, newMockPublisher()).RecordForRecipients(ctx, map[string]*model.ActivityItem{"u-1": {ID: "x"}})

	svc.RecordForRecipients(ctx, map[string]*model.ActivityItem{
		"u-1": {ID: "a", Type: model.ActivityMention},
		"u-2": {ID: "b", Type: model.ActivityDM},
	})
	waitForCond(t, func() bool { return store.count("u-1") == 1 && store.count("u-2") == 1 }, "recipient items recorded")
	waitForCond(t, func() bool {
		return len(activityEvents[model.ActivityNewEvent](t, pub, "u-1", events.EventActivityNew)) == 1 &&
			len(activityEvents[model.ActivityNewEvent](t, pub, "u-2", events.EventActivityNew)) == 1
	}, "each recipient told about their item")
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
	got := store.first("u-1")
	if got.Type != model.ActivityChannelAdded || got.ActorID != "u-2" || got.ParentID != "ch-1" ||
		got.ChannelSlug != "design-review" || got.ParentName != "Design Review" || got.ParentType != ParentChannel {
		t.Fatalf("unexpected item %+v", got)
	}
}

func TestActivityService_MarkParentRead(t *testing.T) {
	ctx := context.Background()
	at := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	store := newFakeActivityStore()
	store.changed = true
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	svc.MarkParentRead(ctx, "u-1", "ch-1", "root-1", at)
	if store.parentKey != "ch-1|root-1" || !store.position.Equal(at) {
		t.Fatalf("store got key=%q position=%v", store.parentKey, store.position)
	}
	got := changes(t, pub, "u-1")
	if len(got) != 1 || got[0].ParentID != "ch-1" || got[0].ThreadRootID != "root-1" {
		t.Fatalf("activity.read = %+v, want the thread", got)
	}

	// Nothing could flip → nothing to tell.
	store.changed = false
	svc.MarkParentRead(ctx, "u-1", "ch-1", "", at)
	if store.parentKey != "ch-1" {
		t.Fatalf("a parent read keys on the parent alone, got %q", store.parentKey)
	}
	// A store failure is logged, never surfaced: the read itself was saved.
	store.changed, store.posErr = true, errors.New("boom")
	svc.MarkParentRead(ctx, "u-1", "ch-1", "", at)
	if got := changes(t, pub, "u-1"); len(got) != 1 {
		t.Fatalf("only the first read may publish, got %+v", got)
	}
}

func TestActivityService_ParentLeft(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	store.parentGone = []string{itemA}
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	svc.ParentLeft(ctx, []string{"u-1"}, "ch-1")
	waitForCond(t, func() bool { return len(changes(t, pub, "u-1")) == 1 }, "removal published")
	if got := changes(t, pub, "u-1")[0]; len(got.Removed) != 1 || got.Removed[0] != itemA {
		t.Fatalf("activity.read = %+v", got)
	}
	store.mu.Lock()
	user, parent := store.parentUser, store.parentID
	store.mu.Unlock()
	if user != "u-1" || parent != "ch-1" {
		t.Fatalf("store got %s/%s", user, parent)
	}
}

func TestActivityService_ParentLeftNothingOrError(t *testing.T) {
	ctx := context.Background()
	for name, setup := range map[string]func(*fakeActivityStore){
		"nothing removed": func(*fakeActivityStore) {},
		"store error":     func(f *fakeActivityStore) { f.parentGone, f.parentErr = []string{itemA}, errors.New("boom") },
	} {
		store := newFakeActivityStore()
		setup(store)
		pub := newMockPublisher()
		NewActivityService(store, pub).ParentLeft(ctx, []string{"u-1"}, "ch-1")
		waitForCond(t, func() bool {
			store.mu.Lock()
			defer store.mu.Unlock()
			return store.parentID == "ch-1"
		}, name+": cleanup ran")
		// The publish (if any) follows the store call on the same goroutine.
		time.Sleep(20 * time.Millisecond)
		if got := changes(t, pub, "u-1"); len(got) != 0 {
			t.Fatalf("%s: must not publish, got %+v", name, got)
		}
	}
}

func TestActivityService_MessagesDeleted(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	store.touched = map[string][]string{"u-1": {itemA}, "u-2": {itemB}}
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)

	// No messages, or no member lister, does nothing.
	svc.MessagesDeleted(ctx, "ch-1", ParentChannel, nil)
	svc.MessagesDeleted(ctx, "ch-1", ParentChannel, []string{"m-1"})

	svc.SetMemberLister(&fakeMemberLister{ids: []string{"u-1", "u-2", "u-3"}})
	svc.MessagesDeleted(ctx, "ch-1", ParentChannel, []string{"m-1", "m-2"})
	waitForCond(t, func() bool { return len(changes(t, pub, "u-1")) == 1 && len(changes(t, pub, "u-2")) == 1 }, "removals published")
	if got := changes(t, pub, "u-1")[0]; len(got.Removed) != 1 || got.Removed[0] != itemA {
		t.Fatalf("u-1 activity.read = %+v", got)
	}
	users, ids, _ := store.lastMessageCall()
	if len(users) != 3 || len(ids) != 2 || ids[1] != "m-2" {
		t.Fatalf("store got users=%v ids=%v", users, ids)
	}
	if got := changes(t, pub, "u-3"); len(got) != 0 {
		t.Fatalf("an untouched member must not be told, got %+v", got)
	}
}

// A partial store failure still tells the users whose items did change; a
// failed member lookup changes nothing.
func TestActivityService_MessageSyncFailures(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	store.touched = map[string][]string{"u-1": {itemA}}
	store.perUserErr = errors.New("partial")
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)
	svc.SetMemberLister(&fakeMemberLister{ids: []string{"u-1", "u-2"}})

	svc.MessagesDeleted(ctx, "ch-1", ParentChannel, []string{"m-1"})
	waitForCond(t, func() bool { return len(changes(t, pub, "u-1")) == 1 }, "partial removal published")

	failing := newFakeActivityStore()
	failPub := newMockPublisher()
	failSvc := NewActivityService(failing, failPub)
	lister := &fakeMemberLister{err: errors.New("boom")}
	failSvc.SetMemberLister(lister)
	failSvc.MessagesDeleted(ctx, "ch-1", ParentChannel, []string{"m-1"})
	time.Sleep(50 * time.Millisecond)
	if users, _, _ := failing.lastMessageCall(); users != nil {
		t.Fatalf("a failed member lookup must not touch the store, got %v", users)
	}
}

func TestActivityService_MessageEdited(t *testing.T) {
	ctx := context.Background()
	store := newFakeActivityStore()
	store.touched = map[string][]string{"u-1": {itemA}}
	pub := newMockPublisher()
	svc := NewActivityService(store, pub)
	svc.SetMemberLister(&fakeMemberLister{ids: []string{"u-1"}})

	svc.MessageEdited(ctx, &model.Message{ID: "m-1", ParentID: "ch-1", Body: "fixed\n\ttypo"}, ParentChannel)
	waitForCond(t, func() bool { return len(changes(t, pub, "u-1")) == 1 }, "update published")
	if got := changes(t, pub, "u-1")[0]; len(got.Updated) != 1 || got.Updated[0] != itemA {
		t.Fatalf("activity.read = %+v", got)
	}
	_, ids, preview := store.lastMessageCall()
	if ids[0] != "m-1" || preview != "fixed typo" {
		t.Fatalf("store got ids=%v preview=%q", ids, preview)
	}
}

// Archiving hands over every member at once; one goroutine works through them
// and each user still hears about their own removed items.
func TestActivityService_ParentLeftManyUsers(t *testing.T) {
	store := newFakeActivityStore()
	store.parentGone = []string{itemA}
	pub := newMockPublisher()
	NewActivityService(store, pub).ParentLeft(context.Background(), []string{"u-1", "u-2", "u-3"}, "ch-1")
	waitForCond(t, func() bool {
		return len(changes(t, pub, "u-1")) == 1 && len(changes(t, pub, "u-2")) == 1 && len(changes(t, pub, "u-3")) == 1
	}, "every user told")
}
