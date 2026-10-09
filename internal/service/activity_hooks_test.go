package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// activityHooks implements every activity hook the other services call
// (ChannelActivityRecorder, MessageActivityRecorder, ActivityReadTracker) and
// records the calls. The hooks are called synchronously; the real service
// detaches the slow ones itself.
type activityHooks struct {
	reactions []string // emoji per RecordReaction
	added     []channelAdd
	left      []parentLeft
	reads     []parentRead
	deleted   [][]string
	edited    []*model.Message
	calls     int // ParentLeft calls (each may carry several users)
}

type channelAdd struct {
	actorID, userID string
	ch              *model.Channel
}

type parentLeft struct{ userID, parentID string }

type parentRead struct {
	userID, parentID, threadRootID string
	position                       time.Time
}

func (r *activityHooks) RecordReaction(_ context.Context, _ *model.Message, _, _, emoji string) {
	r.reactions = append(r.reactions, emoji)
}

func (r *activityHooks) RecordChannelAdded(_ context.Context, actorID, userID string, ch *model.Channel) {
	r.added = append(r.added, channelAdd{actorID, userID, ch})
}

func (r *activityHooks) ParentLeft(_ context.Context, userIDs []string, parentID string) {
	r.calls++
	for _, userID := range userIDs {
		r.left = append(r.left, parentLeft{userID, parentID})
	}
}

func (r *activityHooks) MarkParentRead(_ context.Context, userID, parentID, threadRootID string, position time.Time) {
	r.reads = append(r.reads, parentRead{userID, parentID, threadRootID, position})
}

func (r *activityHooks) MessagesDeleted(_ context.Context, _, _ string, messageIDs []string) {
	r.deleted = append(r.deleted, messageIDs)
}

func (r *activityHooks) MessageEdited(_ context.Context, msg *model.Message, _ string) {
	r.edited = append(r.edited, msg)
}

// onlyRead asserts exactly one parent read was recorded and returns it.
func (r *activityHooks) onlyRead(t *testing.T) parentRead {
	t.Helper()
	if len(r.reads) != 1 {
		t.Fatalf("parent reads = %+v, want exactly one", r.reads)
	}
	return r.reads[0]
}

func recentlyNow(t *testing.T, at time.Time) {
	t.Helper()
	if d := time.Since(at); d < 0 || d > time.Minute {
		t.Fatalf("position %v is not now", at)
	}
}

// Reading a channel reads its activity items (the badge regression: reading a
// channel left its mention items unread in the Activity tab).
func TestChannelService_MarkChannelRead_ReadsActivity(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	rec := &activityHooks{}
	svc.SetActivityRecorder(rec)
	channels.channels["ch-7"] = &model.Channel{ID: "ch-7", Name: "seven", Type: model.ChannelTypePublic, MessageSeq: 7}

	if err := svc.MarkChannelRead(context.Background(), "user-1", "ch-7"); err != nil {
		t.Fatalf("MarkChannelRead: %v", err)
	}
	got := rec.onlyRead(t)
	if got.userID != "user-1" || got.parentID != "ch-7" || got.threadRootID != "" {
		t.Fatalf("read = %+v", got)
	}
	recentlyNow(t, got.position)
}

// Losing access to a channel, whether the user left or was removed, drops its
// items and cancels their reminders there — the reminders even with no
// activity recorder wired.
func TestChannelService_LeaveAndRemove_DropActivityAndReminders(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	rec, rem := &activityHooks{}, &activityHooks{}
	svc.SetActivityRecorder(rec)
	svc.SetReminderSync(rem)
	ctx := context.Background()
	memberships.memberships["ch9#user-1"] = &model.ChannelMembership{ChannelID: "ch9", UserID: "user-1", Role: model.ChannelRoleMember}
	memberships.memberships["ch9#admin-1"] = &model.ChannelMembership{ChannelID: "ch9", UserID: "admin-1", Role: model.ChannelRoleAdmin}
	memberships.memberships["ch9#target"] = &model.ChannelMembership{ChannelID: "ch9", UserID: "target", Role: model.ChannelRoleMember}

	if err := svc.Leave(ctx, "user-1", "ch9"); err != nil {
		t.Fatalf("Leave: %v", err)
	}
	if err := svc.RemoveMember(ctx, "admin-1", "ch9", "target"); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}
	want := []parentLeft{{"user-1", "ch9"}, {"target", "ch9"}}
	for name, got := range map[string][]parentLeft{"activity": rec.left, "reminders": rem.left} {
		if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
			t.Fatalf("%s left = %+v, want %+v", name, got, want)
		}
	}

	remindersOnly, _, memberships2, _, _ := setupChannelService()
	rem2 := &activityHooks{}
	remindersOnly.SetReminderSync(rem2)
	memberships2.memberships["ch9#user-1"] = &model.ChannelMembership{ChannelID: "ch9", UserID: "user-1", Role: model.ChannelRoleMember}
	if err := remindersOnly.Leave(ctx, "user-1", "ch9"); err != nil {
		t.Fatalf("Leave: %v", err)
	}
	if len(rem2.left) != 1 || rem2.left[0] != want[0] {
		t.Fatalf("reminders left = %+v without an activity recorder", rem2.left)
	}
}

