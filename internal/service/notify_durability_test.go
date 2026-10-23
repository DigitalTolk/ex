package service

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/hibiken/asynq"
)

// awaitCond polls for observable state within the suite's shared 5s waiting
// budget (sized for a loaded machine).
func awaitCond(t *testing.T, cond func() bool, desc string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", desc)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// gatedNotifier blocks every fan-out on gate and tracks how many run at once.
type gatedNotifier struct {
	gate     chan struct{}
	inFlight atomic.Int64
	maxSeen  atomic.Int64
	done     atomic.Int64
}

func (g *gatedNotifier) NotifyForMessage(context.Context, *model.Message, string, *model.Message) {
	n := g.inFlight.Add(1)
	for {
		m := g.maxSeen.Load()
		if n <= m || g.maxSeen.CompareAndSwap(m, n) {
			break
		}
	}
	<-g.gate
	g.inFlight.Add(-1)
	g.done.Add(1)
}

func notifyFixture(t *testing.T) (*MessageService, *mockMessageStore) {
	t.Helper()
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}
	return svc, messages
}

// Regression: every message started its own unbounded fan-out goroutine. A
// process-wide limit bounds how many run at once — and a fan-out over the
// limit waits its turn; it is never dropped.
func TestNotify_FanOutsAreBoundedAndQueued(t *testing.T) {
	svc, _ := notifyFixture(t)
	svc.fanOutSlots = make(chan struct{}, 2)
	n := &gatedNotifier{gate: make(chan struct{})}
	svc.SetNotifier(n)
	for range 5 {
		if _, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "hi", ""); err != nil {
			t.Fatalf("Send: %v", err)
		}
	}
	awaitCond(t, func() bool { return n.inFlight.Load() == 2 }, "two fan-outs running")
	if m := n.maxSeen.Load(); m > 2 {
		t.Fatalf("concurrent fan-outs = %d, want at most 2", m)
	}
	close(n.gate)
	awaitCond(t, func() bool { return n.done.Load() == 5 }, "every queued fan-out to run")
	if m := n.maxSeen.Load(); m > 2 {
		t.Fatalf("concurrent fan-outs = %d, want at most 2", m)
	}
}

// Graceful shutdown drains in-flight fan-outs: WaitForNotifyFanOut returns
// only once they finished (main bounds the wait).
func TestNotify_WaitForNotifyFanOutDrains(t *testing.T) {
	svc, _ := notifyFixture(t)
	n := &gatedNotifier{gate: make(chan struct{})}
	svc.SetNotifier(n)
	if _, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "hi", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	awaitCond(t, func() bool { return n.inFlight.Load() == 1 }, "the fan-out to start")
	drained := make(chan struct{})
	go func() {
		svc.WaitForNotifyFanOut()
		close(drained)
	}()
	select {
	case <-drained:
		t.Fatal("drain returned while a fan-out was still running")
	default:
	}
	close(n.gate)
	select {
	case <-drained:
	case <-time.After(5 * time.Second):
		t.Fatal("drain never returned after the fan-out finished")
	}
}

// A send that lands while shutdown is already draining is waited for too (and
// never trips the WaitGroup "Add concurrently with Wait" misuse).
func TestNotify_DrainCoversFanOutsStartedDuringTheWait(t *testing.T) {
	svc, _ := notifyFixture(t)
	n := &gatedNotifier{gate: make(chan struct{})}
	svc.SetNotifier(n)
	if _, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "first", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	awaitCond(t, func() bool { return n.inFlight.Load() == 1 }, "the first fan-out to start")
	drained := make(chan struct{})
	go func() {
		svc.WaitForNotifyFanOut()
		close(drained)
	}()
	if _, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "second", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	awaitCond(t, func() bool { return n.inFlight.Load() == 2 }, "the second fan-out to start")
	n.gate <- struct{}{} // release one
	awaitCond(t, func() bool { return n.done.Load() == 1 }, "one fan-out to finish")
	select {
	case <-drained:
		t.Fatal("drain returned with a fan-out still running")
	default:
	}
	close(n.gate)
	select {
	case <-drained:
	case <-time.After(5 * time.Second):
		t.Fatal("drain never returned")
	}
}

// recordingSafetyNet records scheduled checks.
type recordingSafetyNet struct {
	mu     sync.Mutex
	checks []string
	err    error
}

