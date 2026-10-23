//go:build integration

package service

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/hibiken/asynq"
	"github.com/redis/go-redis/v9"
)

// The crash case end to end over real Redis + asynq: the message is committed
// and its safety net armed, then the process dies before its in-process
// fan-out ran. Another instance's worker runs the check when it comes due and
// alerts the audience; a message whose fan-out completed is left alone.
func TestNotifySafetyNet_RecoversAFanOutLostToACrash(t *testing.T) {
	origDelay := notifySafetyNetDelay
	notifySafetyNetDelay = 200 * time.Millisecond
	t.Cleanup(func() { notifySafetyNetDelay = origDelay })
	rdb := newAudienceRedis(t)
	ctx := context.Background()

	// The surviving instance: notifier + marker + worker.
	svc, pub, msgs, _, _ := safetyNetFixture(t)
	marker := NewRedisNotifyMarker(rdb)
	svc.SetNotifyMarker(marker)
	if err := svc.NotificationsWired(); err != nil {
		t.Fatalf("NotificationsWired: %v", err)
	}
	worker := NewAsynqPushWorker(rdb, nil, AsynqPushWorkerConfig{
		Concurrency:              2,
		DelayedTaskCheckInterval: 50 * time.Millisecond,
		ShutdownTimeout:          2 * time.Second,
	})
	worker.Handle(TaskTypeNotifyCheck, svc.NotifyCheckTaskHandler())
	if err := worker.Start(); err != nil {
		t.Fatalf("worker start: %v", err)
	}
	t.Cleanup(worker.Shutdown)

	// The crashed instance's producer: it committed two messages and armed
	// both checks. m-done's fan-out completed (marker written); m-lost's
	// never ran.
	sched := NewAsynqPushScheduler(rdb)
	t.Cleanup(func() { _ = sched.Close() })
	lost := &model.Message{ID: "m-lost", ParentID: "ch1", AuthorID: "sender", Body: "prod is down"}
	done := &model.Message{ID: "m-done", ParentID: "ch1", AuthorID: "sender", Body: "fixed"}
	msgs.messages["ch1#m-lost"] = lost
	msgs.messages["ch1#m-done"] = done
	for _, m := range []*model.Message{lost, done} {
		if err := sched.ScheduleNotifyCheck(ctx, m, ParentChannel); err != nil {
			t.Fatalf("ScheduleNotifyCheck: %v", err)
		}
	}
	// Arming twice (a retried send) is one check.
	if err := sched.ScheduleNotifyCheck(ctx, lost, ParentChannel); err != nil {
		t.Fatalf("duplicate ScheduleNotifyCheck: %v", err)
	}
	if err := marker.MarkNotified(ctx, done.ID); err != nil {
		t.Fatalf("MarkNotified: %v", err)
	}

	awaitCond(t, func() bool { return alertedUsers(pub)["u1"] }, "the safety net to alert the lost message")
	awaitCond(t, func() bool {
		ok, err := marker.WasNotified(ctx, lost.ID)
		return err == nil && ok
	}, "the recovered fan-out to be marked")

	// Exactly one alert: for the lost message, never for the completed one,
	// and the duplicate arm did not alert twice.
	inspector := asynq.NewInspectorFromRedisClient(rdb)
	awaitCond(t, func() bool {
		q, err := inspector.GetQueueInfo("default")
		return err == nil && q.Scheduled == 0 && q.Pending == 0 && q.Active == 0
	}, "both checks to finish")
	var alerts []string
	pub.mu.Lock()
	for _, p := range pub.published {
		if p.event.Type == "notification.new" {
			alerts = append(alerts, string(p.event.Data))
		}
	}
	pub.mu.Unlock()
	if len(alerts) != 1 {
		t.Fatalf("alerts = %d, want exactly 1 (the lost message)", len(alerts))
	}
}

func TestRedisNotifyMarker(t *testing.T) {
	rdb := newAudienceRedis(t)
	ctx := context.Background()
	m := NewRedisNotifyMarker(rdb)
	if ok, err := m.WasNotified(ctx, "x"); err != nil || ok {
		t.Fatalf("unmarked = %v, %v", ok, err)
	}
	if err := m.MarkNotified(ctx, "x"); err != nil {
		t.Fatalf("MarkNotified: %v", err)
	}
	if ok, err := m.WasNotified(ctx, "x"); err != nil || !ok {
		t.Fatalf("marked = %v, %v", ok, err)
	}
	if ttl := rdb.TTL(ctx, notifiedMarkerKey("x")).Val(); ttl <= 0 || ttl > notifiedMarkerTTL {
		t.Fatalf("marker TTL = %v, want within %v", ttl, notifiedMarkerTTL)
	}
}

// An enqueue that fails is reported (the caller logs it loudly).
func TestScheduleNotifyCheck_EnqueueFailure(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	dead := redis.NewClient(&redis.Options{Addr: addr, MaxRetries: -1})
	t.Cleanup(func() { _ = dead.Close() })
	sched := NewAsynqPushScheduler(dead)
	if err := sched.ScheduleNotifyCheck(context.Background(), &model.Message{ID: "m", ParentID: "ch1"}, ParentChannel); err == nil {
		t.Fatal("want an enqueue error against an unreachable Redis")
	}
}
