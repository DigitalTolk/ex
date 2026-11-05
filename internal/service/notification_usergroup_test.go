package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// stubGroupMembers is the user-group lookup the fan-out makes.
type stubGroupMembers struct {
	members map[string][]string
	err     error
	fails   int
	calls   int
}

func (s *stubGroupMembers) MentionedMembers(_ context.Context, _ string, ids []string) (map[string][]string, error) {
	s.calls++
	if s.err != nil {
		return nil, s.err
	}
	if s.fails > 0 {
		s.fails--
		return nil, errors.New("transient")
	}
	out := map[string][]string{}
	for _, id := range ids {
		if m, ok := s.members[id]; ok {
			out[id] = m
		}
	}
	return out, nil
}

const oncallID = "group-oncall"

// groupNotifier is a channel with the author, two @oncall members (bob, dan),
// a non-member (carol) and an @oncall member who isn't in the channel (erin).
func groupNotifier(t *testing.T) (*NotificationService, *mockPublisher, *mockMembershipStore, *mockUserStore, *stubGroupMembers) {
	t.Helper()
	svc, pub, members, _, chans, users := setupNotifier(t)
	groups := &stubGroupMembers{members: map[string][]string{oncallID: {"u-author", "u-bob", "u-dan", "u-erin"}}}
	svc.SetUserGroups(groups)
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "alerts", Slug: "alerts", Type: model.ChannelTypePublic}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	for _, uid := range []string{"u-author", "u-bob", "u-carol", "u-dan"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	return svc, pub, members, users, groups
}

func oncallMessage(body string) *model.Message {
	return &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: body}
}

func TestNotifyForMessage_UserGroupMentionAlertsMembersAsDirectMentions(t *testing.T) {
	svc, pub, _, _, _ := groupNotifier(t)
	svc.NotifyForMessage(context.Background(), oncallMessage("@[group-oncall|oncall] db is down"), ParentChannel, nil)

	kinds := publishedKinds(pub)
	for _, uid := range []string{"u-bob", "u-dan"} {
		if got := kinds[pubsub.UserChannel(uid)]; got != NotificationKindMention {
			t.Errorf("%s: kind = %q, want mention", uid, got)
		}
	}
	if _, ok := kinds[pubsub.UserChannel("u-carol")]; ok {
		t.Error("carol isn't in @oncall and must not be pinged")
	}
	if _, ok := kinds[pubsub.UserChannel("u-erin")]; ok {
		t.Error("erin isn't in the channel and must not be pinged")
	}
	if _, ok := kinds[pubsub.UserChannel("u-author")]; ok {
		t.Error("the author is in @oncall but must not ping themselves")
	}
}

// The recipient truth table: a group mention is a direct @-mention.
func TestNotifyForMessage_UserGroupMentionRespectsSettingsLikeADirectMention(t *testing.T) {
	quiet := model.DefaultNotificationSettings()
	quiet.DesktopLevel = model.NotificationLevelMentions
	ignore := model.DefaultNotificationSettings()
	ignore.IgnoreGroupMentions = true
	cases := []struct {
		name    string
		prefs   *model.NotificationSettings
		muted   bool
		status  string
		alerted bool
	}{
		{name: "mentions level", prefs: &quiet, alerted: true},
		{name: "muted channel", prefs: &quiet, muted: true, alerted: true},
		{name: "ignores @all/@here", prefs: &ignore, alerted: true},
		{name: "deactivated", prefs: &quiet, status: "deactivated", alerted: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, pub, members, users, _ := groupNotifier(t)
			users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob", Status: tc.status, NotificationSettings: tc.prefs}
			if tc.muted {
				members.userChannels = []*model.UserChannel{{UserID: "u-bob", ChannelID: "ch1", Muted: true}}
			}
			svc.NotifyForMessage(context.Background(), oncallMessage("@[group-oncall|oncall] paging"), ParentChannel, nil)
			got, ok := publishedKinds(pub)[pubsub.UserChannel("u-bob")]
			if ok != tc.alerted || (ok && got != NotificationKindMention) {
				t.Fatalf("bob alerted = %v (%q), want %v", ok, got, tc.alerted)
			}
		})
	}
}

