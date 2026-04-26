package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func setupMessageService() (*MessageService, *mockMessageStore, *mockMembershipStore, *mockConversationStore, *mockPublisher) {
	messages := newMockMessageStore()
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	publisher := newMockPublisher()
	broker := newMockBroker()
	svc := NewMessageService(messages, memberships, conversations, publisher, broker)
	return svc, messages, memberships, conversations, publisher
}

func TestMessageService_Send_Channel(t *testing.T) {
	svc, messages, memberships, _, publisher := setupMessageService()
	ctx := context.Background()

	// User is a channel member.
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	msg, err := svc.Send(ctx, "user-1", "ch1", ParentChannel, "hello world", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if msg.Body != "hello world" {
		t.Errorf("Body = %q, want %q", msg.Body, "hello world")
	}
	if msg.AuthorID != "user-1" {
		t.Errorf("AuthorID = %q, want %q", msg.AuthorID, "user-1")
	}
	if msg.ParentID != "ch1" {
		t.Errorf("ParentID = %q, want %q", msg.ParentID, "ch1")
	}
	if msg.ID == "" {
		t.Error("expected non-empty message ID")
	}
	if msg.EditedAt != nil {
		t.Error("new message should have nil EditedAt")
	}

	// Message should be stored.
	if len(messages.messages) != 1 {
		t.Errorf("expected 1 stored message, got %d", len(messages.messages))
	}

	// Event should be published.
	if len(publisher.published) != 1 {
		t.Errorf("expected 1 published event, got %d", len(publisher.published))
	}
}

func TestMessageService_Send_Conversation(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	ctx := context.Background()

	conversations.conversations["conv-1"] = &model.Conversation{
		ID:             "conv-1",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"user-1", "user-2"},
	}

	msg, err := svc.Send(ctx, "user-1", "conv-1", ParentConversation, "hi from DM", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if msg.Body != "hi from DM" {
		t.Errorf("Body = %q, want %q", msg.Body, "hi from DM")
	}
}

func TestMessageService_Send_NotMember(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	ctx := context.Background()

	// User is not a member of channel ch-no.
	_, err := svc.Send(ctx, "stranger", "ch-no", ParentChannel, "hello", "")
	if err == nil {
		t.Fatal("expected error for non-member")
	}
}

func TestMessageService_Send_NotParticipant(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	ctx := context.Background()

	conversations.conversations["conv-2"] = &model.Conversation{
		ID:             "conv-2",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"user-1", "user-2"},
	}

	_, err := svc.Send(ctx, "stranger", "conv-2", ParentConversation, "hello", "")
	if err == nil {
		t.Fatal("expected error for non-participant")
	}
}

func TestMessageService_Send_UnknownParentType(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	ctx := context.Background()

	_, err := svc.Send(ctx, "user-1", "x", "invalid", "hello", "")
	if err == nil {
		t.Fatal("expected error for unknown parent type")
	}
}

func TestMessageService_List(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	messages.messages["ch1#msg-1"] = &model.Message{
		ID:       "msg-1",
		ParentID: "ch1",
		AuthorID: "user-1",
		Body:     "first",
	}

	msgs, hasMore, err := svc.List(ctx, "user-1", "ch1", ParentChannel, "", 50)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(msgs) != 1 {
		t.Errorf("len(msgs) = %d, want 1", len(msgs))
	}
	if hasMore {
		t.Error("expected hasMore = false")
	}
}

func TestMessageService_Edit(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	messages.messages["ch1#msg-1"] = &model.Message{
		ID:       "msg-1",
		ParentID: "ch1",
		AuthorID: "user-1",
		Body:     "original",
	}

	edited, err := svc.Edit(ctx, "user-1", "ch1", ParentChannel, "msg-1", "updated", nil)
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if edited.Body != "updated" {
		t.Errorf("Body = %q, want %q", edited.Body, "updated")
	}
	if edited.EditedAt == nil || edited.EditedAt.IsZero() {
		t.Error("expected EditedAt to be set")
	}
}

type fakeAttachmentRefMgr struct {
	added   []string
	removed []string
}

func (f *fakeAttachmentRefMgr) AddRef(_ context.Context, attachmentID, _ string) error {
	f.added = append(f.added, attachmentID)
	return nil
}

func (f *fakeAttachmentRefMgr) RemoveRef(_ context.Context, attachmentID, _ string) error {
	f.removed = append(f.removed, attachmentID)
	return nil
}