func (r *recordingSafetyNet) ScheduleNotifyCheck(_ context.Context, msg *model.Message, parentType string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.checks = append(r.checks, msg.ID+"/"+parentType)
	return r.err
}

func (r *recordingSafetyNet) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.checks)
}

// Every notifying send arms the durable safety net; a failure to arm it is
// loud but never blocks the live fan-out.
func TestNotify_ArmsTheSafetyNet(t *testing.T) {
	svc, _ := notifyFixture(t)
	rec := &recordingNotifier{calls: make(chan notifierCall, 8)}
	svc.SetNotifier(rec)
	net := &recordingSafetyNet{}
	svc.SetNotifySafetyNet(net)

	msg, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "hi", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	<-rec.calls
	awaitCond(t, func() bool { return net.count() == 1 }, "the safety net to be armed")
	if net.checks[0] != msg.ID+"/"+ParentChannel {
		t.Fatalf("armed %q, want %q", net.checks[0], msg.ID+"/"+ParentChannel)
	}

	net.err = errors.New("redis down")
	if _, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "again", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	select {
	case <-rec.calls:
	case <-time.After(5 * time.Second):
		t.Fatal("a failed safety-net arm stopped the live fan-out")
	}
}

// A system message alerts nobody, so nothing is armed for it.
func TestNotify_SystemMessagesArmNothing(t *testing.T) {
	svc, _ := notifyFixture(t)
	rec := &recordingNotifier{calls: make(chan notifierCall, 8)}
	svc.SetNotifier(rec)
	net := &recordingSafetyNet{}
	svc.SetNotifySafetyNet(net)
	svc.notify(context.Background(), &model.Message{ID: "sys", ParentID: "ch1", System: true}, ParentChannel, nil)
	<-rec.calls
	svc.WaitForNotifyFanOut()
	if net.count() != 0 {
		t.Fatalf("armed %v for a system message", net.checks)
	}
}

// Boot refuses a message service that would alert nobody: no notifier, or no
// durable safety net behind it.
func TestMessageService_NotificationsWired(t *testing.T) {
	svc, _ := notifyFixture(t)
	if err := svc.NotificationsWired(); err == nil {
		t.Fatal("no notifier: want an error")
	}
	svc.SetNotifier(&recordingNotifier{calls: make(chan notifierCall, 1)})
	if err := svc.NotificationsWired(); err == nil {
		t.Fatal("no safety net: want an error")
	}
	svc.SetNotifySafetyNet(&recordingSafetyNet{})
	if err := svc.NotificationsWired(); err != nil {
		t.Fatalf("fully wired: %v", err)
	}
}

// The notifier needs its marker and message store for the safety net.
func TestNotificationService_NotificationsWired(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
	if err := svc.NotificationsWired(); err == nil {
		t.Fatal("no marker: want an error")
	}
	svc.SetNotifyMarker(newMemMarker())
	if err := svc.NotificationsWired(); err != nil {
		t.Fatalf("wired: %v", err)
	}
}

// memMarker is an in-memory NotifyMarker.
type memMarker struct {
	mu      sync.Mutex
	marked  map[string]bool
	markErr error
	readErr error
}

func newMemMarker() *memMarker { return &memMarker{marked: map[string]bool{}} }

func (m *memMarker) MarkNotified(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.markErr != nil {
		return m.markErr
	}
	m.marked[id] = true
	return nil
}

func (m *memMarker) WasNotified(_ context.Context, id string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.marked[id], m.readErr
}

func (m *memMarker) has(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.marked[id]
}

