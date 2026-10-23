package searchaccess

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

type fakeMemberships struct {
	mu    sync.Mutex
	calls atomic.Int32
	chans map[string][]*model.UserChannel
	err   error
	// release, when set, holds every lookup until it is closed.
	release chan struct{}
}

func (f *fakeMemberships) ListUserChannels(_ context.Context, userID string) ([]*model.UserChannel, error) {
	f.calls.Add(1)
	if f.release != nil {
		<-f.release
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, f.err
	}
	return append([]*model.UserChannel(nil), f.chans[userID]...), nil
}

func (f *fakeMemberships) set(userID string, chans ...*model.UserChannel) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chans[userID] = chans
}

type fakeConversations struct {
	calls atomic.Int32
	convs map[string][]*model.UserConversation
	err   error
}

func (f *fakeConversations) ListUserConversations(_ context.Context, userID string) ([]*model.UserConversation, error) {
	f.calls.Add(1)
	if f.err != nil {
		return nil, f.err
	}
	return append([]*model.UserConversation(nil), f.convs[userID]...), nil
}

func TestAccess_CachesMembershipForSearchBurst(t *testing.T) {
	memberships := &fakeMemberships{chans: map[string][]*model.UserChannel{
		"u1": {{ChannelID: "ch-1"}, {ChannelID: "ch-2"}},
	}}
	conversations := &fakeConversations{convs: map[string][]*model.UserConversation{
		"u1": {{ConversationID: "dm-1"}},
	}}
	access := New(memberships, conversations)

	first, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil {
		t.Fatalf("AllowedParentIDs first: %v", err)
	}
	if !reflect.DeepEqual(first, []string{"ch-1", "ch-2", "dm-1"}) {
		t.Fatalf("first ids = %v", first)
	}

	memberships.set("u1", &model.UserChannel{ChannelID: "ch-2"})
	conversations.convs["u1"] = nil
	second, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil {
		t.Fatalf("AllowedParentIDs second: %v", err)
	}
	if !reflect.DeepEqual(second, first) {
		t.Fatalf("second ids = %v, want cached %v", second, first)
	}
	if memberships.calls.Load() != 1 || conversations.calls.Load() != 1 {
		t.Fatalf("calls = memberships:%d conversations:%d, want 1 each", memberships.calls.Load(), conversations.calls.Load())
	}
}

// Callers get their own copy: mutating a returned set must not corrupt the
// cached one the next search reads.
func TestAccess_ReturnsCopies(t *testing.T) {
	memberships := &fakeMemberships{chans: map[string][]*model.UserChannel{"u1": {{ChannelID: "ch-1"}}}}
	access := New(memberships, nil)
	first, _ := access.AllowedParentIDs(context.Background(), "u1")
	first[0] = "tampered"
	second, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil || !reflect.DeepEqual(second, []string{"ch-1"}) {
		t.Fatalf("second = %v, %v; want the untouched cached [ch-1]", second, err)
	}
}

func TestAccess_RefreshesMembershipAfterCacheExpiry(t *testing.T) {
	memberships := &fakeMemberships{chans: map[string][]*model.UserChannel{"u1": {{ChannelID: "ch-1"}}}}
	access := newAccess(memberships, nil, 16, 20*time.Millisecond)

	first, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil || !reflect.DeepEqual(first, []string{"ch-1"}) {
		t.Fatalf("first = %v, %v", first, err)
	}
	memberships.set("u1", &model.UserChannel{ChannelID: "ch-2"})

	// Reads inside the TTL are cache hits; the first read after it expires
	// fetches again. Wait for that refreshed set, never for a fixed time.
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := access.AllowedParentIDs(context.Background(), "u1")
		if err != nil {
			t.Fatalf("AllowedParentIDs: %v", err)
		}
		if reflect.DeepEqual(got, []string{"ch-2"}) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ids = %v, never refreshed to [ch-2] after the TTL", got)
		}
	}
	if memberships.calls.Load() != 2 {
		t.Fatalf("membership calls = %d, want 2 (one per TTL window)", memberships.calls.Load())
	}
}

// The cache is bounded: the least recently used user is evicted.
func TestAccess_CacheIsBounded(t *testing.T) {
	memberships := &fakeMemberships{chans: map[string][]*model.UserChannel{}}
	access := newAccess(memberships, nil, 2, time.Minute)
	for _, u := range []string{"u1", "u2", "u3"} {
		if _, err := access.AllowedParentIDs(context.Background(), u); err != nil {
			t.Fatalf("AllowedParentIDs(%s): %v", u, err)
		}
	}
	if _, err := access.AllowedParentIDs(context.Background(), "u1"); err != nil {
		t.Fatalf("AllowedParentIDs(u1 again): %v", err)
	}
	if memberships.calls.Load() != 4 {
		t.Fatalf("membership calls = %d, want 4 (u1 evicted by u3)", memberships.calls.Load())
	}
}

