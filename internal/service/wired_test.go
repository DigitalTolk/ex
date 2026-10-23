package service

import (
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/wiring"
)

// An unwired service names itself and what it is missing, so a boot that
// forgot a setter fails with an error pointing at the gap.
func TestWiredReportsMissingDependencies(t *testing.T) {
	cases := []struct {
		component string
		c         wiring.Checker
		missing   string
	}{
		{"auth service", &AuthService{}, "password reset store"},
		{"user service", &UserService{}, "reminder canceller"},
		{"channel service", &ChannelService{}, "conversation converter"},
		{"conversation service", &ConversationService{}, "channel memberships"},
		{"message service", &MessageService{}, "agent dispatcher"},
		{"notification service", &NotificationService{}, "ack store"},
		{"user state service", &UserStateService{}, "activity tracker"},
		{"emoji service", &EmojiService{}, "frequency store"},
		{"presence service", &PresenceService{}, "presence audience resolver"},
		{"attachment service", &AttachmentService{}, "media grant key"},
		{"settings service", &SettingsService{}, "publisher"},
		{"unfurl service", &UnfurlService{}, "media URL cache"},
		{"webhook service", &IncomingWebhookService{}, "bot provisioner"},
		{"command service", &CommandService{}, "draft clearer"},
		{"directory sync", &DirectorySyncService{}, "status setter"},
		{"activity service", &ActivityService{}, "member lister"},
		{"reminder service", &ReminderService{}, "owner lookup"},
		{"scheduled message service", &ScheduledMessageService{}, "draft clearer"},
	}
	for _, tc := range cases {
		err := tc.c.Wired()
		if err == nil {
			t.Errorf("%s: Wired = nil on a zero value, want the missing dependencies", tc.component)
			continue
		}
		if msg := err.Error(); !strings.Contains(msg, tc.component+": not wired:") || !strings.Contains(msg, tc.missing) {
			t.Errorf("%s: Wired = %q, want it to name %q", tc.component, msg, tc.missing)
		}
	}
}

// The message service keeps its incident-critical alert check: a missing
// notifier is reported in its own words alongside the generic gaps.
func TestMessageServiceWiredIncludesTheAlertPipeline(t *testing.T) {
	err := (&MessageService{}).Wired()
	if err == nil || !strings.Contains(err.Error(), "messages would alert nobody") {
		t.Fatalf("Wired = %v, want the notifier gap", err)
	}
}
