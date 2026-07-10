package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// fakePresenceStore mirrors the real per-connection semantics: each
// (userID, connID) is an independent entry; the transition verdicts come
// from the live-entry count, and a refresh re-creates a lost entry.
type fakePresenceStore struct {
	conns map[string]map[string]bool // userID → live connIDs
	err   error
}

func newFakePresenceStore() *fakePresenceStore {
	return &fakePresenceStore{conns: make(map[string]map[string]bool)}
}

func (s *fakePresenceStore) IncrementPresence(_ context.Context, userID, connID string) (bool, error) {
	if s.err != nil {
		return false, s.err
	}
	if s.conns[userID] == nil {
		s.conns[userID] = map[string]bool{}
	}
	s.conns[userID][connID] = true
	return len(s.conns[userID]) == 1, nil
}

func (s *fakePresenceStore) DecrementPresence(_ context.Context, userID, connID string) (bool, error) {
	if s.err != nil {
		return false, s.err
	}
	delete(s.conns[userID], connID)
	if len(s.conns[userID]) == 0 {
		delete(s.conns, userID)
		return true, nil
	}
	return false, nil
}

func (s *fakePresenceStore) RefreshPresence(_ context.Context, userID, connID string) error {
	if s.err != nil {
		return s.err
	}
	// Self-heal: like the real ZADD, a refresh re-creates a lost entry.
	if s.conns[userID] == nil {
		s.conns[userID] = map[string]bool{}
	}
	s.conns[userID][connID] = true
	return nil
}

func (s *fakePresenceStore) IsPresenceOnline(_ context.Context, userID string) (bool, error) {
	if s.err != nil {
		return false, s.err
	}
	return len(s.conns[userID]) > 0, nil
}

func (s *fakePresenceStore) OnlinePresenceUserIDs(_ context.Context) ([]string, error) {
	if s.err != nil {
		return nil, s.err
	}
	ids := make([]string, 0, len(s.conns))
	for id := range s.conns {
		ids = append(ids, id)
	}
	return ids, nil
}

func TestPresenceService_Connect_FirstReturnsTrue(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	if !svc.OnConnect(context.Background(), "u1", "c1") {
		t.Error("first connect should return true")
	}
	if !svc.IsOnline("u1") {
		t.Error("u1 should be online")
	}
	if len(pub.published) != 1 {
		t.Fatalf("expected 1 publish, got %d", len(pub.published))
	}
	if pub.published[0].event.Type != events.EventPresenceChanged {
		t.Errorf("event type=%q want %q", pub.published[0].event.Type, events.EventPresenceChanged)
	}
}

func TestPresenceService_Connect_ScopedToAudienceTopics(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)
	svc.SetPresenceAudienceResolver(func(_ context.Context, userID string) []string {
		if userID != "u1" {
			t.Errorf("resolver called for %q, want u1", userID)
		}
		return []string{pubsub.ChannelName("c1"), pubsub.ConversationName("d1")}
	})

	if !svc.OnConnect(context.Background(), "u1", "c1") {
		t.Fatal("first connect should report the transition")
	}
	if len(pub.published) != 2 {
		t.Fatalf("expected 2 scoped publishes (channel + DM), got %d", len(pub.published))
	}
	topics := map[string]bool{}
	for _, p := range pub.published {
		topics[p.channel] = true
		if p.event.Type != events.EventPresenceChanged {
			t.Errorf("event type=%q want %q", p.event.Type, events.EventPresenceChanged)
		}
	}
	if !topics[pubsub.ChannelName("c1")] || !topics[pubsub.ConversationName("d1")] {
		t.Errorf("presence not published to scoped topics: %v", topics)
	}
	if topics[pubsub.PresenceEvents()] {
		t.Error("scoped presence must not publish to the global topic")
	}
}

// manyPub implements events.ManyPublisher so the presence fan-out takes the
// pipelined PublishMany path instead of the per-topic Publish loop.
type manyPub struct {
	manyCalls [][]string
	single    int
}

