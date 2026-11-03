package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// A deactivated account keeps its memberships and its messages, but nothing
// alerts it and nothing is written for it: an @all, a mention or a keyword
// must not leave an alert, an Activity row, a badge bump or a push behind.

type deactivatedFanOutEnv struct {
	svc      *NotificationService
	pub      *mockPublisher
	members  *bumpMockMembershipStore
	conv     *bumpMockConversationStore
	users    *mockUserStore
	activity *recordingActivity
	push     *recordingMobilePush
}

func setupDeactivatedFanOut(t *testing.T) *deactivatedFanOutEnv {
	t.Helper()
	svc, pub, members, conv, chans, users := setupBumpNotifier(t)
	activity := &recordingActivity{}
	svc.SetActivityRecorder(activity)
	push := &recordingMobilePush{}
	svc.SetMobilePushScheduler(push)
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	users.users["u-author"] = &model.User{ID: "u-author", DisplayName: "Alice", Status: "active"}
	users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob", Status: "active"}
	keywords := model.DefaultNotificationSettings()
	keywords.Keywords = []string{"deploy"}
	users.users["u-gone"] = &model.User{ID: "u-gone", DisplayName: "Dave", Status: "deactivated", NotificationSettings: &keywords}
	for _, uid := range []string{"u-author", "u-bob", "u-gone"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	return &deactivatedFanOutEnv{svc: svc, pub: pub, members: members, conv: conv, users: users, activity: activity, push: push}
}

// assertNothingFor fails on any trace the fan-out left for userID.
func (e *deactivatedFanOutEnv) assertNothingFor(t *testing.T, parentID, userID string) {
	t.Helper()
	for _, p := range e.pub.published {
		if p.channel == pubsub.UserChannel(userID) {
			t.Errorf("published %s to %s", p.event.Type, userID)
		}
	}
	if n := e.members.counts[parentID+"#"+userID] + e.conv.counts[parentID+"#"+userID]; n != 0 {
		t.Errorf("badge bumped %d times for %s", n, userID)
	}
	if _, ok := e.activity.items[userID]; ok {
		t.Errorf("Activity row written for %s", userID)
	}
	for _, c := range e.push.calls {
		if c.userID == userID {
			t.Errorf("push scheduled for %s", userID)
		}
	}
}

func (e *deactivatedFanOutEnv) assertAlerted(t *testing.T, userID string) {
	t.Helper()
	if got := publishedKinds(e.pub)[pubsub.UserChannel(userID)]; got == "" {
		t.Errorf("%s was not alerted", userID)
	}
}

func TestNotifyForMessage_DeactivatedMemberGetsNothing(t *testing.T) {
	for _, body := range []string{
		"@all please review",
		"@here please review",
		"@[u-gone|Dave] please review",
		"the deploy is done",
	} {
		t.Run(body, func(t *testing.T) {
			env := setupDeactivatedFanOut(t)
			env.svc.SetPresence(&stubPresence{online: map[string]bool{"u-bob": true, "u-gone": true}})
			msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: body}

			env.svc.NotifyForMessage(context.Background(), msg, ParentChannel, nil)

			env.assertNothingFor(t, "ch1", "u-gone")
			if body != "@[u-gone|Dave] please review" && body != "the deploy is done" {
				env.assertAlerted(t, "u-bob")
			}
		})
	}
}

func TestNotifyForMessage_DeactivatedParticipantGetsNothing(t *testing.T) {
	env := setupDeactivatedFanOut(t)
	env.conv.conversations["c1"] = &model.Conversation{
		ID:             "c1",
		Type:           model.ConversationTypeGroup,
		ParticipantIDs: []string{"u-author", "u-bob", "u-gone"},
	}
	msg := &model.Message{ID: "m1", ParentID: "c1", AuthorID: "u-author", Body: "@all heads up"}

	env.svc.NotifyForMessage(context.Background(), msg, ParentConversation, nil)

	env.assertNothingFor(t, "c1", "u-gone")
	env.assertAlerted(t, "u-bob")
}

func TestNotifyForMessage_ReactivatedMemberIsAlertedAgain(t *testing.T) {
	env := setupDeactivatedFanOut(t)
	env.users.users["u-gone"].Status = "active"
	msg := &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u-author", Body: "@all please review"}

	env.svc.NotifyForMessage(context.Background(), msg, ParentChannel, nil)

	env.assertAlerted(t, "u-gone")
}

