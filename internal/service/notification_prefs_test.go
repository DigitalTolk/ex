package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

func userWith(id string, ns model.NotificationSettings) *model.User {
	return &model.User{ID: id, DisplayName: id, NotificationSettings: &ns}
}

func TestMatchesKeywords(t *testing.T) {
	cases := []struct {
		name string
		body string
		kws  []string
		want bool
	}{
		{"empty body", "", []string{"x"}, false},
		{"no keywords", "hello", nil, false},
		{"case insensitive", "please Deploy now", []string{"deploy"}, true},
		{"not a word boundary", "redeployment plan", []string{"deploy"}, false},
		{"boundary at end", "time to deploy", []string{"deploy"}, true},
		{"underscore is a word char", "a_deploy_b", []string{"deploy"}, false},
		{"blank keyword skipped", "anything", []string{"   "}, false},
		{"second keyword matches", "ship it", []string{"deploy", "ship"}, true},
		{"digit boundary", "v2 release", []string{"v2"}, true},
		// Unicode word boundaries: accented/non-Latin keywords match whole words,
		// and an ASCII keyword must not fire as a prefix of a word continued by a
		// non-ASCII letter.
		{"accented whole word", "ping andré now", []string{"andré"}, true},
		{"ascii prefix before non-ascii letter does not match", "the annüal report", []string{"ann"}, false},
		{"accented keyword not mid-word", "annürep", []string{"andré"}, false},
		{"cjk keyword matches in cjk text", "我们测试一下", []string{"测试"}, true},
		{"cjk keyword absent", "我们一下", []string{"测试"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := matchesKeywords(c.body, c.kws); got != c.want {
				t.Errorf("matchesKeywords(%q, %v) = %v, want %v", c.body, c.kws, got, c.want)
			}
		})
	}
}

func TestNotifyForMessage_KeywordNotifiesAtMentionsLevel(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	users.users["u-bob"] = userWith("u-bob", model.NotificationSettings{
		DesktopLevel: model.NotificationLevelMentions, MobileLevel: model.MobileNotificationDefault,
		ThreadReplies: true, Keywords: []string{"deploy"},
	})
	users.users["u-carol"] = userWith("u-carol", model.DefaultNotificationSettings())
	for _, uid := range []string{"u-author", "u-bob", "u-carol"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "we deploy tonight"}, ParentChannel, nil)

	kinds := publishedKinds(pub)
	if got := kinds[pubsub.UserChannel("u-bob")]; got != NotificationKindMessage {
		t.Errorf("keyword match should notify bob (message kind), got %q", got)
	}
	if _, ok := kinds[pubsub.UserChannel("u-carol")]; ok {
		t.Error("carol (mentions-only, no keyword) must not be notified by an ordinary message")
	}
}

func TestNotifyForMessage_IgnoreGroupMentions(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	ignore := model.DefaultNotificationSettings()
	ignore.IgnoreGroupMentions = true
	users.users["u-bob"] = userWith("u-bob", ignore)
	users.users["u-carol"] = userWith("u-carol", model.DefaultNotificationSettings())
	for _, uid := range []string{"u-author", "u-bob", "u-carol"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "@all hello"}, ParentChannel, nil)

	kinds := publishedKinds(pub)
	if _, ok := kinds[pubsub.UserChannel("u-bob")]; ok {
		t.Error("bob ignores @all/@here and must not be pinged by @all")
	}
	if got := kinds[pubsub.UserChannel("u-carol")]; got != NotificationKindMention {
		t.Errorf("carol should still get the @all mention, got %q", got)
	}
}

func TestNotifyForMessage_ThreadRepliesOff_SuppressesThreadNotif(t *testing.T) {
	svc, pub, members, chans, users, msgs := setupNotifierWithMessages(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	off := model.DefaultNotificationSettings()
	off.ThreadReplies = false
	users.users["u-root"] = userWith("u-root", off)
	users.users["u-replier"] = userWith("u-replier", model.DefaultNotificationSettings())
	for _, uid := range []string{"u-root", "u-replier"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	msgs.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-root", Body: "ask"}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r1", ParentID: "ch1", AuthorID: "u-replier", ParentMessageID: "m-root", Body: "reply",
	}, ParentChannel, nil)

	if got := len(pub.published); got != 0 {
		t.Fatalf("publish count = %d, want 0 (root author disabled thread replies)", got)
	}
}

func TestNotifyForMessage_FollowAllThreads_ExpandsAudience(t *testing.T) {
	svc, pub, members, chans, users, msgs := setupNotifierWithMessages(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-root"] = userWith("u-root", model.DefaultNotificationSettings())
	users.users["u-replier"] = userWith("u-replier", model.DefaultNotificationSettings())
	follow := model.DefaultNotificationSettings()
	follow.FollowAllThreads = true
	users.users["u-watcher"] = userWith("u-watcher", follow)
	for _, uid := range []string{"u-root", "u-replier", "u-watcher"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	msgs.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-root", Body: "ask"}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r1", ParentID: "ch1", AuthorID: "u-replier", ParentMessageID: "m-root", Body: "reply",
	}, ParentChannel, nil)

	kinds := publishedKinds(pub)
	if got := kinds[pubsub.UserChannel("u-watcher")]; got != NotificationKindThreadReply {
		t.Errorf("follow-all watcher should get thread_reply even without participating, got %q", got)
	}
	if got := kinds[pubsub.UserChannel("u-root")]; got != NotificationKindThreadReply {
		t.Errorf("root author should still get thread_reply, got %q", got)
	}
}

