package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// signalIndexer records calls and signals over channels so goroutine-based
// index dispatch can be awaited deterministically.
type signalIndexer struct {
	indexed chan struct{}
	deleted chan struct{}
	idxErr  error
	delErr  error
}

func (s *signalIndexer) IndexMessage(_ context.Context, _ *model.Message, _ string) error {
	if s.indexed != nil {
		s.indexed <- struct{}{}
	}
	return s.idxErr
}

func (s *signalIndexer) DeleteMessage(_ context.Context, _ string) error {
	if s.deleted != nil {
		s.deleted <- struct{}{}
	}
	return s.delErr
}

func TestMessage_DeleteFromIndex_LogsError(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	idx := &signalIndexer{deleted: make(chan struct{}, 1), delErr: errors.New("boom")}
	svc.SetIndexer(idx)
	svc.deleteFromIndex(context.Background(), "m1")
	select {
	case <-idx.deleted:
	case <-time.After(time.Second):
		t.Fatal("DeleteMessage was not dispatched")
	}
}

func TestMessage_AttachRendered_SkipsNil(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	// A nil entry must be skipped without panicking.
	svc.attachRendered(nil, &model.Message{Body: "hi"})
}

func TestMessage_Send_EmptyBodyNoAttachments(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	if _, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "", ""); err == nil {
		t.Fatal("expected body-or-attachments-required error")
	}
}

func TestMessage_Send_BindAttachmentsErrorRollsBack(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	refs := &fakeAttachmentRefMgr{addErr: errors.New("bind boom")}
	svc.SetAttachmentManager(refs)
	if _, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "hi", "", "a1"); err == nil {
		t.Fatal("expected bind error")
	}
	// Rollback deleted the created message.
	if len(messages.messages) != 0 {
		t.Errorf("expected rollback to remove the message, got %d", len(messages.messages))
	}
}

func TestMessage_Send_FileIndexSkipsEmptyAttachmentID(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	refs := &fakeAttachmentRefMgr{}
	svc.SetAttachmentManager(refs)
	// One empty and one real attachment ID: the empty one is skipped in the
	// file-index loop.
	if _, err := svc.Send(context.Background(), "u1", "ch1", ParentChannel, "hi", "", "", "a1"); err != nil {
		t.Fatalf("Send: %v", err)
	}
}

func TestMessage_Edit_ValidationErrors(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	seedMsg(messages, "ch1", "m1", "u1")

	// Body too long.
	long := strings.Repeat("x", MaxMessageBodyChars+1)
	if _, err := svc.Edit(context.Background(), "u1", "ch1", ParentChannel, "m1", long, nil); err == nil {
		t.Fatal("expected body-too-long error")
	}

	// Too many attachments (non-nil list).
	ids := make([]string, MaxAttachmentsPerMessage+1)
	for i := range ids {
		ids[i] = "a"
	}
	if _, err := svc.Edit(context.Background(), "u1", "ch1", ParentChannel, "m1", "ok", ids); err == nil {
		t.Fatal("expected too-many-attachments error")
	}
}

func TestMessage_Edit_ValidateAttachmentsForUseError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	seedMsg(messages, "ch1", "m1", "u1")
	svc.SetAttachmentManager(&fakeAttachmentRefMgr{validateErr: errors.New("bad attachment")})
	if _, err := svc.Edit(context.Background(), "u1", "ch1", ParentChannel, "m1", "ok", []string{"a1"}); err == nil {
		t.Fatal("expected validate-attachments error")
	}
}

func TestMessage_Edit_DedupesAttachmentIDs(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	seedMsg(messages, "ch1", "m1", "u1")
	svc.SetAttachmentManager(&fakeAttachmentRefMgr{})
	// Duplicate and empty IDs are cleaned down to one.
	edited, err := svc.Edit(context.Background(), "u1", "ch1", ParentChannel, "m1", "ok", []string{"a1", "", "a1"})
	if err != nil {
		t.Fatalf("Edit: %v", err)
	}
	if len(edited.AttachmentIDs) != 1 || edited.AttachmentIDs[0] != "a1" {
		t.Fatalf("AttachmentIDs = %v, want [a1]", edited.AttachmentIDs)
	}
}

func TestMessage_Edit_FileIndexDeleteOnRemoval(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	// Message starts with one attachment that owns the file-index row.
	messages.messages["ch1#m1"] = &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "u1", Body: "x", AttachmentIDs: []string{"a1"},
	}
	idx := &erroringParentIndex{} // DeleteFileIndex errors → warn branch
	svc.SetParentIndex(idx)
	svc.SetAttachmentManager(&fakeAttachmentRefMgr{})
	// Remove a1 by passing an empty attachment list.
	if _, err := svc.Edit(context.Background(), "u1", "ch1", ParentChannel, "m1", "new body", []string{}); err != nil {
		t.Fatalf("Edit: %v", err)
	}
}

func TestMessage_SetNoUnfurl_UpdateError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	grantChannelMember(memberships, "ch1", "u1")
	seedMsg(messages, "ch1", "m1", "u1")
	messages.updateErr = errors.New("boom")
	if _, err := svc.SetNoUnfurl(context.Background(), "u1", "ch1", ParentChannel, "m1", true); err == nil {
		t.Fatal("expected update error")
	}
}

func TestMessage_FlagNonMemberMentions_NilMemberships(t *testing.T) {
	// Construct a service with nil memberships to hit the early return.
	svc := NewMessageService(newMockMessageStore(), nil, newMockConversationStore(), newMockPublisher(), newMockBroker())
	svc.flagNonMemberMentions(context.Background(), &model.Message{Body: "@[u2|Bob] hi"})
}
