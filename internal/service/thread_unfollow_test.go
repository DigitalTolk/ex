package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// An unfollowed thread stays unfollowed: nothing implicit brings it back —
// not being in a DM, not "follow all threads", not anyone else's reply. Only
// an explicit follow, replying yourself, or an @-mention of you does.

// alertedUsers lists who got a notification.new.
func alertedUsers(pub *mockPublisher) map[string]bool {
	pub.mu.Lock()
	defer pub.mu.Unlock()
	out := map[string]bool{}
	for _, p := range pub.published {
		if p.event.Type == events.EventNotificationNew {
			out[strings.TrimPrefix(p.channel, "user:")] = true
		}
	}
	return out
}

// threadRows maps each thread.updated recipient to the row's Following.
func threadRows(pub *mockPublisher) map[string]bool {
	pub.mu.Lock()
	defer pub.mu.Unlock()
	out := map[string]bool{}
	for _, p := range pub.published {
		if p.event.Type != events.EventThreadUpdated {
			continue
		}
		var s ThreadSummary
		if err := json.Unmarshal(p.event.Data, &s); err == nil {
			out[strings.TrimPrefix(p.channel, "user:")] = s.Following
		}
	}
	return out
}

func unfollow(t *testing.T, follows *mockThreadFollowStore, uid, parentID, rootID string) {
	t.Helper()
	if err := follows.SetThreadFollow(context.Background(), &model.ThreadFollow{
		UserID: uid, ParentID: parentID, ThreadRootID: rootID, Following: false,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestNotifyForMessage_DMThreadUnfollowSticks(t *testing.T) {
	svc, pub, _, conv, _, users, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	stateStore := newMockUserStateStore()
	svc.SetUserStateService(NewUserStateService(stateStore, nil))
	for _, uid := range []string{"u-author", "u-bob", "u-carol"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid}
	}
	conv.conversations["conv1"] = &model.Conversation{
		ID: "conv1", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-author", "u-bob", "u-carol"},
	}
	root := &model.Message{ID: "m-root", ParentID: "conv1", AuthorID: "u-bob", Body: "ask", CreatedAt: time.Now(), ReplyCount: 1}
	msgs.messages["conv1#m-root"] = root
	unfollow(t, follows, "u-carol", "conv1", "m-root")

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r1", ParentID: "conv1", AuthorID: "u-author", ParentMessageID: "m-root", Body: "reply",
	}, ParentConversation, root)

	alerted := alertedUsers(pub)
	if !alerted["u-bob"] {
		t.Error("a participant still following must be told")
	}
	if alerted["u-carol"] {
		t.Error("a participant who unfollowed the thread was told about a reply")
	}
	if _, ok := stateStore.rows[stateStore.key("u-carol", model.UserStateThreadNotification, "m-root")]; ok {
		t.Error("the reply marked the unfollowed thread unread, listing it again")
	}
	rows := threadRows(pub)
	if _, ok := rows["u-carol"]; ok {
		t.Error("the unfollowed thread was patched back into their list")
	}
	if !rows["u-bob"] {
		t.Errorf("rows = %v, want bob's row followed", rows)
	}

	// An @-mention still reaches them.
	pub.published = nil
	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r2", ParentID: "conv1", AuthorID: "u-author", ParentMessageID: "m-root", Body: "@[u-carol|Carol] look",
	}, ParentConversation, root)
	if !alertedUsers(pub)["u-carol"] {
		t.Error("an @-mention must reach someone who unfollowed")
	}
}

func TestNotifyForMessage_FollowAllRespectsUnfollow(t *testing.T) {
	svc, pub, members, _, chans, users, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	for _, uid := range []string{"u-author", "u-root", "u-all", "u-all-out"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	for _, uid := range []string{"u-all", "u-all-out"} {
		users.users[uid] = &model.User{ID: uid, DisplayName: uid, NotificationSettings: &model.NotificationSettings{
			DesktopLevel: model.NotificationLevelMentions, ThreadReplies: true, FollowAllThreads: true,
		}}
	}
	root := &model.Message{ID: "root", ParentID: "ch1", AuthorID: "u-root", Body: "root", CreatedAt: time.Now(), ReplyCount: 1}
	msgs.messages["ch1#root"] = root
	unfollow(t, follows, "u-all-out", "ch1", "root")

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r", ParentID: "ch1", ParentMessageID: "root", AuthorID: "u-author", Body: "reply",
	}, ParentChannel, root)

	alerted := alertedUsers(pub)
	if !alerted["u-all"] {
		t.Error("follow-all must still reach a thread they didn't unfollow")
	}
	if alerted["u-all-out"] {
		t.Error("follow-all overrode an explicit unfollow")
	}
	if _, ok := threadRows(pub)["u-all-out"]; ok {
		t.Error("follow-all patched the unfollowed thread back into their list")
	}
}

