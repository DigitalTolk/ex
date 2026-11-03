package eventlog

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"
)

// The cache is bounded even when every entry is fresh: past the cap the least
// recently resolved topic is evicted, so dormant topics can't pile up.
func TestResolver_CacheIsBounded(t *testing.T) {
	m := &fakeMembers{ids: map[string][]string{}} // any topic resolves to nil, no error
	r := NewResolver(m, nil)
	r.SetCacheTTL(time.Minute)

	for i := 0; i <= recipientCacheMaxEntries; i++ {
		if _, err := r.Resolve(context.Background(), fmt.Sprintf("chan:c%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if got := r.cache.Load().Len(); got != recipientCacheMaxEntries {
		t.Fatalf("cache size = %d, want the cap %d", got, recipientCacheMaxEntries)
	}
	// The oldest topic was the one evicted: resolving it queries the store again.
	before := m.calls.Load()
	if _, err := r.Resolve(context.Background(), "chan:c0"); err != nil {
		t.Fatal(err)
	}
	if m.calls.Load() != before+1 {
		t.Fatal("the least recently resolved topic was not the one evicted")
	}
}

type fakeMembers struct {
	ids   map[string][]string
	err   error
	calls atomic.Int32
	// release, when set, holds every lookup until it is closed.
	release chan struct{}
}

func (f *fakeMembers) MemberIDs(_ context.Context, channelID string) ([]string, error) {
	f.calls.Add(1)
	if f.release != nil {
		<-f.release
	}
	if f.err != nil {
		return nil, f.err
	}
	return f.ids[channelID], nil
}

// With caching enabled, repeated resolutions of the same topic within the TTL
// are served from cache, and a fetch error is not cached.
func TestResolver_CacheTTL(t *testing.T) {
	m := &fakeMembers{ids: map[string][]string{"c1": {"u1", "u2"}}}
	r := NewResolver(m, nil)
	r.SetCacheTTL(time.Minute)

	if _, err := r.Resolve(context.Background(), "chan:c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Resolve(context.Background(), "chan:c1"); err != nil {
		t.Fatal(err)
	}
	if m.calls.Load() != 1 {
		t.Fatalf("store called %d times, want 1 (second served from cache)", m.calls.Load())
	}

	// A failed fetch propagates and is NOT cached: the next resolve asks again.
	m.err = errors.New("boom")
	if _, err := r.Resolve(context.Background(), "chan:c2"); err == nil {
		t.Error("expected fetch error to propagate")
	}
	m.err = nil
	if _, err := r.Resolve(context.Background(), "chan:c2"); err != nil {
		t.Fatal(err)
	}
	if m.calls.Load() != 3 {
		t.Fatalf("store called %d times, want 3 (the error was not cached)", m.calls.Load())
	}
}

// An expired entry re-fetches. Wait for the refreshed set, never for a fixed
// time.
func TestResolver_CacheExpires(t *testing.T) {
	m := &fakeMembers{ids: map[string][]string{"c1": {"u1"}}}
	r := NewResolver(m, nil)
	r.SetCacheTTL(20 * time.Millisecond)

	if _, err := r.Resolve(context.Background(), "chan:c1"); err != nil {
		t.Fatal(err)
	}
	m.ids = map[string][]string{"c1": {"u1", "u2"}}
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := r.Resolve(context.Background(), "chan:c1")
		if err != nil {
			t.Fatal(err)
		}
		if len(got) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("recipients = %v, never refreshed after the TTL", got)
		}
	}
	if m.calls.Load() != 2 {
		t.Fatalf("store called %d times, want 2 (one per TTL window)", m.calls.Load())
	}
}