func TestAccess_EmptyUserDoesNotQueryStores(t *testing.T) {
	memberships := &fakeMemberships{}
	conversations := &fakeConversations{}
	access := New(memberships, conversations)

	ids, err := access.AllowedParentIDs(context.Background(), "")
	if err != nil {
		t.Fatalf("AllowedParentIDs: %v", err)
	}
	if ids != nil {
		t.Fatalf("ids = %v, want nil", ids)
	}
	if memberships.calls.Load() != 0 || conversations.calls.Load() != 0 {
		t.Fatalf("stores were queried for empty user")
	}
}

// A lookup that fails is an error, and is not remembered: an empty set would
// hide every result for the cache's lifetime.
func TestAccess_FailedLookupIsAnErrorNotCached(t *testing.T) {
	for _, fail := range []string{"channels", "conversations"} {
		t.Run(fail, func(t *testing.T) {
			memberships := &fakeMemberships{chans: map[string][]*model.UserChannel{"u1": {{ChannelID: "ch-1"}}}}
			conversations := &fakeConversations{convs: map[string][]*model.UserConversation{"u1": {{ConversationID: "dm-1"}}}}
			if fail == "channels" {
				memberships.err = context.Canceled
			} else {
				conversations.err = context.Canceled
			}
			access := New(memberships, conversations)
			if ids, err := access.AllowedParentIDs(context.Background(), "u1"); !errors.Is(err, context.Canceled) || ids != nil {
				t.Fatalf("AllowedParentIDs = %v, %v; want the lookup's error", ids, err)
			}
			memberships.err, conversations.err = nil, nil
			ids, err := access.AllowedParentIDs(context.Background(), "u1")
			if err != nil || !reflect.DeepEqual(ids, []string{"ch-1", "dm-1"}) {
				t.Fatalf("after recovery = %v, %v; want a fresh lookup", ids, err)
			}
		})
	}
}

// Someone with no channels or conversations gets an empty set, never nil
// (nil used to mean "unscoped" to channel search).
func TestAccess_NoMembershipsIsEmptyNotNil(t *testing.T) {
	access := New(&fakeMemberships{}, &fakeConversations{})
	ids, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("AllowedParentIDs = %#v, %v; want an empty, non-nil set", ids, err)
	}
}

// Regression: the cached copy of an empty membership set must stay non-nil.
// A nil set read as "unscoped" to channel search, so a user with no
// memberships saw every private channel on their second (cached) search.
func TestAccess_CachedEmptySetStaysNonNil(t *testing.T) {
	access := New(&fakeMemberships{}, &fakeConversations{})
	for call := 1; call <= 2; call++ {
		ids, err := access.AllowedParentIDs(context.Background(), "u1")
		if err != nil || ids == nil || len(ids) != 0 {
			t.Fatalf("call %d: AllowedParentIDs = %#v, %v; want an empty, non-nil set", call, ids, err)
		}
	}
}

// Concurrent misses for one user share ONE lookup — including its failure,
// which is still not cached for the next caller.
func TestAccess_ConcurrentMissesShareOneLookup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		boom := errors.New("dynamo down")
		memberships := &fakeMemberships{err: boom, release: make(chan struct{})}
		access := newAccess(memberships, nil, 16, 0)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		errs := make(chan error, 2)
		for range 2 {
			go func() {
				_, err := access.AllowedParentIDs(ctx, "u1")
				errs <- err
			}()
		}
		synctest.Wait() // both callers are waiting on the one in-flight lookup
		close(memberships.release)
		for range 2 {
			if err := <-errs; !errors.Is(err, boom) {
				t.Fatalf("err = %v, want the shared lookup's error", err)
			}
		}
		if got := memberships.calls.Load(); got != 1 {
			t.Fatalf("membership calls = %d, want 1 shared lookup", got)
		}
		if _, err := access.AllowedParentIDs(ctx, "u1"); !errors.Is(err, boom) {
			t.Fatalf("err = %v, want a fresh (uncached) failing lookup", err)
		}
		if got := memberships.calls.Load(); got != 2 {
			t.Fatalf("membership calls = %d, want 2 (failure not cached)", got)
		}
	})
}

// A caller that gives up returns at once with its own context's error. The
// shared lookup keeps running for everyone else and still fills the cache.
func TestAccess_CallerCancellationDoesNotAbortSharedLookup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		memberships := &fakeMemberships{
			chans:   map[string][]*model.UserChannel{"u1": {{ChannelID: "ch-1"}}},
			release: make(chan struct{}),
		}
		access := newAccess(memberships, nil, 16, 0)

		impatient, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			_, err := access.AllowedParentIDs(impatient, "u1")
			done <- err
		}()
		synctest.Wait() // the lookup is in flight, the caller is waiting on it
		cancel()
		if err := <-done; !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want the caller's own cancellation", err)
		}

		close(memberships.release)
		synctest.Wait() // the detached lookup finished and cached its result
		ids, err := access.AllowedParentIDs(context.Background(), "u1")
		if err != nil || !reflect.DeepEqual(ids, []string{"ch-1"}) {
			t.Fatalf("ids = %v, %v; want the shared lookup's cached [ch-1]", ids, err)
		}
		if got := memberships.calls.Load(); got != 1 {
			t.Fatalf("membership calls = %d, want 1", got)
		}
	})
}
