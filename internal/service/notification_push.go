// The mobile-push half of the pipeline: direct notifies, presence
// batching, badge bumps, and the offline-immediate / online-deferred
// scheduling decision (the ack check itself runs in the asynq worker at
// delivery time — see push_scheduler.go). Split out of notification.go
// (2026-08-12).

package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// NotifyDirect delivers a pre-built notification to a single user, bypassing all
// message-audience gating (mute/level/mention). It is for self-targeted alerts
// like fired reminders: publish the desktop `notification.new` and arm the same
// ack-gated mobile-push fallback messages use, so the alert reaches the user on
// desktop OR mobile exactly as a message notification would. No-op for an empty
// user id.
func (s *NotificationService) NotifyDirect(ctx context.Context, userID string, notif Notification) {
	if userID == "" {
		return
	}
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventNotificationNew, notif)
	online := s.presence != nil && s.presence.IsOnline(userID)
	s.sendMobilePush(ctx, userID, notif, online)
}

// onlineSet resolves presence for many recipients at once: one batched Redis
// read when the lookup supports it (PresenceService does), a per-user check
// otherwise. A nil presence lookup reads as everyone-offline — the fail-safe
// direction (offline → immediate push; duplicates beat silence).
func (s *NotificationService) onlineSet(userIDs []string) map[string]bool {
	if s.presence == nil {
		return map[string]bool{}
	}
	if batch, ok := s.presence.(PresenceBatchLookup); ok {
		return batch.OnlineMany(userIDs)
	}
	out := make(map[string]bool, len(userIDs))
	for _, uid := range userIDs {
		out[uid] = s.presence.IsOnline(uid)
	}
	return out
}

// bumpNotifyCount advances the recipient's alerted-unread badge for the
// parent, returning the authoritative new value. False when the store lacks
// the capability (plain test stores) or the write fails.
func (s *NotificationService) bumpNotifyCount(ctx context.Context, parentType, parentID, userID string) (int64, bool) {
	var backing any
	if parentType == ParentChannel {
		backing = s.members
	} else {
		backing = s.conv
	}
	bumper, ok := backing.(notifyCountBumper)
	if !ok {
		return 0, false
	}
	n, err := bumper.IncrementNotifyCount(ctx, parentID, userID)
	if err != nil {
		slog.Warn("notify count bump failed", "parentID", parentID, "userID", userID, "error", err)
		return 0, false
	}
	return n, true
}

func (s *NotificationService) sendMobilePush(ctx context.Context, recipientUserID string, notif Notification, online bool) {
	if s.pushSched == nil {
		return
	}
	// Offline (no live WebSocket): nothing can ack, so the desktop can't be
	// delivering this — schedule the push for immediate delivery.
	delay := time.Duration(0)
	if online {
		// Online: the desktop SHOULD deliver this, so we don't want to
		// double-notify a healthy desktop with a redundant push. But "online"
		// only means presence SAYS so — a half-open / asleep socket reads
		// online for up to the dead-socket detection window. Trusting presence
		// here is exactly the hole that drops incident alerts. So instead of
		// skipping the push outright, we DEFER it; the worker checks for the
		// client's ACK at delivery time and pushes only if none arrived.
		// Presence can be wrong in EITHER direction without losing an alert.
		if s.ackStore == nil || notif.MessageID == "" {
			// No ack tracking (or nothing to key on) — fall back to the old
			// presence-only behaviour: skip the push for an online user.
			return
		}
		delay = ackFallbackDelay
	}
	if delay > 0 {
		pushMetrics.scheduledDeferred.Add(1)
	} else {
		pushMetrics.scheduledImmediate.Add(1)
	}
	// The scheduled task is Redis-backed, so it survives restarts and any
	// instance's worker can deliver it. WithoutCancel: scheduling is a quick
	// Redis write that must not be aborted by the caller's teardown — a
	// reminder fired during shutdown still gets its push scheduled.
	if err := s.pushSched.SchedulePush(context.WithoutCancel(ctx), recipientUserID, notif, delay); err != nil {
		// A failed schedule IS a potentially lost alert — loud, never silent.
		slog.Error(
			"mobile push schedule failed — alert may not reach the recipient",
			"userID", recipientUserID,
			"parentID", notif.ParentID,
			"parentType", notif.ParentType,
			"messageID", notif.MessageID,
			"kind", notif.Kind,
			"delay", delay,
			"error", err,
		)
	}
}
