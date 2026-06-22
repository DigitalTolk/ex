package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestNotification_MarkChannelNotification_Error(t *testing.T) {
	svc, _, _, _, _, _ := setupNotifier(t)
	st := newMockUserStateStore()
	st.setErr = errors.New("boom")
	svc.SetUserStateService(NewUserStateService(st, nil))
	// Logs the failure; must not panic.
	svc.markChannelNotification(context.Background(), "u1", "ch1")
}

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
	if got := svc.resolveThreadRecipients(context.Background(), &model.Message{ParentMessageID: "root"}, ParentChannel, memberSnapshot{}); got != nil {
		t.Fatalf("expected nil with nil messages, got %v", got)
	}
	// messages present but no ParentMessageID → nil.
	svc2, _, _, _, _, _ := setupNotifier(t)
	if got := svc2.resolveThreadRecipients(context.Background(), &model.Message{}, ParentChannel, memberSnapshot{}); got != nil {
		t.Fatalf("expected nil with empty ParentMessageID, got %v", got)
	}
}

func TestNotification_ResolveThreadRecipients_ListMessagesError(t *testing.T) {
	svc, _, _, _, _, msgs := setupNotifierWithMessages(t)
	msgs.listErr = errors.New("boom")
	got := svc.resolveThreadRecipients(context.Background(), &model.Message{ParentID: "ch1", ParentMessageID: "root1"}, ParentChannel, memberSnapshot{})
	if got != nil {
		t.Fatalf("expected nil on ListMessages error, got %v", got)
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
	// MutedUserIDs errors → fall back to "no one muted" while still listing the
	// member as a recipient (a missed mute over-notifies, never drops a member).
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