func TestMessageService_Edit_AttachmentDiff(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	refs := &fakeAttachmentRefMgr{}
	svc.SetAttachmentManager(refs)

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	messages.messages["ch1#msg-1"] = &model.Message{
		ID:            "msg-1",
		ParentID:      "ch1",
		AuthorID:      "user-1",
		Body:          "hello",
		AttachmentIDs: []string{"a", "b"},
	}

	// Replace attachments: drop "a", keep "b", add "c".
	edited, err := svc.Edit(ctx, "user-1", "ch1", ParentChannel, "msg-1", "hello edited", []string{"b", "c"})
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if got, want := len(edited.AttachmentIDs), 2; got != want {
		t.Errorf("AttachmentIDs len=%d want %d (%v)", got, want, edited.AttachmentIDs)
	}
	if edited.AttachmentIDs[0] != "b" || edited.AttachmentIDs[1] != "c" {
		t.Errorf("AttachmentIDs=%v want [b c]", edited.AttachmentIDs)
	}
	if len(refs.added) != 1 || refs.added[0] != "c" {
		t.Errorf("added=%v want [c]", refs.added)
	}
	if len(refs.removed) != 1 || refs.removed[0] != "a" {
		t.Errorf("removed=%v want [a]", refs.removed)
	}
}

func TestMessageService_Edit_NilAttachmentsPreserves(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	refs := &fakeAttachmentRefMgr{}
	svc.SetAttachmentManager(refs)

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	messages.messages["ch1#msg-1"] = &model.Message{
		ID:            "msg-1",
		ParentID:      "ch1",
		AuthorID:      "user-1",
		Body:          "hi",
		AttachmentIDs: []string{"a"},
	}

	edited, err := svc.Edit(ctx, "user-1", "ch1", ParentChannel, "msg-1", "hi edited", nil)
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if len(edited.AttachmentIDs) != 1 || edited.AttachmentIDs[0] != "a" {
		t.Errorf("AttachmentIDs=%v want [a]", edited.AttachmentIDs)
	}
	if len(refs.added) != 0 || len(refs.removed) != 0 {
		t.Errorf("ref ops should be empty: added=%v removed=%v", refs.added, refs.removed)
	}
}

func TestMessageService_Edit_RejectsEmptyBodyAndNoAttachments(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	messages.messages["ch1#msg-1"] = &model.Message{
		ID:            "msg-1",
		ParentID:      "ch1",
		AuthorID:      "user-1",
		Body:          "old",
		AttachmentIDs: []string{"a"},
	}

	if _, err := svc.Edit(ctx, "user-1", "ch1", ParentChannel, "msg-1", "", []string{}); err == nil {
		t.Error("expected error when body and attachmentIDs are both empty")
	}
}

func TestMessageService_Edit_NotAuthor(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	memberships.memberships["ch1#user-2"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-2",
		Role:      model.ChannelRoleMember,
	}

	messages.messages["ch1#msg-1"] = &model.Message{
		ID:       "msg-1",
		ParentID: "ch1",
		AuthorID: "user-1",
		Body:     "original",
	}

	_, err := svc.Edit(ctx, "user-2", "ch1", ParentChannel, "msg-1", "hijacked", nil)
	if err == nil {
		t.Fatal("expected error for non-author editing")
	}
}

func TestMessageService_Delete_ByAuthor(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	messages.messages["ch1#msg-del"] = &model.Message{
		ID:       "msg-del",
		ParentID: "ch1",
		AuthorID: "user-1",
		Body:     "to delete",
	}

	err := svc.Delete(ctx, "user-1", "ch1", ParentChannel, "msg-del")
	if err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if _, ok := messages.messages["ch1#msg-del"]; ok {
		t.Error("message should have been deleted")
	}
}

func TestMessageService_Delete_ByChannelAdmin(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#admin-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "admin-1",
		Role:      model.ChannelRoleAdmin,
	}

	messages.messages["ch1#msg-del2"] = &model.Message{
		ID:       "msg-del2",
		ParentID: "ch1",
		AuthorID: "user-1", // different author
		Body:     "admin deletes",
	}

	err := svc.Delete(ctx, "admin-1", "ch1", ParentChannel, "msg-del2")
	if err != nil {
		t.Fatalf("Delete by admin: %v", err)
	}
}

func TestMessageService_Delete_NotAuthorOrAdmin(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-2"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-2",
		Role:      model.ChannelRoleMember, // not admin
	}

	messages.messages["ch1#msg-del3"] = &model.Message{
		ID:       "msg-del3",
		ParentID: "ch1",
		AuthorID: "user-1",
		Body:     "cannot delete",
	}

	err := svc.Delete(ctx, "user-2", "ch1", ParentChannel, "msg-del3")
	if err == nil {
		t.Fatal("expected error for non-author non-admin delete")
	}
}