func TestNormalizeKeywords(t *testing.T) {
	if got := normalizeKeywords(nil); got != nil {
		t.Errorf("nil input should give nil, got %v", got)
	}
	if got := normalizeKeywords([]string{"  ", "\t"}); got != nil {
		t.Errorf("all-blank input should give nil, got %v", got)
	}
	// Length clamp.
	long := make([]byte, MaxNotificationKeywordLen+50)
	for i := range long {
		long[i] = 'a'
	}
	got := normalizeKeywords([]string{string(long)})
	if len(got) != 1 || len([]rune(got[0])) != MaxNotificationKeywordLen {
		t.Errorf("keyword should be clamped to %d runes, got len %d", MaxNotificationKeywordLen, len([]rune(got[0])))
	}
	// Count cap.
	many := make([]string, MaxNotificationKeywords+10)
	for i := range many {
		many[i] = string(rune('a'+i%26)) + string(rune('0'+i%10)) + "kw" + string(rune('A'+i%26))
	}
	if got := normalizeKeywords(many); len(got) != MaxNotificationKeywords {
		t.Errorf("keyword count should cap at %d, got %d", MaxNotificationKeywords, len(got))
	}
}

func TestNotifyForMessage_ThreadReply_AllLevelNotifies(t *testing.T) {
	svc, pub, members, chans, users, msgs := setupNotifierWithMessages(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	all := model.DefaultNotificationSettings()
	all.DesktopLevel = model.NotificationLevelAll
	users.users["u-root"] = userWith("u-root", all)
	users.users["u-replier"] = userWith("u-replier", model.DefaultNotificationSettings())
	for _, uid := range []string{"u-root", "u-replier"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	msgs.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-root", Body: "ask"}

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r1", ParentID: "ch1", AuthorID: "u-replier", ParentMessageID: "m-root", Body: "reply",
	}, ParentChannel, nil)

	if got := publishedKinds(pub)[pubsub.UserChannel("u-root")]; got != NotificationKindThreadReply {
		t.Errorf("thread root at 'all' level should get thread_reply, got %q", got)
	}
}

func TestNotifyForMessage_PerChannelOverrideBeatsAccount(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	// Account default is quiet (mentions), but the per-channel override bumps
	// this channel to "all" so ordinary messages notify.
	users.users["u-bob"] = userWith("u-bob", model.DefaultNotificationSettings())
	allLevel := model.NotificationLevelAll
	members.userChannels = []*model.UserChannel{
		{UserID: "u-bob", ChannelID: "ch1", DesktopLevel: &allLevel},
	}
	for _, uid := range []string{"u-author", "u-bob"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "plain"}, ParentChannel, nil)

	if got := publishedKinds(pub)[pubsub.UserChannel("u-bob")]; got != NotificationKindMessage {
		t.Errorf("per-channel 'all' override should notify bob, got %q", got)
	}
}

func TestNotifyForMessage_MobileAll_DesktopMentions(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	ns := model.DefaultNotificationSettings()
	ns.MobileLevel = model.MobileNotificationAll // desktop stays quiet, mobile gets everything
	users.users["u-bob"] = userWith("u-bob", ns)
	for _, uid := range []string{"u-author", "u-bob"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "plain"}, ParentChannel, nil)

	if got := len(pub.published); got != 0 {
		t.Errorf("desktop (mentions) should not publish for a plain message, got %d", got)
	}
	if got := len(push.calls); got != 1 || push.calls[0].userID != "u-bob" {
		t.Errorf("mobile (all) should push to bob, got %+v", push.calls)
	}
}

func TestNotifyForMessage_MobileMentions_DesktopAll(t *testing.T) {
	svc, pub, members, _, chans, users := setupNotifier(t)
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	ns := model.DefaultNotificationSettings()
	ns.DesktopLevel = model.NotificationLevelAll
	ns.MobileLevel = model.MobileNotificationMentions
	users.users["u-bob"] = userWith("u-bob", ns)
	for _, uid := range []string{"u-author", "u-bob"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}

	svc.NotifyForMessage(ctx, &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "plain"}, ParentChannel, nil)

	if got := len(pub.published); got != 1 {
		t.Errorf("desktop (all) should publish, got %d", got)
	}
	if got := len(push.calls); got != 0 {
		t.Errorf("mobile (mentions) should not push a plain message, got %d", got)
	}
}

// --- account / per-channel setters ---

