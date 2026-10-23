package service

import (
	"errors"

	"github.com/DigitalTolk/ex/internal/wiring"
)

// Production wiring checks (see internal/wiring). Each Wired lists the
// collaborators production always sets on that service; ones wired only when
// their backend is configured (S3, search, Microsoft Graph, mobile push, an
// SMTP/SES transport) are deliberately absent. The app refuses to boot while
// any of these reports a gap.

func (s *AuthService) Wired() error {
	return wiring.Check("auth service",
		wiring.Dep{Name: "password reset store", Set: s.resets != nil},
		wiring.Dep{Name: "runner revoker", Set: s.runners != nil},
		wiring.Dep{Name: "channel joiner", Set: s.joiner != nil},
	)
}

func (s *UserService) Wired() error {
	return wiring.Check("user service",
		wiring.Dep{Name: "media URL cache", Set: s.mediaCache != nil},
		wiring.Dep{Name: "token store", Set: s.tokens != nil},
		wiring.Dep{Name: "runner revoker", Set: s.runners != nil},
		wiring.Dep{Name: "automation stopper", Set: s.automations != nil},
		wiring.Dep{Name: "audience invalidator", Set: s.audience != nil},
		wiring.Dep{Name: "reminder canceller", Set: s.reminders != nil},
	)
}

func (s *ChannelService) Wired() error {
	return wiring.Check("channel service",
		wiring.Dep{Name: "audience invalidator", Set: s.audience != nil},
		wiring.Dep{Name: "conversation converter", Set: s.conversions != nil && s.convertedDrafts != nil},
		wiring.Dep{Name: "activity recorder", Set: s.activity != nil},
		wiring.Dep{Name: "reminder sync", Set: s.reminders != nil},
	)
}

func (s *ConversationService) Wired() error {
	return wiring.Check("conversation service",
		wiring.Dep{Name: "media URL cache", Set: s.mediaCache != nil},
		wiring.Dep{Name: "user profile resolver", Set: s.userProfiles != nil},
		wiring.Dep{Name: "channel memberships", Set: s.channelMembers != nil},
		wiring.Dep{Name: "activity tracker", Set: s.activity != nil},
	)
}

// Wired adds the rest of the message service's collaborators to the
// incident-critical alert pipeline check (NotificationsWired).
func (s *MessageService) Wired() error {
	return errors.Join(s.NotificationsWired(), wiring.Check("message service",
		wiring.Dep{Name: "channel unread seq", Set: s.channelSeq != nil},
		wiring.Dep{Name: "conversation unread seq", Set: s.convSeq != nil},
		wiring.Dep{Name: "thread follows", Set: s.threadFollows != nil},
		wiring.Dep{Name: "user state", Set: s.userState != nil},
		wiring.Dep{Name: "parent index", Set: s.parentIndex != nil},
		wiring.Dep{Name: "markdown renderer", Set: s.markdown != nil},
		wiring.Dep{Name: "conversation activator", Set: s.activator != nil},
		wiring.Dep{Name: "channel reader", Set: s.channels != nil},
		wiring.Dep{Name: "mention resolver", Set: s.mentions != nil},
		wiring.Dep{Name: "agent dispatcher", Set: s.agentDispatcher != nil},
		wiring.Dep{Name: "run log purger", Set: s.runLogPurger != nil},
		wiring.Dep{Name: "run skill resolver", Set: s.skillBadges != nil},
		wiring.Dep{Name: "thread seed users", Set: s.seedUsers != nil},
		wiring.Dep{Name: "attachment manager", Set: s.attachments != nil},
		wiring.Dep{Name: "draft clearer", Set: s.drafts != nil},
		wiring.Dep{Name: "activity recorder", Set: s.activity != nil},
		wiring.Dep{Name: "reminder sync", Set: s.reminders != nil},
	))
}

