package service

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/cenkalti/backoff/v5"
)

// fakeSentDraftClearer records every clear and fails the first `failures`
// attempts. done is signaled after each attempt (the fold runs detached).
type fakeSentDraftClearer struct {
	mu       sync.Mutex
	calls    []draftScope
	failures int
	err      error
	done     chan struct{}
}

func newFakeSentDraftClearer() *fakeSentDraftClearer {
	return &fakeSentDraftClearer{done: make(chan struct{}, 16), err: errors.New("draft store down")}
}

func (f *fakeSentDraftClearer) DeleteForScope(_ context.Context, userID, parentID, parentType, parentMessageID string) error {
	f.mu.Lock()
	f.calls = append(f.calls, draftScope{userID: userID, parentID: parentID, parentType: parentType, parentMessageID: parentMessageID})
	fail := f.failures > 0
	if fail {
		f.failures--
	}
	f.mu.Unlock()
	f.done <- struct{}{}
	if fail {
		return f.err
	}
	return nil
}

func (f *fakeSentDraftClearer) waitForCalls(t *testing.T, n int) []draftScope {
	t.Helper()
	for i := range n {
		select {
		case <-f.done:
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for draft clear %d/%d", i+1, n)
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]draftScope(nil), f.calls...)
}

// stubSentDraftRetry compresses the clear's retry schedule; the clear
// snapshots the config when it starts, so every test waits on its fake's
// calls before ending.
func stubSentDraftRetry(t *testing.T, b backoff.BackOff, timeout time.Duration) {
	t.Helper()
	prevBackOff, prevTimeout := newClearSentDraftBackOff, clearSentDraftTimeout
	newClearSentDraftBackOff = func() backoff.BackOff { return b }
	clearSentDraftTimeout = timeout
	t.Cleanup(func() { newClearSentDraftBackOff, clearSentDraftTimeout = prevBackOff, prevTimeout })
}

var scopeCh1 = draftScope{userID: "u-1", parentID: "ch-1", parentType: ParentChannel}

// The production schedule keeps the hand-rolled loop's pacing: about a second,
// then about five, then it gives up.
func TestSentDraftBackOffPacing(t *testing.T) {
	b := newClearSentDraftBackOff()
	first, second := b.NextBackOff(), b.NextBackOff()
	if first < 500*time.Millisecond || first > 1500*time.Millisecond {
		t.Errorf("first retry in %v, want ~1s", first)
	}
	if second < 2500*time.Millisecond || second > 7500*time.Millisecond {
		t.Errorf("second retry in %v, want ~5s", second)
	}
	if clearSentDraftMaxTries != 3 || clearSentDraftTimeout != 30*time.Second {
		t.Errorf("tries=%d timeout=%v, want 3 and 30s", clearSentDraftMaxTries, clearSentDraftTimeout)
	}
}

func TestClearSentDraftNow_FirstAttempt(t *testing.T) {
	c := newFakeSentDraftClearer()
	if err := clearSentDraftNow(context.Background(), c, scopeCh1); err != nil {
		t.Fatalf("clear = %v", err)
	}
	if got := c.waitForCalls(t, 1); len(got) != 1 || got[0] != scopeCh1 {
		t.Fatalf("clears = %+v, want one for %+v", got, scopeCh1)
	}
}

// A transient failure heals: the retry clears the draft.
func TestClearSentDraftNow_RetriesTransientFailure(t *testing.T) {
	stubSentDraftRetry(t, &backoff.ZeroBackOff{}, time.Minute)
	c := newFakeSentDraftClearer()
	c.failures = 1
	if err := clearSentDraftNow(context.Background(), c, scopeCh1); err != nil {
		t.Fatalf("clear = %v, want the retry to succeed", err)
	}
	if got := c.waitForCalls(t, 2); len(got) != 2 {
		t.Fatalf("attempts = %d, want 2", len(got))
	}
}

// The attempts are bounded: three, then the failure is reported.
func TestClearSentDraftNow_GivesUpAfterThreeAttempts(t *testing.T) {
	stubSentDraftRetry(t, &backoff.ZeroBackOff{}, time.Minute)
	c := newFakeSentDraftClearer()
	c.failures = 10
	err := clearSentDraftNow(context.Background(), c, scopeCh1)
	if !errors.Is(err, c.err) {
		t.Fatalf("clear = %v, want the store error", err)
	}
	if got := c.waitForCalls(t, 3); len(got) != 3 {
		t.Fatalf("attempts = %d, want 3", len(got))
	}
}

// The deadline bounds the whole attempt: a retry that would wait past it is
// abandoned, and the report keeps the store's error.
func TestClearSentDraftNow_DeadlineAbandons(t *testing.T) {
	stubSentDraftRetry(t, backoff.NewConstantBackOff(time.Hour), 20*time.Millisecond)
	c := newFakeSentDraftClearer()
	c.failures = 10
	err := clearSentDraftNow(context.Background(), c, scopeCh1)
	if !errors.Is(err, c.err) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("clear = %v, want the store error and the deadline", err)
	}
	if got := c.waitForCalls(t, 1); len(got) != 1 {
		t.Fatalf("attempts = %d, want 1", len(got))
	}
}

// The detached fold outlives the request: a cancelled request context still
// clears the draft, and a failure is logged rather than surfacing anywhere.
func TestClearSentDraft_DetachedFromTheRequest(t *testing.T) {
	stubSentDraftRetry(t, &backoff.ZeroBackOff{}, time.Minute)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	ok := newFakeSentDraftClearer()
	clearSentDraft(ctx, ok, scopeCh1)
	ok.waitForCalls(t, 1)

	failing := newFakeSentDraftClearer()
	failing.failures = 10
	clearSentDraft(ctx, failing, scopeCh1)
	failing.waitForCalls(t, 3)
}

