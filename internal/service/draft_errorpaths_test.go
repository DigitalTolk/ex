package service

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
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

func TestDraft_CheckAccess_ChannelMembershipNotFound(t *testing.T) {
	svc, _, memberships, _ := newDraftSvc()
	memberships.getErr = store.ErrNotFound // not a member
	if err := svc.checkAccess(context.Background(), "u1", "ch1", ParentChannel); err == nil {
		t.Fatal("expected not-a-member error")
	}
}

func newDraftSvcFull() (*DraftService, *mockDraftStore, *mockMessageStore, *mockMembershipStore, *mockConversationStore) {
	drafts := newMockDraftStore()
	messages := newMockMessageStore()
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	svc := NewDraftService(drafts, messages, memberships, conversations, newMockPublisher())
	return svc, drafts, messages, memberships, conversations
}

func TestDraft_Upsert_BodyTooLong(t *testing.T) {
	svc, _, _, memberships, _ := newDraftSvcFull()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}
	body := strings.Repeat("x", MaxMessageBodyChars+1)
	if _, err := svc.Upsert(context.Background(), "u1", "ch1", ParentChannel, "", body, nil, ""); err == nil {
		t.Fatal("expected body-too-long error")
	}
}

func TestDraft_Upsert_TooManyAttachments(t *testing.T) {
	svc, _, _, memberships, _ := newDraftSvcFull()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}
	ids := make([]string, MaxAttachmentsPerMessage+1)
	for i := range ids {
		ids[i] = "a" + strconv.Itoa(i)
	}
	if _, err := svc.Upsert(context.Background(), "u1", "ch1", ParentChannel, "", "hi", ids, ""); err == nil {
		t.Fatal("expected too-many-attachments error")
	}
}

func TestDraft_Upsert_PreservesCreatedAtOnUpdate(t *testing.T) {
	svc, drafts, _, memberships, _ := newDraftSvcFull()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}
	first, err := svc.Upsert(context.Background(), "u1", "ch1", ParentChannel, "", "hello", nil, "")
	if err != nil {
		t.Fatalf("first upsert: %v", err)
	}
	if first == nil {
		t.Fatal("expected draft")
	}
	// Second upsert finds the existing row and keeps its CreatedAt.
	second, err := svc.Upsert(context.Background(), "u1", "ch1", ParentChannel, "", "hello again", nil, first.Gen)
	if err != nil {
		t.Fatalf("second upsert: %v", err)
	}
	if !second.CreatedAt.Equal(first.CreatedAt) {
		t.Errorf("CreatedAt changed on update: %v -> %v", first.CreatedAt, second.CreatedAt)
	}
	_ = drafts
}

func TestDraft_Upsert_GetExistingError(t *testing.T) {
	svc, drafts, _, memberships, _ := newDraftSvcFull()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1"}
	drafts.getErr = errors.New("boom") // non-NotFound on Get existing
	if _, err := svc.Upsert(context.Background(), "u1", "ch1", ParentChannel, "", "hi", nil, ""); err == nil {
		t.Fatal("expected get-existing error")
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
