package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestNotification_MarkThreadNotification_Error(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
	st := newMockUserStateStore()
	st.setErr = errors.New("boom")
	svc.SetUserStateService(NewUserStateService(st, nil))
	msg := &model.Message{ID: "m1", ParentID: "ch1", ParentMessageID: "root1"}
	svc.markThreadNotification(context.Background(), "u1", msg, ParentChannel)
}

func TestNotification_LoadMemberSnapshot_UnknownParentType(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
	snap := svc.loadMemberSnapshot(context.Background(), &model.Message{ParentID: "p1"}, "bogus", "name")
	if len(snap.memberIDs) != 0 {
		t.Fatalf("expected empty snapshot for unknown parent type, got %+v", snap)
	}
}

func TestNotification_ResolveThreadRecipients_NilMessagesAndNoParentMsg(t *testing.T) {
	// messages nil → nil.
	svc := &NotificationService{}
	if got, _ := svc.resolveThreadRecipients(context.Background(), &model.Message{ParentMessageID: "root"}, memberSnapshot{}, nil); got != nil {
		t.Fatalf("expected nil with nil messages, got %v", got)
	}
	// messages present but no ParentMessageID → nil.
	svc2, _, _, _, _, _ := setupNotifier(t)
	if got, _ := svc2.resolveThreadRecipients(context.Background(), &model.Message{}, memberSnapshot{}, nil); got != nil {
		t.Fatalf("expected nil with empty ParentMessageID, got %v", got)
	}
}

// A failed reply read loses only the repliers it would have found: the root
// author and the followers are still alerted — never nobody. (It used to
// return no recipients at all.)
func TestNotification_ResolveThreadRecipients_ListThreadRepliesError(t *testing.T) {
	svc, _, _, _, _, _, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	msgs.threadReplyErr = errors.New("boom")
	if got, _ := svc.resolveThreadRecipients(context.Background(), &model.Message{ParentID: "ch1", ParentMessageID: "root1"}, memberSnapshot{}, nil); len(got) != 0 {
		t.Fatalf("expected no recipients with an empty audience, got %v", got)
	}
	if err := follows.SetThreadFollow(context.Background(), &model.ThreadFollow{UserID: "follower", ParentID: "ch1", ThreadRootID: "root1", Following: true}); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}
	root := &model.Message{ID: "root1", ParentID: "ch1", AuthorID: "root-author"}
	got, _ := svc.resolveThreadRecipients(context.Background(),
		&model.Message{ParentID: "ch1", ParentMessageID: "root1", AuthorID: "sender"},
		memberSnapshot{memberIDs: []string{"root-author", "follower"}}, root)
	if len(got) != 2 || got[0] != "root-author" || got[1] != "follower" {
		t.Fatalf("recipients on a failed reply read = %v, want [root-author follower]", got)
	}
}

// A follow index that can't be read never narrows the audience: the thread's
// replies are read instead, even for an indexed thread.
func TestNotification_ResolveThreadRecipients_FollowIndexErrorReadsReplies(t *testing.T) {
	svc, _, _, _, _, _, msgs, follows := setupNotifierWithMessagesAndFollows(t)
	follows.listErr = errors.New("follow index down")
	root := &model.Message{ID: "root1", ParentID: "ch1", AuthorID: "root-author", CreatedAt: threadIndexEpoch.Add(time.Hour)}
	msgs.messages["ch1#r1"] = &model.Message{ID: "r1", ParentID: "ch1", ParentMessageID: "root1", AuthorID: "replier"}
	got, _ := svc.resolveThreadRecipients(context.Background(),
		&model.Message{ID: "r2", ParentID: "ch1", ParentMessageID: "root1", AuthorID: "sender"},
		memberSnapshot{memberIDs: []string{"root-author", "replier"}}, root)
	if len(got) != 2 || got[0] != "root-author" || got[1] != "replier" {
		t.Fatalf("recipients = %v, want [root-author replier] from the reply read", got)
	}
}

func TestNotification_ParentDisplayName_NilChannelStore(t *testing.T) {
	svc := &NotificationService{}
	if got := svc.parentDisplayName(context.Background(), "p1", ParentChannel); got != "p1" {
		t.Fatalf("expected fallback to parentID, got %q", got)
	}
}

func TestNotification_UserDisplayName_NilUserStore(t *testing.T) {
	svc := &NotificationService{}
	if got := svc.userDisplayName(context.Background(), "u1"); got != "u1" {
		t.Fatalf("expected fallback to userID, got %q", got)
	}
}

func TestNotification_LoadMemberSnapshot_MutedBatchError(t *testing.T) {
	svc, _, members, _, _, _ := setupNotifier(t)
	members.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}
	members.listChannelsErr = errors.New("boom")
	// UserChannelNotifPrefs errors → fall back to "no overrides / no one muted"
	// while still listing the member as a recipient (a missed mute over-
	// notifies, never drops a member).
	snap := svc.loadMemberSnapshot(context.Background(), &model.Message{ParentID: "ch1", AuthorID: "author"}, ParentChannel, "general")
	if len(snap.muted) != 0 {
		t.Fatalf("expected empty muted on batch error, got %v", snap.muted)
	}
	if len(snap.memberIDs) != 1 || snap.memberIDs[0] != "u1" {
		t.Fatalf("expected u1 still a recipient, got %v", snap.memberIDs)
	}
}

func TestNotification_MarkThreadNotification_NoUserState(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
	// userState nil → early return (no-op, covers the guard).
	svc.markThreadNotification(context.Background(), "u1", &model.Message{ParentMessageID: "root1"}, ParentChannel)
	// msg with empty ParentMessageID → early return.
	svc.markThreadNotification(context.Background(), "u1", &model.Message{}, ParentChannel)
}

// A group conversation's title name: no store or an unknown parent type gives
// no name; the name cache serves a hit and is filled on a miss.
func TestNotification_ParentDisplayName_ConversationNames(t *testing.T) {
	ctx := context.Background()
	if got := (&NotificationService{}).parentDisplayName(ctx, "c1", ParentConversation); got != "" {
		t.Fatalf("no conversation store: got %q, want empty", got)
	}
	if got := (&NotificationService{}).parentDisplayName(ctx, "x1", "thread"); got != "" {
		t.Fatalf("unknown parent type: got %q, want empty", got)
	}

	svc, _, _, conv, _, _ := setupNotifier(t)
	nc := &stubNameCache{hits: map[string]string{"conv:c-cached": "Cached crew"}, sets: map[string]string{}}
	svc.SetNameCache(nc)
	conv.conversations["c-group"] = &model.Conversation{ID: "c-group", Type: model.ConversationTypeGroup, Name: "Release crew"}

	if got := svc.parentDisplayName(ctx, "c-cached", ParentConversation); got != "Cached crew" {
		t.Fatalf("cached conversation name = %q, want Cached crew", got)
	}
	if got := svc.parentDisplayName(ctx, "c-group", ParentConversation); got != "Release crew" {
		t.Fatalf("conversation name = %q, want Release crew", got)
	}
	if nc.sets["conv:c-group"] != "Release crew" {
		t.Fatalf("conversation name not cached after a miss: %v", nc.sets)
	}
}