// A completed fan-out leaves the "notified" marker the safety net checks; a
// fan-out whose audience could not be read leaves none, so the safety net
// runs it again later.
func TestNotifyForMessage_MarksOnlyCompletedFanOuts(t *testing.T) {
	orig := audienceRetryInterval
	audienceRetryInterval = time.Millisecond
	t.Cleanup(func() { audienceRetryInterval = orig })
	svc, _, members, _, chans, users := setupNotifier(t)
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	members.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}
	seedAllLevel(users, "u1")
	marker := newMemMarker()
	svc.SetNotifyMarker(marker)

	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "sender", Body: "x"}, ParentChannel, nil)
	if !marker.has("m1") {
		t.Fatal("a completed fan-out left no marker")
	}
	members.listMembersErr = errors.New("dynamo down")
	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m2", ParentID: "ch1", AuthorID: "sender", Body: "x"}, ParentChannel, nil)
	if marker.has("m2") {
		t.Fatal("a fan-out that alerted nobody (audience unreadable) was marked done")
	}
	// A failed marker write is logged; the alert itself already went out.
	members.listMembersErr = nil
	marker.markErr = errors.New("redis down")
	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m3", ParentID: "ch1", AuthorID: "sender", Body: "x"}, ParentChannel, nil)
	// nil messages and system messages are a no-op.
	svc.NotifyForMessage(context.Background(), nil, ParentChannel, nil)
	svc.NotifyForMessage(context.Background(), &model.Message{ID: "s1", ParentID: "ch1", System: true}, ParentChannel, nil)
}

func notifyCheckTask(t *testing.T, parentID, parentType, msgID string) *asynq.Task {
	t.Helper()
	payload, err := json.Marshal(notifyCheckPayload{ParentID: parentID, ParentType: parentType, MessageID: msgID})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return asynq.NewTask(TaskTypeNotifyCheck, payload)
}

func safetyNetFixture(t *testing.T) (*NotificationService, *mockPublisher, *mockMessageStore, *memMarker, *mockMembershipStore) {
	t.Helper()
	pub := newMockPublisher()
	members := newMockMembershipStore()
	chans := newMockChannelStore()
	users := newMockUserStore()
	msgs := newMockMessageStore()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	members.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}
	seedAllLevel(users, "u1")
	svc := NewNotificationService(pub, members, newMockConversationStore(), chans, users, msgs)
	marker := newMemMarker()
	svc.SetNotifyMarker(marker)
	return svc, pub, msgs, marker, members
}

// The durable safety net: a message whose live fan-out never completed (the
// process died between commit and fan-out) is alerted when its check comes
// due — and one whose fan-out completed is left alone.
func TestNotifyCheckTask_RunsOnlyMissedFanOuts(t *testing.T) {
	ctx := context.Background()
	svc, pub, msgs, marker, _ := safetyNetFixture(t)
	handler := svc.NotifyCheckTaskHandler()
	msgs.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "sender", Body: "incident!"}

	// Completed already: nothing re-sent.
	marker.marked["m1"] = true
	if err := handler(ctx, notifyCheckTask(t, "ch1", ParentChannel, "m1")); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if alertedUsers(pub)["u1"] {
		t.Fatal("re-alerted a message whose fan-out completed")
	}

	// Missed: alerted now, and marked so a retry can't repeat it.
	delete(marker.marked, "m1")
	if err := handler(ctx, notifyCheckTask(t, "ch1", ParentChannel, "m1")); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if !alertedUsers(pub)["u1"] {
		t.Fatal("the safety net did not alert a missed message")
	}
	if !marker.has("m1") {
		t.Fatal("the safety net's fan-out left no marker")
	}
}

// A missed thread reply is re-run with its root, so the /threads live patch
// goes out too.
func TestNotifyCheckTask_ThreadReplyCarriesTheRoot(t *testing.T) {
	ctx := context.Background()
	svc, pub, msgs, _, _ := safetyNetFixture(t)
	msgs.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "u1", Body: "root", ReplyCount: 1}
	msgs.messages["ch1#r1"] = &model.Message{ID: "r1", ParentID: "ch1", ParentMessageID: "root", AuthorID: "sender", Body: "reply"}
	if err := svc.NotifyCheckTaskHandler()(ctx, notifyCheckTask(t, "ch1", ParentChannel, "r1")); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if got, _ := threadUpdateRecipients(pub); !got["u1"] {
		t.Fatalf("thread.updated recipients = %v, want the root author", got)
	}
	if !alertedUsers(pub)["u1"] {
		t.Fatal("root author not alerted about the missed reply")
	}
}