func TestChannelService_AddMember_RecordsActivity(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	rec := &activityHooks{}
	svc.SetActivityRecorder(rec)
	ctx := context.Background()

	channels.channels["ch12"] = &model.Channel{ID: "ch12", Name: "design-review", Type: model.ChannelTypePublic}
	memberships.memberships["ch12#admin-1"] = &model.ChannelMembership{ChannelID: "ch12", UserID: "admin-1", Role: model.ChannelRoleAdmin}

	if err := svc.AddMember(ctx, "admin-1", "ch12", "user-new", model.ChannelRoleMember); err != nil {
		t.Fatalf("AddMember: %v", err)
	}
	if len(rec.added) != 1 || rec.added[0].actorID != "admin-1" || rec.added[0].userID != "user-new" || rec.added[0].ch.ID != "ch12" {
		t.Fatalf("recorded %+v", rec.added)
	}
}

// A bot or agent added to a channel gets no activity item: nobody reads it.
func TestChannelService_AddMember_SkipsMachineActivity(t *testing.T) {
	svc, channels, memberships, users, _, _ := setupChannelServiceWithUsers()
	rec := &activityHooks{}
	svc.SetActivityRecorder(rec)
	ctx := context.Background()

	channels.channels["ch12"] = &model.Channel{ID: "ch12", Name: "design-review", Type: model.ChannelTypePublic}
	memberships.memberships["ch12#admin-1"] = &model.ChannelMembership{ChannelID: "ch12", UserID: "admin-1", Role: model.ChannelRoleAdmin}
	users.users["agent-1"] = &model.User{ID: "agent-1", DisplayName: "gg", Kind: model.UserKindAgent}
	users.users["bot-1"] = &model.User{ID: "bot-1", DisplayName: "alerts", IsBot: true}
	users.users["human-1"] = &model.User{ID: "human-1", DisplayName: "Ann"}

	for _, id := range []string{"agent-1", "bot-1", "human-1"} {
		if err := svc.AddMember(ctx, "admin-1", "ch12", id, model.ChannelRoleMember); err != nil {
			t.Fatalf("AddMember %s: %v", id, err)
		}
	}
	if len(rec.added) != 1 || rec.added[0].userID != "human-1" {
		t.Fatalf("recorded %+v, want only the human", rec.added)
	}
}

func TestConversationService_MarkConversationRead_ReadsActivity(t *testing.T) {
	svc, convStore, _, _, _ := setupConversationService()
	rec := &activityHooks{}
	svc.SetActivityTracker(rec)
	convStore.conversations["dm-1"] = &model.Conversation{ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}, MessageSeq: 3}
	convStore.userConvs["u-1"] = []*model.UserConversation{{UserID: "u-1", ConversationID: "dm-1"}}

	ctx := context.Background()
	// A failed last-read write reads nothing.
	if err := svc.MarkConversationRead(ctx, "u-2", "dm-1"); err == nil {
		t.Fatal("expected a missing user row to fail")
	}
	if err := svc.MarkConversationRead(ctx, "u-1", "dm-1"); err != nil {
		t.Fatalf("MarkConversationRead: %v", err)
	}
	got := rec.onlyRead(t)
	if got.userID != "u-1" || got.parentID != "dm-1" || got.threadRootID != "" {
		t.Fatalf("read = %+v", got)
	}
	recentlyNow(t, got.position)
}