func TestClearSentDraft_NilClearerIsNoop(t *testing.T) {
	clearSentDraft(context.Background(), nil, scopeCh1) // must not panic
}

// Sending a message clears the author's draft for exactly that composer —
// the thread composer for a reply — on every send path the composer uses.
func TestMessageSendClearsTheComposerDraft(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1", Role: model.ChannelRoleMember}
	c := newFakeSentDraftClearer()
	svc.SetDraftClearer(c)
	ctx := context.Background()

	// A rejected send leaves the draft alone…
	if _, err := svc.Send(ctx, "u-1", "ch-1", ParentChannel, "", ""); err == nil {
		t.Fatal("an empty send must be rejected")
	}
	root, err := svc.Send(ctx, "u-1", "ch-1", ParentChannel, "root", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if _, err := svc.Send(ctx, "u-1", "ch-1", ParentChannel, "reply", root.ID); err != nil {
		t.Fatalf("Send reply: %v", err)
	}
	got := c.waitForCalls(t, 2)
	reply := draftScope{userID: "u-1", parentID: "ch-1", parentType: ParentChannel, parentMessageID: root.ID}
	// …so only the two accepted sends cleared anything (the folds run
	// detached, in either order).
	if len(got) != 2 || !slices.Contains(got, scopeCh1) || !slices.Contains(got, reply) {
		t.Fatalf("clears = %+v, want %+v and %+v", got, scopeCh1, reply)
	}
}

// A scheduled message reaching its time is not a composer send: the composer
// was emptied when it was scheduled, and whatever the author drafted there
// since is theirs to keep.
func TestScheduledDeliveryKeepsTheComposerDraft(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1", Role: model.ChannelRoleMember}
	memberships.memberships["ch-2#u-1"] = &model.ChannelMembership{ChannelID: "ch-2", UserID: "u-1", Role: model.ChannelRoleMember}
	c := newFakeSentDraftClearer()
	svc.SetDraftClearer(c)
	ctx := context.Background()

	if _, err := svc.SendScheduled(ctx, "u-1", "ch-2", ParentChannel, "scheduled", ""); err != nil {
		t.Fatalf("SendScheduled: %v", err)
	}
	// A composer send afterwards is the only clear the fake ever sees.
	if _, err := svc.Send(ctx, "u-1", "ch-1", ParentChannel, "typed", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if got := c.waitForCalls(t, 1); len(got) != 1 || got[0] != scopeCh1 {
		t.Fatalf("clears = %+v, want only the composer send's", got)
	}
}

// Scheduling empties the composer like sending does — and a rejected
// schedule leaves the draft in place.
func TestScheduleClearsTheComposerDraft(t *testing.T) {
	fx := newSchedFixture()
	c := newFakeSentDraftClearer()
	fx.svc.SetDraftClearer(c)
	ctx := context.Background()

	if _, err := fx.svc.Schedule(ctx, "u-1", ScheduledMessageInput{ParentID: "ch-1", ParentType: ParentChannel, Body: "late", SendAt: fx.now.Add(-time.Hour)}); err == nil {
		t.Fatal("a past send time must be rejected")
	}
	if _, err := fx.svc.Schedule(ctx, "u-1", ScheduledMessageInput{ParentID: "ch-1", ParentType: ParentChannel, ParentMessageID: "root", Body: "later", SendAt: fx.now.Add(time.Hour)}); err != nil {
		t.Fatalf("Schedule: %v", err)
	}
	want := draftScope{userID: "u-1", parentID: "ch-1", parentType: ParentChannel, parentMessageID: "root"}
	if got := c.waitForCalls(t, 1); len(got) != 1 || got[0] != want {
		t.Fatalf("clears = %+v, want %+v", got, want)
	}
}

// A slash command posts on the composer's behalf, so a successful run clears
// the draft that held it; a failed run keeps it for another try.
func TestCommandRunClearsTheComposerDraft(t *testing.T) {
	failing := &fakeCommand{info: CommandInfo{Name: "fail"}, err: errors.New("graph down")}
	ok := &fakeCommand{info: CommandInfo{Name: "ok"}, msg: &model.Message{ID: "m1"}}
	svc := NewCommandService()
	svc.Register(failing)
	svc.Register(ok)
	c := newFakeSentDraftClearer()
	svc.SetDraftClearer(c)
	ctx := context.Background()

	if _, err := svc.Run(ctx, "fail", CommandRequest{UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel}); err == nil {
		t.Fatal("the failing command must fail")
	}
	if _, err := svc.Run(ctx, "ok", CommandRequest{UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel}); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := c.waitForCalls(t, 1); len(got) != 1 || got[0] != scopeCh1 {
		t.Fatalf("clears = %+v, want %+v", got, scopeCh1)
	}
}

// The fold is best-effort for the send itself: a draft store that keeps
// failing never fails the message, which is already stored and broadcast.
func TestMessageSendSucceedsWhenTheDraftClearFails(t *testing.T) {
	stubSentDraftRetry(t, &backoff.ZeroBackOff{}, time.Minute)
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1", Role: model.ChannelRoleMember}
	c := newFakeSentDraftClearer()
	c.failures = 10
	svc.SetDraftClearer(c)

	if _, err := svc.Send(context.Background(), "u-1", "ch-1", ParentChannel, "hi", ""); err != nil {
		t.Fatalf("Send = %v, want the message sent despite the draft store", err)
	}
	c.waitForCalls(t, 3)
}