// Concurrent misses for one topic share ONE store query — including its
// failure, which is still not cached.
func TestResolver_ConcurrentMissesShareOneLookup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		boom := errors.New("dynamo down")
		m := &fakeMembers{err: boom, release: make(chan struct{})}
		r := NewResolver(m, nil)
		// A non-expiring cache: an expiring one runs a sweeper goroutine that
		// never exits, which a synctest bubble can't hold.
		r.cache.Store(expirable.NewLRU[string, recipients](recipientCacheMaxEntries, nil, 0))

		var wg sync.WaitGroup
		for range 10 {
			wg.Go(func() {
				if _, err := r.Resolve(context.Background(), "chan:busy"); !errors.Is(err, boom) {
					t.Errorf("err = %v, want the shared lookup's error", err)
				}
			})
		}
		synctest.Wait() // every caller is parked: one querying, the rest waiting on it
		close(m.release)
		wg.Wait()
		if got := m.calls.Load(); got != 1 {
			t.Fatalf("store calls = %d, want 1 shared lookup", got)
		}
		if _, err := r.Resolve(context.Background(), "chan:busy"); !errors.Is(err, boom) {
			t.Fatalf("err = %v, want a fresh failing lookup", err)
		}
		if got := m.calls.Load(); got != 2 {
			t.Fatalf("store calls = %d, want 2 (the failure was not cached)", got)
		}
	})
}

// SetCacheTTL(0) turns the cache back off: every resolve queries the store.
func TestResolver_CacheCanBeDisabled(t *testing.T) {
	m := &fakeMembers{ids: map[string][]string{"c1": {"u1"}}}
	r := NewResolver(m, nil)
	r.SetCacheTTL(time.Minute)
	r.SetCacheTTL(0)
	for range 2 {
		if _, err := r.Resolve(context.Background(), "chan:c1"); err != nil {
			t.Fatal(err)
		}
	}
	if m.calls.Load() != 2 {
		t.Fatalf("store called %d times, want 2 with the cache off", m.calls.Load())
	}
}

type fakeParticipants struct {
	ids   map[string][]string
	err   error
	calls atomic.Int32
}

func (f *fakeParticipants) ParticipantIDs(_ context.Context, convID string) ([]string, error) {
	f.calls.Add(1)
	if f.err != nil {
		return nil, f.err
	}
	return f.ids[convID], nil
}

// Channel topics resolve to the channel's member set so the publisher
// fans out to every member's per-user inbox.
func TestResolver_ChannelTopic(t *testing.T) {
	m := &fakeMembers{ids: map[string][]string{"c1": {"u1", "u2"}}}
	r := NewResolver(m, nil)
	got, err := r.Resolve(context.Background(), "chan:c1")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(got) != 2 || got[0] != "u1" || got[1] != "u2" {
		t.Errorf("got %v, want [u1 u2]", got)
	}
}

// Conversation topics resolve to the conversation's participants.
func TestResolver_ConversationTopic(t *testing.T) {
	p := &fakeParticipants{ids: map[string][]string{"conv1": {"a", "b", "c"}}}
	r := NewResolver(nil, p)
	got, err := r.Resolve(context.Background(), "conv:conv1")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(got) != 3 {
		t.Errorf("got %v, want 3 entries", got)
	}
}

// User topics encode the recipient directly — no store lookup
// needed — so a single-user notification doesn't trigger an
// unnecessary membership scan on every publish.
func TestResolver_UserTopic(t *testing.T) {
	r := NewResolver(nil, nil)
	got, err := r.Resolve(context.Background(), "user:u-direct")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(got) != 1 || got[0] != "u-direct" {
		t.Errorf("got %v, want [u-direct]", got)
	}
}

// Global broadcast topics (channels, emojis, presence, users) are
// not stored durably — they're either ephemeral (presence) or cheap
// to refetch on reconnect (channel catalog, emoji catalog). Resolver
// returns an empty slice so the publisher skips fan-out cleanly.
func TestResolver_GlobalTopicsReturnNoRecipients(t *testing.T) {
	r := NewResolver(&fakeMembers{}, &fakeParticipants{})
	for _, topic := range []string{"global:channels", "global:emojis", "global:presence", "global:users", "weird:other"} {
		got, err := r.Resolve(context.Background(), topic)
		if err != nil {
			t.Errorf("%s: unexpected error: %v", topic, err)
		}
		if len(got) != 0 {
			t.Errorf("%s: got %v, want empty", topic, got)
		}
	}
}

