//go:build integration

package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

var activityBase = time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)

// activityClock pins a store's clock, advanced one millisecond per tick so
// insertion order is unambiguous.
type activityClock struct{ at time.Time }

func (c *activityClock) now() time.Time { return c.at }
func (c *activityClock) tick()          { c.at = c.at.Add(time.Millisecond) }

func setupActivityStore(t *testing.T) (*RedisActivityStore, *redis.Client, *activityClock) {
	t.Helper()
	client := storeRedisClient(t)
	s := NewRedisActivityStore(client)
	clock := &activityClock{at: activityBase}
	s.now = clock.now
	return s, client, clock
}

// itemID builds a distinct, sortable item id.
func itemID(n int) string { return fmt.Sprintf("01J%023d", n) }

func mention(n int, parentID string, created time.Time) *model.ActivityItem {
	return &model.ActivityItem{ID: itemID(n), Type: model.ActivityMention, CreatedAt: created, MessageID: fmt.Sprintf("m-%d", n), ParentID: parentID, ParentType: "channel"}
}

func addOne(t *testing.T, s *RedisActivityStore, userID string, item *model.ActivityItem) bool {
	t.Helper()
	res := s.AddActivityMany(context.Background(), []ActivityAdd{{UserID: userID, Item: item}})
	if res[0].Err != nil {
		t.Fatalf("AddActivityMany: %v", res[0].Err)
	}
	return res[0].Read
}

func list(t *testing.T, s *RedisActivityStore, userID string) []*model.ActivityFeedItem {
	t.Helper()
	items, err := s.ListActivity(context.Background(), userID)
	if err != nil {
		t.Fatalf("ListActivity: %v", err)
	}
	return items
}

// readState maps item id → read for the user's stream.
func readState(t *testing.T, s *RedisActivityStore, userID string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, it := range list(t, s, userID) {
		out[it.ID] = it.Read
	}
	return out
}

func ids(items []*model.ActivityFeedItem) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

func TestRedisActivityStore_ListsNewestArrivalFirst(t *testing.T) {
	s, _, clock := setupActivityStore(t)
	// A DM (conversational bucket) and two mentions (addressed bucket) list as
	// one stream, newest arrival first.
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	clock.tick()
	addOne(t, s, "u-1", &model.ActivityItem{ID: itemID(2), Type: model.ActivityDM, CreatedAt: activityBase, MessageID: "m-2", ParentID: "dm-1", ParentType: "conversation"})
	clock.tick()
	addOne(t, s, "u-1", mention(3, "ch-1", activityBase))

	got := ids(list(t, s, "u-1"))
	want := []string{itemID(3), itemID(2), itemID(1)}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("order = %v, want %v", got, want)
	}

	// Items that arrive in the same millisecond order by id, newest first.
	addOne(t, s, "u-2", mention(4, "ch-1", activityBase))
	addOne(t, s, "u-2", mention(5, "ch-1", activityBase))
	if got := ids(list(t, s, "u-2")); got[0] != itemID(5) {
		t.Fatalf("same-ms order = %v", got)
	}
}

// The production store reads the Redis clock, so every app instance stamps
// insertions from one clock.
func TestRedisActivityStore_UsesRedisClock(t *testing.T) {
	client := storeRedisClient(t)
	s := NewRedisActivityStore(client)
	before := time.Now().Add(-time.Minute)
	addOne(t, s, "u-1", mention(1, "ch-1", time.Now()))
	score, err := client.ZScore(context.Background(), keysFor("u-1").feed, itemID(1)).Result()
	if err != nil {
		t.Fatalf("ZScore: %v", err)
	}
	if at := time.UnixMilli(int64(score)); at.Before(before) || at.After(time.Now().Add(time.Minute)) {
		t.Fatalf("insertion time %v is not the Redis clock", at)
	}
	if ttl := client.PTTL(context.Background(), keysFor("u-1").items).Val(); ttl <= 0 || ttl > activityTTL {
		t.Fatalf("items TTL = %v, want refreshed to the window", ttl)
	}
}