func (m *manyPub) Publish(_ context.Context, _ string, _ *events.Event) error {
	m.single++
	return nil
}

func (m *manyPub) PublishMany(_ context.Context, channels []string, _ *events.Event) error {
	m.manyCalls = append(m.manyCalls, channels)
	return nil
}

func TestPresenceService_Connect_PipelinesViaPublishMany(t *testing.T) {
	pub := &manyPub{}
	svc := NewPresenceService(nil, pub)
	svc.SetPresenceAudienceResolver(func(context.Context, string) []string {
		return []string{pubsub.ChannelName("c1"), pubsub.ConversationName("d1")}
	})

	if !svc.OnConnect(context.Background(), "u1", "c1") {
		t.Fatal("first connect should report the transition")
	}
	if len(pub.manyCalls) != 1 || len(pub.manyCalls[0]) != 2 {
		t.Fatalf("expected one pipelined PublishMany with 2 topics, got %v", pub.manyCalls)
	}
	if pub.single != 0 {
		t.Errorf("batch path must not also call Publish per topic, got %d", pub.single)
	}
}

func TestPresenceService_Connect_NoSharedContextPublishesNothing(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)
	svc.SetPresenceAudienceResolver(func(context.Context, string) []string { return nil })
	if !svc.OnConnect(context.Background(), "loner", "c1") {
		t.Fatal("first connect should report the transition")
	}
	if len(pub.published) != 0 {
		t.Fatalf("a user sharing no channel/DM should reach no one, got %d publishes", len(pub.published))
	}
}

func TestPresenceService_Connect_SecondReturnsFalse(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	svc.OnConnect(context.Background(), "u1", "c1")
	if svc.OnConnect(context.Background(), "u1", "c2") {
		t.Error("second connect should return false (still online)")
	}
	if len(pub.published) != 1 {
		t.Errorf("only first connect should publish, got %d", len(pub.published))
	}
}

func TestPresenceService_Disconnect_LastReturnsTrue(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	svc.OnConnect(context.Background(), "u1", "c1")
	if !svc.OnDisconnect(context.Background(), "u1", "c1") {
		t.Error("only-connection disconnect should return true")
	}
	if svc.IsOnline("u1") {
		t.Error("u1 should be offline after disconnect")
	}
	if len(pub.published) != 2 {
		t.Errorf("expected 2 publishes (connect+disconnect), got %d", len(pub.published))
	}
}

func TestPresenceService_Disconnect_OneOfManyReturnsFalse(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	svc.OnConnect(context.Background(), "u1", "c1")
	svc.OnConnect(context.Background(), "u1", "c2")
	if svc.OnDisconnect(context.Background(), "u1", "c2") {
		t.Error("disconnect with remaining connections should return false")
	}
	if !svc.IsOnline("u1") {
		t.Error("u1 should still be online")
	}
	if len(pub.published) != 1 {
		t.Errorf("only first connect should publish, got %d", len(pub.published))
	}
}

func TestPresenceService_Disconnect_NeverConnectedReturnsFalse(t *testing.T) {
	svc := NewPresenceService(nil, newMockPublisher())
	if svc.OnDisconnect(context.Background(), "ghost", "c1") {
		t.Error("disconnect of never-connected user should return false")
	}
}

// The instance-crash class of bug: a disconnect for a connID the store never
// saw (or that already lapsed) must be a no-op that cannot knock a live user
// offline — under the old counter design this DECR drove the count negative
// and published a false offline while another connection was still live.
func TestPresenceService_Disconnect_UnknownConnIDIsNoOp(t *testing.T) {
	store := newFakePresenceStore()
	pub := newMockPublisher()
	svc := NewPresenceService(store, pub)

	svc.OnConnect(context.Background(), "u1", "c-live")
	if svc.OnDisconnect(context.Background(), "u1", "c-ghost") {
		t.Fatal("unknown connID disconnect must not report an offline transition")
	}
	if !svc.IsOnline("u1") {
		t.Fatal("live connection must survive an unknown connID disconnect")
	}
	if len(pub.published) != 1 {
		t.Fatalf("no offline may be published, got %d publishes", len(pub.published))
	}
}

