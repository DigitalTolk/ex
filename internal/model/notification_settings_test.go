package model

import "testing"

func TestDefaultNotificationSettings(t *testing.T) {
	d := DefaultNotificationSettings()
	if d.DesktopLevel != NotificationLevelMentions {
		t.Errorf("default desktop level = %q, want mentions", d.DesktopLevel)
	}
	if d.MobileLevel != MobileNotificationDefault {
		t.Errorf("default mobile level = %q, want default", d.MobileLevel)
	}
	if !d.ThreadReplies {
		t.Error("default thread replies should be on")
	}
	if d.IgnoreGroupMentions || d.FollowAllThreads {
		t.Error("ignore-group / follow-all should default off")
	}
	if len(d.Keywords) != 0 {
		t.Error("default keywords should be empty")
	}
}

func TestNotificationLevel_Valid(t *testing.T) {
	for _, l := range []NotificationLevel{NotificationLevelAll, NotificationLevelMentions} {
		if !l.Valid() {
			t.Errorf("%q should be valid", l)
		}
	}
	if NotificationLevel("bogus").Valid() {
		t.Error("bogus desktop level should be invalid")
	}
}

func TestMobileNotificationLevel_Valid(t *testing.T) {
	for _, l := range []MobileNotificationLevel{MobileNotificationDefault, MobileNotificationAll, MobileNotificationMentions} {
		if !l.Valid() {
			t.Errorf("%q should be valid", l)
		}
	}
	if MobileNotificationLevel("bogus").Valid() {
		t.Error("bogus mobile level should be invalid")
	}
}

func TestResolveNotificationPrefs_NilOverrideUsesAccount(t *testing.T) {
	account := NotificationSettings{
		DesktopLevel:     NotificationLevelAll,
		MobileLevel:      MobileNotificationMentions,
		ThreadReplies:    false,
		FollowAllThreads: true,
		Keywords:         []string{"deploy"},
	}
	got := ResolveNotificationPrefs(account, nil)
	if got.DesktopLevel != NotificationLevelAll || got.MobileLevel != MobileNotificationMentions {
		t.Errorf("nil override should pass account through, got %+v", got)
	}
	if got.ThreadReplies || !got.FollowAllThreads {
		t.Errorf("nil override should keep account toggles, got %+v", got)
	}
	if len(got.Keywords) != 1 || got.Keywords[0] != "deploy" {
		t.Errorf("keywords should come from account, got %v", got.Keywords)
	}
}

func TestResolveNotificationPrefs_EmptyEnumsFallBackToDefaults(t *testing.T) {
	got := ResolveNotificationPrefs(NotificationSettings{}, nil)
	if got.DesktopLevel != NotificationLevelMentions {
		t.Errorf("empty desktop should default to mentions, got %q", got.DesktopLevel)
	}
	if got.MobileLevel != MobileNotificationDefault {
		t.Errorf("empty mobile should default to default, got %q", got.MobileLevel)
	}
}

func TestResolveNotificationPrefs_OverrideWins(t *testing.T) {
	account := DefaultNotificationSettings()
	desktop := NotificationLevelAll
	mobile := MobileNotificationAll
	thread := false
	ignore := true
	follow := true
	uc := &UserChannel{
		DesktopLevel:        &desktop,
		MobileLevel:         &mobile,
		ThreadReplies:       &thread,
		IgnoreGroupMentions: &ignore,
		FollowAllThreads:    &follow,
	}
	got := ResolveNotificationPrefs(account, uc)
	if got.DesktopLevel != NotificationLevelAll {
		t.Errorf("desktop override ignored: %q", got.DesktopLevel)
	}
	if got.MobileLevel != MobileNotificationAll {
		t.Errorf("mobile override ignored: %q", got.MobileLevel)
	}
	if got.ThreadReplies {
		t.Error("thread-replies override ignored")
	}
	if !got.IgnoreGroupMentions {
		t.Error("ignore-group override ignored")
	}
	if !got.FollowAllThreads {
		t.Error("follow-all override ignored")
	}
}

func TestResolveNotificationPrefs_PartialOverride(t *testing.T) {
	// Only desktop overridden; everything else inherits the account.
	account := NotificationSettings{
		DesktopLevel:  NotificationLevelMentions,
		MobileLevel:   MobileNotificationAll,
		ThreadReplies: true,
	}
	desktop := NotificationLevelAll
	got := ResolveNotificationPrefs(account, &UserChannel{DesktopLevel: &desktop})
	if got.DesktopLevel != NotificationLevelAll {
		t.Errorf("desktop should be overridden, got %q", got.DesktopLevel)
	}
	if got.MobileLevel != MobileNotificationAll {
		t.Errorf("mobile should inherit account, got %q", got.MobileLevel)
	}
	if !got.ThreadReplies {
		t.Error("thread replies should inherit account (true)")
	}
}