// Addressed items and conversational items are capped separately, so a busy
// DM can't push a mention out of the stream.
func TestRedisActivityStore_CapsEachBucket(t *testing.T) {
	s, client, _ := setupActivityStore(t)
	ctx := context.Background()
	addOne(t, s, "u-1", mention(0, "ch-1", activityBase))

	var adds []ActivityAdd
	for i := 1; i <= activityMaxChatItems+5; i++ {
		adds = append(adds, ActivityAdd{UserID: "u-1", Item: &model.ActivityItem{
			ID: itemID(i), Type: model.ActivityDM, CreatedAt: activityBase, MessageID: fmt.Sprintf("m-%d", i), ParentID: "dm-1", ParentType: "conversation",
		}})
	}
	for _, r := range s.AddActivityMany(ctx, adds) {
		if r.Err != nil {
			t.Fatalf("AddActivityMany: %v", r.Err)
		}
	}
	k := keysFor("u-1")
	if n := client.ZCard(ctx, k.chat).Val(); n != activityMaxChatItems {
		t.Fatalf("chat bucket = %d, want %d", n, activityMaxChatItems)
	}
	if n := client.HLen(ctx, k.items).Val(); n != activityMaxChatItems+1 {
		t.Fatalf("item bodies = %d, want trimmed with their ids", n)
	}
	got := readState(t, s, "u-1")
	if _, ok := got[itemID(0)]; !ok {
		t.Fatal("the mention must survive a DM flood")
	}
	if _, ok := got[itemID(1)]; ok {
		t.Fatal("the oldest DM must be trimmed")
	}
	// The trimmed DM's message index entry went with it.
	if client.HExists(ctx, k.msgs, "m:m-1").Val() {
		t.Fatal("trimmed item left its message index entry behind")
	}
}

func TestRedisActivityStore_CapsAddressedBucketAcrossBatches(t *testing.T) {
	s, client, _ := setupActivityStore(t)
	ctx := context.Background()
	// More adds than one pipelined batch carries.
	var adds []ActivityAdd
	for i := 1; i <= activityBatchSize+10; i++ {
		adds = append(adds, ActivityAdd{UserID: "u-1", Item: mention(i, "ch-1", activityBase)})
	}
	for _, r := range s.AddActivityMany(ctx, adds) {
		if r.Err != nil {
			t.Fatalf("AddActivityMany: %v", r.Err)
		}
	}
	if n := client.ZCard(ctx, keysFor("u-1").feed).Val(); n != activityMaxFeedItems {
		t.Fatalf("feed bucket = %d, want %d", n, activityMaxFeedItems)
	}
}

func TestRedisActivityStore_DropsExpired(t *testing.T) {
	s, _, clock := setupActivityStore(t)
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	clock.at = activityBase.Add(activityTTL + time.Hour)
	// Listing skips it even before an add trims it...
	if got := list(t, s, "u-1"); len(got) != 0 {
		t.Fatalf("expired item listed: %v", ids(got))
	}
	// ...and the next add trims it.
	addOne(t, s, "u-1", mention(2, "ch-1", clock.at))
	if got := ids(list(t, s, "u-1")); len(got) != 1 || got[0] != itemID(2) {
		t.Fatalf("stream = %v, want only the fresh item", got)
	}
}

func TestRedisActivityStore_MarkAllRead(t *testing.T) {
	s, client, clock := setupActivityStore(t)
	ctx := context.Background()
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	clock.tick()
	addOne(t, s, "u-1", mention(2, "ch-1", activityBase))
	if _, err := s.SetActivityRead(ctx, "u-1", []string{itemID(1)}, true); err != nil {
		t.Fatalf("SetActivityRead: %v", err)
	}
	clock.tick()
	if err := s.MarkActivitySeen(ctx, "u-1"); err != nil {
		t.Fatalf("MarkActivitySeen: %v", err)
	}
	if got := readState(t, s, "u-1"); !got[itemID(1)] || !got[itemID(2)] {
		t.Fatalf("after mark all read = %v", got)
	}
	if client.Exists(ctx, keysFor("u-1").marks).Val() != 0 {
		t.Fatal("mark all read must drop the per-item marks")
	}
	clock.tick()
	addOne(t, s, "u-1", mention(3, "ch-1", clock.at))
	if got := readState(t, s, "u-1"); got[itemID(3)] {
		t.Fatal("an item arriving after mark all read is unread")
	}
}

// Mark all read covers everything already in the stream, even items stamped
// later than the reader's clock.
func TestRedisActivityStore_MarkAllReadCoversNewestItem(t *testing.T) {
	s, _, clock := setupActivityStore(t)
	clock.at = activityBase.Add(time.Hour)
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	clock.at = activityBase
	if err := s.MarkActivitySeen(context.Background(), "u-1"); err != nil {
		t.Fatalf("MarkActivitySeen: %v", err)
	}
	if got := readState(t, s, "u-1"); !got[itemID(1)] {
		t.Fatal("the newest item must be read")
	}
}

