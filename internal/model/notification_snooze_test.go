package model

import (
	"testing"
	"time"
)

func TestNotificationSettings_Snoozed(t *testing.T) {
	now := time.Now()
	later, earlier := now.Add(time.Minute), now.Add(-time.Minute)
	if (NotificationSettings{}).Snoozed(now) {
		t.Error("no snooze reads as snoozed")
	}
	if !(NotificationSettings{SnoozeUntil: &later}).Snoozed(now) {
		t.Error("a snooze still running reads as off")
	}
	if (NotificationSettings{SnoozeUntil: &earlier}).Snoozed(now) {
		t.Error("a snooze that ended reads as on")
	}
}
