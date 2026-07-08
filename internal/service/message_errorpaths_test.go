package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// grantChannelMember makes checkAccess pass for a channel parent.
func grantChannelMember(memberships *mockMembershipStore, channelID, userID string) {
	memberships.memberships[channelID+"#"+userID] = &model.ChannelMembership{
		ChannelID: channelID,
		UserID:    userID,
		Role:      model.ChannelRoleMember,
	}
}

// Attachment access is always anchored to a message. The old un-anchored
// fallback (scan up to 1000 parent messages for a referencing one) was
// unreachable from every caller — the service guard at attachment.go rejects
// an empty messageID before this check runs — and was deleted; an empty
// messageID is now a definitive denial.
func TestCanAccessMessageAttachment_NoMessageID_Denied(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AttachmentIDs: []string{"att-1"}}

	err := svc.CanAccessMessageAttachment(context.Background(), "u1", "ch1", ParentChannel, "", "att-1")
	if !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden for message-less access, got %v", err)
	}
}

func TestCanAccessMessageAttachment_GetMessageError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.getErr = errors.New("boom")

	err := svc.CanAccessMessageAttachment(context.Background(), "u1", "ch1", ParentChannel, "m1", "att-1")
	if err == nil {
		t.Fatal("expected error from GetMessage failure")
	}
}

func TestCanAccessMessageAttachment_MessageMissingAttachment(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AttachmentIDs: []string{"other"}}

	err := svc.CanAccessMessageAttachment(context.Background(), "u1", "ch1", ParentChannel, "m1", "att-1")
	if err == nil {
		t.Fatal("expected not-referenced-by-message error")
	}
}

func TestCanAccessMessageAttachment_AccessDenied(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	// No membership granted → checkAccess fails before any store call.
	err := svc.CanAccessMessageAttachment(context.Background(), "u1", "ch1", ParentChannel, "m1", "att-1")
	if err == nil {
		t.Fatal("expected access-denied error")
	}
}

func TestSend_CreateMessageError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.createErr = errors.New("boom")

	_, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "hi", "")
	if err == nil {
		t.Fatal("expected error from CreateMessage failure")
	}
}

func seedMsg(messages *mockMessageStore, parentID, id, author string) {
	messages.messages[parentID+"#"+id] = &model.Message{ID: id, ParentID: parentID, AuthorID: author, Body: "x"}
}

func TestEdit_GetError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.getErr = errors.New("boom")
	if _, err := svc.Edit(context.Background(), "u1", "ch1", ParentChannel, "m1", "new", nil); err == nil {
		t.Fatal("expected get error")
	}
}

func TestEdit_UpdateError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	seedMsg(messages, "ch1", "m1", "u1")
	messages.updateErr = errors.New("boom")
	if _, err := svc.Edit(context.Background(), "u1", "ch1", ParentChannel, "m1", "new body", nil); err == nil {
		t.Fatal("expected update error")
	}
}

func TestDelete_GetError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.getErr = errors.New("boom")
	if err := svc.Delete(context.Background(), "u1", "ch1", ParentChannel, "m1"); err == nil {
		t.Fatal("expected get error")
	}
}

func TestDelete_UpdateError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	seedMsg(messages, "ch1", "m1", "u1")
	messages.updateErr = errors.New("boom")
	if err := svc.Delete(context.Background(), "u1", "ch1", ParentChannel, "m1"); err == nil {
		t.Fatal("expected soft-delete update error")
	}
}

func TestSetPinned_GetError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.getErr = errors.New("boom")
	if _, err := svc.SetPinned(context.Background(), "u1", "ch1", ParentChannel, "m1", true); err == nil {
		t.Fatal("expected get error")
	}
}

func TestSetPinned_UpdateError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	seedMsg(messages, "ch1", "m1", "u1")
	messages.updateErr = errors.New("boom")
	if _, err := svc.SetPinned(context.Background(), "u1", "ch1", ParentChannel, "m1", true); err == nil {
		t.Fatal("expected update error")
	}
}

func TestSetNoUnfurl_GetError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.getErr = errors.New("boom")
	if _, err := svc.SetNoUnfurl(context.Background(), "u1", "ch1", ParentChannel, "m1", true); err == nil {
		t.Fatal("expected get error")
	}
}