func TestRedisActivityStore_SetActivityRead(t *testing.T) {
	s, _, clock := setupActivityStore(t)
	ctx := context.Background()
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	addOne(t, s, "u-1", mention(2, "ch-1", activityBase))
	clock.tick()
	if err := s.MarkActivitySeen(ctx, "u-1"); err != nil {
		t.Fatalf("MarkActivitySeen: %v", err)
	}
	clock.tick()
	applied, err := s.SetActivityRead(ctx, "u-1", []string{itemID(1), "01J0000000000000000000GONE"}, false)
	if err != nil {
		t.Fatalf("SetActivityRead: %v", err)
	}
	if len(applied) != 1 || applied[0] != itemID(1) {
		t.Fatalf("applied = %v, want only the item in the stream", applied)
	}
	if got := readState(t, s, "u-1"); got[itemID(1)] || !got[itemID(2)] {
		t.Fatalf("after mark unread = %v", got)
	}
	clock.tick()
	if _, err := s.SetActivityRead(ctx, "u-1", []string{itemID(1)}, true); err != nil {
		t.Fatalf("SetActivityRead: %v", err)
	}
	if got := readState(t, s, "u-1"); !got[itemID(1)] {
		t.Fatal("mark read must win over the earlier mark unread")
	}
	// Ids that were never in the stream leave no mark behind.
	if applied, _ := s.SetActivityRead(ctx, "u-1", []string{"01J0000000000000000000GONE"}, true); len(applied) != 0 {
		t.Fatalf("applied = %v", applied)
	}
}

// Reading a channel, conversation or thread reads its items; marking a message
// unread there makes its item unread again; the most recent signal wins.
func TestRedisActivityStore_ParentReadPosition(t *testing.T) {
	s, _, clock := setupActivityStore(t)
	ctx := context.Background()
	t1 := activityBase.Add(-time.Minute)
	addOne(t, s, "u-1", mention(1, "ch-1", t1))
	addOne(t, s, "u-1", &model.ActivityItem{ID: itemID(2), Type: model.ActivityThreadReply, CreatedAt: t1, MessageID: "m-2", ParentID: "ch-1", ParentType: "channel", ParentMessageID: "root-1"})
	addOne(t, s, "u-1", &model.ActivityItem{ID: itemID(3), Type: model.ActivityReaction, CreatedAt: t1, MessageID: "m-3", ParentID: "ch-1", ParentType: "channel"})
	addOne(t, s, "u-1", mention(4, "ch-2", t1))

	clock.tick()
	changed, err := s.MarkActivityParentRead(ctx, "u-1", "ch-1", activityBase)
	if err != nil || !changed {
		t.Fatalf("read ch-1 = %v, %v; want changed", changed, err)
	}
	got := readState(t, s, "u-1")
	if !got[itemID(1)] {
		t.Fatal("reading the channel reads its mention")
	}
	if got[itemID(2)] {
		t.Fatal("reading the channel must not read a thread in it")
	}
	if got[itemID(3)] {
		t.Fatal("a reaction hint does not follow the channel's read position")
	}
	if got[itemID(4)] {
		t.Fatal("reading one channel must not read another")
	}

	// Reading it again changes nothing.
	clock.tick()
	if changed, _ := s.MarkActivityParentRead(ctx, "u-1", "ch-1", activityBase.Add(time.Second)); changed {
		t.Fatal("a repeat read cannot flip anything")
	}

	// The thread reads on its own key.
	clock.tick()
	if _, err := s.MarkActivityParentRead(ctx, "u-1", ActivityParentKey("ch-1", "root-1"), activityBase); err != nil {
		t.Fatalf("read thread: %v", err)
	}
	if !readState(t, s, "u-1")[itemID(2)] {
		t.Fatal("reading the thread reads its reply")
	}

	// Mark unread from the mention's message → unread again.
	clock.tick()
	if changed, _ := s.MarkActivityParentRead(ctx, "u-1", "ch-1", t1.Add(-time.Millisecond)); !changed {
		t.Fatal("rewinding past an item can flip it")
	}
	if readState(t, s, "u-1")[itemID(1)] {
		t.Fatal("mark unread must make the mention unread")
	}

	// An explicit mark after that wins; a later channel read wins over it.
	clock.tick()
	if _, err := s.SetActivityRead(ctx, "u-1", []string{itemID(1)}, true); err != nil {
		t.Fatalf("SetActivityRead: %v", err)
	}
	if !readState(t, s, "u-1")[itemID(1)] {
		t.Fatal("explicit mark read must win over the older rewind")
	}
	clock.tick()
	if changed, _ := s.MarkActivityParentRead(ctx, "u-1", "ch-1", t1.Add(-time.Millisecond)); !changed {
		t.Fatal("with explicit marks present, a read can flip them")
	}
	if readState(t, s, "u-1")[itemID(1)] {
		t.Fatal("the newer rewind must win over the explicit mark")
	}
}

