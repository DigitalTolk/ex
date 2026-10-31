//go:build integration

package store

import (
	"context"
	"crypto/rand"
	"errors"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/oklog/ulid/v2"
)

// participantsEpoch stands in for the service's threadIndexEpoch.
var participantsEpoch = time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)

// idAt mints a message ID whose ULID time is at.
func idAt(at time.Time) string {
	return ulid.MustNew(ulid.Timestamp(at), rand.Reader).String()
}

func putMessage(t *testing.T, ms *MessageStoreImpl, m *model.Message) {
	t.Helper()
	if err := ms.CreateMessage(context.Background(), m); err != nil {
		t.Fatalf("create %s: %v", m.ID, err)
	}
}

func reply(parentID, rootID, author string, at time.Time) *model.Message {
	return &model.Message{ID: idAt(at), ParentID: parentID, ParentMessageID: rootID, AuthorID: author, Body: "reply", CreatedAt: at.Truncate(time.Millisecond)}
}

// The scan reads every reply once, across parallel segments, and keeps only
// the threads rooted before the cut-off: each with its distinct reply authors
// and its latest reply.
func TestScanThreadReplies(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	old := participantsEpoch.Add(-30 * 24 * time.Hour)
	oldRoot := idAt(old)
	putMessage(t, ms, &model.Message{ID: oldRoot, ParentID: "ch-a", AuthorID: "root-author", Body: "root", CreatedAt: old})
	putMessage(t, ms, reply("ch-a", oldRoot, "u-a", old.Add(time.Minute)))
	putMessage(t, ms, reply("ch-a", oldRoot, "u-b", old.Add(2*time.Minute)))
	last := reply("ch-a", oldRoot, "u-a", old.Add(3*time.Minute))
	putMessage(t, ms, last)
	newRoot := idAt(participantsEpoch.Add(time.Hour))
	putMessage(t, ms, reply("ch-a", newRoot, "u-c", participantsEpoch.Add(2*time.Hour)))
	// A root ID that isn't a ULID can't be dated: it counts as old.
	putMessage(t, ms, reply("dm-1", "legacy-root", "u-d", old))

	threads, replies, err := ms.ScanThreadReplies(ctx, participantsEpoch, 3)
	if err != nil {
		t.Fatalf("ScanThreadReplies: %v", err)
	}
	if replies != 5 {
		t.Fatalf("replies read = %d, want all 5", replies)
	}
	if len(threads) != 2 {
		t.Fatalf("threads = %+v, want the two old ones", threads)
	}
	byRoot := map[string]*ThreadReplies{}
	for _, th := range threads {
		byRoot[th.RootID] = th
	}
	got := byRoot[oldRoot]
	authors := slices.Clone(got.AuthorIDs)
	slices.Sort(authors)
	if got.ParentID != "ch-a" || !slices.Equal(authors, []string{"u-a", "u-b"}) || !got.LastReplyAt.Equal(last.CreatedAt) {
		t.Fatalf("old thread = %+v, want ch-a with u-a, u-b and the latest reply's time", got)
	}
	if lr := byRoot["legacy-root"]; lr == nil || lr.ParentID != "dm-1" || !slices.Equal(lr.AuthorIDs, []string{"u-d"}) {
		t.Fatalf("undatable thread = %+v", lr)
	}

	if _, _, err := NewMessageStore(withFault(db, func(f *faultClient) { f.failScan = true })).ScanThreadReplies(ctx, participantsEpoch, 1); !errors.Is(err, errInjected) {
		t.Fatalf("scan fault = %v, want errInjected", err)
	}
	_, _, err = NewMessageStore(withFault(db, func(f *faultClient) { f.transformScan = corruptScan })).ScanThreadReplies(ctx, participantsEpoch, 0)
	assertUnmarshalErr(t, err, "ScanThreadReplies")
}