func TestMessageService_Delete_ConversationNotAuthor(t *testing.T) {
	svc, messages, _, conversations, _ := setupMessageService()
	ctx := context.Background()

	conversations.conversations["conv-del"] = &model.Conversation{
		ID:             "conv-del",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"user-1", "user-2"},
	}

	messages.messages["conv-del#msg-cd"] = &model.Message{
		ID:       "msg-cd",
		ParentID: "conv-del",
		AuthorID: "user-1",
		Body:     "dm message",
	}

	err := svc.Delete(ctx, "user-2", "conv-del", ParentConversation, "msg-cd")
	if err == nil {
		t.Fatal("expected error: only the author can delete in conversations")
	}
}

func TestMessageService_PublishEvent_NilPublisher(t *testing.T) {
	messages := newMockMessageStore()
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	svc := NewMessageService(messages, memberships, conversations, nil, nil)
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	// Should not panic with nil publisher.
	_, err := svc.Send(ctx, "user-1", "ch1", ParentChannel, "test", "")
	if err != nil {
		t.Fatalf("Send with nil publisher: %v", err)
	}
}

// Sending a reply (parentMessageID set) bumps the root's ReplyCount and
// emits a message.edited event for the root.
func TestSendMessage_WithThread(t *testing.T) {
	svc, messages, memberships, _, publisher := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch-thr#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-thr",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	// Seed the root message.
	root := &model.Message{
		ID:       "root-msg",
		ParentID: "ch-thr",
		AuthorID: "user-1",
		Body:     "root",
	}
	messages.messages["ch-thr#root-msg"] = root

	reply, err := svc.Send(ctx, "user-1", "ch-thr", ParentChannel, "reply!", "root-msg")
	if err != nil {
		t.Fatalf("Send reply: %v", err)
	}
	if reply.ParentMessageID != "root-msg" {
		t.Errorf("ParentMessageID = %q, want %q", reply.ParentMessageID, "root-msg")
	}

	// Root reply count incremented in store.
	stored := messages.messages["ch-thr#root-msg"]
	if stored.ReplyCount != 1 {
		t.Errorf("root ReplyCount = %d, want 1", stored.ReplyCount)
	}

	// We expect both message.new (for the reply) and message.edited (for the root).
	var sawNew, sawEdited bool
	for _, e := range publisher.published {
		if e.event.Type == "message.new" {
			sawNew = true
		}
		if e.event.Type == "message.edited" {
			sawEdited = true
		}
	}
	if !sawNew {
		t.Error("expected message.new event for the reply")
	}
	if !sawEdited {
		t.Error("expected message.edited event for the parent (reply count bump)")
	}
}

// ListThreadMessages returns the root and all its replies in chronological
// order (oldest first). Without sorting, the underlying store returns msgs
// in map iteration order — this is a regression test for that bug.
func TestMessageService_ListThreadMessages(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch-list-thr#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-list-thr",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	// IDs are ULID-shaped: lexicographic order matches creation order.
	messages.messages["ch-list-thr#01-root"] = &model.Message{
		ID: "01-root", ParentID: "ch-list-thr", AuthorID: "user-1", Body: "root",
	}
	messages.messages["ch-list-thr#02-r1"] = &model.Message{
		ID: "02-r1", ParentID: "ch-list-thr", AuthorID: "user-1", Body: "reply 1", ParentMessageID: "01-root",
	}
	messages.messages["ch-list-thr#03-r2"] = &model.Message{
		ID: "03-r2", ParentID: "ch-list-thr", AuthorID: "user-1", Body: "reply 2", ParentMessageID: "01-root",
	}
	messages.messages["ch-list-thr#04-r3"] = &model.Message{
		ID: "04-r3", ParentID: "ch-list-thr", AuthorID: "user-1", Body: "reply 3", ParentMessageID: "01-root",
	}
	messages.messages["ch-list-thr#99-other"] = &model.Message{
		ID: "99-other", ParentID: "ch-list-thr", AuthorID: "user-1", Body: "unrelated",
	}

	thread, err := svc.ListThreadMessages(ctx, "user-1", "ch-list-thr", ParentChannel, "01-root")
	if err != nil {
		t.Fatalf("ListThreadMessages: %v", err)
	}
	if len(thread) != 4 {
		t.Fatalf("len(thread) = %d, want 4 (root + 3 replies)", len(thread))
	}
	wantOrder := []string{"01-root", "02-r1", "03-r2", "04-r3"}
	for i, want := range wantOrder {
		if thread[i].ID != want {
			t.Errorf("thread[%d].ID = %q, want %q (thread should be sorted ascending)", i, thread[i].ID, want)
		}
	}
}