// A read position also overrides "mark all read" when it is newer, in either
// direction.
func TestRedisActivityStore_ParentReadAfterMarkAllRead(t *testing.T) {
	s, _, clock := setupActivityStore(t)
	ctx := context.Background()
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	clock.tick()
	if err := s.MarkActivitySeen(ctx, "u-1"); err != nil {
		t.Fatalf("MarkActivitySeen: %v", err)
	}
	clock.tick()
	if _, err := s.MarkActivityParentRead(ctx, "u-1", "ch-1", activityBase.Add(-time.Millisecond)); err != nil {
		t.Fatalf("rewind: %v", err)
	}
	if readState(t, s, "u-1")[itemID(1)] {
		t.Fatal("a rewind after mark all read makes the item unread")
	}
	clock.tick()
	if err := s.MarkActivitySeen(ctx, "u-1"); err != nil {
		t.Fatalf("MarkActivitySeen: %v", err)
	}
	if !readState(t, s, "u-1")[itemID(1)] {
		t.Fatal("a later mark all read wins over the rewind")
	}
}

// The notification fan-out writes items off the send path, so the recipient
// can read the DM before its item lands. The item must arrive already read —
// not leave an unread trace for a message they watched arrive.
func TestRedisActivityStore_LateWriteArrivesRead(t *testing.T) {
	s, _, clock := setupActivityStore(t)
	ctx := context.Background()
	sent := activityBase
	clock.at = sent.Add(time.Second)
	if _, err := s.MarkActivityParentRead(ctx, "u-1", "dm-1", clock.at); err != nil {
		t.Fatalf("read: %v", err)
	}
	clock.tick()
	dm := &model.ActivityItem{ID: itemID(1), Type: model.ActivityDM, CreatedAt: sent, MessageID: "m-1", ParentID: "dm-1", ParentType: "conversation"}
	if !addOne(t, s, "u-1", dm) {
		t.Fatal("AddActivityMany must report the late item as already read")
	}
	if !readState(t, s, "u-1")[itemID(1)] {
		t.Fatal("the late item must list as read")
	}
	// A message sent after the read stays unread.
	clock.tick()
	newer := &model.ActivityItem{ID: itemID(2), Type: model.ActivityDM, CreatedAt: clock.at, MessageID: "m-2", ParentID: "dm-1", ParentType: "conversation"}
	if addOne(t, s, "u-1", newer) {
		t.Fatal("a newer message must arrive unread")
	}
}

// Being added to a channel again replaces the earlier row instead of stacking.
func TestRedisActivityStore_ChannelAddedDedupes(t *testing.T) {
	s, _, clock := setupActivityStore(t)
	added := func(n int) *model.ActivityItem {
		return &model.ActivityItem{ID: itemID(n), Type: model.ActivityChannelAdded, CreatedAt: clock.at, ParentID: "ch-1", ParentType: "channel"}
	}
	addOne(t, s, "u-1", added(1))
	clock.tick()
	addOne(t, s, "u-1", added(2))
	if got := ids(list(t, s, "u-1")); len(got) != 1 || got[0] != itemID(2) {
		t.Fatalf("stream = %v, want only the latest channel add", got)
	}
	// An id-less channel add (no parent) is stored but not indexed.
	addOne(t, s, "u-1", &model.ActivityItem{ID: itemID(3), Type: model.ActivityChannelAdded, CreatedAt: clock.at})
	if got := list(t, s, "u-1"); len(got) != 2 {
		t.Fatalf("stream = %v", ids(got))
	}
}

