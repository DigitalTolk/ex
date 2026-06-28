package eventlog

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// At the cache cap, inserting another entry sweeps the expired ones so the map
// can't grow without bound from dormant topics.
func TestResolver_CacheEvictsExpiredAtCap(t *testing.T) {
	m := &fakeMembers{ids: map[string][]string{}} // any topic resolves to nil, no error
	r := NewResolver(m, nil)
	r.SetCacheTTL(time.Minute)
	base := time.Unix(1000, 0)
	r.now = func() time.Time { return base }

	for i := 0; i < recipientCacheMaxEntries; i++ {
		if _, err := r.Resolve(context.Background(), fmt.Sprintf("chan:c%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	// Advance past the TTL so the cap-fill is all expired, then one more insert
	// trips the cap and sweeps them.
	base = base.Add(2 * time.Minute)
	if _, err := r.Resolve(context.Background(), "chan:fresh"); err != nil {
		t.Fatal(err)
	}
	r.mu.Lock()
	got := len(r.cache)
	r.mu.Unlock()
	if got != 1 {
		t.Fatalf("cache size after cap-sweep = %d, want 1 (expired entries evicted)", got)
	}
}

type fakeMembers struct {
	ids   map[string][]string
	err   error
	calls int
}

func (f *fakeMembers) MemberIDs(_ context.Context, channelID string) ([]string, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.ids[channelID], nil
}

// With caching enabled, repeated resolutions of the same topic within the TTL
// are served from cache; an expired entry re-fetches; a fetch error is not
// cached.
func TestResolver_CacheTTL(t *testing.T) {
	m := &fakeMembers{ids: map[string][]string{"c1": {"u1", "u2"}}}
	r := NewResolver(m, nil)
	r.SetCacheTTL(time.Minute)
	offset := time.Duration(0)
	r.now = func() time.Time { return time.Unix(1000, 0).Add(offset) }

	if _, err := r.Resolve(context.Background(), "chan:c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Resolve(context.Background(), "chan:c1"); err != nil {
		t.Fatal(err)
	}
	if m.calls != 1 {
		t.Fatalf("store called %d times, want 1 (second served from cache)", m.calls)
	}

	// Advance past the TTL → re-fetch.
	offset = 2 * time.Minute
	if _, err := r.Resolve(context.Background(), "chan:c1"); err != nil {
		t.Fatal(err)
	}
	if m.calls != 2 {
		t.Fatalf("store called %d times after expiry, want 2", m.calls)
	}

	// Expire again and make the fetch fail — the error propagates and is NOT cached.
	offset = 4 * time.Minute
	m.err = errors.New("boom")
	if _, err := r.Resolve(context.Background(), "chan:c1"); err == nil {
		t.Error("expected fetch error to propagate")
	}
}

// Covers the default (time.Now) clock path when caching is on but no clock is injected.
func TestResolver_CacheDefaultClock(t *testing.T) {
	m := &fakeMembers{ids: map[string][]string{"c1": {"u1"}}}
	r := NewResolver(m, nil)
	r.SetCacheTTL(time.Minute)
	if _, err := r.Resolve(context.Background(), "chan:c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Resolve(context.Background(), "chan:c1"); err != nil {
		t.Fatal(err)
	}
	if m.calls != 1 {
		t.Fatalf("store called %d times, want 1 with the default clock", m.calls)
	}
}

type fakeParticipants struct {
	ids map[string][]string
	err error
}

func (f *fakeParticipants) ParticipantIDs(_ context.Context, convID string) ([]string, error) {
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