// A thread's parent is a channel or a conversation; a group conversation that
// became a channel keeps its ID and is a channel.
func TestParentTypes(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	chans, convs := NewChannelStore(db), NewConversationStore(db)
	for _, id := range []string{"ch-1", "converted"} {
		if err := chans.CreateChannel(ctx, &model.Channel{ID: id, Name: id, Slug: id, Type: model.ChannelTypePublic, CreatedAt: time.Now()}); err != nil {
			t.Fatalf("CreateChannel %s: %v", id, err)
		}
	}
	for _, id := range []string{"dm-1", "converted"} {
		if err := convs.CreateConversation(ctx, &model.Conversation{ID: id, Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-a", "u-b"}, CreatedAt: time.Now(), UpdatedAt: time.Now()}, nil); err != nil {
			t.Fatalf("CreateConversation %s: %v", id, err)
		}
	}

	got, err := ParentTypes(ctx, db, []string{"ch-1", "dm-1", "converted", "gone"})
	if err != nil {
		t.Fatalf("ParentTypes: %v", err)
	}
	want := map[string]string{"ch-1": SidebarItemChannel, "dm-1": SidebarItemConversation, "converted": SidebarItemChannel}
	if len(got) != len(want) {
		t.Fatalf("types = %v, want %v", got, want)
	}
	for id, typ := range want {
		if got[id] != typ {
			t.Fatalf("types = %v, want %v", got, want)
		}
	}

	if _, err := ParentTypes(ctx, withFault(db, func(f *faultClient) { f.failBatchGetItem = true }), []string{"ch-1"}); !errors.Is(err, errInjected) {
		t.Fatalf("batch get fault = %v, want errInjected", err)
	}
	_, err = ParentTypes(ctx, withFault(db, func(f *faultClient) { f.transformBatchGetItem = corruptBatchGetOut(db) }), []string{"ch-1"})
	assertUnmarshalErr(t, err, "ParentTypes")
}

func TestMarkThreadParticipantsIndexed(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	root := idAt(participantsEpoch.Add(-time.Hour))
	putMessage(t, ms, &model.Message{ID: root, ParentID: "ch-m", AuthorID: "u-a", Body: "root", CreatedAt: time.Now()})

	if err := ms.MarkThreadParticipantsIndexed(ctx, "ch-m", root); err != nil {
		t.Fatalf("Mark: %v", err)
	}
	if m, err := ms.GetMessage(ctx, "ch-m", root); err != nil || !m.ParticipantsIndexed {
		t.Fatalf("root = %+v (err %v), want it flagged", m, err)
	}
	if err := ms.MarkThreadParticipantsIndexed(ctx, "ch-m", "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing root = %v, want ErrNotFound", err)
	}
	if err := NewMessageStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true })).MarkThreadParticipantsIndexed(ctx, "ch-m", root); !errors.Is(err, errInjected) {
		t.Fatalf("update fault = %v, want errInjected", err)
	}
}

// backfillFixture is one channel with four threads rooted before the cut-off:
// one to backfill, one already flagged, one deleted, one whose root is gone.
type backfillFixture struct {
	db                     *DB
	ms                     *MessageStoreImpl
	follows                *ThreadFollowStoreImpl
	threads                []*ThreadReplies
	open, flagged, deleted string
	latest                 time.Time
}

