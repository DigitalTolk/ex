package model

// NotificationLevel controls which messages fire a user-facing notification
// (sound + popup on desktop; push on mobile). It is deliberately small: the
// "all" firehose or the quiet "mentions, DMs & keywords only" default.
type NotificationLevel string

const (
	NotificationLevelAll      NotificationLevel = "all"      // every message
	NotificationLevelMentions NotificationLevel = "mentions" // mentions, DMs, keywords only
)

// Valid reports whether l is a recognised desktop notification level.
func (l NotificationLevel) Valid() bool {
	return l == NotificationLevelAll || l == NotificationLevelMentions
}

// MobileNotificationLevel mirrors NotificationLevel but adds a "default"
// sentinel meaning "use the same rule as desktop". This is the default so a
// user only has to configure mobile separately when they actually want to.
type MobileNotificationLevel string

const (
	MobileNotificationDefault  MobileNotificationLevel = "default" // same as desktop
	MobileNotificationAll      MobileNotificationLevel = "all"
	MobileNotificationMentions MobileNotificationLevel = "mentions"
)

// Valid reports whether m is a recognised mobile notification level.
func (m MobileNotificationLevel) Valid() bool {
	return m == MobileNotificationDefault || m == MobileNotificationAll || m == MobileNotificationMentions
}

// NotificationSettings is a user's account-level notification baseline. Every
// channel inherits these unless overridden per-channel (see UserChannel's
// pointer override fields). Keywords live only here — they are global, matched
// case-insensitively on word boundaries so "mentions, DMs & keywords only" can
// still surface messages a user cares about.
type NotificationSettings struct {
	DesktopLevel        NotificationLevel       `json:"desktopLevel" dynamodbav:"desktopLevel"`
	MobileLevel         MobileNotificationLevel `json:"mobileLevel" dynamodbav:"mobileLevel"`
	ThreadReplies       bool                    `json:"threadReplies" dynamodbav:"threadReplies"`
	IgnoreGroupMentions bool                    `json:"ignoreGroupMentions" dynamodbav:"ignoreGroupMentions"`
	FollowAllThreads    bool                    `json:"followAllThreads" dynamodbav:"followAllThreads"`
	Keywords            []string                `json:"keywords" dynamodbav:"keywords,omitempty"`
}

// DefaultNotificationSettings is the baseline applied to any user who has
// never saved preferences: quiet by default (mentions/DMs/keywords only),
// thread replies on, group mentions honoured, no follow-all.
func DefaultNotificationSettings() NotificationSettings {
	return NotificationSettings{
		DesktopLevel:  NotificationLevelMentions,
		MobileLevel:   MobileNotificationDefault,
		ThreadReplies: true,
	}
}

// ChannelNotificationOverride carries the per-channel override values a user
// submits. A nil field means "inherit the account default" — persisted as an
// absent attribute so the resolver falls back to the account setting.
type ChannelNotificationOverride struct {
	DesktopLevel        *NotificationLevel       `json:"desktopLevel,omitempty"`
	MobileLevel         *MobileNotificationLevel `json:"mobileLevel,omitempty"`
	ThreadReplies       *bool                    `json:"threadReplies,omitempty"`
	IgnoreGroupMentions *bool                    `json:"ignoreGroupMentions,omitempty"`
	FollowAllThreads    *bool                    `json:"followAllThreads,omitempty"`
}

// ResolveNotificationPrefs folds a per-channel override onto the account
// baseline, returning the effective settings used by the notifier. Keywords
// always come from the account; only the five gating fields can be overridden.
// Empty enum strings on the account fall back to their defaults so a partially
// populated record still resolves sensibly.
func ResolveNotificationPrefs(account NotificationSettings, uc *UserChannel) NotificationSettings {
	eff := account
	if eff.DesktopLevel == "" {
		eff.DesktopLevel = NotificationLevelMentions
	}
	if eff.MobileLevel == "" {
		eff.MobileLevel = MobileNotificationDefault
	}
	if uc != nil {
		if uc.DesktopLevel != nil {
			eff.DesktopLevel = *uc.DesktopLevel
		}
		if uc.MobileLevel != nil {
			eff.MobileLevel = *uc.MobileLevel
		}
		if uc.ThreadReplies != nil {
			eff.ThreadReplies = *uc.ThreadReplies
		}
		if uc.IgnoreGroupMentions != nil {
			eff.IgnoreGroupMentions = *uc.IgnoreGroupMentions
		}
		if uc.FollowAllThreads != nil {
			eff.FollowAllThreads = *uc.FollowAllThreads
		}
	}
	return eff
}