func TestNotifyCheckTask_Outcomes(t *testing.T) {
	ctx := context.Background()

	t.Run("malformed payload is never retried", func(t *testing.T) {
		svc, _, _, _, _ := safetyNetFixture(t)
		err := svc.NotifyCheckTaskHandler()(ctx, asynq.NewTask(TaskTypeNotifyCheck, []byte("{")))
		if !errors.Is(err, asynq.SkipRetry) {
			t.Fatalf("err = %v, want SkipRetry", err)
		}
	})
	t.Run("marker unreadable is retried", func(t *testing.T) {
		svc, _, _, marker, _ := safetyNetFixture(t)
		marker.readErr = errors.New("redis down")
		if err := svc.NotifyCheckTaskHandler()(ctx, notifyCheckTask(t, "ch1", ParentChannel, "m1")); err == nil {
			t.Fatal("want a retryable error")
		}
	})
	t.Run("message gone is done", func(t *testing.T) {
		svc, pub, _, _, _ := safetyNetFixture(t)
		if err := svc.NotifyCheckTaskHandler()(ctx, notifyCheckTask(t, "ch1", ParentChannel, "missing")); err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if len(pub.published) != 0 {
			t.Fatal("published for a message that no longer exists")
		}
	})
	t.Run("deleted message is done", func(t *testing.T) {
		svc, pub, msgs, _, _ := safetyNetFixture(t)
		msgs.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", Deleted: true}
		if err := svc.NotifyCheckTaskHandler()(ctx, notifyCheckTask(t, "ch1", ParentChannel, "m1")); err != nil {
			t.Fatalf("err = %v, want nil", err)
		}
		if len(pub.published) != 0 {
			t.Fatal("alerted about a deleted message")
		}
	})
	t.Run("message unreadable is retried", func(t *testing.T) {
		svc, _, msgs, _, _ := safetyNetFixture(t)
		msgs.getErr = errors.New("throttled")
		if err := svc.NotifyCheckTaskHandler()(ctx, notifyCheckTask(t, "ch1", ParentChannel, "m1")); err == nil {
			t.Fatal("want a retryable error")
		}
	})
	t.Run("audience unreadable is retried", func(t *testing.T) {
		orig := audienceRetryInterval
		audienceRetryInterval = time.Millisecond
		t.Cleanup(func() { audienceRetryInterval = orig })
		svc, _, msgs, marker, members := safetyNetFixture(t)
		msgs.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "sender", Body: "x"}
		members.listMembersErr = errors.New("dynamo down")
		if err := svc.NotifyCheckTaskHandler()(ctx, notifyCheckTask(t, "ch1", ParentChannel, "m1")); err == nil {
			t.Fatal("want a retryable error")
		}
		if marker.has("m1") {
			t.Fatal("marked a fan-out that reached nobody")
		}
	})
}

// gatedPushScheduler blocks every schedule on gate and tracks concurrency.
type gatedPushScheduler struct {
	gate     chan struct{}
	inFlight atomic.Int64
	maxSeen  atomic.Int64
	total    atomic.Int64
}

func (g *gatedPushScheduler) SchedulePush(context.Context, string, Notification, time.Duration) error {
	n := g.inFlight.Add(1)
	for {
		m := g.maxSeen.Load()
		if n <= m || g.maxSeen.CompareAndSwap(m, n) {
			break
		}
	}
	<-g.gate
	g.inFlight.Add(-1)
	g.total.Add(1)
	return nil
}

// Regression: mobile pushes were scheduled one Redis round trip after another.
// They are enqueued bounded-parallel — several at once, never more than the
// write limit — and every one of them is still scheduled.
func TestNotifyForMessage_SchedulesPushesInParallel(t *testing.T) {
	svc, _, members, _, chans, users := setupNotifier(t)
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	ids := make([]string, 0, 40)
	for i := range 40 {
		uid := "u" + string(rune('A'+i/26)) + string(rune('a'+i%26))
		ids = append(ids, uid)
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	seedAllLevel(users, ids...)
	sched := &gatedPushScheduler{gate: make(chan struct{})}
	svc.SetMobilePushScheduler(sched) // nobody online → immediate pushes for all 40

	done := make(chan struct{})
	go func() {
		svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "sender", Body: "x"}, ParentChannel, nil)
		close(done)
	}()
	awaitCond(t, func() bool { return sched.inFlight.Load() == notifyWriteConcurrency }, "a full set of parallel push enqueues")
	close(sched.gate)
	<-done
	if got := sched.total.Load(); got != 40 {
		t.Fatalf("pushes scheduled = %d, want 40", got)
	}
	if m := sched.maxSeen.Load(); m > notifyWriteConcurrency {
		t.Fatalf("parallel enqueues = %d, want at most %d", m, notifyWriteConcurrency)
	}
}
