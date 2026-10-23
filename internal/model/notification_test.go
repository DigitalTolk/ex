package model

import "testing"

func TestNotificationDeliveryKey(t *testing.T) {
	if got := (Notification{MessageID: "m1"}).DeliveryKey(); got != "m1" {
		t.Errorf("a message alert keys on its message: got %q", got)
	}
	if got := (Notification{MessageID: "m1", AlertID: "rem-1"}).DeliveryKey(); got != "rem-1" {
		t.Errorf("an alert that can recur keys on its alert id: got %q", got)
	}
}