// Wired adds the rest of the notifier's collaborators to the safety-net check
// (NotificationsWired). The ack store gates the deferred mobile push and the
// presence lookup picks immediate vs deferred delivery, so both are required.
func (s *NotificationService) Wired() error {
	return errors.Join(s.NotificationsWired(), wiring.Check("notification service",
		wiring.Dep{Name: "presence", Set: s.presence != nil},
		wiring.Dep{Name: "thread follows", Set: s.follows != nil},
		wiring.Dep{Name: "user state", Set: s.userState != nil},
		wiring.Dep{Name: "ack store", Set: s.ackStore != nil},
		wiring.Dep{Name: "name cache", Set: s.nameCache != nil},
		wiring.Dep{Name: "audience cache", Set: s.audience != nil},
		wiring.Dep{Name: "activity recorder", Set: s.activity != nil},
		wiring.Dep{Name: "mention resolver", Set: s.mentions != nil},
	))
}

func (s *UserStateService) Wired() error {
	return wiring.Check("user state service",
		wiring.Dep{Name: "activity tracker", Set: s.activity != nil},
	)
}

func (s *EmojiService) Wired() error {
	return wiring.Check("emoji service",
		wiring.Dep{Name: "media URL cache", Set: s.mediaCache != nil},
		wiring.Dep{Name: "frequency store", Set: s.frequency != nil},
	)
}

func (s *PresenceService) Wired() error {
	return wiring.Check("presence service",
		wiring.Dep{Name: "presence audience resolver", Set: s.audience != nil},
	)
}

func (s *AttachmentService) Wired() error {
	return wiring.Check("attachment service",
		wiring.Dep{Name: "media URL cache", Set: s.mediaCache != nil},
		wiring.Dep{Name: "access checker", Set: s.accessChecker != nil},
		wiring.Dep{Name: "media grant key", Set: len(s.mediaGrantKey) > 0},
		wiring.Dep{Name: "upload limits", Set: s.limits != nil},
	)
}

func (s *SettingsService) Wired() error {
	return wiring.Check("settings service",
		wiring.Dep{Name: "publisher", Set: s.pub != nil},
	)
}

func (s *UnfurlService) Wired() error {
	return wiring.Check("unfurl service",
		wiring.Dep{Name: "media URL cache", Set: s.mediaCache != nil},
	)
}

func (s *IncomingWebhookService) Wired() error {
	return wiring.Check("webhook service",
		wiring.Dep{Name: "DM resolver", Set: s.dms != nil},
		wiring.Dep{Name: "user resolver", Set: s.users != nil},
		wiring.Dep{Name: "bot provisioner", Set: s.bots != nil},
		wiring.Dep{Name: "membership resolver", Set: s.memberships != nil},
		wiring.Dep{Name: "publisher", Set: s.publisher != nil},
	)
}

func (s *CommandService) Wired() error {
	return wiring.Check("command service",
		wiring.Dep{Name: "draft clearer", Set: s.drafts != nil},
	)
}

func (s *DirectorySyncService) Wired() error {
	return wiring.Check("directory sync",
		wiring.Dep{Name: "status setter", Set: s.status != nil},
	)
}

func (s *ActivityService) Wired() error {
	return wiring.Check("activity service",
		wiring.Dep{Name: "channel resolver", Set: s.channels != nil},
		wiring.Dep{Name: "member lister", Set: s.members != nil},
		wiring.Dep{Name: "mention resolver", Set: s.mentions != nil},
	)
}

func (s *ReminderService) Wired() error {
	return wiring.Check("reminder service",
		wiring.Dep{Name: "activity", Set: s.activity != nil},
		wiring.Dep{Name: "notifier", Set: s.notifier != nil},
		wiring.Dep{Name: "publisher", Set: s.events != nil},
		wiring.Dep{Name: "owner lookup", Set: s.owners != nil},
		wiring.Dep{Name: "mention resolver", Set: s.mentions != nil},
	)
}

func (s *ScheduledMessageService) Wired() error {
	return wiring.Check("scheduled message service",
		wiring.Dep{Name: "draft clearer", Set: s.drafts != nil},
	)
}