func TestToggleReaction_GetError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.getErr = errors.New("boom")
	if _, err := svc.ToggleReaction(context.Background(), "u1", "ch1", ParentChannel, "m1", "👍"); err == nil {
		t.Fatal("expected get error")
	}
}

func TestToggleReaction_UpdateError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	seedMsg(messages, "ch1", "m1", "u1")
	messages.updateErr = errors.New("boom")
	if _, err := svc.ToggleReaction(context.Background(), "u1", "ch1", ParentChannel, "m1", "👍"); err == nil {
		t.Fatal("expected update error")
	}
}

func setupConvParticipant(svc *MessageService, conversations *mockConversationStore, convID, userID string) {
	conversations.conversations[convID] = &model.Conversation{ID: convID, ParticipantIDs: []string{userID, "other"}}
}

func TestList_ListError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.listErr = errors.New("boom")
	if _, _, err := svc.List(context.Background(), "u1", "ch1", ParentChannel, "", 50); err == nil {
		t.Fatal("expected list error")
	}
}

func TestListAfter_ListError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.listErr = errors.New("boom")
	if _, _, err := svc.ListAfter(context.Background(), "u1", "ch1", ParentChannel, "", 50); err == nil {
		t.Fatal("expected list error")
	}
}

func TestListAround_ListError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	messages.listErr = errors.New("boom")
	if _, _, _, err := svc.ListAround(context.Background(), "u1", "ch1", ParentChannel, "m1", 10, 10); err == nil {
		t.Fatal("expected list error")
	}
}

func TestCheckAccess_ConversationGetError(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	conversations.getErr = errors.New("boom")
	if _, err := svc.Send(context.Background(), "u1", "conv1", ParentConversation, "hi", ""); err == nil {
		t.Fatal("expected conversation get error")
	}
}

func TestCheckAccess_NotConversationParticipant(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	conversations.conversations["conv1"] = &model.Conversation{ID: "conv1", ParticipantIDs: []string{"someone-else"}}
	if _, err := svc.Send(context.Background(), "u1", "conv1", ParentConversation, "hi", ""); err == nil {
		t.Fatal("expected not-a-participant error")
	}
}

func TestSend_ConversationTouchError(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	setupConvParticipant(svc, conversations, "conv1", "u1")
	conversations.touchErr = errors.New("boom")
	// Touch failure is logged, not fatal — Send still succeeds.
	if _, err := svc.Send(context.Background(), "u1", "conv1", ParentConversation, "hi", ""); err != nil {
		t.Fatalf("Send should tolerate touch failure, got %v", err)
	}
}

type mockActivator struct {
	err    error
	called bool
}

func (m *mockActivator) Activate(_ context.Context, _ string) error {
	m.called = true
	return m.err
}

func TestSend_ConversationActivatesAndBumpsSeq(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	conversations.conversations["c1"] = &model.Conversation{ID: "c1", ParticipantIDs: []string{"u1", "u2"}}
	act := &mockActivator{}
	seqStore := &mockUnreadSeqStore{}
	svc.SetActivator(act)
	svc.SetConversationSeqStore(seqStore)
	if _, err := svc.Send(context.Background(), "u1", "c1", ParentConversation, "hi", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !act.called {
		t.Error("first top-level message should activate the conversation")
	}
	waitForCond(t, func() bool { return seqStore.count("c1") == 1 }, "conversation seq to bump")
}

func TestSend_ConversationActivateError(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	conversations.conversations["c1"] = &model.Conversation{ID: "c1", ParticipantIDs: []string{"u1", "u2"}}
	svc.SetActivator(&mockActivator{err: errors.New("boom")})
	// Activate failure is logged, not fatal.
	if _, err := svc.Send(context.Background(), "u1", "c1", ParentConversation, "hi", ""); err != nil {
		t.Fatalf("Send should tolerate activate failure, got %v", err)
	}
}

func TestSend_ConversationSeqErrorIsNonFatal(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	conversations.conversations["c1"] = &model.Conversation{ID: "c1", ParticipantIDs: []string{"u1", "u2"}}
	svc.SetConversationSeqStore(&mockUnreadSeqStore{err: errors.New("boom")})
	if _, err := svc.Send(context.Background(), "u1", "c1", ParentConversation, "hi", ""); err != nil {
		t.Fatalf("Send should tolerate seq failure, got %v", err)
	}
}
