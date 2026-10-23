package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// memGens is an in-memory AudienceGenerations: the Redis semantics (seed on
// first read, bump moves the value) without a server, plus failure knobs.
type memGens struct {
	mu       sync.Mutex
	vals     map[string]string
	seq      int
	calls    int
	getErr   error
	bumpErr  error
	bumpKeys []string
}

func newMemGens() *memGens { return &memGens{vals: map[string]string{}} }

func (g *memGens) Generations(_ context.Context, keys []string) ([]string, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls++
	if g.getErr != nil {
		return nil, g.getErr
	}
	out := make([]string, len(keys))
	for i, k := range keys {
		if _, ok := g.vals[k]; !ok {
			g.seq++
			g.vals[k] = fmt.Sprint("seed-", g.seq)
		}
		out[i] = g.vals[k]
	}
	return out, nil
}

func (g *memGens) Bump(_ context.Context, keys ...string) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.bumpKeys = append(g.bumpKeys, keys...)
	if g.bumpErr != nil {
		return g.bumpErr
	}
	for _, k := range keys {
		g.seq++
		g.vals[k] = fmt.Sprint("bump-", g.seq)
	}
	return nil
}

func (g *memGens) roundTrips() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.calls
}

// countingUserStore counts account-settings reads.
type countingUserStore struct {
	*mockUserStore
	accountReads atomic.Int64
	maxChunk     atomic.Int64
	inFlight     atomic.Int64
	maxInFlight  atomic.Int64
	gate         chan struct{} // when set, each read waits on it
}

func (c *countingUserStore) NotificationAccountsFor(ctx context.Context, ids []string) (map[string]store.NotificationAccount, error) {
	c.accountReads.Add(1)
	n := c.inFlight.Add(1)
	defer c.inFlight.Add(-1)
	for {
		m := c.maxInFlight.Load()
		if n <= m || c.maxInFlight.CompareAndSwap(m, n) {
			break
		}
	}
	for {
		m := c.maxChunk.Load()
		if int64(len(ids)) <= m || c.maxChunk.CompareAndSwap(m, int64(len(ids))) {
			break
		}
	}
	if c.gate != nil {
		<-c.gate
	}
	return c.mockUserStore.NotificationAccountsFor(ctx, ids)
}

type audienceFixture struct {
	svc     *NotificationService
	pub     *mockPublisher
	members *mockMembershipStore
	users   *countingUserStore
	gens    *memGens
	cache   *AudienceCache
}