func TestRedisActivityStore_RemoveActivity(t *testing.T) {
	s, client, _ := setupActivityStore(t)
	ctx := context.Background()
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	addOne(t, s, "u-1", mention(2, "ch-1", activityBase))
	addOne(t, s, "u-1", &model.ActivityItem{ID: itemID(3), Type: model.ActivityReminder, CreatedAt: activityBase})
	if _, err := s.SetActivityRead(ctx, "u-1", []string{itemID(1)}, true); err != nil {
		t.Fatalf("SetActivityRead: %v", err)
	}

	removed, err := s.RemoveActivity(ctx, "u-1", []string{itemID(1), itemID(3), "01J0000000000000000000GONE"})
	if err != nil {
		t.Fatalf("RemoveActivity: %v", err)
	}
	if len(removed) != 2 {
		t.Fatalf("removed = %v, want the two existing items", removed)
	}
	if got := ids(list(t, s, "u-1")); len(got) != 1 || got[0] != itemID(2) {
		t.Fatalf("stream = %v", got)
	}
	k := keysFor("u-1")
	if client.HExists(ctx, k.marks, itemID(1)).Val() || client.HExists(ctx, k.msgs, "m:m-1").Val() {
		t.Fatal("removing an item must drop its mark and message index entry")
	}
}

func TestRedisActivityStore_RemoveActivityForMessages(t *testing.T) {
	s, _, _ := setupActivityStore(t)
	ctx := context.Background()
	// u-1 has a mention and a reaction about m-1, u-2 a DM about m-1, u-3
	// nothing about it.
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	addOne(t, s, "u-1", &model.ActivityItem{ID: itemID(2), Type: model.ActivityReaction, CreatedAt: activityBase, MessageID: "m-1", ParentID: "ch-1"})
	addOne(t, s, "u-1", mention(3, "ch-1", activityBase))
	addOne(t, s, "u-2", &model.ActivityItem{ID: itemID(4), Type: model.ActivityDM, CreatedAt: activityBase, MessageID: "m-1", ParentID: "ch-1"})
	addOne(t, s, "u-3", mention(5, "ch-1", activityBase))

	got, err := s.RemoveActivityForMessages(ctx, []string{"u-1", "u-2", "u-3"}, []string{"m-1", "m-9"})
	if err != nil {
		t.Fatalf("RemoveActivityForMessages: %v", err)
	}
	if len(got["u-1"]) != 2 || len(got["u-2"]) != 1 {
		t.Fatalf("removed = %v", got)
	}
	if _, ok := got["u-3"]; ok {
		t.Fatalf("u-3 had nothing about m-1, got %v", got["u-3"])
	}
	if left := ids(list(t, s, "u-1")); len(left) != 1 || left[0] != itemID(3) {
		t.Fatalf("u-1 stream = %v", left)
	}
}

func TestRedisActivityStore_UpdateActivityPreview(t *testing.T) {
	s, _, _ := setupActivityStore(t)
	ctx := context.Background()
	first := mention(1, "ch-1", activityBase)
	first.MessagePreview = "typo"
	first.Webhook = true
	addOne(t, s, "u-1", first)
	addOne(t, s, "u-1", mention(2, "ch-1", activityBase))

	got, err := s.UpdateActivityPreview(ctx, []string{"u-1", "u-2"}, "m-1", "fixed")
	if err != nil {
		t.Fatalf("UpdateActivityPreview: %v", err)
	}
	if len(got) != 1 || len(got["u-1"]) != 1 || got["u-1"][0] != itemID(1) {
		t.Fatalf("updated = %v", got)
	}
	items := list(t, s, "u-1")
	byID := map[string]*model.ActivityFeedItem{}
	for _, it := range items {
		byID[it.ID] = it
	}
	if it := byID[itemID(1)]; it.MessagePreview != "fixed" || !it.Webhook || it.MessageID != "m-1" || !it.CreatedAt.Equal(activityBase) {
		t.Fatalf("edited item = %+v, want only the preview changed", it)
	}
	if byID[itemID(2)].MessagePreview != "" {
		t.Fatal("another message's item must be untouched")
	}

	// An edit down to nothing previewable clears the preview.
	if _, err := s.UpdateActivityPreview(ctx, []string{"u-1"}, "m-1", ""); err != nil {
		t.Fatalf("UpdateActivityPreview: %v", err)
	}
	for _, it := range list(t, s, "u-1") {
		if it.ID == itemID(1) && it.MessagePreview != "" {
			t.Fatalf("preview = %q, want cleared", it.MessagePreview)
		}
	}
}

func TestRedisActivityStore_RemoveActivityForParent(t *testing.T) {
	s, _, _ := setupActivityStore(t)
	ctx := context.Background()
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	addOne(t, s, "u-1", &model.ActivityItem{ID: itemID(2), Type: model.ActivityChannelAdded, CreatedAt: activityBase, ParentID: "ch-1"})
	addOne(t, s, "u-1", mention(3, "ch-2", activityBase))

	removed, err := s.RemoveActivityForParent(ctx, "u-1", "ch-1")
	if err != nil {
		t.Fatalf("RemoveActivityForParent: %v", err)
	}
	if len(removed) != 2 {
		t.Fatalf("removed = %v, want the mention and the channel add", removed)
	}
	if got := ids(list(t, s, "u-1")); len(got) != 1 || got[0] != itemID(3) {
		t.Fatalf("stream = %v", got)
	}
}

