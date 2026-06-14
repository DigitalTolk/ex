package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func newDraftSvc() (*DraftService, *mockMessageStore, *mockMembershipStore, *mockConversationStore) {
	messages := newMockMessageStore()
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	svc := NewDraftService(newMockDraftStore(), messages, memberships, conversations, newMockPublisher())
	return svc, messages, memberships, conversations
}

func TestDraft_CheckAccess_ChannelMembershipError(t *testing.T) {
	svc, _, memberships, _ := newDraftSvc()
	memberships.getErr = errors.New("boom") // non-NotFound → generic error path
	if err := svc.checkAccess(context.Background(), "u1", "ch1", ParentChannel); err == nil {
		t.Fatal("expected membership check error")
	}
}

func TestDraft_CheckAccess_UnknownParentType(t *testing.T) {
	svc, _, _, _ := newDraftSvc()
	if err := svc.checkAccess(context.Background(), "u1", "p1", "bogus"); err == nil {
		t.Fatal("expected unknown-parent-type error")
	}
}

func TestDraft_CheckAccess_ConversationGetError(t *testing.T) {
	svc, _, _, conversations := newDraftSvc()
	conversations.getErr = errors.New("boom")
	if err := svc.checkAccess(context.Background(), "u1", "conv1", ParentConversation); err == nil {
		t.Fatal("expected conversation get error")
	}
}

func TestDraft_CheckAccess_NotConversationParticipant(t *testing.T) {
	svc, _, _, conversations := newDraftSvc()
	conversations.conversations["conv1"] = &model.Conversation{ID: "conv1", ParticipantIDs: []string{"other"}}
	if err := svc.checkAccess(context.Background(), "u1", "conv1", ParentConversation); err == nil {
		t.Fatal("expected not-a-participant error")
	}
}

func TestDraft_CheckThreadRoot_GetError(t *testing.T) {
	svc, messages, _, _ := newDraftSvc()
	messages.getErr = errors.New("boom")
	if err := svc.checkThreadRoot(context.Background(), "ch1", "root1"); err == nil {
		t.Fatal("expected thread-root get error")
	}
}

func TestDraft_CheckThreadRoot_Deleted(t *testing.T) {
	svc, messages, _, _ := newDraftSvc()
	messages.messages["ch1#root1"] = &model.Message{ID: "root1", ParentID: "ch1", Deleted: true}
	if err := svc.checkThreadRoot(context.Background(), "ch1", "root1"); err == nil {
		t.Fatal("expected thread-root-deleted error")
	}
}
