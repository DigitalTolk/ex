package service

import "sync/atomic"

// pushMetrics counts the mobile-push pipeline's outcomes on THIS instance
// (SPEC P4 / G-P4.1): every scheduled task and every delivery-time verdict.
// The counters make the reliability contract observable — "how many pushes
// were stood down by a desktop ack vs actually delivered vs undeliverable" —
// via the admin push-stats endpoint. Process-local by design: an aggregator
// (Datadog) sums across instances; a Redis-backed counter would put a network
// hop into the delivery path for no operational gain.
type pushMetricsCounters struct {
	scheduledImmediate atomic.Int64 // recipient offline → push scheduled for now
	scheduledDeferred  atomic.Int64 // recipient online → push deferred behind the ack window
	delivered          atomic.Int64 // provider accepted the push
	ackSuppressed      atomic.Int64 // desktop acked in time → push stood down
	undeliverable      atomic.Int64 // provider says the recipient is unreachable (ERROR-logged)
	transientFailures  atomic.Int64 // delivery attempts that will be retried
}

var pushMetrics pushMetricsCounters

// PushMetricsSnapshot returns the current counter values for the admin
// endpoint. Key names are the wire contract — the frontend panel and any
// dashboards key off them.
func PushMetricsSnapshot() map[string]int64 {
	return map[string]int64{
		"scheduledImmediate": pushMetrics.scheduledImmediate.Load(),
		"scheduledDeferred":  pushMetrics.scheduledDeferred.Load(),
		"delivered":          pushMetrics.delivered.Load(),
		"ackSuppressed":      pushMetrics.ackSuppressed.Load(),
		"undeliverable":      pushMetrics.undeliverable.Load(),
		"transientFailures":  pushMetrics.transientFailures.Load(),
	}
}

// ResetPushMetricsForTests zeroes all counters.
func ResetPushMetricsForTests() {
	pushMetrics.scheduledImmediate.Store(0)
	pushMetrics.scheduledDeferred.Store(0)
	pushMetrics.delivered.Store(0)
	pushMetrics.ackSuppressed.Store(0)
	pushMetrics.undeliverable.Store(0)
	pushMetrics.transientFailures.Store(0)
}