// Streams written before the rewrite (one JSON-member ZSET plus a watermark)
// fold into the current layout on first touch, keeping their read state and
// thread roots.
func TestRedisActivityStore_MigratesLegacyStream(t *testing.T) {
	s, client, clock := setupActivityStore(t)
	ctx := context.Background()
	legacy := func(m map[string]any) string {
		b, _ := json.Marshal(m)
		return string(b)
	}
	old := activityBase.Add(-time.Hour)
	members := []redis.Z{
		{Score: float64(old.UnixMilli()), Member: legacy(map[string]any{"id": itemID(1), "type": "thread_reply", "createdAt": old, "messageID": "m-1", "parentID": "ch-1", "parentType": "channel", "threadRootID": "root-1", "read": false})},
		{Score: float64(old.Add(time.Minute).UnixMilli()), Member: legacy(map[string]any{"id": itemID(2), "type": "mention", "createdAt": old, "messageID": "m-2", "parentID": "ch-1", "parentType": "channel"})},
		{Score: float64(old.Add(time.Minute).UnixMilli()), Member: legacy(map[string]any{"id": itemID(4), "type": "channel_added", "createdAt": old, "parentID": "ch-9", "parentType": "channel"})},
		{Score: float64(old.Add(2 * time.Minute).UnixMilli()), Member: "not-json"},
		{Score: float64(old.Add(2 * time.Minute).UnixMilli()), Member: legacy(map[string]any{"type": "mention"})},
	}
	if err := client.ZAdd(ctx, "activity:u-1", members...).Err(); err != nil {
		t.Fatalf("seed legacy: %v", err)
	}
	if err := client.Set(ctx, "activity:seen:u-1", strconv.FormatInt(old.UnixMilli(), 10), 0).Err(); err != nil {
		t.Fatalf("seed legacy seen: %v", err)
	}

	items := list(t, s, "u-1")
	if len(items) != 3 {
		t.Fatalf("migrated = %v, want the three valid items", ids(items))
	}
	byID := map[string]*model.ActivityFeedItem{}
	for _, it := range items {
		byID[it.ID] = it
	}
	if it := byID[itemID(1)]; it.ParentMessageID != "root-1" || !it.Read {
		t.Fatalf("legacy thread reply = %+v, want its thread root and the old watermark's read state", it)
	}
	if byID[itemID(2)].Read {
		t.Fatal("an item past the old watermark stays unread")
	}
	if client.Exists(ctx, "activity:u-1", "activity:seen:u-1").Val() != 0 {
		t.Fatal("legacy keys must be removed once folded in")
	}
	// Migrated items are indexed like new ones.
	if got, _ := s.RemoveActivityForMessages(ctx, []string{"u-1"}, []string{"m-2"}); len(got["u-1"]) != 1 {
		t.Fatalf("migrated item not indexed: %v", got)
	}
	clock.tick()
	addOne(t, s, "u-1", &model.ActivityItem{ID: itemID(5), Type: model.ActivityChannelAdded, CreatedAt: clock.at, ParentID: "ch-9"})
	if _, ok := readState(t, s, "u-1")[itemID(4)]; ok {
		t.Fatal("a migrated channel add is replaced by a newer one")
	}

	// A legacy watermark alone migrates too, without clobbering a current one.
	if err := client.Set(ctx, "activity:seen:u-2", "5", 0).Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	list(t, s, "u-2")
	if v := client.Get(ctx, keysFor("u-2").seen).Val(); v != "5" {
		t.Fatalf("migrated watermark = %q", v)
	}
	if err := client.Set(ctx, "activity:seen:u-2", "1", 0).Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	list(t, s, "u-2")
	if v := client.Get(ctx, keysFor("u-2").seen).Val(); v != "5" {
		t.Fatalf("watermark = %q, a stale legacy one must not overwrite it", v)
	}
}