func TestPresenceService_OnlineUserIDs(t *testing.T) {
	svc := NewPresenceService(nil, newMockPublisher())

	if got := svc.OnlineUserIDs(); len(got) != 0 {
		t.Errorf("empty initial online list, got %v", got)
	}

	svc.OnConnect(context.Background(), "u1", "c1")
	svc.OnConnect(context.Background(), "u2", "c2")

	got := svc.OnlineUserIDs()
	if len(got) != 2 {
		t.Errorf("expected 2 online, got %d (%v)", len(got), got)
	}
}

func TestPresenceService_SharedStoreMakesRemoteConnectionsVisible(t *testing.T) {
	store := newFakePresenceStore()
	svcA := NewPresenceService(store, newMockPublisher())
	svcB := NewPresenceService(store, newMockPublisher())

	svcA.OnConnect(context.Background(), "u1", "c-a1")

	if !svcB.IsOnline("u1") {
		t.Fatal("second service should see user online through shared presence store")
	}
	got := svcB.OnlineUserIDs()
	if len(got) != 1 || got[0] != "u1" {
		t.Fatalf("shared online IDs = %v, want [u1]", got)
	}
}

func TestPresenceService_SharedStorePublishesOnlyOnGlobalTransitions(t *testing.T) {
	store := newFakePresenceStore()
	pubA := newMockPublisher()
	pubB := newMockPublisher()
	svcA := NewPresenceService(store, pubA)
	svcB := NewPresenceService(store, pubB)

	if !svcA.OnConnect(context.Background(), "u1", "c-a1") {
		t.Fatal("first process should publish online transition")
	}
	if svcB.OnConnect(context.Background(), "u1", "c-b1") {
		t.Fatal("second process connection should not publish duplicate online transition")
	}
	if len(pubA.published) != 1 || len(pubB.published) != 0 {
		t.Fatalf("online publishes: pubA=%d pubB=%d", len(pubA.published), len(pubB.published))
	}

	if svcB.OnDisconnect(context.Background(), "u1", "c-b1") {
		t.Fatal("disconnect while another process is still connected should not publish offline")
	}
	if !svcA.OnDisconnect(context.Background(), "u1", "c-a1") {
		t.Fatal("last global disconnect should publish offline")
	}
	if len(pubA.published) != 2 || len(pubB.published) != 0 {
		t.Fatalf("final publishes: pubA=%d pubB=%d", len(pubA.published), len(pubB.published))
	}
}

func TestPresenceService_FallsBackToLocalPresenceOnStoreError(t *testing.T) {
	store := newFakePresenceStore()
	store.err = errors.New("redis down")
	svc := NewPresenceService(store, newMockPublisher())

	svc.OnConnect(context.Background(), "u1", "c1")

	if !svc.IsOnline("u1") {
		t.Fatal("local presence should remain usable when the shared store errors")
	}
	got := svc.OnlineUserIDs()
	if len(got) != 1 || got[0] != "u1" {
		t.Fatalf("local online IDs = %v, want [u1]", got)
	}
}

// With a broken store, the LOCAL transitions still publish — a user's own
// instance keeps announcing them (fail toward visible), and the second local
// connection stays deduped.
func TestPresenceService_StoreErrorFallsBackToLocalTransitions(t *testing.T) {
	store := newFakePresenceStore()
	store.err = errors.New("redis down")
	pub := newMockPublisher()
	svc := NewPresenceService(store, pub)

	if !svc.OnConnect(context.Background(), "u1", "c1") {
		t.Fatal("first local connect must publish online despite store error")
	}
	if svc.OnConnect(context.Background(), "u1", "c2") {
		t.Fatal("second local connect must stay deduped despite store error")
	}
	if svc.OnDisconnect(context.Background(), "u1", "c2") {
		t.Fatal("non-last local disconnect must not publish offline")
	}
	if !svc.OnDisconnect(context.Background(), "u1", "c1") {
		t.Fatal("last local disconnect must publish offline despite store error")
	}
	if len(pub.published) != 2 {
		t.Fatalf("expected 2 publishes (online+offline), got %d", len(pub.published))
	}
}