// A keyword alert lists a thread for someone who doesn't follow it; their row
// says so, while followers' rows say they follow.
func TestNotifyForMessage_ThreadRowsSayWhoFollows(t *testing.T) {
	svc, pub, members, _, chans, users, msgs, _ := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	for _, uid := range []string{"u-author", "u-root", "u-watcher"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	users.users["u-watcher"] = &model.User{ID: "u-watcher", DisplayName: "W", NotificationSettings: &model.NotificationSettings{
		DesktopLevel: model.NotificationLevelMentions, Keywords: []string{"outage"},
	}}
	root := &model.Message{ID: "root", ParentID: "ch1", AuthorID: "u-root", Body: "root", CreatedAt: time.Now(), ReplyCount: 1}
	msgs.messages["ch1#root"] = root

	svc.NotifyForMessage(ctx, &model.Message{
		ID: "m-r", ParentID: "ch1", ParentMessageID: "root", AuthorID: "u-author", Body: "we have an outage",
	}, ParentChannel, root)

	rows := threadRows(pub)
	following, listed := rows["u-watcher"]
	if !listed || following {
		t.Errorf("watcher row = listed %v following %v, want listed, not following", listed, following)
	}
	if !rows["u-root"] || !rows["u-author"] {
		t.Errorf("rows = %v, want the root author and the replier following", rows)
	}
}

func TestActivityFor_UnfollowedDMThread(t *testing.T) {
	r := recipientReasons{threadReply: true}
	if typ, _ := activityFor(ParentConversation, r, ""); typ != "" {
		t.Errorf("unfollowed DM thread reply listed as %q", typ)
	}
	r.keyword = true
	if typ, kind := activityFor(ParentConversation, r, ""); typ != model.ActivityMention || kind != model.MentionKindKeyword {
		t.Errorf("keyword in an unfollowed DM thread = %q/%q, want a keyword mention", typ, kind)
	}
	r = recipientReasons{threadReply: true, threadParticipant: true}
	if typ, _ := activityFor(ParentConversation, r, ""); typ != model.ActivityThreadReply {
		t.Errorf("followed DM thread reply = %q, want a thread reply", typ)
	}
}

func TestListThreadsPage_SaysWhichThreadsAreFollowed(t *testing.T) {
	svc, messages, memberships, conversations, follows := threadIndexService()
	ctx := context.Background()
	follows.seeded = true
	seedMembership(memberships, "ch-1", "u-1")
	conversations.conversations["dm-1"] = &model.Conversation{ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}}
	conversations.userConvs["u-1"] = []*model.UserConversation{{UserID: "u-1", ConversationID: "dm-1"}}
	at := time.Now().Truncate(time.Second)
	for _, m := range []*model.Message{
		{ID: "followed", ParentID: "ch-1", CreatedAt: at},
		{ID: "pulled", ParentID: "ch-1", CreatedAt: at},
		{ID: "dm", ParentID: "dm-1", CreatedAt: at},
		{ID: "dm-out", ParentID: "dm-1", CreatedAt: at},
	} {
		messages.messages[m.ParentID+"#"+m.ID] = m
	}
	follows.follows[threadFollowMockKey("u-1", "ch-1", "followed")] = &model.ThreadFollow{UserID: "u-1", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: "followed", Following: true, LastActivityAt: &at}
	follows.follows[threadFollowMockKey("u-1", "dm-1", "dm-out")] = &model.ThreadFollow{UserID: "u-1", ParentID: "dm-1", ParentType: ParentConversation, ThreadRootID: "dm-out", Following: false}
	state := newMockUserStateStore()
	for parent, roots := range map[string][]string{"ch-1": {"pulled"}, "dm-1": {"dm", "dm-out"}} {
		parentType := ParentChannel
		if parent == "dm-1" {
			parentType = ParentConversation
		}
		for _, root := range roots {
			state.rows[state.key("u-1", model.UserStateThreadNotification, root)] = &model.UserStateItem{
				UserID: "u-1", Kind: model.UserStateThreadNotification, ParentID: parent, ParentType: parentType, ThreadRootID: root, TargetID: root, UpdatedAt: at,
			}
		}
	}
	svc.SetUserStateStore(state)

	following := map[string]bool{}
	for cursor := ""; ; {
		page, err := svc.ListThreadsPage(ctx, "u-1", cursor, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, s := range page.Threads {
			following[s.ThreadRootID] = s.Following
		}
		if page.NextCursor == "" {
			break
		}
		cursor = page.NextCursor
	}
	// An alert pulls a thread in without following it; a DM's threads are
	// followed unless unfollowed.
	want := map[string]bool{"followed": true, "pulled": false, "dm": true, "dm-out": false}
	if len(following) != len(want) {
		t.Fatalf("threads = %v, want %v", following, want)
	}
	for root, f := range want {
		if following[root] != f {
			t.Errorf("%s following = %v, want %v", root, following[root], f)
		}
	}

	// The legacy scan (before the index is seeded) agrees, and seeds only the
	// threads followed: an alert alone never becomes a standing follow.
	follows.seeded = false
	parents := []threadParent{{id: "ch-1", typ: ParentChannel}, {id: "dm-1", typ: ParentConversation}}
	overrides := map[string]bool{"ch-1#followed": true, "dm-1#dm-out": false}
	pulled := map[string]bool{"ch-1#pulled": true, "dm-1#dm": true, "dm-1#dm-out": true}
	scanned, complete := svc.scanUserThreads(ctx, "u-1", parents, overrides, pulled)
	if !complete {
		t.Fatal("scan incomplete")
	}
	for _, s := range scanned {
		if s.Following != want[s.ThreadRootID] {
			t.Errorf("legacy %s following = %v, want %v", s.ThreadRootID, s.Following, want[s.ThreadRootID])
		}
	}
	seeds := seedFinished(svc)
	if _, err := svc.ListThreadsPage(ctx, "u-1", "", 0); err != nil {
		t.Fatal(err)
	}
	waitThreadSeed(t, seeds)
	if f, ok := follows.follows[threadFollowMockKey("u-1", "ch-1", "pulled")]; ok {
		t.Errorf("seeded a follow for a thread an alert pulled in: %+v", f)
	}
	if f := follows.follows[threadFollowMockKey("u-1", "dm-1", "dm")]; f == nil || !f.Following {
		t.Error("the followed DM thread was not seeded")
	}
}

func TestSetThreadFollow_UnfollowTakesTheThreadOffTheList(t *testing.T) {
	svc, messages, memberships, _, follows := threadIndexService()
	ctx := context.Background()
	pub := newMockPublisher()
	svc.publisher = pub
	memberships.memberships["ch-1#u-1"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-1"}
	messages.messages["ch-1#root"] = &model.Message{ID: "root", ParentID: "ch-1", CreatedAt: time.Now()}
	state := newMockUserStateStore()
	key := state.key("u-1", model.UserStateThreadNotification, "root")
	state.rows[key] = &model.UserStateItem{UserID: "u-1", Kind: model.UserStateThreadNotification, ParentID: "ch-1", ThreadRootID: "root"}
	svc.SetUserStateStore(state)

	// Following keeps the alert; the user's other tabs refresh either way.
	if err := svc.SetThreadFollow(ctx, "u-1", "ch-1", ParentChannel, "root", true); err != nil {
		t.Fatal(err)
	}
	if _, ok := state.rows[key]; !ok {
		t.Fatal("following cleared the thread's alert")
	}
	if err := svc.SetThreadFollow(ctx, "u-1", "ch-1", ParentChannel, "root", false); err != nil {
		t.Fatal(err)
	}
	if _, ok := state.rows[key]; ok {
		t.Fatal("unfollowing left the thread's alert, keeping it listed")
	}
	refreshes := 0
	for _, p := range pub.published {
		if p.channel == pubsub.UserChannel("u-1") && p.event.Type == events.EventUserChannelUpdated && strings.Contains(string(p.event.Data), `"threads":true`) {
			refreshes++
		}
	}
	if refreshes != 2 {
		t.Fatalf("thread list refreshes = %d, want one per change", refreshes)
	}

	// A failed alert cleanup is logged; the unfollow itself stands.
	state.deleteErr = errors.New("state down")
	if err := svc.SetThreadFollow(ctx, "u-1", "ch-1", ParentChannel, "root", false); err != nil {
		t.Fatalf("unfollow failed on alert cleanup: %v", err)
	}

	// A follow that couldn't be stored is an error, and nobody is told.
	follows.setErr = errors.New("dynamo down")
	pub.published = nil
	if err := svc.SetThreadFollow(ctx, "u-1", "ch-1", ParentChannel, "root", false); !errors.Is(err, follows.setErr) {
		t.Fatalf("unfollow with a failing store = %v", err)
	}
	if len(pub.published) != 0 {
		t.Fatalf("published %d events for a follow that wasn't stored", len(pub.published))
	}
}