func newAudienceFixture(t *testing.T, memberIDs ...string) *audienceFixture {
	t.Helper()
	pub := newMockPublisher()
	members := newMockMembershipStore()
	users := &countingUserStore{mockUserStore: newMockUserStore()}
	chans := newMockChannelStore()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	svc := NewNotificationService(pub, members, newMockConversationStore(), chans, users, newMockMessageStore())
	seedAllLevel(users.mockUserStore, memberIDs...)
	for _, uid := range memberIDs {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	gens := newMemGens()
	cache := NewAudienceCache(gens)
	svc.SetAudienceCache(cache)
	return &audienceFixture{svc: svc, pub: pub, members: members, users: users, gens: gens, cache: cache}
}

func (f *audienceFixture) post(t *testing.T, id string) map[string]bool {
	t.Helper()
	f.pub.mu.Lock()
	f.pub.published = nil
	f.pub.mu.Unlock()
	f.svc.NotifyForMessage(context.Background(), &model.Message{ID: id, ParentID: "ch1", AuthorID: "sender", Body: "status update"}, ParentChannel, nil)
	return alertedUsers(f.pub)
}

// The steady state costs ONE generation read per fan-out — no member, override
// or account reads — and still alerts exactly the cached audience.
func TestAudienceCache_SteadyStateIsOneRoundTrip(t *testing.T) {
	f := newAudienceFixture(t, "u1", "u2")
	if got := f.post(t, "m1"); !got["u1"] || !got["u2"] {
		t.Fatalf("first fan-out alerted %v, want u1+u2", got)
	}
	lists, reads, trips := f.members.listMembersCalls.Load(), f.users.accountReads.Load(), f.gens.roundTrips()

	if got := f.post(t, "m2"); !got["u1"] || !got["u2"] {
		t.Fatalf("cached fan-out alerted %v, want u1+u2", got)
	}
	if n := f.members.listMembersCalls.Load() - lists; n != 0 {
		t.Fatalf("member reads on a cached fan-out = %d, want 0", n)
	}
	if n := f.users.accountReads.Load() - reads; n != 0 {
		t.Fatalf("account reads on a cached fan-out = %d, want 0", n)
	}
	if n := f.gens.roundTrips() - trips; n != 1 {
		t.Fatalf("generation round trips on a cached fan-out = %d, want 1", n)
	}
}

// A changed channel or user reloads exactly what changed.
func TestAudienceCache_ChangesReload(t *testing.T) {
	f := newAudienceFixture(t, "u1", "u2")
	f.post(t, "m1")
	ctx := context.Background()

	// Membership change: u2 leaves, u3 joins.
	delete(f.members.memberships, "ch1#u2")
	seedAllLevel(f.users.mockUserStore, "u3")
	f.members.memberships["ch1#u3"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u3"}
	f.cache.ChannelAudienceChanged(ctx, "ch1")
	if got := f.post(t, "m2"); got["u2"] || !got["u3"] || !got["u1"] {
		t.Fatalf("after the membership change alerted %v, want u1+u3 only", got)
	}

	// Account change: u1 drops to mentions-only.
	f.users.users["u1"].NotificationSettings = &model.NotificationSettings{DesktopLevel: model.NotificationLevelMentions, MobileLevel: model.MobileNotificationDefault}
	reads := f.users.accountReads.Load()
	f.cache.UserAudienceChanged(ctx, "u1")
	if got := f.post(t, "m3"); got["u1"] || !got["u3"] {
		t.Fatalf("after u1's settings change alerted %v, want u3 only", got)
	}
	if n := f.users.accountReads.Load() - reads; n != 1 {
		t.Fatalf("account reads after one user's change = %d, want 1 (only the changed user)", n)
	}
}

// An entry ages out after audienceEntryTTL even without a bump — the backstop
// for writes from outside the app (importer, migrations).
func TestAudienceCache_EntryTTLBackstop(t *testing.T) {
	f := newAudienceFixture(t, "u1")
	clock := time.Now()
	f.cache.now = func() time.Time { return clock }
	f.post(t, "m1")
	// An out-of-band writer adds u2 without bumping anything.
	seedAllLevel(f.users.mockUserStore, "u2")
	f.members.memberships["ch1#u2"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u2"}
	if got := f.post(t, "m2"); got["u2"] {
		t.Fatalf("an unbumped entry should still be served before its TTL, got %v", got)
	}
	clock = clock.Add(audienceEntryTTL)
	if got := f.post(t, "m3"); !got["u2"] {
		t.Fatalf("after the TTL alerted %v, want u2 included", got)
	}
}

// Redis unavailable → the audience is read uncached; alerts never depend on
// the cache.
func TestAudienceCache_GenerationReadFailureReadsUncached(t *testing.T) {
	f := newAudienceFixture(t, "u1")
	f.post(t, "m1")
	f.gens.getErr = errors.New("redis down")
	lists := f.members.listMembersCalls.Load()
	if got := f.post(t, "m2"); !got["u1"] {
		t.Fatalf("alerted %v, want u1 with Redis down", got)
	}
	if f.members.listMembersCalls.Load() == lists {
		t.Fatal("audience not re-read with the generations unavailable")
	}
	// A conversation's account read degrades the same way.
	conv := f.svc.conv.(*mockConversationStore)
	conv.conversations["dm1"] = &model.Conversation{ID: "dm1", ParticipantIDs: []string{"sender", "u1"}}
	f.svc.NotifyForMessage(context.Background(), &model.Message{ID: "m3", ParentID: "dm1", AuthorID: "sender", Body: "hi"}, ParentConversation, nil)
	if !alertedUsers(f.pub)["u1"] {
		t.Fatal("DM recipient not alerted with Redis down")
	}
}

// A read that failed is never cached: a lost mute read (over-notifies once)
// or a lost account read must not stick.
func TestAudienceCache_PartialReadsAreNotCached(t *testing.T) {
	f := newAudienceFixture(t, "u1")
	f.members.listChannelsErr = errors.New("throttled") // override read fails
	f.users.notifErr = errors.New("throttled")          // account read fails
	f.post(t, "m1")
	if f.cache.channels.Len() != 0 || f.cache.users.Len() != 0 {
		t.Fatalf("cached a failed read: %d channels, %d users", f.cache.channels.Len(), f.cache.users.Len())
	}
	f.members.listChannelsErr, f.users.notifErr = nil, nil
	f.members.mutes["ch1#u1"] = true
	if got := f.post(t, "m2"); got["u1"] {
		t.Fatalf("muted u1 alerted %v — the failed read was served from cache", got)
	}
}

// A member read that fails loses the audience (loud, and the safety net
// retries); it is not cached either.
func TestAudienceCache_MemberReadFailure(t *testing.T) {
	orig := audienceRetryInterval
	audienceRetryInterval = time.Millisecond
	t.Cleanup(func() { audienceRetryInterval = orig })
	f := newAudienceFixture(t, "u1")
	f.members.listMembersErr = errors.New("down")
	if got := f.post(t, "m1"); len(got) != 0 {
		t.Fatalf("alerted %v with the member list unreadable", got)
	}
	if f.cache.channels.Len() != 0 {
		t.Fatal("cached a failed member read")
	}
}

// A failed bump is logged loudly, drops the local entry, and never panics.
func TestAudienceCache_BumpFailure(t *testing.T) {
	orig := audienceRetryInterval
	audienceRetryInterval = time.Millisecond
	t.Cleanup(func() { audienceRetryInterval = orig })
	f := newAudienceFixture(t, "u1")
	f.post(t, "m1")
	f.gens.bumpErr = errors.New("redis down")
	f.cache.ChannelAudienceChanged(context.Background(), "ch1")
	f.cache.UserAudienceChanged(context.Background(), "u1")
	if f.cache.channels.Len() != 0 || f.cache.users.Len() != 0 {
		t.Fatal("a failed bump left the local entries in place")
	}
	if len(f.gens.bumpKeys) != 2*int(audienceRetryMaxRetries+1) {
		t.Fatalf("bump attempts = %d, want %d (retried)", len(f.gens.bumpKeys), 2*int(audienceRetryMaxRetries+1))
	}
}

// consistentMembers adds the strongly consistent member read.
type consistentMembers struct {
	*mockMembershipStore
	consistentCalls atomic.Int64
}

func (c *consistentMembers) ListMembersConsistent(ctx context.Context, channelID string) ([]*model.ChannelMembership, error) {
	c.consistentCalls.Add(1)
	return c.ListMembers(ctx, channelID)
}

// A cache fill reads members strongly consistently (a just-joined member must
// be in what gets cached); an uncached read keeps the cheaper read.
func TestAudienceCache_FillsReadConsistently(t *testing.T) {
	f := newAudienceFixture(t, "u1")
	cm := &consistentMembers{mockMembershipStore: f.members}
	f.svc.members = cm
	f.post(t, "m1")
	if cm.consistentCalls.Load() != 1 {
		t.Fatalf("consistent member reads on a fill = %d, want 1", cm.consistentCalls.Load())
	}
	f.svc.SetAudienceCache(nil)
	f.post(t, "m2")
	if cm.consistentCalls.Load() != 1 {
		t.Fatal("an uncached read used the consistent read")
	}
}

// Large audiences read in DynamoDB-sized chunks, several at once.
func TestAudienceCache_LargeAudienceReadsInParallelChunks(t *testing.T) {
	ids := make([]string, 0, 350)
	for i := range 350 {
		ids = append(ids, fmt.Sprintf("u%03d", i))
	}
	f := newAudienceFixture(t, ids...)
	gate := make(chan struct{})
	f.users.gate = gate
	done := make(chan map[string]bool)
	go func() { done <- f.post(t, "m1") }()
	// All four chunks must be in flight at once before any is released.
	awaitCond(t, func() bool { return f.users.inFlight.Load() == 4 }, "four parallel account chunks")
	close(gate)
	got := <-done
	if len(got) != 350 {
		t.Fatalf("alerted %d members, want 350", len(got))
	}
	if f.users.maxChunk.Load() > audienceBatchSize {
		t.Fatalf("largest chunk = %d, want <= %d", f.users.maxChunk.Load(), audienceBatchSize)
	}
}

// A batch read that panics is a failed chunk, not a crash or a silent success.
func TestParallelChunks_PanicIsAnError(t *testing.T) {
	err := parallelChunks(context.Background(), []string{"a"}, func(context.Context, []string) error {
		panic("boom")
	})
	if !errors.Is(err, errAudienceChunkPanicked) {
		t.Fatalf("err = %v, want errAudienceChunkPanicked", err)
	}
}

// No user store → defaults for everyone, never a crash.
func TestReadAccounts_NoUserStore(t *testing.T) {
	svc := &NotificationService{}
	if got, ok := svc.readAccounts(context.Background(), []string{"u1"}); ok || len(got) != 0 {
		t.Fatalf("readAccounts = %v, %v; want empty, not ok", got, ok)
	}
}