func TestMessageService_ListThreadMessages_Empty(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch-empty#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-empty",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}

	thread, err := svc.ListThreadMessages(ctx, "user-1", "ch-empty", ParentChannel, "missing")
	if err != nil {
		t.Fatalf("ListThreadMessages: %v", err)
	}
	if len(thread) != 0 {
		t.Errorf("len(thread) = %d, want 0", len(thread))
	}
}

func TestMessageService_ListThreadMessages_NotMember(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	ctx := context.Background()
	_, err := svc.ListThreadMessages(ctx, "user-1", "ch1", ParentChannel, "root")
	if err == nil {
		t.Fatal("expected access error for non-member")
	}
}

func TestMessageService_ToggleReaction_Add(t *testing.T) {
	svc, messages, memberships, _, publisher := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m1"] = &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "user-2", Body: "hi",
	}

	msg, err := svc.ToggleReaction(ctx, "user-1", "ch1", ParentChannel, "m1", "👍")
	if err != nil {
		t.Fatalf("ToggleReaction: %v", err)
	}
	if got := msg.Reactions["👍"]; len(got) != 1 || got[0] != "user-1" {
		t.Fatalf("Reactions[👍] = %v, want [user-1]", got)
	}
	// Persisted.
	stored := messages.messages["ch1#m1"]
	if got := stored.Reactions["👍"]; len(got) != 1 || got[0] != "user-1" {
		t.Errorf("stored Reactions not updated: %v", got)
	}
	// Event published.
	if len(publisher.published) != 1 {
		t.Errorf("expected 1 published event, got %d", len(publisher.published))
	}
}

func TestMessageService_ToggleReaction_Remove(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m1"] = &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "user-2", Body: "hi",
		Reactions: map[string][]string{"👍": {"user-1"}},
	}

	msg, err := svc.ToggleReaction(ctx, "user-1", "ch1", ParentChannel, "m1", "👍")
	if err != nil {
		t.Fatalf("ToggleReaction: %v", err)
	}
	if msg.Reactions != nil {
		t.Errorf("Reactions = %v, want nil after toggling off the only reaction", msg.Reactions)
	}
}

func TestMessageService_ToggleReaction_MultipleUsers(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	memberships.memberships["ch1#user-2"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-2", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m1"] = &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "user-3", Body: "hi",
	}

	if _, err := svc.ToggleReaction(ctx, "user-1", "ch1", ParentChannel, "m1", "🎉"); err != nil {
		t.Fatalf("u1 react: %v", err)
	}
	msg, err := svc.ToggleReaction(ctx, "user-2", "ch1", ParentChannel, "m1", "🎉")
	if err != nil {
		t.Fatalf("u2 react: %v", err)
	}
	got := msg.Reactions["🎉"]
	if len(got) != 2 {
		t.Fatalf("Reactions[🎉] len = %d, want 2", len(got))
	}

	// u1 toggles off -> only u2 left.
	msg, err = svc.ToggleReaction(ctx, "user-1", "ch1", ParentChannel, "m1", "🎉")
	if err != nil {
		t.Fatalf("u1 toggle off: %v", err)
	}
	got = msg.Reactions["🎉"]
	if len(got) != 1 || got[0] != "user-2" {
		t.Errorf("after u1 toggle off, Reactions[🎉] = %v, want [user-2]", got)
	}
}

func TestMessageService_ToggleReaction_EmptyEmoji(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "user-1", Body: "hi"}

	if _, err := svc.ToggleReaction(ctx, "user-1", "ch1", ParentChannel, "m1", ""); err == nil {
		t.Fatal("expected error for empty emoji")
	}
}

func TestMessageService_ToggleReaction_NotMember(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	ctx := context.Background()
	_, err := svc.ToggleReaction(ctx, "user-x", "ch1", ParentChannel, "m1", "👍")
	if err == nil {
		t.Fatal("expected access error for non-member")
	}
}

func TestMessageService_ToggleReaction_MessageNotFound(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	if _, err := svc.ToggleReaction(ctx, "user-1", "ch1", ParentChannel, "missing", "👍"); err == nil {
		t.Fatal("expected error for missing message")
	}
}
