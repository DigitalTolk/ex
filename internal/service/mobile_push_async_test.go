package service

import (
	"context"
	"errors"
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