// Deactivating or reactivating moves the account's notification audience on,
// so every instance's cached copy of it reloads before the next message.
func TestApplyStatusMovesTheAudience(t *testing.T) {
	svc, _, _ := setupDirectoryStatusUser(t, model.AuthProviderOIDC, "active")
	inv := &recordingInvalidator{}
	svc.SetAudienceInvalidator(inv)

	if err := svc.SetStatusFromDirectory(context.Background(), "u1", true); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if err := svc.SetStatusFromDirectory(context.Background(), "u1", false); err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	if len(inv.users) != 2 || inv.users[0] != "u1" || inv.users[1] != "u1" {
		t.Errorf("audience changes = %v, want u1 twice", inv.users)
	}
}

func TestChannelService_ListMembersLeavesOutDeactivated(t *testing.T) {
	svc, _, memberships, users, _, _ := setupChannelServiceWithUsers()
	// Production answers this from the user service's shared roster.
	svc.SetDeactivatedAccounts(NewUserService(users, newMockCache(), nil, nil))
	ctx := context.Background()
	users.users["u1"] = &model.User{ID: "u1", Status: "active"}
	users.users["u-gone"] = &model.User{ID: "u-gone", Status: "deactivated"}
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}
	memberships.memberships["ch1#u-gone"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-gone"}
	// No profile row at all: nothing says it is deactivated, so it stays.
	memberships.memberships["ch1#u-unknown"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-unknown"}

	members, err := svc.ListMembers(ctx, "u1", "ch1")
	if err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	got := map[string]bool{}
	for _, m := range members {
		got[m.UserID] = true
	}
	if len(got) != 2 || !got["u1"] || !got["u-unknown"] {
		t.Errorf("members = %v, want u1 and u-unknown", got)
	}
	if _, ok := memberships.memberships["ch1#u-gone"]; !ok {
		t.Error("the deactivated account's membership must be kept underneath")
	}

	// A failed status read lists everyone rather than nobody.
	users.deactivatedErr = errors.New("dynamo down")
	members, err = svc.ListMembers(ctx, "u1", "ch1")
	if err != nil || len(members) != 3 {
		t.Errorf("ListMembers on a failed status read = (%d members, %v), want all 3", len(members), err)
	}
}

func TestChannelService_AddMemberRefusesDeactivated(t *testing.T) {
	svc, channels, memberships, users, _, _ := setupChannelServiceWithUsers()
	ctx := context.Background()
	channels.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Type: model.ChannelTypePublic}
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleAdmin}
	users.users["u-gone"] = &model.User{ID: "u-gone", DisplayName: "Dave", Status: "deactivated"}

	if err := svc.AddMember(ctx, "u1", "ch1", "u-gone", model.ChannelRoleMember); !errors.Is(err, ErrMemberDeactivated) {
		t.Fatalf("AddMember = %v, want ErrMemberDeactivated", err)
	}
	if _, ok := memberships.memberships["ch1#u-gone"]; ok {
		t.Error("no membership may be written for a deactivated account")
	}
}

// fakeDeactivatedAccounts answers DeactivatedAmong from a fixed set.
type fakeDeactivatedAccounts struct {
	ids map[string]bool
	err error
}

func (f *fakeDeactivatedAccounts) DeactivatedAmong(_ context.Context, userIDs []string) (map[string]bool, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := map[string]bool{}
	for _, uid := range userIDs {
		if f.ids[uid] {
			out[uid] = true
		}
	}
	return out, nil
}