// Missing dependency for the corresponding topic prefix returns
// empty (live still works, durability just no-ops). This is the
// path tests that don't wire a real store hit.
func TestResolver_MissingDeps(t *testing.T) {
	r := NewResolver(nil, nil)
	if got, _ := r.Resolve(context.Background(), "chan:c1"); len(got) != 0 {
		t.Errorf("chan with nil members = %v, want empty", got)
	}
	if got, _ := r.Resolve(context.Background(), "conv:c1"); len(got) != 0 {
		t.Errorf("conv with nil participants = %v, want empty", got)
	}
}

// Errors from the underlying store must propagate so the publisher
// can log them. Returning empty would mask a broken dependency and
// silently drop durable fan-out forever.
func TestResolver_PropagatesStoreErrors(t *testing.T) {
	boom := errors.New("boom")
	r := NewResolver(&fakeMembers{err: boom}, &fakeParticipants{err: boom})
	if _, err := r.Resolve(context.Background(), "chan:c"); !errors.Is(err, boom) {
		t.Errorf("chan: got err %v, want %v", err, boom)
	}
	if _, err := r.Resolve(context.Background(), "conv:c"); !errors.Is(err, boom) {
		t.Errorf("conv: got err %v, want %v", err, boom)
	}
}

// A nil Resolver is safe to call — keeps the publisher's contract
// (`if resolver != nil` is only checked once) simple.
func TestResolver_NilSafe(t *testing.T) {
	var r *Resolver
	got, err := r.Resolve(context.Background(), "chan:c1")
	if err != nil || len(got) != 0 {
		t.Errorf("nil Resolver got=%v err=%v, want empty+nil", got, err)
	}
}

type fakeGenerations struct {
	gen map[string]string
	err error
}

func (f *fakeGenerations) ChannelGeneration(_ context.Context, channelID string) (string, error) {
	return f.gen[channelID], f.err
}

// With channel generations wired, a channel's recipients are read again only
// when a membership write moved its generation: one Redis read per event
// instead of a member query per TTL window. A generation that can't be read
// fetches without caching; conversation topics keep the TTL alone.
func TestResolver_ChannelEntriesFollowTheGeneration(t *testing.T) {
	m := &fakeMembers{ids: map[string][]string{"c1": {"u1"}}}
	p := &fakeParticipants{ids: map[string][]string{"d1": {"u1", "u2"}}}
	g := &fakeGenerations{gen: map[string]string{"c1": "7"}}
	r := NewResolver(m, p)
	r.SetCacheTTL(time.Hour)
	r.SetChannelGenerations(g)
	ctx := context.Background()
	resolve := func(topic string, want int) {
		t.Helper()
		if got, err := r.Resolve(ctx, topic); err != nil || len(got) != want {
			t.Fatalf("Resolve(%s) = %v (err %v), want %d recipients", topic, got, err, want)
		}
	}

	for range 3 {
		resolve("chan:c1", 1)
	}
	if m.calls.Load() != 1 {
		t.Fatalf("members read %d times, want 1 while the generation holds", m.calls.Load())
	}

	m.ids["c1"] = []string{"u1", "u2"}
	g.gen["c1"] = "8"
	resolve("chan:c1", 2)
	if m.calls.Load() != 2 {
		t.Fatalf("members read %d times, want a re-read after the generation moved", m.calls.Load())
	}

	g.err = errors.New("redis down")
	resolve("chan:c1", 2)
	resolve("chan:c1", 2)
	if m.calls.Load() != 4 {
		t.Fatalf("members read %d times, want a read per event while the generation is unreadable", m.calls.Load())
	}
	g.err = nil
	resolve("chan:c1", 2)
	if m.calls.Load() != 4 {
		t.Fatalf("members read %d times, want the generation-8 entry reused", m.calls.Load())
	}

	resolve("conv:d1", 2)
	resolve("conv:d1", 2)
	if p.calls.Load() != 1 {
		t.Fatalf("participants read %d times, want 1 within the TTL", p.calls.Load())
	}
}