// The per-parent hashes are pruned once they pass the threshold: expired
// fields first, then the oldest.
func TestRedisActivityStore_PrunesParentHashes(t *testing.T) {
	s, client, _ := setupActivityStore(t)
	ctx := context.Background()
	k := keysFor("u-1")
	nowMs := activityBase.UnixMilli()
	expired := activityBase.Add(-activityTTL - time.Hour).UnixMilli()
	pos := map[string]any{}
	last := map[string]any{}
	for i := 0; i < activityPruneAt+50; i++ {
		at := nowMs - int64(activityPruneAt-i)*1000
		if i < 100 {
			at = expired
		}
		pos[fmt.Sprintf("p-%04d", i)] = fmt.Sprintf("%d:%d", at, at)
		last[fmt.Sprintf("p-%04d", i)] = at
	}
	if err := client.HSet(ctx, k.pos, pos).Err(); err != nil {
		t.Fatalf("seed pos: %v", err)
	}
	if err := client.HSet(ctx, k.last, last).Err(); err != nil {
		t.Fatalf("seed last: %v", err)
	}

	if _, err := s.MarkActivityParentRead(ctx, "u-1", "p-new", activityBase); err != nil {
		t.Fatalf("MarkActivityParentRead: %v", err)
	}
	want := int64(activityPruneAt * 3 / 4)
	if n := client.HLen(ctx, k.pos).Val(); n != want {
		t.Fatalf("pos fields = %d, want %d", n, want)
	}
	if n := client.HLen(ctx, k.last).Val(); n != want {
		t.Fatalf("last fields = %d, want %d", n, want)
	}
	if !client.HExists(ctx, k.pos, "p-new").Val() || client.HExists(ctx, k.pos, "p-0000").Val() || client.HExists(ctx, k.pos, "p-0150").Val() {
		t.Fatal("pruning must keep the newest positions and drop expired and oldest")
	}
}

// A user who never reads still has a bounded newest-item hash: adds prune it
// too.
func TestRedisActivityStore_AddPrunesNewestItemHash(t *testing.T) {
	s, client, _ := setupActivityStore(t)
	ctx := context.Background()
	k := keysFor("u-1")
	last := map[string]any{}
	for i := 0; i < activityPruneAt+10; i++ {
		last[fmt.Sprintf("p-%04d", i)] = activityBase.UnixMilli() - int64(activityPruneAt-i)*1000
	}
	if err := client.HSet(ctx, k.last, last).Err(); err != nil {
		t.Fatalf("seed last: %v", err)
	}
	addOne(t, s, "u-1", mention(1, "ch-new", activityBase))
	if n := client.HLen(ctx, k.last).Val(); n != int64(activityPruneAt*3/4) {
		t.Fatalf("last fields = %d, want pruned to %d", n, activityPruneAt*3/4)
	}
	if !client.HExists(ctx, k.last, "ch-new").Val() {
		t.Fatal("the newest parent must survive the prune")
	}
}

func TestRedisActivityStore_ListSkipsStaleAndRejectsCorrupt(t *testing.T) {
	s, client, _ := setupActivityStore(t)
	ctx := context.Background()
	k := keysFor("u-1")
	addOne(t, s, "u-1", mention(1, "ch-1", activityBase))
	// An id whose body is gone is skipped.
	if err := client.ZAdd(ctx, k.feed, redis.Z{Score: float64(activityBase.UnixMilli()), Member: "ghost"}).Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if got := ids(list(t, s, "u-1")); len(got) != 1 || got[0] != itemID(1) {
		t.Fatalf("stream = %v, want the stale id skipped", got)
	}
	// A corrupt body fails the list, and the Lua paths step over it.
	if err := client.HSet(ctx, k.items, "ghost", "not-json").Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := client.HSet(ctx, k.msgs, "m:m-x", "ghost").Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_, err := s.ListActivity(ctx, "u-1")
	assertUnmarshalErr(t, err, "activity ListActivity")
	if got, err := s.UpdateActivityPreview(ctx, []string{"u-1"}, "m-x", "p"); err != nil || len(got) != 0 {
		t.Fatalf("preview over a corrupt body = %v, %v", got, err)
	}
	if got, err := s.RemoveActivityForParent(ctx, "u-1", "ch-9"); err != nil || len(got) != 0 {
		t.Fatalf("parent removal over a corrupt body = %v, %v", got, err)
	}
	if got, err := s.RemoveActivity(ctx, "u-1", []string{"ghost"}); err != nil || len(got) != 1 {
		t.Fatalf("removing a corrupt body = %v, %v", got, err)
	}
}