func TestUserStateService_MarkThreadSeen_ReadsActivity(t *testing.T) {
	svc := NewUserStateService(newMockUserStateStore(), nil)
	rec := &activityHooks{}
	svc.SetActivityTracker(rec)

	if err := svc.MarkThreadSeen(context.Background(), "u-1", "ch-1", ParentChannel, "root-1"); err != nil {
		t.Fatalf("MarkThreadSeen: %v", err)
	}
	got := rec.onlyRead(t)
	if got.userID != "u-1" || got.parentID != "ch-1" || got.threadRootID != "root-1" {
		t.Fatalf("read = %+v", got)
	}
	recentlyNow(t, got.position)
}

// A failed seen write must not read the thread's activity items.
func TestUserStateService_MarkThreadSeen_StoreErrorSkipsActivity(t *testing.T) {
	st := newMockUserStateStore()
	st.setErr = errors.New("boom")
	svc := NewUserStateService(st, nil)
	rec := &activityHooks{}
	svc.SetActivityTracker(rec)

	if err := svc.MarkThreadSeen(context.Background(), "u-1", "ch-1", ParentChannel, "root-1"); err == nil {
		t.Fatal("expected store error")
	}
	if len(rec.reads) != 0 {
		t.Fatalf("reads = %+v, want none", rec.reads)
	}
}

// Marking a message unread makes its activity item unread again: the parent's
// read position rewinds to the instant before the message.
func TestMessageService_MarkUnread_RewindsActivity(t *testing.T) {
	f := newUnreadFixture(t)
	rec := &activityHooks{}
	f.svc.SetActivityRecorder(rec)
	msg := f.add("ch-1", 1, nil)

	if _, err := f.svc.MarkUnread(context.Background(), "u-1", "ch-1", ParentChannel, msg.ID); err != nil {
		t.Fatalf("MarkUnread: %v", err)
	}
	got := rec.onlyRead(t)
	if got.parentID != "ch-1" || got.threadRootID != "" || !got.position.Equal(msg.CreatedAt.Add(-time.Millisecond)) {
		t.Fatalf("read = %+v, want ch-1 rewound to just before %v", got, msg.CreatedAt)
	}
}

func TestMessageService_MarkThreadUnread_RewindsActivity(t *testing.T) {
	f := newUnreadFixture(t)
	rec := &activityHooks{}
	f.svc.SetActivityRecorder(rec)
	root := f.add("ch-1", 1, nil)
	reply := f.add("ch-1", 2, func(m *model.Message) { m.ParentMessageID = root.ID })

	if _, err := f.svc.MarkUnread(context.Background(), "u-1", "ch-1", ParentChannel, reply.ID); err != nil {
		t.Fatalf("MarkUnread: %v", err)
	}
	got := rec.onlyRead(t)
	if got.parentID != "ch-1" || got.threadRootID != root.ID || !got.position.Equal(reply.CreatedAt.Add(-time.Millisecond)) {
		t.Fatalf("read = %+v, want the thread rewound to just before %v", got, reply.CreatedAt)
	}
}