func newBackfillFixture(t *testing.T) *backfillFixture {
	t.Helper()
	ctx := context.Background()
	db := setupDynamoDB(t)
	f := &backfillFixture{db: db, ms: NewMessageStore(db), follows: NewThreadFollowStore(db)}
	old := participantsEpoch.Add(-60 * 24 * time.Hour).Truncate(time.Millisecond)
	f.open, f.flagged, f.deleted = idAt(old), idAt(old.Add(time.Second)), idAt(old.Add(2*time.Second))
	f.latest = old.Add(time.Hour)
	// The root's own last-reply time is older than the scan's: the scan wins.
	rootLast := old.Add(time.Minute)
	putMessage(t, f.ms, &model.Message{ID: f.open, ParentID: "ch-bf", AuthorID: "root-author", Body: "root", CreatedAt: old, LastReplyAt: &rootLast})
	putMessage(t, f.ms, &model.Message{ID: f.flagged, ParentID: "ch-bf", AuthorID: "root-author", Body: "root", CreatedAt: old, ParticipantsIndexed: true})
	putMessage(t, f.ms, &model.Message{ID: f.deleted, ParentID: "ch-bf", AuthorID: "root-author", CreatedAt: old, Deleted: true})
	// u-b unfollowed the open thread on purpose: that stays.
	if err := f.follows.SetThreadFollow(ctx, &model.ThreadFollow{UserID: "u-b", ParentID: "ch-bf", ParentType: SidebarItemChannel, ThreadRootID: f.open, Following: false, UpdatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	f.threads = []*ThreadReplies{
		{ParentID: "ch-bf", RootID: f.open, AuthorIDs: []string{"u-a", "u-b", "webhook", "", "root-author"}, LastReplyAt: f.latest},
		{ParentID: "ch-bf", RootID: f.flagged, AuthorIDs: []string{"u-a"}, LastReplyAt: f.latest},
		{ParentID: "ch-bf", RootID: f.deleted, AuthorIDs: []string{"u-a"}, LastReplyAt: f.latest},
		{ParentID: "ch-bf", RootID: "gone", AuthorIDs: []string{"u-a"}, LastReplyAt: f.latest},
	}
	return f
}

var machineAuthors = []string{"system", "webhook"}

// Every participant of an old thread becomes a follower, dated by its latest
// reply so it sorts into their /threads list; a deliberate unfollow stays;
// the root is flagged once its rows are written. A dry run writes nothing,
// and a second run finds nothing left to do.
func TestBackfillThreadParticipants(t *testing.T) {
	f := newBackfillFixture(t)
	ctx := context.Background()

	dry, err := BackfillThreadParticipants(ctx, f.db, "ch-bf", SidebarItemChannel, f.threads, machineAuthors, true)
	if err != nil {
		t.Fatalf("dry run: %v", err)
	}
	if dry != (ThreadParticipantsResult{Indexed: 1, AlreadyIndexed: 1, FollowsWritten: 2, RootsSkipped: 2}) {
		t.Fatalf("dry run = %+v", dry)
	}
	if fl, _ := f.follows.GetThreadFollow(ctx, "u-a", "ch-bf", f.open); fl != nil {
		t.Fatalf("dry run wrote a follow row: %+v", fl)
	}
	if m, _ := f.ms.GetMessage(ctx, "ch-bf", f.open); m.ParticipantsIndexed {
		t.Fatal("dry run flagged the root")
	}

	res, err := BackfillThreadParticipants(ctx, f.db, "ch-bf", SidebarItemChannel, f.threads, machineAuthors, false)
	if err != nil || res != dry {
		t.Fatalf("apply = %+v (err %v), want %+v", res, err, dry)
	}
	for _, uid := range []string{"root-author", "u-a"} {
		fl, err := f.follows.GetThreadFollow(ctx, uid, "ch-bf", f.open)
		if err != nil || fl == nil || !fl.Following || fl.ParentType != SidebarItemChannel || fl.LastActivityAt == nil || !fl.LastActivityAt.Equal(f.latest) {
			t.Fatalf("%s follow = %+v (err %v), want a follow dated by the latest reply", uid, fl, err)
		}
	}
	if fl, _ := f.follows.GetThreadFollow(ctx, "u-b", "ch-bf", f.open); fl == nil || fl.Following {
		t.Fatalf("u-b follow = %+v, want the unfollow kept", fl)
	}
	if fl, _ := f.follows.GetThreadFollow(ctx, "webhook", "ch-bf", f.open); fl != nil {
		t.Fatalf("the webhook sentinel got a follow row: %+v", fl)
	}
	if m, _ := f.ms.GetMessage(ctx, "ch-bf", f.open); !m.ParticipantsIndexed {
		t.Fatal("the backfilled root is not flagged")
	}
	if m, _ := f.ms.GetMessage(ctx, "ch-bf", f.deleted); m.ParticipantsIndexed {
		t.Fatal("a deleted root was flagged")
	}
	// The thread is on u-a's /threads list.
	listed, _, err := f.follows.ListFollowedThreadsByActivity(ctx, "u-a", "", 10)
	if err != nil || len(listed) != 1 || listed[0].ThreadRootID != f.open {
		t.Fatalf("u-a's threads = %+v (err %v), want the backfilled one", listed, err)
	}

	again, err := BackfillThreadParticipants(ctx, f.db, "ch-bf", SidebarItemChannel, f.threads, machineAuthors, false)
	if err != nil || again != (ThreadParticipantsResult{AlreadyIndexed: 2, RootsSkipped: 2}) {
		t.Fatalf("second run = %+v (err %v), want nothing left", again, err)
	}
}

// nthBatchGetFails fails the nth BatchGetItem call (1-based).
type nthBatchGetFails struct {
	DynamoAPI
	n, calls atomic.Int32
}

func (c *nthBatchGetFails) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, o ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	if c.calls.Add(1) == c.n.Load() {
		return nil, errInjected
	}
	return c.DynamoAPI.BatchGetItem(ctx, in, o...)
}

// rootGoneBeforeFlag hard-deletes the row an UpdateItem targets just before
// it runs: a root deleted while its rows were being written.
type rootGoneBeforeFlag struct{ DynamoAPI }

func (c *rootGoneBeforeFlag) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, o ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if _, err := c.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: in.TableName, Key: in.Key}); err != nil {
		return nil, err
	}
	return c.DynamoAPI.UpdateItem(ctx, in, o...)
}

