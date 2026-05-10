package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
)

type fakePresenceStore struct {
	counts map[string]int
	err    error
}

func newFakePresenceStore() *fakePresenceStore {
	return &fakePresenceStore{counts: make(map[string]int)}
}

func (s *fakePresenceStore) IncrementPresence(_ context.Context, userID string) (bool, error) {
	if s.err != nil {
		return false, s.err
	}
	s.counts[userID]++
	return s.counts[userID] == 1, nil
}

func (s *fakePresenceStore) DecrementPresence(_ context.Context, userID string) (bool, error) {
	if s.err != nil {
		return false, s.err
	}
	if s.counts[userID] <= 1 {
		delete(s.counts, userID)
		return true, nil
	}
	s.counts[userID]--
	return false, nil
}

func (s *fakePresenceStore) RefreshPresence(_ context.Context, userID string) error {
	if s.err != nil {
		return s.err
	}
	if s.counts[userID] == 0 {
		return errors.New("missing")
	}
	return nil
}

func (s *fakePresenceStore) IsPresenceOnline(_ context.Context, userID string) (bool, error) {
	if s.err != nil {
		return false, s.err
	}
	return s.counts[userID] > 0, nil
}

func (s *fakePresenceStore) OnlinePresenceUserIDs(_ context.Context) ([]string, error) {
	if s.err != nil {
		return nil, s.err
	}
	ids := make([]string, 0, len(s.counts))
	for id := range s.counts {
		ids = append(ids, id)
	}
	return ids, nil
}

func TestPresenceService_Connect_FirstReturnsTrue(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	if !svc.OnConnect(context.Background(), "u1") {
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

func TestPresenceService_Connect_SecondReturnsFalse(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	svc.OnConnect(context.Background(), "u1")
	if svc.OnConnect(context.Background(), "u1") {
		t.Error("second connect should return false (still online)")
	}
	if len(pub.published) != 1 {
		t.Errorf("only first connect should publish, got %d", len(pub.published))
	}
}

func TestPresenceService_Disconnect_LastReturnsTrue(t *testing.T) {
	pub := newMockPublisher()
	svc := NewPresenceService(nil, pub)

	svc.OnConnect(context.Background(), "u1")
	if !svc.OnDisconnect(context.Background(), "u1") {
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

	svc.OnConnect(context.Background(), "u1")
	svc.OnConnect(context.Background(), "u1")
	if svc.OnDisconnect(context.Background(), "u1") {
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
	if svc.OnDisconnect(context.Background(), "ghost") {
		t.Error("disconnect of never-connected user should return false")
	}
}

func TestPresenceService_OnlineUserIDs(t *testing.T) {
	svc := NewPresenceService(nil, newMockPublisher())

	if got := svc.OnlineUserIDs(); len(got) != 0 {
		t.Errorf("empty initial online list, got %v", got)
	}

	svc.OnConnect(context.Background(), "u1")
	svc.OnConnect(context.Background(), "u2")

	got := svc.OnlineUserIDs()
	if len(got) != 2 {
		t.Errorf("expected 2 online, got %d (%v)", len(got), got)
	}
}

func TestPresenceService_SharedStoreMakesRemoteConnectionsVisible(t *testing.T) {
	store := newFakePresenceStore()
	svcA := NewPresenceService(store, newMockPublisher())
	svcB := NewPresenceService(store, newMockPublisher())

	svcA.OnConnect(context.Background(), "u1")

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

	if !svcA.OnConnect(context.Background(), "u1") {
		t.Fatal("first process should publish online transition")
	}
	if svcB.OnConnect(context.Background(), "u1") {
		t.Fatal("second process connection should not publish duplicate online transition")
	}
	if len(pubA.published) != 1 || len(pubB.published) != 0 {
		t.Fatalf("online publishes: pubA=%d pubB=%d", len(pubA.published), len(pubB.published))
	}

	if svcB.OnDisconnect(context.Background(), "u1") {
		t.Fatal("disconnect while another process is still connected should not publish offline")
	}
	if !svcA.OnDisconnect(context.Background(), "u1") {
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

	svc.OnConnect(context.Background(), "u1")

	if !svc.IsOnline("u1") {
		t.Fatal("local presence should remain usable when the shared store errors")
	}
	got := svc.OnlineUserIDs()
	if len(got) != 1 || got[0] != "u1" {
		t.Fatalf("local online IDs = %v, want [u1]", got)
	}
}

func TestPresenceService_RefreshOnlyTouchesLocalConnections(t *testing.T) {
	store := newFakePresenceStore()
	svc := NewPresenceService(store, newMockPublisher())

	svc.Refresh(context.Background(), "u1")
	svc.OnConnect(context.Background(), "u1")
	svc.Refresh(context.Background(), "u1")
	if store.counts["u1"] != 1 {
		t.Fatalf("refresh should not change connection count, got %d", store.counts["u1"])
	}
}

func TestPresenceService_NilPublisher(t *testing.T) {
	// Should not panic.
	svc := NewPresenceService(nil, nil)
	svc.OnConnect(context.Background(), "u1")
	svc.OnDisconnect(context.Background(), "u1")
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
	svc.OnConnect(context.Background(), "u-local")

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