// Deleting a thread root takes the items and pending reminders about the root
// AND every cascaded reply with it, in one hand-off each with the same ids.
func TestMessageService_Delete_DropsActivityAndReminders(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	rec, rem := &activityHooks{}, &activityHooks{}
	svc.SetActivityRecorder(rec)
	svc.SetReminderSync(rem)
	ctx := context.Background()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}
	messages.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "user-1", Body: "root", ReplyCount: 2}
	messages.messages["ch1#r1"] = &model.Message{ID: "r1", ParentID: "ch1", AuthorID: "user-2", ParentMessageID: "root", Body: "a"}
	messages.messages["ch1#r2"] = &model.Message{ID: "r2", ParentID: "ch1", AuthorID: "user-3", ParentMessageID: "root", Body: "b"}
	messages.messages["ch1#solo"] = &model.Message{ID: "solo", ParentID: "ch1", AuthorID: "user-1", ParentMessageID: "root2", Body: "c"}

	if err := svc.Delete(ctx, "user-1", "ch1", ParentChannel, "root"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if len(rec.deleted) != 1 || len(rec.deleted[0]) != 3 || rec.deleted[0][0] != "root" {
		t.Fatalf("deleted = %v, want root + both replies", rec.deleted)
	}
	got := map[string]bool{}
	for _, id := range rec.deleted[0] {
		got[id] = true
	}
	if !got["r1"] || !got["r2"] {
		t.Fatalf("deleted = %v, want r1 and r2", rec.deleted[0])
	}

	// A reply deletes alone.
	if err := svc.Delete(ctx, "user-1", "ch1", ParentChannel, "solo"); err != nil {
		t.Fatalf("Delete reply: %v", err)
	}
	if len(rec.deleted) != 2 || len(rec.deleted[1]) != 1 || rec.deleted[1][0] != "solo" {
		t.Fatalf("deleted = %v", rec.deleted)
	}
	if fmt.Sprint(rem.deleted) != fmt.Sprint(rec.deleted) {
		t.Fatalf("reminders deleted = %v, want %v", rem.deleted, rec.deleted)
	}
}

// A reply whose tombstone write fails stays out of the cleanup: its message
// still exists, so its items do too.
func TestMessageService_Delete_FailedCascadeKeepsActivity(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	rec := &activityHooks{}
	svc.SetActivityRecorder(rec)
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}
	messages.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "user-1", Body: "root", ReplyCount: 1}
	messages.messages["ch1#r1"] = &model.Message{ID: "r1", ParentID: "ch1", AuthorID: "user-2", ParentMessageID: "root", Body: "a"}
	messages.updateErrID = "r1"

	if err := svc.Delete(context.Background(), "user-1", "ch1", ParentChannel, "root"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if len(rec.deleted) != 1 || len(rec.deleted[0]) != 1 || rec.deleted[0][0] != "root" {
		t.Fatalf("deleted = %v, want only the root", rec.deleted)
	}
}

// Editing a message's text refreshes its items' and reminders' previews; an
// edit that only touches attachments leaves them alone.
func TestMessageService_Edit_RefreshesActivityAndReminders(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	rec, rem := &activityHooks{}, &activityHooks{}
	svc.SetActivityRecorder(rec)
	svc.SetReminderSync(rem)
	ctx := context.Background()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}
	messages.messages["ch1#msg-1"] = &model.Message{ID: "msg-1", ParentID: "ch1", AuthorID: "user-1", Body: "original"}

	if _, err := svc.Edit(ctx, "user-1", "ch1", ParentChannel, "msg-1", "updated", nil); err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if len(rec.edited) != 1 || rec.edited[0].Body != "updated" {
		t.Fatalf("edited = %+v", rec.edited)
	}
	if _, err := svc.Edit(ctx, "user-1", "ch1", ParentChannel, "msg-1", "updated", nil); err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if len(rec.edited) != 1 || len(rem.edited) != 1 || rem.edited[0].Body != "updated" {
		t.Fatalf("an edit re-previews items and reminders once; got %d / %d", len(rec.edited), len(rem.edited))
	}
}

func TestMessageService_ParentMemberIDs(t *testing.T) {
	svc, _, memberships, conversations, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-1"}
	memberships.memberships["ch1#u-2"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-2"}
	conversations.conversations["dm-1"] = &model.Conversation{ID: "dm-1", ParticipantIDs: []string{"u-1", "u-3"}}

	ids, err := svc.ParentMemberIDs(ctx, "ch1", ParentChannel)
	if err != nil || len(ids) != 2 {
		t.Fatalf("channel members = %v, %v", ids, err)
	}
	ids, err = svc.ParentMemberIDs(ctx, "dm-1", ParentConversation)
	if err != nil || len(ids) != 2 || ids[1] != "u-3" {
		t.Fatalf("participants = %v, %v", ids, err)
	}
	if _, err := svc.ParentMemberIDs(ctx, "missing", ParentConversation); err == nil {
		t.Fatal("expected a missing conversation to fail")
	}
	memberships.listMembersErr = errors.New("boom")
	if _, err := svc.ParentMemberIDs(ctx, "ch1", ParentChannel); err == nil {
		t.Fatal("expected a member-list failure to fail")
	}
}
