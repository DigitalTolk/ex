package service

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

type blockingMobilePush struct {
	started chan string
	release chan struct{}
}

func newBlockingMobilePush() *blockingMobilePush {
	return &blockingMobilePush{
		started: make(chan string, 16),
		release: make(chan struct{}),
	}
}

func (p *blockingMobilePush) Send(ctx context.Context, userID string, _ Notification) error {
	select {
	case p.started <- userID:
	default:
	}
	select {
	case <-p.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type immediateMobilePush struct {
	called chan string
	err    error
}

func (p *immediateMobilePush) Send(_ context.Context, userID string, _ Notification) error {
	p.called <- userID
	return p.err
}

func TestAsyncMobilePushSender_NilAndClosedNoops(t *testing.T) {
	var nilPush *AsyncMobilePushSender
	if err := nilPush.Send(context.Background(), "u-1", Notification{}); err != nil {
		t.Fatalf("nil Send error = %v, want nil", err)
	}
	nilPush.Close()

	if push := NewAsyncMobilePushSender(nil, 0, 0); push != nil {
		t.Fatalf("NewAsyncMobilePushSender(nil) = %#v, want nil", push)
	}

	inner := &immediateMobilePush{called: make(chan string, 1)}
	push := NewAsyncMobilePushSender(inner, 0, 0)
	push.Close()
	push.Close()
	if err := push.Send(context.Background(), "u-2", Notification{}); err != nil {
		t.Fatalf("closed Send error = %v, want nil", err)
	}
}

func TestAsyncMobilePushSender_ContextCanceledBeforeEnqueue(t *testing.T) {
	inner := &immediateMobilePush{called: make(chan string, 1)}
	push := NewAsyncMobilePushSender(inner, 1, 1)
	defer push.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := push.Send(ctx, "u-1", Notification{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Send error = %v, want context canceled", err)
	}
}

func TestAsyncMobilePushSender_WorkerHandlesProviderFailure(t *testing.T) {
	inner := &immediateMobilePush{
		called: make(chan string, 1),
		err:    errors.New("provider unavailable"),
	}
	push := NewAsyncMobilePushSender(inner, 1, 1)
	defer push.Close()

	if err := push.Send(context.Background(), "u-1", Notification{MessageID: "m1"}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	select {
	case got := <-inner.called:
		if got != "u-1" {
			t.Fatalf("provider userID = %q, want u-1", got)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not call provider")
	}
}

func TestAsyncMobilePushSender_SendEnqueuesWithoutBlocking(t *testing.T) {
	inner := newBlockingMobilePush()
	push := NewAsyncMobilePushSender(inner, 1, 1)
	defer func() {
		close(inner.release)
		push.Close()
	}()

	if err := push.Send(context.Background(), "u-1", Notification{MessageID: "m1"}); err != nil {
		t.Fatalf("Send first job: %v", err)
	}
	select {
	case <-inner.started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start first mobile push")
	}

	done := make(chan error, 1)
	go func() {
		done <- push.Send(context.Background(), "u-2", Notification{MessageID: "m2"})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Send second job: %v", err)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("async mobile push enqueue blocked behind provider send")
	}
}

func TestAsyncMobilePushSender_QueueFullReturnsWithoutBlocking(t *testing.T) {
	inner := newBlockingMobilePush()
	push := NewAsyncMobilePushSender(inner, 1, 1)
	defer func() {
		close(inner.release)
		push.Close()
	}()

	if err := push.Send(context.Background(), "u-1", Notification{MessageID: "m1"}); err != nil {
		t.Fatalf("Send first job: %v", err)
	}
	select {
	case <-inner.started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start first mobile push")
	}
	if err := push.Send(context.Background(), "u-2", Notification{MessageID: "m2"}); err != nil {
		t.Fatalf("Send queued job: %v", err)
	}
	if err := push.Send(context.Background(), "u-3", Notification{MessageID: "m3"}); !errors.Is(err, errMobilePushQueueFull) {
		t.Fatalf("Send with full queue error = %v, want %v", err, errMobilePushQueueFull)
	}
}

// canceledOnReleaseMobilePush blocks until released, then returns
// context.Canceled — used to exercise the worker's shutdown-during-send
// branch (errors.Is(context.Canceled) && s.ctx.Err() != nil).
type canceledOnReleaseMobilePush struct {
	started chan struct{}
	release chan struct{}
}

func (p *canceledOnReleaseMobilePush) Send(_ context.Context, _ string, _ Notification) error {
	select {
	case p.started <- struct{}{}:
	default:
	}
	<-p.release
	return context.Canceled
}

func TestAsyncMobilePushSender_WorkerReturnsOnShutdownDuringSend(t *testing.T) {
	inner := &canceledOnReleaseMobilePush{
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
	push := NewAsyncMobilePushSender(inner, 1, 1)

	if err := push.Send(context.Background(), "u-1", Notification{MessageID: "m1"}); err != nil {
		t.Fatalf("Send: %v", err)
	}
	select {
	case <-inner.started:
	case <-time.After(time.Second):
		t.Fatal("worker did not start the send")
	}
	// Cancel the sender's context while the provider Send is in flight, then
	// release it so it returns context.Canceled.
	push.cancel()
	close(inner.release)
	// Close drains the worker; it must terminate via the shutdown branch.
	push.Close()
}

func TestAsyncMobilePushSender_SendRacesCancelWithFullQueue(t *testing.T) {
	inner := newBlockingMobilePush()
	push := NewAsyncMobilePushSender(inner, 1, 1)
	defer func() {
		close(inner.release)
		push.Close()
	}()
	// Saturate the single worker and fill the 1-slot buffer so every
	// subsequent Send hits the full-queue select.
	if err := push.Send(context.Background(), "warm", Notification{}); err != nil {
		t.Fatalf("warm send: %v", err)
	}
	<-inner.started
	if err := push.Send(context.Background(), "fill", Notification{}); err != nil {
		t.Fatalf("fill send: %v", err)
	}
	// Hammer Send with contexts cancelled concurrently. With the queue full,
	// a cancel that lands between the two selects drives the ctx.Done arm of
	// the second select; otherwise we get errMobilePushQueueFull. Either is a
	// valid outcome — we only need to exercise the path many times.
	var wg sync.WaitGroup
	for i := 0; i < 2000; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithCancel(context.Background())
			go cancel()
			_ = push.Send(ctx, "racer", Notification{})
		}()
	}
	wg.Wait()
}

func TestAsyncMobilePushSender_SendRacesSenderShutdownWithFullQueue(t *testing.T) {
	// The worker stays blocked inside the provider so the 1-slot queue stays
	// full for the whole test; cancelling the sender's own context while many
	// Sends are in their second select drives the s.ctx.Done arm.
	inner := newBlockingMobilePush()
	push := NewAsyncMobilePushSender(inner, 1, 1)
	if err := push.Send(context.Background(), "warm", Notification{}); err != nil {
		t.Fatalf("warm send: %v", err)
	}
	<-inner.started
	if err := push.Send(context.Background(), "fill", Notification{}); err != nil {
		t.Fatalf("fill send: %v", err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 2000; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = push.Send(context.Background(), "racer", Notification{})
		}()
	}
	// Cancel the sender mid-flight so some Sends observe s.ctx.Done in the
	// second select rather than the full-queue default.
	push.cancel()
	wg.Wait()
	close(inner.release)
	push.Close()
}

func TestAsyncMobilePushSender_WorkerSkipsRecipientWhoCameOnline(t *testing.T) {
	inner := &immediateMobilePush{called: make(chan string, 2)}
	push := NewAsyncMobilePushSender(inner, 2, 1)
	defer push.Close()
	push.SetPresence(&stubPresence{online: map[string]bool{"u-online": true}})

	// Online recipient: the worker re-checks presence and suppresses the push.
	if err := push.Send(context.Background(), "u-online", Notification{MessageID: "m1"}); err != nil {
		t.Fatalf("Send online: %v", err)
	}
	// Offline recipient: delivered. Processed after the online one (FIFO, 1 worker),
	// so its delivery proves the online job was reached and skipped.
	if err := push.Send(context.Background(), "u-offline", Notification{MessageID: "m2"}); err != nil {
		t.Fatalf("Send offline: %v", err)
	}
	select {
	case got := <-inner.called:
		if got != "u-offline" {
			t.Fatalf("delivered to %q, want only u-offline", got)
		}
	case <-time.After(time.Second):
		t.Fatal("offline recipient push not delivered")
	}
	select {
	case got := <-inner.called:
		t.Fatalf("online recipient must be skipped, but got delivery to %q", got)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestNotificationService_AsyncMobilePushDoesNotBlockMessageDelivery(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	inner := newBlockingMobilePush()
	push := NewAsyncMobilePushSender(inner, 1, 1)
	defer func() {
		close(inner.release)
		push.Close()
	}()
	svc.SetMobilePushSender(push)

	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	seedAllLevel(users, "u-1", "u-2", "u-3", "u-4", "u-5")
	members.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author"}
	for _, uid := range []string{"u-1", "u-2", "u-3", "u-4", "u-5"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	done := make(chan struct{})
	go func() {
		svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "hello"}, ParentChannel)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("NotifyForMessage blocked on slow mobile push provider")
	}

	if got := len(pub.published); got != 5 {
		t.Fatalf("websocket publish count = %d, want 5", got)
	}
}
