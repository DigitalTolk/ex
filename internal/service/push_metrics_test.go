package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

// The pipeline counters (SPEC P4 / G-P4.1) must move exactly once per
// delivery-time verdict — they are how an operator verifies the desktop-ack ⇄
// mobile-fallback arbitration live.
func TestPushMetrics_CountDeliveryOutcomes(t *testing.T) {
	ResetPushMetricsForTests()
	t.Cleanup(ResetPushMetricsForTests)

	// delivered
	okProvider := &recordingMobilePush{}
	h := NewMobilePushTaskHandler(&stubAckStore{acked: map[string]bool{}}, okProvider)
	if err := h(context.Background(), mobilePushTask(t, "u-1", Notification{MessageID: "m1"})); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	// ackSuppressed
	h = NewMobilePushTaskHandler(&stubAckStore{acked: map[string]bool{"u-1:m2": true}}, okProvider)
	if err := h(context.Background(), mobilePushTask(t, "u-1", Notification{MessageID: "m2"})); err != nil {
		t.Fatalf("suppress: %v", err)
	}
	// undeliverable
	h = NewMobilePushTaskHandler(nil, &recordingMobilePush{err: fmt.Errorf("status 400: %w", ErrPushUndeliverable)})
	_ = h(context.Background(), mobilePushTask(t, "u-1", Notification{MessageID: "m3"}))
	// transient
	h = NewMobilePushTaskHandler(nil, &recordingMobilePush{err: errors.New("status 502")})
	_ = h(context.Background(), mobilePushTask(t, "u-1", Notification{MessageID: "m4"}))

	got := PushMetricsSnapshot()
	want := map[string]int64{
		"scheduledImmediate": 0,
		"scheduledDeferred":  0,
		"delivered":          1,
		"ackSuppressed":      1,
		"undeliverable":      1,
		"transientFailures":  1,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("snapshot[%q] = %d, want %d", k, got[k], v)
		}
	}
}

// Scheduling counters split by path: offline → immediate, online → deferred.
func TestPushMetrics_CountSchedulePaths(t *testing.T) {
	ResetPushMetricsForTests()
	t.Cleanup(ResetPushMetricsForTests)

	sched := &recordingMobilePush{}
	svc := &NotificationService{pushSched: sched, ackStore: &stubAckStore{acked: map[string]bool{}}}
	svc.sendMobilePush(context.Background(), "u-1", Notification{MessageID: "m1"}, false) // offline → immediate
	svc.sendMobilePush(context.Background(), "u-1", Notification{MessageID: "m2"}, true)  // online → deferred

	got := PushMetricsSnapshot()
	if got["scheduledImmediate"] != 1 || got["scheduledDeferred"] != 1 {
		t.Fatalf("schedule counters = %+v, want 1 immediate + 1 deferred", got)
	}

	// The online-without-ack-store skip path must count NOTHING (no task).
	ResetPushMetricsForTests()
	noAck := &NotificationService{pushSched: sched}
	noAck.sendMobilePush(context.Background(), "u-1", Notification{MessageID: "m3"}, true)
	got = PushMetricsSnapshot()
	if got["scheduledImmediate"] != 0 || got["scheduledDeferred"] != 0 {
		t.Fatalf("skip path must not count a schedule, got %+v", got)
	}
}