func TestNotifyForMessage_UserGroupMentionInADM(t *testing.T) {
	svc, pub, _, conv, _, users := setupNotifier(t)
	svc.SetUserGroups(&stubGroupMembers{members: map[string][]string{oncallID: {"u-bob", "u-erin"}}})
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice"}
	conv.conversations["c1"] = &model.Conversation{ID: "c1", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-author", "u-bob", "u-carol"}}

	svc.NotifyForMessage(context.Background(), &model.Message{ID: "m1", ParentID: "c1", AuthorID: "u-author", Body: "@[group-oncall|oncall] see this"}, ParentConversation, nil)

	kinds := publishedKinds(pub)
	if got := kinds[pubsub.UserChannel("u-bob")]; got != NotificationKindMention {
		t.Errorf("bob (participant in @oncall) kind = %q, want mention", got)
	}
	if _, ok := kinds[pubsub.UserChannel("u-erin")]; ok {
		t.Error("erin isn't in the conversation and must not be pinged")
	}
}

func TestNotifyForMessage_UserGroupActivityRows(t *testing.T) {
	svc, _, _, _, _ := groupNotifier(t)
	rec := &recordingActivity{}
	svc.SetActivityRecorder(rec)

	// Dan is also mentioned by name: the direct mention wins the label.
	svc.NotifyForMessage(context.Background(), oncallMessage("@[group-oncall|oncall] and @[u-dan|Dan]: db down"), ParentChannel, nil)

	bob, dan := rec.items["u-bob"], rec.items["u-dan"]
	if bob == nil || bob.Type != model.ActivityMention || bob.MentionKind != model.MentionKindUserGroup ||
		bob.UserGroupID != oncallID || bob.UserGroupHandle != "oncall" {
		t.Fatalf("bob item = %+v, want a usergroup mention naming @oncall", bob)
	}
	if dan == nil || dan.MentionKind != model.MentionKindUser || dan.UserGroupID != "" {
		t.Fatalf("dan item = %+v, want a direct mention", dan)
	}
	if _, ok := rec.items["u-carol"]; ok {
		t.Error("carol isn't in @oncall and gets no Activity row")
	}
}

func TestNotifyForMessage_UserGroupMentionPushesToPhone(t *testing.T) {
	svc, pub, push, _, _, _ := mobileLevelSetup(t, model.MobileNotificationMentions)
	svc.SetUserGroups(&stubGroupMembers{members: map[string][]string{oncallID: {"u-bob"}}})
	svc.NotifyForMessage(context.Background(),
		&model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "paging @[group-oncall|oncall]"}, ParentChannel, nil)

	if got := publishedKinds(pub)[pubsub.UserChannel("u-bob")]; got != NotificationKindMention {
		t.Fatalf("desktop kind = %q, want mention", got)
	}
	if len(push.calls) != 1 || push.calls[0].userID != "u-bob" {
		t.Fatalf("mobile push calls = %#v, want one to u-bob", push.calls)
	}
}

func TestNotifyForMessage_DisabledOrUnknownGroupAlertsNobody(t *testing.T) {
	svc, pub, _, _, groups := groupNotifier(t)
	groups.members = map[string][]string{} // disabled/unknown groups resolve to nothing
	svc.NotifyForMessage(context.Background(), oncallMessage("@[group-oncall|oncall] hello"), ParentChannel, nil)
	if _, ok := publishedKinds(pub)[pubsub.UserChannel("u-bob")]; ok {
		t.Fatal("a group that resolved to nobody pinged bob")
	}
}

func TestNotifyForMessage_NoGroupLookupWithoutGroupMentions(t *testing.T) {
	svc, _, _, _, groups := groupNotifier(t)
	svc.NotifyForMessage(context.Background(), oncallMessage("@[u-bob|Bob] plain"), ParentChannel, nil)
	if groups.calls != 0 {
		t.Fatalf("looked up groups %d times for a message mentioning none", groups.calls)
	}
}

func TestNotifyForMessage_UserGroupLookupRetriesTransientFailures(t *testing.T) {
	withFastAudienceRetry(t)
	svc, pub, _, _, groups := groupNotifier(t)
	groups.fails = 1
	marker := newMemMarker()
	svc.SetNotifyMarker(marker)
	svc.NotifyForMessage(context.Background(), oncallMessage("@[group-oncall|oncall] retry"), ParentChannel, nil)
	if got := publishedKinds(pub)[pubsub.UserChannel("u-bob")]; got != NotificationKindMention {
		t.Fatalf("bob kind after a transient failure = %q, want mention", got)
	}
	if !marker.marked["m1"] {
		t.Fatal("a fan-out that resolved its groups must be marked done")
	}
}

func TestNotifyForMessage_UserGroupLookupFailureLeavesItToTheSafetyNet(t *testing.T) {
	withFastAudienceRetry(t)
	svc, pub, _, users, groups := groupNotifier(t)
	groups.err = errors.New("dynamo down")
	seedAllLevel(users, "u-carol")
	marker := newMemMarker()
	svc.SetNotifyMarker(marker)

	svc.NotifyForMessage(context.Background(), oncallMessage("@[group-oncall|oncall] outage"), ParentChannel, nil)

	// Everyone else is still alerted now...
	if got := publishedKinds(pub)[pubsub.UserChannel("u-carol")]; got != NotificationKindMessage {
		t.Fatalf("carol kind = %q, want the ordinary message alert", got)
	}
	// ...and the fan-out stays unmarked so the safety net runs it again.
	if marker.marked["m1"] {
		t.Fatal("a fan-out whose groups were unresolved was marked done — its members would never be alerted")
	}
}

func TestActivityFor_UserGroupMention(t *testing.T) {
	typ, kind := activityFor(ParentChannel, recipientReasons{explicitMention: true, viaUserGroup: true, muted: true}, model.MentionKindAll)
	if typ != model.ActivityMention || kind != model.MentionKindUserGroup {
		t.Fatalf("activityFor = (%q, %q), want a usergroup mention even when muted", typ, kind)
	}
}

func TestNotificationService_WiredNamesUserGroups(t *testing.T) {
	err := (&NotificationService{}).Wired()
	if err == nil || !strings.Contains(err.Error(), "user groups") {
		t.Fatalf("Wired = %v, want it to name the user groups", err)
	}
}