func TestPresenceService_RefreshOnlyTouchesLocalConnections(t *testing.T) {
	store := newFakePresenceStore()
	svc := NewPresenceService(store, newMockPublisher())

	svc.Refresh(context.Background(), "u1", "c1") // not locally connected → no store touch
	if len(store.conns["u1"]) != 0 {
		t.Fatalf("refresh before connect must not touch the store, got %v", store.conns["u1"])
	}
	svc.OnConnect(context.Background(), "u1", "c1")
	svc.Refresh(context.Background(), "u1", "c1")
	if len(store.conns["u1"]) != 1 {
		t.Fatalf("refresh should re-score the same connection, got %v", store.conns["u1"])
	}
}

// The self-heal contract: a distributed entry lost to a Redis blip is
// re-created by the next keep-alive refresh, so a live user cannot stay
// offline in the fleet view until they reconnect.
func TestPresenceService_RefreshHealsLostStoreEntry(t *testing.T) {
	store := newFakePresenceStore()
	svc := NewPresenceService(store, newMockPublisher())

	svc.OnConnect(context.Background(), "u1", "c1")
	delete(store.conns, "u1") // the blip: distributed entry vanishes

	svc.Refresh(context.Background(), "u1", "c1")
	on, err := store.IsPresenceOnline(context.Background(), "u1")
	if err != nil || !on {
		t.Fatalf("refresh must re-create the lost entry (on=%v err=%v)", on, err)
	}
}

func TestPresenceService_NilPublisher(t *testing.T) {
	// Should not panic.
	svc := NewPresenceService(nil, nil)
	svc.OnConnect(context.Background(), "u1", "c1")
	svc.OnDisconnect(context.Background(), "u1", "c1")
	svc.Refresh(context.Background(), "u1", "c1") // nil store → early return, no panic
}

// slowPresenceStore blocks IsPresenceOnline / OnlinePresenceUserIDs
// until the caller's context fires Done. Used to verify the lookup
// timeout: a wedged Redis must NOT freeze the request hot path.
type slowPresenceStore struct {
	*fakePresenceStore
}

func (s *slowPresenceStore) IsPresenceOnline(ctx context.Context, userID string) (bool, error) {
	<-ctx.Done()
	return false, ctx.Err()
}

func (s *slowPresenceStore) OnlinePresenceUserIDs(ctx context.Context) ([]string, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestPresenceService_IsOnline_TimesOutOnWedgedStore(t *testing.T) {
	store := &slowPresenceStore{fakePresenceStore: newFakePresenceStore()}
	svc := NewPresenceService(store, newMockPublisher())

	start := time.Now()
	got := svc.IsOnline("u1")
	elapsed := time.Since(start)

	if got {
		t.Error("IsOnline should fall back to false on store timeout")
	}
	// Timeout is 500ms; allow ample headroom for slow CI hosts but
	// fail loudly if the call blocked beyond ~2s (the bug we fixed).
	if elapsed > 2*time.Second {
		t.Errorf("IsOnline blocked for %v; expected ≤2s", elapsed)
	}
}

func TestPresenceService_OnlineUserIDs_TimesOutOnWedgedStore(t *testing.T) {
	store := &slowPresenceStore{fakePresenceStore: newFakePresenceStore()}
	svc := NewPresenceService(store, newMockPublisher())
	svc.OnConnect(context.Background(), "u-local", "c1")

	start := time.Now()
	ids := svc.OnlineUserIDs()
	elapsed := time.Since(start)

	// On store timeout, fall back to in-process map ("u-local" was
	// just added). The fallback must contain that ID, proving we did
	// NOT stall waiting on Redis.
	found := false
	for _, id := range ids {
		if id == "u-local" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected fallback to include u-local, got %v", ids)
	}
	if elapsed > 2*time.Second {
		t.Errorf("OnlineUserIDs blocked for %v; expected ≤2s", elapsed)
	}
}
