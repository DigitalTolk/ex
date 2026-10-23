package service

import (
	"testing"
	"time"
)

// The notification.new payloads as the client receives them. The frontend's
// notification.new schema (src/lib/ws-events.ts) parses these goldens, so a
// renamed or retyped field fails the client's test rather than silently
// dropping alerts.

func TestWireGolden_Notification_Message(t *testing.T) {
	n := Notification{
		Kind:                    NotificationKindMention,
		Title:                   "Alice in ~general",
		Body:                    "@Bob the deploy is done",
		DeepLink:                "/channel/general?msg=01J0000000000000000000MSG1",
		ParentID:                "01J0000000000000000000CH01",
		ParentType:              ParentChannel,
		MessageID:               "01J0000000000000000000MSG1",
		AuthorID:                "01J0000000000000000000US01",
		CreatedAt:               time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
		ParentUnreadNotifyCount: 2,
	}
	assertGolden(t, "notification_message.json", n)
}

func TestWireGolden_Notification_Webhook(t *testing.T) {
	n := Notification{
		Kind:       NotificationKindMessage,
		Title:      "pagerduty in ~alerts",
		Body:       "disk at 95%",
		DeepLink:   "/channel/alerts?msg=01J0000000000000000000MSG2",
		ParentID:   "01J0000000000000000000CH02",
		ParentType: ParentChannel,
		MessageID:  "01J0000000000000000000MSG2",
		AuthorID:   WebhookAuthorID,
		Webhook:    true,
		CreatedAt:  time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
	}
	assertGolden(t, "notification_webhook.json", n)
}

func TestWireGolden_Notification_Reminder(t *testing.T) {
	// A fired reminder: keyed by its alert id, no author.
	n := Notification{
		Kind:            NotificationKindReminder,
		Title:           "Reminder",
		Body:            "ship it",
		DeepLink:        "/conversation/01J0000000000000000000CV01?thread=01J0000000000000000000MSG3",
		ParentID:        "01J0000000000000000000CV01",
		ParentType:      ParentConversation,
		MessageID:       "01J0000000000000000000MSG4",
		AlertID:         "reminder:01J0000000000000000000RM01",
		ParentMessageID: "01J0000000000000000000MSG3",
		CreatedAt:       time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC),
	}
	assertGolden(t, "notification_reminder.json", n)
}