// A Redis whose script cache was flushed (restart, failover) re-sends the
// script source instead of failing the batch.
func TestRedisActivityStore_RecoversFromScriptCacheFlush(t *testing.T) {
	s, client, _ := setupActivityStore(t)
	ctx := context.Background()
	if err := client.ScriptFlush(ctx).Err(); err != nil {
		t.Fatalf("SCRIPT FLUSH: %v", err)
	}
	res := s.AddActivityMany(ctx, []ActivityAdd{{UserID: "u-1", Item: mention(1, "ch-1", activityBase)}, {UserID: "u-2", Item: mention(2, "ch-1", activityBase)}})
	for _, r := range res {
		if r.Err != nil {
			t.Fatalf("AddActivityMany after flush: %v", r.Err)
		}
	}
	if err := client.ScriptFlush(ctx).Err(); err != nil {
		t.Fatalf("SCRIPT FLUSH: %v", err)
	}
	if got, err := s.RemoveActivityForMessages(ctx, []string{"u-1", "u-2"}, []string{"m-1", "m-2"}); err != nil || len(got) != 2 {
		t.Fatalf("RemoveActivityForMessages after flush = %v, %v", got, err)
	}
}

func TestRedisActivityStore_ClientErrors(t *testing.T) {
	s, client, _ := setupActivityStore(t)
	ctx := context.Background()
	_ = client.Close() // closed client: every command now errors
	if res := s.AddActivityMany(ctx, []ActivityAdd{{UserID: "u-1", Item: mention(1, "ch-1", activityBase)}}); res[0].Err == nil {
		t.Error("AddActivityMany on closed redis should error")
	}
	if _, err := s.ListActivity(ctx, "u-1"); err == nil {
		t.Error("ListActivity on closed redis should error")
	}
	if err := s.MarkActivitySeen(ctx, "u-1"); err == nil {
		t.Error("MarkActivitySeen on closed redis should error")
	}
	if _, err := s.SetActivityRead(ctx, "u-1", []string{"a"}, true); err == nil {
		t.Error("SetActivityRead on closed redis should error")
	}
	if _, err := s.RemoveActivity(ctx, "u-1", []string{"a"}); err == nil {
		t.Error("RemoveActivity on closed redis should error")
	}
	if _, err := s.RemoveActivityForMessages(ctx, []string{"u-1", "u-2"}, []string{"m-1"}); err == nil {
		t.Error("RemoveActivityForMessages on closed redis should error")
	}
	if _, err := s.UpdateActivityPreview(ctx, []string{"u-1"}, "m-1", "p"); err == nil {
		t.Error("UpdateActivityPreview on closed redis should error")
	}
	if _, err := s.RemoveActivityForParent(ctx, "u-1", "ch-1"); err == nil {
		t.Error("RemoveActivityForParent on closed redis should error")
	}
	if _, err := s.MarkActivityParentRead(ctx, "u-1", "ch-1", activityBase); err == nil {
		t.Error("MarkActivityParentRead on closed redis should error")
	}
}

func TestActivityParentKey(t *testing.T) {
	if got := ActivityParentKey("ch-1", ""); got != "ch-1" {
		t.Fatalf("parent key = %q", got)
	}
	if got := ActivityParentKey("ch-1", "root-1"); got != "ch-1|root-1" {
		t.Fatalf("thread key = %q", got)
	}
}

// activityRead resolves the most recent signal: watermark, read position or
// explicit mark.
func TestActivityRead(t *testing.T) {
	const created, score = 1000, 2000
	cases := []struct {
		name     string
		seen     int64
		mark     string
		position string
		want     bool
	}{
		{"no signal", 0, "", "", false},
		{"under the watermark", 2000, "", "", true},
		{"over the watermark", 1999, "", "", false},
		{"explicit read", 0, "r5", "", true},
		{"explicit unread under the watermark, newer", 2000, "u2001", "", false},
		{"explicit unread under the watermark, older", 2000, "u1999", "", true},
		{"read past the message", 0, "", "1000:10", true},
		{"read up to before the message", 0, "", "999:10", false},
		{"rewind newer than the watermark", 2000, "", "999:2001", false},
		{"rewind older than the watermark", 2000, "", "999:1999", true},
		{"explicit read newer than a rewind", 0, "r20", "999:10", true},
		{"rewind newer than an explicit read", 0, "r5", "999:10", false},
		{"malformed mark", 0, "r", "", false},
		{"malformed position", 0, "", "999", false},
	}
	for _, tc := range cases {
		if got := activityRead(score, created, tc.seen, tc.mark, tc.position); got != tc.want {
			t.Errorf("%s: read = %v, want %v", tc.name, got, tc.want)
		}
	}
}