func TestUserService_SetNotificationSettings(t *testing.T) {
	users := newMockUserStore()
	pub := newMockPublisher()
	svc := NewUserService(users, nil, nil, pub)
	ctx := context.Background()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "U"}

	in := model.NotificationSettings{
		DesktopLevel:  model.NotificationLevelAll,
		MobileLevel:   model.MobileNotificationDefault,
		ThreadReplies: true,
		Keywords:      []string{" Deploy ", "deploy", "", "ship"}, // trimmed, deduped, blanks dropped
	}
	got, err := svc.SetNotificationSettings(ctx, "u1", in)
	if err != nil {
		t.Fatalf("SetNotificationSettings: %v", err)
	}
	if got.NotificationSettings == nil || got.NotificationSettings.DesktopLevel != model.NotificationLevelAll {
		t.Fatalf("settings not persisted: %+v", got.NotificationSettings)
	}
	if kw := got.NotificationSettings.Keywords; len(kw) != 2 || kw[0] != "Deploy" || kw[1] != "ship" {
		t.Errorf("keywords not normalized: %v", kw)
	}
	// A private event went to the user's own channel.
	found := false
	for _, p := range pub.published {
		if p.channel == pubsub.UserChannel("u1") && p.event.Type == events.EventNotificationSettingsUpdated {
			found = true
		}
	}
	if !found {
		t.Error("expected notification.settings_updated event to the user's own channel")
	}
}

func TestUserService_SetNotificationSettings_Validation(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, newMockPublisher())
	ctx := context.Background()
	users.users["u1"] = &model.User{ID: "u1"}

	if _, err := svc.SetNotificationSettings(ctx, "u1", model.NotificationSettings{DesktopLevel: "bogus", MobileLevel: model.MobileNotificationDefault}); err == nil {
		t.Error("expected error for invalid desktop level")
	}
	if _, err := svc.SetNotificationSettings(ctx, "u1", model.NotificationSettings{DesktopLevel: model.NotificationLevelAll, MobileLevel: "bogus"}); err == nil {
		t.Error("expected error for invalid mobile level")
	}
	// Not found.
	if _, err := svc.SetNotificationSettings(ctx, "missing", model.NotificationSettings{DesktopLevel: model.NotificationLevelAll, MobileLevel: model.MobileNotificationDefault}); err == nil {
		t.Error("expected error for missing user")
	}
}

func TestUserService_SetNotificationSettings_StoreError(t *testing.T) {
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1"}
	users.updateErr = errors.New("boom")
	svc := NewUserService(users, nil, nil, newMockPublisher())
	if _, err := svc.SetNotificationSettings(context.Background(), "u1", model.DefaultNotificationSettings()); err == nil {
		t.Error("expected error when the store update fails")
	}
}

func TestChannelService_SetNotificationPrefs(t *testing.T) {
	svc, _, memberships, _, pub := setupChannelService()
	ctx := context.Background()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-1", Role: model.ChannelRoleMember}
	memberships.userChannels = []*model.UserChannel{{UserID: "u-1", ChannelID: "ch1"}}

	all := model.NotificationLevelAll
	if err := svc.SetNotificationPrefs(ctx, "u-1", "ch1", model.ChannelNotificationOverride{DesktopLevel: &all}); err != nil {
		t.Fatalf("SetNotificationPrefs: %v", err)
	}
	if uc := memberships.userChannels[0]; uc.DesktopLevel == nil || *uc.DesktopLevel != model.NotificationLevelAll {
		t.Errorf("override not persisted: %+v", uc)
	}
	found := false
	for _, p := range pub.published {
		if p.channel == pubsub.UserChannel("u-1") && p.event.Type == events.EventUserChannelUpdated {
			found = true
		}
	}
	if !found {
		t.Error("expected userchannel.updated event")
	}
}

func TestChannelService_SetNotificationPrefs_Validation(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-1"}

	bogusDesktop := model.NotificationLevel("bogus")
	if err := svc.SetNotificationPrefs(ctx, "u-1", "ch1", model.ChannelNotificationOverride{DesktopLevel: &bogusDesktop}); err == nil {
		t.Error("expected error for invalid desktop override")
	}
	bogusMobile := model.MobileNotificationLevel("bogus")
	if err := svc.SetNotificationPrefs(ctx, "u-1", "ch1", model.ChannelNotificationOverride{MobileLevel: &bogusMobile}); err == nil {
		t.Error("expected error for invalid mobile override")
	}
	// Not a member.
	if err := svc.SetNotificationPrefs(ctx, "u-1", "ch-missing", model.ChannelNotificationOverride{}); err == nil {
		t.Error("expected error when caller is not a member")
	}
}

func TestChannelService_SetNotificationPrefs_StoreError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	ctx := context.Background()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-1"}
	memberships.setNotifErr = errors.New("boom")
	if err := svc.SetNotificationPrefs(ctx, "u-1", "ch1", model.ChannelNotificationOverride{}); err == nil {
		t.Error("expected error when the store write fails")
	}
}