// A reply mentioning someone makes them follow the thread; a deactivated
// account mentioned that way gets no follow row.
func TestFollowMentionedThreadUsersSkipsDeactivated(t *testing.T) {
	setup := func(t *testing.T, accounts *fakeDeactivatedAccounts) *mockThreadFollowStore {
		t.Helper()
		svc, messages, memberships, _, _ := setupMessageService()
		for _, uid := range []string{"user-1", "u-bob", "u-gone"} {
			seedMembership(memberships, "ch1", uid)
		}
		follows := newMockThreadFollowStore()
		svc.SetThreadFollowStore(follows)
		svc.SetDeactivatedAccounts(accounts)
		messages.messages["ch1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch1", AuthorID: "user-9", Body: "root"}
		if _, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, "@[u-bob|Bob] @[u-gone|Dave] look", "root-1"); err != nil {
			t.Fatalf("Send: %v", err)
		}
		return follows
	}

	follows := setup(t, &fakeDeactivatedAccounts{ids: map[string]bool{"u-gone": true}})
	if _, ok := follows.follows[threadFollowMockKey("u-bob", "ch1", "root-1")]; !ok {
		t.Error("u-bob should follow the thread")
	}
	if _, ok := follows.follows[threadFollowMockKey("u-gone", "ch1", "root-1")]; ok {
		t.Error("the deactivated account must not follow the thread")
	}

	// A failed check follows everyone mentioned.
	follows = setup(t, &fakeDeactivatedAccounts{err: errors.New("dynamo down")})
	if _, ok := follows.follows[threadFollowMockKey("u-gone", "ch1", "root-1")]; !ok {
		t.Error("a failed status read must keep the follow")
	}

	// Mentioning only the deactivated account writes nothing at all.
	svc, messages, memberships, _, _ := setupMessageService()
	seedMembership(memberships, "ch1", "user-1")
	seedMembership(memberships, "ch1", "u-gone")
	empty := newMockThreadFollowStore()
	svc.SetThreadFollowStore(empty)
	svc.SetDeactivatedAccounts(&fakeDeactivatedAccounts{ids: map[string]bool{"u-gone": true}})
	messages.messages["ch1#root-1"] = &model.Message{ID: "root-1", ParentID: "ch1", AuthorID: "user-9", Body: "root"}
	if _, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, "@[u-gone|Dave] look", "root-1"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if _, ok := empty.follows[threadFollowMockKey("u-gone", "ch1", "root-1")]; ok {
		t.Error("the deactivated account must not follow the thread")
	}
}

// signallingDeactivated is a DeactivatedAccounts that reports each check on
// a channel, so a test can wait for the detached reaction path to decide.
type signallingDeactivated struct {
	fakeDeactivatedAccounts
	checked chan string
}

func (s *signallingDeactivated) DeactivatedAmong(ctx context.Context, ids []string) (map[string]bool, error) {
	out, err := s.fakeDeactivatedAccounts.DeactivatedAmong(ctx, ids)
	s.checked <- ids[0]
	return out, err
}

// next waits for the reaction path's account check, within the shared wait
// budget.
func (s *signallingDeactivated) next(t *testing.T) string {
	t.Helper()
	select {
	case id := <-s.checked:
		return id
	case <-time.After(5 * time.Second):
		t.Fatal("the author's account was never checked")
		return ""
	}
}

// Reacting to a deactivated colleague's message leaves no hint in their
// Activity stream: nobody reads it any more.
func TestActivityService_RecordReactionSkipsDeactivatedAuthor(t *testing.T) {
	store := newFakeActivityStore()
	svc := NewActivityService(store, newMockPublisher())
	check := &signallingDeactivated{fakeDeactivatedAccounts: fakeDeactivatedAccounts{ids: map[string]bool{"u-gone": true}}, checked: make(chan string, 1)}
	svc.SetDeactivatedAccounts(check)

	svc.RecordReaction(context.Background(), reactedMessage("u-gone"), ParentChannel, "reactor-2", "👍")

	if got := check.next(t); got != "u-gone" {
		t.Fatalf("checked %q, want the author", got)
	}
	// The check answered "deactivated"; the goroutine returns without a write.
	if got := store.count("u-gone"); got != 0 {
		t.Fatalf("activity items for a deactivated author = %d, want 0", got)
	}

	// A failed check reads as active: the hint is written.
	check.err = errors.New("dynamo down")
	svc.RecordReaction(context.Background(), reactedMessage("u-gone"), ParentChannel, "reactor-2", "👍")
	check.next(t)
	waitForCond(t, func() bool { return store.count("u-gone") == 1 }, "hint written when the check fails")
}

// Without a user store nothing says who is deactivated: everyone is listed.
func TestChannelService_ListMembersWithoutAUserStore(t *testing.T) {
	memberships := newMockMembershipStore()
	svc := NewChannelService(newMockChannelStore(), memberships, nil, newMockMessageStore(), newMockCache(), newMockBroker(), newMockPublisher())
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}
	memberships.memberships["ch1#u2"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u2"}

	members, err := svc.ListMembers(context.Background(), "u1", "ch1")
	if err != nil || len(members) != 2 {
		t.Fatalf("ListMembers = (%d members, %v), want both", len(members), err)
	}
}
