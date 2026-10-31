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
// to work out who participates, and re-read the root NotifyForMessage was
// handed — O(replies) per reply, O(replies²) per thread. A thread rooted after
// the write-time participation index existed is served from its follow rows
// (every replier wrote one) with the root passed in: no reply read, no root
// read — and the same participants are alerted.
func TestNotifyForMessage_IndexedThreadUsesFollowIndex(t *testing.T) {
	rootCreated := threadIndexEpoch.Add(24 * time.Hour)
	svc, pub, msgs, root, reply := seedIndexedThread(t, rootCreated, []string{"root-author", "replier-a", "replier-b", "follower", "sender"})

	svc.NotifyForMessage(context.Background(), reply, ParentChannel, root)

	if n := msgs.threadReplyCalls.Load(); n != 0 {
		t.Fatalf("ListThreadReplies calls = %d, want 0 for an indexed thread", n)
	}
	if n := msgs.getMessageCalls.Load(); n != 0 {
		t.Fatalf("GetMessage calls = %d, want 0 (the root is passed in)", n)
	}
	got := alertedUsers(pub)
	for _, uid := range []string{"root-author", "replier-a", "replier-b", "follower"} {
		if !got[uid] {
			t.Errorf("participant %q got no thread-reply alert (got %v)", uid, got)
		}
	}
	if got["sender"] {
		t.Error("the reply author alerted themselves")
	}
}

// A thread rooted before the index existed may have repliers with no follow
// row, so it keeps the full read: replier-b (no row) is still alerted.
func TestNotifyForMessage_LegacyThreadKeepsFullRead(t *testing.T) {
	rootCreated := threadIndexEpoch.Add(-24 * time.Hour)
	svc, pub, msgs, root, reply := seedIndexedThread(t, rootCreated, []string{"follower"})

	svc.NotifyForMessage(context.Background(), reply, ParentChannel, root)

	if n := msgs.threadReplyCalls.Load(); n != 1 {
		t.Fatalf("ListThreadReplies calls = %d, want 1 for a legacy thread", n)
	}
	got := alertedUsers(pub)
	for _, uid := range []string{"root-author", "replier-a", "replier-b", "follower"} {
		if !got[uid] {
			t.Errorf("participant %q got no thread-reply alert (got %v)", uid, got)
		}
	}
}

// A thread rooted before the index existed whose participants were backfilled
// (the thread-participants migration, or the importer, flags the root) is
// served from its follow rows like any newer thread: a reply in an imported
// thread no longer re-reads the whole thread.
func TestNotifyForMessage_BackfilledLegacyThreadUsesFollowIndex(t *testing.T) {
	rootCreated := threadIndexEpoch.Add(-24 * time.Hour)
	svc, pub, msgs, root, reply := seedIndexedThread(t, rootCreated, []string{"root-author", "replier-a", "replier-b", "follower", "sender"})
	root.ParticipantsIndexed = true

	svc.NotifyForMessage(context.Background(), reply, ParentChannel, root)

	if n := msgs.threadReplyCalls.Load(); n != 0 {
		t.Fatalf("ListThreadReplies calls = %d, want 0 for a backfilled thread", n)
	}
	got := alertedUsers(pub)
	for _, uid := range []string{"root-author", "replier-a", "replier-b", "follower"} {
		if !got[uid] {
			t.Errorf("participant %q got no thread-reply alert (got %v)", uid, got)
		}
	}
}

// The migration backfills exactly the threads the reply path treats as legacy.
func TestThreadIndexEpoch(t *testing.T) {
	if !ThreadIndexEpoch().Equal(threadIndexEpoch) {
		t.Fatalf("ThreadIndexEpoch() = %v, want %v", ThreadIndexEpoch(), threadIndexEpoch)
	}
}
