package service

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// seedIndexedThread builds a channel thread whose root was created at
// rootCreated with two earlier replies (replier-a, replier-b). follows lists
// who has a follow row (the write-time participation index).
func seedIndexedThread(t *testing.T, rootCreated time.Time, follows []string) (*NotificationService, *mockPublisher, *mockMessageStore, *model.Message, *model.Message) {
	t.Helper()
	svc, pub, members, _, chans, users, msgs, followStore := setupNotifierWithMessagesAndFollows(t)
	ctx := context.Background()
	chans.channels["ch1"] = &model.Channel{ID: "ch1", Name: "general", Slug: "general"}
	for _, uid := range []string{"sender", "root-author", "replier-a", "replier-b", "follower"} {
		members.memberships["ch1#"+uid] = &model.ChannelMembership{ChannelID: "ch1", UserID: uid}
	}
	users.users["sender"] = &model.User{ID: "sender", DisplayName: "Sender"}
	root := &model.Message{ID: "root", ParentID: "ch1", AuthorID: "root-author", Body: "root", CreatedAt: rootCreated, ReplyCount: 3}
	msgs.messages["ch1#root"] = root
	msgs.messages["ch1#r-a"] = &model.Message{ID: "r-a", ParentID: "ch1", ParentMessageID: "root", AuthorID: "replier-a", CreatedAt: rootCreated.Add(time.Minute)}
	msgs.messages["ch1#r-b"] = &model.Message{ID: "r-b", ParentID: "ch1", ParentMessageID: "root", AuthorID: "replier-b", CreatedAt: rootCreated.Add(2 * time.Minute)}
	for _, uid := range follows {
		if err := followStore.SetThreadFollow(ctx, &model.ThreadFollow{UserID: uid, ParentID: "ch1", ThreadRootID: "root", Following: true}); err != nil {
			t.Fatalf("SetThreadFollow: %v", err)
		}
	}
	reply := &model.Message{ID: "r-new", ParentID: "ch1", ParentMessageID: "root", AuthorID: "sender", Body: "new reply", CreatedAt: rootCreated.Add(3 * time.Minute)}
	msgs.messages["ch1#r-new"] = reply
	msgs.getMessageCalls.Store(0)
	msgs.threadReplyCalls.Store(0)
	return svc, pub, msgs, root, reply
}

// Regression: every thread reply re-read the WHOLE thread (all reply pages)
// to work out who participates. Every thread's participants have follow rows
// — written at reply time, and backfilled for older and imported threads — so
// a reply is answered from them however old the thread is: no reply read, and
// no root read (it is passed in). The same participants are alerted.
func TestNotifyForMessage_ThreadUsesFollowIndex(t *testing.T) {
	for _, rootCreated := range []time.Time{time.Date(2026, 7, 1, 9, 0, 0, 0, time.UTC), time.Now().Add(-time.Hour)} {
		svc, pub, msgs, root, reply := seedIndexedThread(t, rootCreated, []string{"root-author", "replier-a", "replier-b", "follower", "sender"})

		svc.NotifyForMessage(context.Background(), reply, ParentChannel, root)

		if n := msgs.threadReplyCalls.Load(); n != 0 {
			t.Fatalf("root from %s: ListThreadReplies calls = %d, want 0", rootCreated, n)
		}
		if n := msgs.getMessageCalls.Load(); n != 0 {
			t.Fatalf("root from %s: GetMessage calls = %d, want 0 (the root is passed in)", rootCreated, n)
		}
		got := alertedUsers(pub)
		for _, uid := range []string{"root-author", "replier-a", "replier-b", "follower"} {
			if !got[uid] {
				t.Errorf("root from %s: participant %q got no thread-reply alert (got %v)", rootCreated, uid, got)
			}
		}
		if got["sender"] {
			t.Error("the reply author alerted themselves")
		}
	}
}

// A root that couldn't be read still has the thread's replies read: nobody
// who replied may silently miss the alert.
func TestResolveThreadRecipients_UnreadableRootReadsReplies(t *testing.T) {
	svc, _, msgs, _, reply := seedIndexedThread(t, time.Now().Add(-time.Hour), []string{"follower"})

	got, _ := svc.resolveThreadRecipients(context.Background(), reply,
		memberSnapshot{memberIDs: []string{"sender", "root-author", "replier-a", "replier-b", "follower"}}, nil)

	if n := msgs.threadReplyCalls.Load(); n != 1 {
		t.Fatalf("ListThreadReplies calls = %d, want 1", n)
	}
	want := map[string]bool{"replier-a": true, "replier-b": true, "follower": true}
	if len(got) != len(want) {
		t.Fatalf("recipients = %v, want %v", got, want)
	}
	for _, uid := range got {
		if !want[uid] {
			t.Fatalf("recipients = %v, want %v", got, want)
		}
	}
}