// A failed read or write stops the batch with the error and leaves the root
// unflagged, so a re-run picks it up; a root deleted mid-way is skipped.
func TestBackfillThreadParticipants_Failures(t *testing.T) {
	ctx := context.Background()
	run := func(f *backfillFixture, db *DB) (ThreadParticipantsResult, error) {
		return BackfillThreadParticipants(ctx, db, "ch-bf", SidebarItemChannel, f.threads[:1], machineAuthors, false)
	}
	for name, fault := range map[string]func(*faultClient){
		"put follow": func(c *faultClient) { c.failPutItem = true },
		"flag root":  func(c *faultClient) { c.failUpdateItem = true },
	} {
		f := newBackfillFixture(t)
		if _, err := run(f, withFault(f.db, fault)); !errors.Is(err, errInjected) {
			t.Fatalf("%s fault = %v, want errInjected", name, err)
		}
		if m, _ := f.ms.GetMessage(ctx, "ch-bf", f.open); m.ParticipantsIndexed {
			t.Fatalf("%s fault: root flagged anyway", name)
		}
	}
	for n := int32(1); n <= 2; n++ { // the roots, then the follow rows
		f := newBackfillFixture(t)
		c := &nthBatchGetFails{DynamoAPI: f.db.Client}
		c.n.Store(n)
		if _, err := run(f, &DB{Client: c, Table: f.db.Table}); !errors.Is(err, errInjected) {
			t.Fatalf("batch get %d fault = %v, want errInjected", n, err)
		}
	}

	f := newBackfillFixture(t)
	res, err := run(f, &DB{Client: &rootGoneBeforeFlag{DynamoAPI: f.db.Client}, Table: f.db.Table})
	if err != nil || res != (ThreadParticipantsResult{FollowsWritten: 2, RootsSkipped: 1}) {
		t.Fatalf("root deleted mid-way = %+v (err %v)", res, err)
	}
}

// A reply that landed after the scan moved the root's last-reply time past
// the scan's: the follow rows take the newer one.
func TestBackfillThreadParticipants_DatesByTheNewerReply(t *testing.T) {
	f := newBackfillFixture(t)
	ctx := context.Background()
	newer := f.latest.Add(time.Hour)
	root, err := f.ms.GetMessage(ctx, "ch-bf", f.open)
	if err != nil {
		t.Fatal(err)
	}
	root.LastReplyAt = &newer
	if err := f.ms.UpdateMessage(ctx, root); err != nil {
		t.Fatal(err)
	}
	if _, err := BackfillThreadParticipants(ctx, f.db, "ch-bf", SidebarItemChannel, f.threads[:1], machineAuthors, false); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if fl, _ := f.follows.GetThreadFollow(ctx, "u-a", "ch-bf", f.open); fl == nil || fl.LastActivityAt == nil || !fl.LastActivityAt.Equal(newer) {
		t.Fatalf("u-a follow = %+v, want it dated by the newer reply", fl)
	}
}
