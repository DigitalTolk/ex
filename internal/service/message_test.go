package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// errorsIs is a thin wrapper so the new validation tests don't have to
// import errors at every callsite. The full path is exercised once
// elsewhere in the file.
func errorsIs(err, target error) bool { return errors.Is(err, target) }

func setupMessageService() (*MessageService, *mockMessageStore, *mockMembershipStore, *mockConversationStore, *mockPublisher) {
	messages := newMockMessageStore()
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	publisher := newMockPublisher()
	broker := newMockBroker()
	svc := NewMessageService(messages, memberships, conversations, publisher, broker)
	// Production main always wires a parent index; tests do the same
	// so ListPinned / ListFiles take the real (indexed) code path.
	// Tests that need to seed or inspect the index call
	// svc.SetParentIndex(...) again with their own instance.
	svc.SetParentIndex(newMockParentIndex())
	return svc, messages, memberships, conversations, publisher
}

// writeUnreadSeq (the synchronous core of the detached bump) advances the
// counter and marks the author caught up — their own post never shows as unread
// to them. Tested directly so the assertion doesn't race the goroutine.
func TestMessageService_WriteUnreadSeq(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	seqStore := &mockUnreadSeqStore{}
	ctx := context.Background()

	svc.writeUnreadSeq(ctx, seqStore, "ch1", "user-1")
	if seqStore.count("ch1") != 1 {
		t.Errorf("MessageSeq = %d, want 1", seqStore.count("ch1"))
	}
	if seq, ok := seqStore.lastRead("ch1", "user-1"); !ok || seq != 1 {
		t.Errorf("author last-read = %d (set=%v), want 1 (own post reads the parent)", seq, ok)
	}
}

// IncrementMessageSeq failing must not set the author's last-read (and must not
// panic) — unread tracking is best-effort, message delivery is not.
func TestMessageService_WriteUnreadSeq_IncrementErrorIsNonFatal(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	seqStore := &mockUnreadSeqStore{err: errors.New("boom")}

	svc.writeUnreadSeq(context.Background(), seqStore, "ch1", "user-1")
	if _, ok := seqStore.lastRead("ch1", "user-1"); ok {
		t.Error("author last-read should not be set when increment failed")
	}
}

// A SetLastRead failure after a successful increment is logged, not fatal.
func TestMessageService_WriteUnreadSeq_SetLastReadErrorIsNonFatal(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	seqStore := &mockUnreadSeqStore{lastErr: errors.New("boom")}

	svc.writeUnreadSeq(context.Background(), seqStore, "ch1", "user-1")
	if seqStore.count("ch1") != 1 {
		t.Errorf("seq = %d, want 1 (increment still happened)", seqStore.count("ch1"))
	}
}

// Send dispatches the (detached) unread-seq bump for a top-level channel
// message. The bump runs in a goroutine, so poll for it.
func TestMessageService_Send_BumpsChannelSeq(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	seqStore := &mockUnreadSeqStore{}
	svc.SetChannelSeqStore(seqStore)
	ctx := context.Background()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}

	if _, err := svc.Send(ctx, "user-1", "ch1", ParentChannel, "first", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	waitForCond(t, func() bool { return seqStore.count("ch1") == 1 }, "channel seq to bump after send")
}

// A conversation message bumps the conversation's seq counter the same way —
// the unified mechanism, no Redis flag.
func TestMessageService_Send_BumpsConversationSeq(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	seqStore := &mockUnreadSeqStore{}
	svc.SetConversationSeqStore(seqStore)
	ctx := context.Background()
	conversations.conversations["conv1"] = &model.Conversation{ID: "conv1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"user-1", "user-2"}}

	if _, err := svc.Send(ctx, "user-1", "conv1", ParentConversation, "hey", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	waitForCond(t, func() bool { return seqStore.count("conv1") == 1 }, "conversation seq to bump after send")
}

// A webhook posting into a channel or DM bumps the unread counter too, so an
// incident-bot alert lights the sidebar like any other message.
func TestMessageService_SendWebhook_BumpsChannelSeq(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	seqStore := &mockUnreadSeqStore{}
	svc.SetChannelSeqStore(seqStore)
	ctx := context.Background()

	if _, err := svc.SendWebhook(ctx, WebhookMessageInput{ParentID: "ch1", ParentType: ParentChannel, AuthorID: "bot", Body: "alert"}); err != nil {
		t.Fatalf("SendWebhook: %v", err)
	}
	waitForCond(t, func() bool { return seqStore.count("ch1") == 1 }, "channel seq to bump after webhook send")
}

// A webhook posting into a DM bumps the conversation counter too (closes the
// old gap where webhook DMs left no unread).
func TestMessageService_SendWebhook_BumpsConversationSeq(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	seqStore := &mockUnreadSeqStore{}
	svc.SetConversationSeqStore(seqStore)
	ctx := context.Background()

	if _, err := svc.SendWebhook(ctx, WebhookMessageInput{ParentID: "conv1", ParentType: ParentConversation, AuthorID: "bot", Body: "alert"}); err != nil {
		t.Fatalf("SendWebhook: %v", err)
	}
	waitForCond(t, func() bool { return seqStore.count("conv1") == 1 }, "conversation seq to bump after webhook send")
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

// Send must reject bodies past the codepoint cap with the named error
// so handlers can map it to a 400.
func TestMessageService_Send_RejectsBodyOverLimit(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}
	body := strings.Repeat("a", MaxMessageBodyChars+1)
	_, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, body, "")
	if err == nil {
		t.Fatal("expected error for over-cap body")
	}
	if !errorsIs(err, ErrMessageTooLong) {
		t.Errorf("got %v, want ErrMessageTooLong", err)
	}
}

func TestMessageService_Send_RejectsTooManyAttachments(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember}
	atts := make([]string, MaxAttachmentsPerMessage+1)
	for i := range atts {
		atts[i] = "att-" + string(rune('a'+i))
	}
	_, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, "hi", "", atts...)
	if err == nil {
		t.Fatal("expected error for too many attachments")
	}
	if !errorsIs(err, ErrTooManyAttachments) {
		t.Errorf("got %v, want ErrTooManyAttachments", err)
	}
}

func TestMessageService_Send_Conversation(t *testing.T) {
	svc, _, _, conversations, publisher := setupMessageService()
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
	var sidebarEvents int
	for _, published := range publisher.published {
		if published.event.Type == "userchannel.updated" {
			sidebarEvents++
		}
	}
	if sidebarEvents != 2 {
		t.Fatalf("userchannel.updated events = %d, want 2 participant sidebar refreshes", sidebarEvents)
	}
}

func TestMessageService_CanAccessMessageAttachment(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch-access#u1"] = &model.ChannelMembership{ChannelID: "ch-access", UserID: "u1", Role: model.ChannelRoleMember}
	messages.messages["ch-access#m1"] = &model.Message{
		ID: "m1", ParentID: "ch-access", AuthorID: "u2", AttachmentIDs: []string{"att-1"},
	}

	if err := svc.CanAccessMessageAttachment(ctx, "u1", "ch-access", ParentChannel, "m1", "att-1"); err != nil {
		t.Fatalf("CanAccessMessageAttachment: %v", err)
	}
	if err := svc.CanAccessMessageAttachment(ctx, "u1", "ch-access", ParentChannel, "m1", "att-other"); err == nil {
		t.Fatal("expected missing attachment reference to fail")
	}
	if err := svc.CanAccessMessageAttachment(ctx, "u-outsider", "ch-access", ParentChannel, "m1", "att-1"); err == nil {
		t.Fatal("expected non-member to fail")
	}
	if err := svc.CanAccessMessageAttachment(ctx, "u1", "ch-access", ParentChannel, "", "att-1"); err != nil {
		t.Fatalf("parent-scoped CanAccessMessageAttachment: %v", err)
	}
}

// A thread-only reply in a conversation must NOT count as new conversation
// activity: it must not re-touch/re-order the conversation or fan out
// userchannel.updated. Otherwise the DM lights up and jumps to the top of the
// sidebar as if a fresh top-level message arrived. This mirrors the channel
// rule (a thread reply doesn't bump the channel unread counter either).
func TestMessageService_Send_ConversationThreadReplyDoesNotTouchActivity(t *testing.T) {
	svc, messages, _, conversations, publisher := setupMessageService()
	ctx := context.Background()
	old := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)

	conversations.conversations["conv-thread"] = &model.Conversation{
		ID:             "conv-thread",
		Type:           model.ConversationTypeGroup,
		ParticipantIDs: []string{"user-1", "user-2"},
		UpdatedAt:      old,
	}
	conversations.userConvs["user-1"] = []*model.UserConversation{{
		UserID:         "user-1",
		ConversationID: "conv-thread",
		UpdatedAt:      old,
	}}
	conversations.userConvs["user-2"] = []*model.UserConversation{{
		UserID:         "user-2",
		ConversationID: "conv-thread",
		UpdatedAt:      old,
	}}
	messages.messages["conv-thread#root-msg"] = &model.Message{
		ID:       "root-msg",
		ParentID: "conv-thread",
		AuthorID: "user-1",
		Body:     "root",
	}

	reply, err := svc.Send(ctx, "user-1", "conv-thread", ParentConversation, "reply", "root-msg")
	if err != nil {
		t.Fatalf("Send reply: %v", err)
	}
	if reply.ParentMessageID != "root-msg" {
		t.Errorf("ParentMessageID = %q, want root-msg", reply.ParentMessageID)
	}
	if !conversations.conversations["conv-thread"].UpdatedAt.Equal(old) {
		t.Errorf("conversation UpdatedAt = %v, want unchanged %v (thread reply must not re-touch)", conversations.conversations["conv-thread"].UpdatedAt, old)
	}
	for userID, userConvs := range conversations.userConvs {
		if len(userConvs) != 1 || !userConvs[0].UpdatedAt.Equal(old) {
			t.Errorf("%s user conversation UpdatedAt = %+v, want unchanged %v", userID, userConvs, old)
		}
	}
	var sidebarEvents int
	for _, published := range publisher.published {
		if published.event.Type == "userchannel.updated" {
			sidebarEvents++
		}
	}
	if sidebarEvents != 0 {
		t.Fatalf("userchannel.updated events = %d, want 0 (a thread reply is not new conversation activity)", sidebarEvents)
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

func TestMessageService_ListAround_DelegatesAfterAccessCheck(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#u"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u", Role: model.ChannelRoleMember,
	}
	_, hasMoreOlder, hasMoreNewer, err := svc.ListAround(context.Background(), "u", "ch1", ParentChannel, "anchor", 10, 10)
	if err != nil {
		t.Fatalf("ListAround: %v", err)
	}
	// mockMessageStore.ListMessagesAround returns both has-mores=false.
	if hasMoreOlder || hasMoreNewer {
		t.Errorf("hasMoreOlder=%v hasMoreNewer=%v, want both false from mock", hasMoreOlder, hasMoreNewer)
	}
}

func TestMessageService_ListAround_RejectsNonMember(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	if _, _, _, err := svc.ListAround(context.Background(), "stranger", "ch1", ParentChannel, "anchor", 10, 10); err == nil {
		t.Fatal("expected access error for non-member")
	}
}

func TestMessageService_ListAfter_RejectsNonMember(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	if _, _, err := svc.ListAfter(context.Background(), "stranger", "ch1", ParentChannel, "cursor", 10); err == nil {
		t.Fatal("expected access error for non-member")
	}
}

func TestMessageService_List_ExcludesThreadReplies(t *testing.T) {
	// Regression: deep-linking into a channel with bursts of threaded
	// conversations used to render only ~2 messages around the
	// highlight because the around-window's 50 raw items were
	// dominated by replies that the frontend filtered out. The API
	// list endpoints must filter top-level on the server so each
	// page returns ~limit RENDERABLE messages.
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "user-1", Body: "root"}
	messages.messages["ch1#reply-1"] = &model.Message{
		ID: "reply-1", ParentID: "ch1", AuthorID: "user-1", Body: "r1", ParentMessageID: "root",
	}
	messages.messages["ch1#reply-2"] = &model.Message{
		ID: "reply-2", ParentID: "ch1", AuthorID: "user-1", Body: "r2", ParentMessageID: "root",
	}
	messages.messages["ch1#top-2"] = &model.Message{ID: "top-2", ParentID: "ch1", AuthorID: "user-1", Body: "top-2"}

	msgs, _, err := svc.List(context.Background(), "user-1", "ch1", ParentChannel, "", 50)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, m := range msgs {
		if m.ParentMessageID != "" {
			t.Errorf("top-level list returned reply %q with parentMessageID=%q", m.ID, m.ParentMessageID)
		}
	}
	if len(msgs) != 2 {
		t.Errorf("got %d top-level messages, want 2", len(msgs))
	}
}

func TestMessageService_ListAfter_ExcludesThreadReplies(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "user-1", Body: "x"}
	messages.messages["ch1#r1"] = &model.Message{
		ID: "r1", ParentID: "ch1", AuthorID: "user-1", Body: "x", ParentMessageID: "m1",
	}

	msgs, _, err := svc.ListAfter(context.Background(), "user-1", "ch1", ParentChannel, "cursor", 50)
	if err != nil {
		t.Fatalf("ListAfter: %v", err)
	}
	for _, m := range msgs {
		if m.ParentMessageID != "" {
			t.Errorf("ListAfter returned reply %q", m.ID)
		}
	}
}

func TestMessageService_ListAround_ExcludesThreadReplies(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#anchor"] = &model.Message{ID: "anchor", ParentID: "ch1", AuthorID: "user-1", Body: "a"}
	messages.messages["ch1#top"] = &model.Message{ID: "top", ParentID: "ch1", AuthorID: "user-1", Body: "t"}
	messages.messages["ch1#reply"] = &model.Message{
		ID: "reply", ParentID: "ch1", AuthorID: "user-1", Body: "r", ParentMessageID: "anchor",
	}

	msgs, _, _, err := svc.ListAround(context.Background(), "user-1", "ch1", ParentChannel, "anchor", 25, 25)
	if err != nil {
		t.Fatalf("ListAround: %v", err)
	}
	for _, m := range msgs {
		if m.ID == "anchor" {
			continue // the target itself is allowed regardless
		}
		if m.ParentMessageID != "" {
			t.Errorf("ListAround returned reply %q in the surrounding window", m.ID)
		}
	}
}

func TestMessageService_ListAfter_DelegatesToStore(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#u"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u", Role: model.ChannelRoleMember}
	messages.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "u", Body: "hi"}
	got, _, err := svc.ListAfter(context.Background(), "u", "ch1", ParentChannel, "cursor", 10)
	if err != nil {
		t.Fatalf("ListAfter: %v", err)
	}
	if len(got) != 1 || got[0].ID != "m1" {
		t.Fatalf("got %+v, want [m1]", got)
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
	added       []string
	removed     []string
	validateErr error
	addErr      error
	removeErr   error
}

func (f *fakeAttachmentRefMgr) ValidateForUse(_ context.Context, _ string) error {
	return f.validateErr
}

func (f *fakeAttachmentRefMgr) AddRef(_ context.Context, attachmentID, _ string) error {
	f.added = append(f.added, attachmentID)
	return f.addErr
}

func (f *fakeAttachmentRefMgr) RemoveRef(_ context.Context, attachmentID, _ string) error {
	f.removed = append(f.removed, attachmentID)
	return f.removeErr
}

func TestMessageService_releaseAttachments_SkipsEmptyAndSwallowsError(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	refs := &fakeAttachmentRefMgr{removeErr: errors.New("remove boom")}
	svc.SetAttachmentManager(refs)

	// Empty IDs are skipped; the RemoveRef error on the real ID is logged
	// and swallowed (releaseAttachments waits on its goroutines).
	svc.releaseAttachments(context.Background(), "msg-1", []string{"", "a1"})
	if len(refs.removed) != 1 || refs.removed[0] != "a1" {
		t.Fatalf("expected RemoveRef on a1 only, got %+v", refs.removed)
	}
}

func TestMessageService_followMentionedThreadUsers_SkipsAndSwallowsBatchError(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	follows.setManyErr = errors.New("batch boom")
	svc.SetThreadFollowStore(follows)
	memberships.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob", Role: model.ChannelRoleMember}

	msg := &model.Message{
		ID:              "m-reply",
		ParentID:        "ch1",
		ParentMessageID: "m-root",
		AuthorID:        "u-author",
		// self mention (skipped), member mentioned twice (dedup), non-member (access fail).
		Body: "@[u-author|Author] @[u-bob|Bob] @[u-bob|Bob] @[u-outsider|Out]",
	}
	// One valid follow is collected, the batch write fails, and the error is
	// logged and swallowed (no panic / no return value).
	svc.followMentionedThreadUsers(context.Background(), msg, ParentChannel)
	if follows.setManyCalls != 1 {
		t.Fatalf("SetThreadFollowMany calls = %d, want 1", follows.setManyCalls)
	}
}

func TestMessageService_followMentionedThreadUsers_NoOpGuards(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	// Not a thread reply (no ParentMessageID) → no-op.
	svc.followMentionedThreadUsers(context.Background(), &model.Message{ID: "m", ParentID: "ch1", Body: "@[u-bob|Bob]"}, ParentChannel)
	// Thread reply but no mentions → no-op.
	svc.followMentionedThreadUsers(context.Background(), &model.Message{ID: "m", ParentID: "ch1", ParentMessageID: "r", Body: "no mentions"}, ParentChannel)
	if follows.setManyCalls != 0 {
		t.Fatalf("expected no batch writes, got %d", follows.setManyCalls)
	}
}

func TestMessageService_scanParentMessages_Branches(t *testing.T) {
	ctx := context.Background()

	// Error path.
	svc, messages, _, _, _ := setupMessageService()
	messages.listErr = errors.New("boom")
	if _, err := svc.scanParentMessages(ctx, "ch1"); err == nil {
		t.Fatal("expected list error")
	}

	// Empty parent → returns an empty slice, no error.
	svc2, _, _, _, _ := setupMessageService()
	got, err := svc2.scanParentMessages(ctx, "empty-parent")
	if err != nil || len(got) != 0 {
		t.Fatalf("empty scan = %v, %v; want empty slice", got, err)
	}

	// hasMore=true forever → the scan caps at maxThreadScanPages and returns.
	svc3, messages3, _, _, _ := setupMessageService()
	messages3.listHasMore = true
	messages3.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1"}
	out, err := svc3.scanParentMessages(ctx, "ch1")
	if err != nil {
		t.Fatalf("paginated scan: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("expected accumulated messages from capped scan")
	}
}

func TestMessageService_postSystemMessage_CreateErrorSwallowed(t *testing.T) {
	svc, messages, _, _, _ := setupMessageService()
	messages.createErr = errors.New("boom")
	// The create fails; postSystemMessage swallows it and publishes nothing.
	svc.postSystemMessage(context.Background(), "ch1", "system notice")
}

func TestMessageService_releaseAttachments_NoOpWhenNilOrEmpty(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	// No attachment manager wired → no-op, no panic.
	svc.releaseAttachments(context.Background(), "msg-1", []string{"a1"})

	refs := &fakeAttachmentRefMgr{}
	svc.SetAttachmentManager(refs)
	// Empty id list → no-op.
	svc.releaseAttachments(context.Background(), "msg-1", nil)
	if len(refs.removed) != 0 {
		t.Fatalf("expected no RemoveRef calls, got %+v", refs.removed)
	}
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

func TestMessageService_Edit_ReturnsWhenAttachmentBindFails(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	refs := &fakeAttachmentRefMgr{addErr: errors.New("bind failed")}
	svc.SetAttachmentManager(refs)

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1",
		UserID:    "user-1",
		Role:      model.ChannelRoleMember,
	}
	messages.messages["ch1#msg-1"] = &model.Message{
		ID:       "msg-1",
		ParentID: "ch1",
		AuthorID: "user-1",
		Body:     "hello",
	}

	if _, err := svc.Edit(ctx, "user-1", "ch1", ParentChannel, "msg-1", "hello edited", []string{"att-1"}); err == nil {
		t.Fatal("expected edit to fail when new attachment bind fails")
	}
	if len(refs.added) != 1 || refs.added[0] != "att-1" {
		t.Fatalf("AddRef calls = %+v, want [att-1]", refs.added)
	}
	if len(refs.removed) != 0 {
		t.Fatalf("RemoveRef calls = %+v, want none", refs.removed)
	}
	if messages.messages["ch1#msg-1"].Body != "hello" {
		t.Fatalf("message body changed after failed bind: %q", messages.messages["ch1#msg-1"].Body)
	}
}

func TestMessageService_Send_RejectsInvalidAttachmentBeforeCreate(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}
	refs := &fakeAttachmentRefMgr{validateErr: errors.New("object missing")}
	svc.SetAttachmentManager(refs)

	if _, err := svc.Send(ctx, "u1", "ch1", ParentChannel, "body", "", "att-missing"); err == nil {
		t.Fatal("expected invalid attachment to reject send")
	}
	if len(messages.messages) != 0 {
		t.Fatalf("message was created despite invalid attachment: %+v", messages.messages)
	}
	if len(refs.added) != 0 {
		t.Fatalf("attachment refs were added despite invalid attachment: %+v", refs.added)
	}
}

func TestMessageService_Send_RollsBackWhenAttachmentBindFails(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}
	refs := &fakeAttachmentRefMgr{addErr: errors.New("bind failed")}
	svc.SetAttachmentManager(refs)

	if _, err := svc.Send(ctx, "u1", "ch1", ParentChannel, "body", "", "att-1"); err == nil {
		t.Fatal("expected send to fail when attachment bind fails")
	}
	if len(messages.messages) != 0 {
		t.Fatalf("message was not rolled back after bind failure: %+v", messages.messages)
	}
	if len(refs.added) != 1 || refs.added[0] != "att-1" {
		t.Fatalf("AddRef calls = %+v, want [att-1]", refs.added)
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

func TestMessageService_SetPinned_TogglesAndPublishesEvents(t *testing.T) {
	svc, messages, memberships, _, publisher := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-1", Role: model.ChannelRoleMember}
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u-1"}

	pinned, err := svc.SetPinned(ctx, "u-1", "ch1", ParentChannel, "m-1", true)
	if err != nil {
		t.Fatalf("SetPinned: %v", err)
	}
	if !pinned.Pinned {
		t.Error("expected message to be pinned")
	}
	if pinned.PinnedBy != "u-1" {
		t.Errorf("PinnedBy = %q, want u-1", pinned.PinnedBy)
	}
	if pinned.PinnedAt == nil {
		t.Error("expected PinnedAt to be set")
	}

	// One message.edited event carrying the updated message — re-uses the
	// existing client-side invalidation path.
	if len(publisher.published) != 1 || publisher.published[0].event.Type != "message.edited" {
		t.Errorf("expected 1 message.edited event; got %d (%v)", len(publisher.published), publisher.published)
	}

	// Idempotent: calling SetPinned(true) again is a no-op (no extra events).
	if _, err := svc.SetPinned(ctx, "u-1", "ch1", ParentChannel, "m-1", true); err != nil {
		t.Fatalf("idempotent SetPinned: %v", err)
	}
	if len(publisher.published) != 1 {
		t.Errorf("idempotent toggle should not republish; total events = %d", len(publisher.published))
	}

	// Unpin clears the metadata.
	unp, err := svc.SetPinned(ctx, "u-1", "ch1", ParentChannel, "m-1", false)
	if err != nil {
		t.Fatalf("unpin: %v", err)
	}
	if unp.Pinned || unp.PinnedAt != nil || unp.PinnedBy != "" {
		t.Error("expected unpin to clear all pin metadata")
	}
}

func TestMessageService_Send_NonMemberMention_PostsNoSystemMessage(t *testing.T) {
	// The old behaviour posted a public "X isn't a member" system message.
	// That's now replaced by an author-facing in-app invite prompt (frontend),
	// so the send itself must NOT post any system audit message.
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#u-author"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u-author", Role: model.ChannelRoleMember,
	}

	_, err := svc.Send(ctx, "u-author", "ch1", ParentChannel, "hi @[u-outsider|Outsider Sue]", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	for _, m := range messages.messages {
		if m.System {
			t.Errorf("send must not post a system message for a non-member mention; got %q", m.Body)
		}
	}
}

func TestMessageService_Send_MentionedMemberDoesNotProduceSystemMessage(t *testing.T) {
	// If the mentioned user IS already a channel member, no audit message
	// is posted — the mention is a normal interaction.
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#u-author"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u-author", Role: model.ChannelRoleMember,
	}
	memberships.memberships["ch1#u-bob"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u-bob", Role: model.ChannelRoleMember,
	}

	_, err := svc.Send(ctx, "u-author", "ch1", ParentChannel, "@[u-bob|Bob] hi", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	for _, m := range messages.messages {
		if m.System {
			t.Errorf("unexpected system message: %q", m.Body)
		}
	}
}

func TestMessageService_Send_ThreadReplyFollowsMentionedMember(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	ctx := context.Background()

	memberships.memberships["ch1#u-author"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u-author", Role: model.ChannelRoleMember,
	}
	memberships.memberships["ch1#u-bob"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u-bob", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-other", Body: "root"}

	if _, err := svc.Send(ctx, "u-author", "ch1", ParentChannel, "please check @[u-bob|Bob]", "m-root"); err != nil {
		t.Fatalf("Send: %v", err)
	}

	got, err := follows.GetThreadFollow(ctx, "u-bob", "ch1", "m-root")
	if err != nil {
		t.Fatalf("GetThreadFollow: %v", err)
	}
	if !got.Following || got.ParentType != ParentChannel {
		t.Fatalf("follow = %+v, want mentioned member following channel thread", got)
	}
}

func TestMessageService_Send_ThreadReplyDoesNotFollowMentionedNonMember(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	ctx := context.Background()

	memberships.memberships["ch1#u-author"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u-author", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-other", Body: "root"}

	if _, err := svc.Send(ctx, "u-author", "ch1", ParentChannel, "please check @[u-outsider|Outsider]", "m-root"); err != nil {
		t.Fatalf("Send: %v", err)
	}

	if _, err := follows.GetThreadFollow(ctx, "u-outsider", "ch1", "m-root"); err == nil {
		t.Fatal("expected non-member mention not to create a thread follow")
	}
}

func TestMessageService_Send_ConversationThreadReplyFollowsMentionedParticipant(t *testing.T) {
	svc, messages, _, conversations, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	ctx := context.Background()
	conversations.conversations["c1"] = &model.Conversation{
		ID:             "c1",
		Type:           model.ConversationTypeGroup,
		ParticipantIDs: []string{"u-author", "u-bob"},
	}
	messages.messages["c1#m-root"] = &model.Message{ID: "m-root", ParentID: "c1", AuthorID: "u-author", Body: "root"}

	if _, err := svc.Send(ctx, "u-author", "c1", ParentConversation, "please check @[u-bob|Bob]", "m-root"); err != nil {
		t.Fatalf("Send: %v", err)
	}

	got, err := follows.GetThreadFollow(ctx, "u-bob", "c1", "m-root")
	if err != nil {
		t.Fatalf("GetThreadFollow: %v", err)
	}
	if !got.Following || got.ParentType != ParentConversation {
		t.Fatalf("follow = %+v, want mentioned participant following conversation thread", got)
	}
}

func TestMessageService_Send_ConversationMention_NoSystemMessage(t *testing.T) {
	// Non-member-mention checks are channel-only; mentioning an outsider
	// in a DM/group should not surface anything (no concept of outsider).
	svc, messages, memberships, conversations, _ := setupMessageService()
	ctx := context.Background()

	conversations.conversations["c1"] = &model.Conversation{
		ID: "c1", Type: model.ConversationTypeGroup,
		ParticipantIDs: []string{"u-author", "u-other"},
	}
	memberships.memberships["c1#u-author"] = &model.ChannelMembership{
		ChannelID: "c1", UserID: "u-author", Role: model.ChannelRoleMember,
	}

	_, err := svc.Send(ctx, "u-author", "c1", ParentConversation, "hi @[u-outsider|Stranger]", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	for _, m := range messages.messages {
		if m.System {
			t.Errorf("conversation parent should not produce non-member-mention audit; got %q", m.Body)
		}
	}
}

func TestMessageService_ListUserThreads(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	// User is a member of one channel; populate userChannels override on the
	// membership mock so ListUserChannels returns it.
	memberships.userChannels = []*model.UserChannel{
		{UserID: "u-me", ChannelID: "ch-1"},
	}

	now := time.Now()
	root := &model.Message{
		ID: "m-root", ParentID: "ch-1", AuthorID: "u-me",
		Body: "starting a thread", CreatedAt: now.Add(-time.Hour), ReplyCount: 1,
	}
	reply1 := &model.Message{
		ID: "m-reply1", ParentID: "ch-1", AuthorID: "u-other",
		Body: "first reply", CreatedAt: now.Add(-30 * time.Minute), ParentMessageID: "m-root",
	}
	noisyOtherThreadRoot := &model.Message{
		ID: "m-other-root", ParentID: "ch-1", AuthorID: "u-other",
		Body: "other thread", CreatedAt: now.Add(-2 * time.Hour), ReplyCount: 2,
	}
	// User replied to the other thread → still counts as participation.
	userReply := &model.Message{
		ID: "m-user-reply", ParentID: "ch-1", AuthorID: "u-me",
		Body: "I jumped in", CreatedAt: now.Add(-15 * time.Minute), ParentMessageID: "m-other-root",
	}
	otherReply := &model.Message{
		ID: "m-other-reply", ParentID: "ch-1", AuthorID: "u-other",
		Body: "later", CreatedAt: now.Add(-10 * time.Minute), ParentMessageID: "m-other-root",
	}
	// A thread the user has nothing to do with.
	stranger := &model.Message{
		ID: "m-stranger", ParentID: "ch-1", AuthorID: "u-other",
		Body: "stranger", CreatedAt: now.Add(-5 * time.Minute), ReplyCount: 1,
	}
	for _, m := range []*model.Message{root, reply1, noisyOtherThreadRoot, userReply, otherReply, stranger} {
		messages.messages["ch-1#"+m.ID] = m
	}

	got, err := svc.ListUserThreads(ctx, "u-me")
	if err != nil {
		t.Fatalf("ListUserThreads: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 thread summaries (root + replied-to), got %d", len(got))
	}
	roots := map[string]bool{got[0].ThreadRootID: true, got[1].ThreadRootID: true}
	if !roots["m-root"] || !roots["m-other-root"] {
		t.Errorf("expected both thread roots; got %+v", roots)
	}
	// Sorted by latest activity desc — m-other-root has otherReply at -10min;
	// m-root has reply1 at -30min — so m-other-root should be first.
	if got[0].ThreadRootID != "m-other-root" {
		t.Errorf("expected m-other-root first by latest activity; got %q", got[0].ThreadRootID)
	}
}

func TestMessageService_ListUserThreads_UsesFollowOverrides(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	ctx := context.Background()

	memberships.userChannels = []*model.UserChannel{{UserID: "u-me", ChannelID: "ch-1"}}
	now := time.Now()
	messages.messages["ch-1#m-participated"] = &model.Message{
		ID: "m-participated", ParentID: "ch-1", AuthorID: "u-me", Body: "mine", CreatedAt: now.Add(-time.Hour), ReplyCount: 1,
	}
	messages.messages["ch-1#m-participated-r"] = &model.Message{
		ID: "m-participated-r", ParentID: "ch-1", AuthorID: "u-other", Body: "reply", CreatedAt: now.Add(-50 * time.Minute), ParentMessageID: "m-participated",
	}
	messages.messages["ch-1#m-followed"] = &model.Message{
		ID: "m-followed", ParentID: "ch-1", AuthorID: "u-other", Body: "follow me", CreatedAt: now.Add(-40 * time.Minute), ReplyCount: 1,
	}
	messages.messages["ch-1#m-followed-r"] = &model.Message{
		ID: "m-followed-r", ParentID: "ch-1", AuthorID: "u-someone", Body: "reply", CreatedAt: now.Add(-30 * time.Minute), ParentMessageID: "m-followed",
	}
	if err := follows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID: "u-me", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: "m-followed", Following: true,
	}); err != nil {
		t.Fatalf("follow m-followed: %v", err)
	}
	if err := follows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID: "u-me", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: "m-participated", Following: false,
	}); err != nil {
		t.Fatalf("unfollow m-participated: %v", err)
	}

	got, err := svc.ListUserThreads(ctx, "u-me")
	if err != nil {
		t.Fatalf("ListUserThreads: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected only explicit follow after unfollow override, got %d: %+v", len(got), got)
	}
	if got[0].ThreadRootID != "m-followed" {
		t.Fatalf("ThreadRootID = %q, want m-followed", got[0].ThreadRootID)
	}
}

func TestMessageService_ListUserThreads_IncludesUnreadThreadNotification(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	stateStore := newMockUserStateStore()
	svc.SetUserStateStore(stateStore)
	ctx := context.Background()

	memberships.userChannels = []*model.UserChannel{{UserID: "u-me", ChannelID: "ch-1"}}
	now := time.Now()
	messages.messages["ch-1#m-notified"] = &model.Message{
		ID: "m-notified", ParentID: "ch-1", AuthorID: "u-other", Body: "root", CreatedAt: now.Add(-time.Hour), ReplyCount: 1,
	}
	messages.messages["ch-1#m-notified-r"] = &model.Message{
		ID: "m-notified-r", ParentID: "ch-1", AuthorID: "u-author", Body: "@all", CreatedAt: now.Add(-30 * time.Minute), ParentMessageID: "m-notified",
	}
	if err := stateStore.SetUserState(ctx, &model.UserStateItem{
		UserID:       "u-me",
		Kind:         model.UserStateThreadNotification,
		TargetID:     "m-notified",
		ParentID:     "ch-1",
		ParentType:   ParentChannel,
		ThreadRootID: "m-notified",
		UpdatedAt:    now,
	}); err != nil {
		t.Fatalf("SetUserState: %v", err)
	}

	got, err := svc.ListUserThreads(ctx, "u-me")
	if err != nil {
		t.Fatalf("ListUserThreads: %v", err)
	}
	if len(got) != 1 || got[0].ThreadRootID != "m-notified" {
		t.Fatalf("ListUserThreads = %+v, want unread notified thread", got)
	}
}

func TestMessageService_ListUserThreads_NotificationTemporarilyOverridesUnfollow(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	stateStore := newMockUserStateStore()
	svc.SetThreadFollowStore(follows)
	svc.SetUserStateStore(stateStore)
	ctx := context.Background()

	memberships.userChannels = []*model.UserChannel{{UserID: "u-me", ChannelID: "ch-1"}}
	now := time.Now()
	messages.messages["ch-1#m-unfollowed"] = &model.Message{
		ID: "m-unfollowed", ParentID: "ch-1", AuthorID: "u-me", Body: "root", CreatedAt: now.Add(-time.Hour), ReplyCount: 1,
	}
	messages.messages["ch-1#m-unfollowed-r"] = &model.Message{
		ID: "m-unfollowed-r", ParentID: "ch-1", AuthorID: "u-other", Body: "@here", CreatedAt: now.Add(-30 * time.Minute), ParentMessageID: "m-unfollowed",
	}
	if err := follows.SetThreadFollow(ctx, &model.ThreadFollow{
		UserID: "u-me", ParentID: "ch-1", ParentType: ParentChannel, ThreadRootID: "m-unfollowed", Following: false,
	}); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}
	if err := stateStore.SetUserState(ctx, &model.UserStateItem{
		UserID:       "u-me",
		Kind:         model.UserStateThreadNotification,
		TargetID:     "m-unfollowed",
		ParentID:     "ch-1",
		ParentType:   ParentChannel,
		ThreadRootID: "m-unfollowed",
		UpdatedAt:    now,
	}); err != nil {
		t.Fatalf("SetUserState: %v", err)
	}

	got, err := svc.ListUserThreads(ctx, "u-me")
	if err != nil {
		t.Fatalf("ListUserThreads with notification: %v", err)
	}
	if len(got) != 1 || got[0].ThreadRootID != "m-unfollowed" {
		t.Fatalf("ListUserThreads with notification = %+v, want temporarily visible unread thread", got)
	}

	if err := stateStore.DeleteUserState(ctx, "u-me", model.UserStateThreadNotification, "m-unfollowed"); err != nil {
		t.Fatalf("DeleteUserState: %v", err)
	}
	got, err = svc.ListUserThreads(ctx, "u-me")
	if err != nil {
		t.Fatalf("ListUserThreads after read: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("ListUserThreads after read = %+v, want unfollowed thread hidden again", got)
	}
}

func TestMessageService_SetThreadFollow_RejectsReplyAsRoot(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	svc.SetThreadFollowStore(newMockThreadFollowStore())
	ctx := context.Background()
	memberships.memberships["ch-1#u-me"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-me"}
	messages.messages["ch-1#m-reply"] = &model.Message{
		ID: "m-reply", ParentID: "ch-1", AuthorID: "u-other", ParentMessageID: "m-root", Body: "reply",
	}

	if err := svc.SetThreadFollow(ctx, "u-me", "ch-1", ParentChannel, "m-reply", true); err == nil {
		t.Fatal("expected reply roots to be rejected")
	}
}

func TestMessageService_SetThreadFollow_Success(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	ctx := context.Background()
	memberships.memberships["ch-1#u-me"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-me"}
	messages.messages["ch-1#m-root"] = &model.Message{
		ID: "m-root", ParentID: "ch-1", AuthorID: "u-other", Body: "root",
	}

	if err := svc.SetThreadFollow(ctx, "u-me", "ch-1", ParentChannel, "m-root", true); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}
	got, err := follows.GetThreadFollow(ctx, "u-me", "ch-1", "m-root")
	if err != nil {
		t.Fatalf("GetThreadFollow: %v", err)
	}
	if !got.Following || got.ParentType != ParentChannel {
		t.Fatalf("follow = %+v, want following channel row", got)
	}
}

func TestMessageService_SetThreadFollow_ConversationAndListUserThreads(t *testing.T) {
	svc, messages, _, conversations, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	ctx := context.Background()
	conversations.conversations["conv-1"] = &model.Conversation{
		ID: "conv-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-me", "u-other"},
	}
	conversations.userConvs["u-me"] = []*model.UserConversation{{UserID: "u-me", ConversationID: "conv-1"}}
	now := time.Now()
	messages.messages["conv-1#m-root"] = &model.Message{
		ID: "m-root", ParentID: "conv-1", AuthorID: "u-other", Body: "root", CreatedAt: now.Add(-time.Hour), ReplyCount: 1,
	}
	messages.messages["conv-1#m-r1"] = &model.Message{
		ID: "m-r1", ParentID: "conv-1", AuthorID: "u-someone", Body: "reply", CreatedAt: now.Add(-30 * time.Minute), ParentMessageID: "m-root",
	}

	if err := svc.SetThreadFollow(ctx, "u-me", "conv-1", ParentConversation, "m-root", true); err != nil {
		t.Fatalf("SetThreadFollow conversation: %v", err)
	}
	got, err := svc.ListUserThreads(ctx, "u-me")
	if err != nil {
		t.Fatalf("ListUserThreads: %v", err)
	}
	if len(got) != 1 || got[0].ParentType != ParentConversation || got[0].ThreadRootID != "m-root" {
		t.Fatalf("ListUserThreads = %+v, want followed conversation thread", got)
	}
}

func TestMessageService_SetThreadFollow_InvalidConfigurationAndParentType(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	ctx := context.Background()
	if err := svc.SetThreadFollow(ctx, "u-me", "ch-1", "bogus", "root", true); err == nil {
		t.Fatal("expected invalid parent type error")
	}
	if err := svc.SetThreadFollow(ctx, "u-me", "ch-1", ParentChannel, "root", true); err == nil {
		t.Fatal("expected missing follow store error")
	}
}

func TestMessageService_CheckAccess(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch-1#u-me"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-me"}
	if err := svc.CheckAccess(ctx, "u-me", "ch-1", ParentChannel); err != nil {
		t.Fatalf("CheckAccess channel: %v", err)
	}
	if err := svc.CheckAccess(ctx, "u-me", "ch-1", "bogus"); err == nil {
		t.Fatal("expected invalid parent type error")
	}
}

func TestMessageService_SetThreadFollow_AccessAndMissingRootErrors(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	svc.SetThreadFollowStore(newMockThreadFollowStore())
	ctx := context.Background()

	if err := svc.SetThreadFollow(ctx, "u-me", "ch-1", ParentChannel, "root", true); err == nil {
		t.Fatal("expected access error")
	}
	memberships.memberships["ch-1#u-me"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-me"}
	if err := svc.SetThreadFollow(ctx, "u-me", "ch-1", ParentChannel, "missing", true); err == nil {
		t.Fatal("expected missing root error")
	}
	messages.messages["ch-1#root"] = &model.Message{ID: "root", ParentID: "ch-other", AuthorID: "u-other"}
	if err := svc.SetThreadFollow(ctx, "u-me", "ch-1", ParentChannel, "root", false); err != nil {
		t.Fatalf("SetThreadFollow accepts existing top-level root regardless of stored parent mismatch: %v", err)
	}
}

// The general happy path is covered by TestMessageService_ListPinned_UsesIndex;
// dropped the scan-and-filter-on-Pinned-flag variant when the legacy
// no-index code path was removed (production always wires the index).

func TestMessageService_ListPinned_NotMemberRejected(t *testing.T) {
	svc, messages, _, _, _ := setupMessageService()
	ctx := context.Background()
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u-1", Pinned: true}

	if _, err := svc.ListPinned(ctx, "stranger", "ch1", ParentChannel); err == nil {
		t.Fatal("expected ListPinned to reject non-members")
	}
}

// The general happy path is covered by TestMessageService_ListFiles_UsesIndex;
// attachment dedup happens at the FILE# index write side
// (SetFileIndex upserts per (parentID, attachmentID) — the latest
// sharer wins by row identity, not by scan-time filtering).

func TestMessageService_ListFiles_NotMemberRejected(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	if _, err := svc.ListFiles(context.Background(), "stranger", "ch1", ParentChannel); err == nil {
		t.Fatal("expected ListFiles to reject non-members")
	}
}

func TestMessageService_SetPinned_NotMemberRejected(t *testing.T) {
	svc, messages, _, _, _ := setupMessageService()
	ctx := context.Background()
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u-1"}

	if _, err := svc.SetPinned(ctx, "stranger", "ch1", ParentChannel, "m-1", true); err == nil {
		t.Fatal("expected SetPinned to reject non-members")
	}
}

func TestMessageService_SetNoUnfurl_AuthorTogglesAndPublishes(t *testing.T) {
	svc, messages, memberships, _, publisher := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u-1"}

	got, err := svc.SetNoUnfurl(ctx, "u-1", "ch1", ParentChannel, "m-1", true)
	if err != nil {
		t.Fatalf("SetNoUnfurl: %v", err)
	}
	if !got.NoUnfurl {
		t.Error("expected NoUnfurl=true after dismiss")
	}
	if len(publisher.published) != 1 || publisher.published[0].event.Type != "message.edited" {
		t.Errorf("expected one message.edited event; got %d (%v)", len(publisher.published), publisher.published)
	}

	// Idempotent — toggling to the same value publishes nothing more.
	if _, err := svc.SetNoUnfurl(ctx, "u-1", "ch1", ParentChannel, "m-1", true); err != nil {
		t.Fatalf("idempotent SetNoUnfurl: %v", err)
	}
	if len(publisher.published) != 1 {
		t.Errorf("idempotent dismiss republished; total events = %d", len(publisher.published))
	}
}

func TestMessageService_SetNoUnfurl_NonAuthorRejected(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#stranger"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "stranger", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u-1"}
	if _, err := svc.SetNoUnfurl(context.Background(), "stranger", "ch1", ParentChannel, "m-1", true); err == nil {
		t.Fatal("expected non-author to be rejected")
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

	// Soft delete: row stays so threads still resolve, but the body and
	// any attachments / reactions are cleared and the Deleted flag is set.
	stored, ok := messages.messages["ch1#msg-del"]
	if !ok {
		t.Fatal("expected soft-deleted message to remain in the store")
	}
	if !stored.Deleted {
		t.Error("expected stored.Deleted = true")
	}
	if stored.Body != "" {
		t.Errorf("expected body cleared, got %q", stored.Body)
	}
	if len(stored.AttachmentIDs) != 0 {
		t.Errorf("expected attachments cleared, got %v", stored.AttachmentIDs)
	}
	if stored.Reactions != nil {
		t.Errorf("expected reactions cleared, got %v", stored.Reactions)
	}
}

func TestMessageService_Delete_ThreadReplyEventCarriesParentMessageID(t *testing.T) {
	svc, messages, memberships, _, publisher := setupMessageService()
	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	// Deleting a reply (parentMessageID set) must surface that ID in
	// the event so the client can invalidate the right thread query —
	// otherwise the thread sidebar / /threads page show stale data.
	messages.messages["ch1#m-reply"] = &model.Message{
		ID: "m-reply", ParentID: "ch1", AuthorID: "user-1",
		ParentMessageID: "m-root", Body: "in thread",
	}
	if err := svc.Delete(context.Background(), "user-1", "ch1", ParentChannel, "m-reply"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if len(publisher.published) != 1 {
		t.Fatalf("expected 1 event, got %d", len(publisher.published))
	}
	ev := publisher.published[0].event
	if ev.Type != "message.deleted" {
		t.Fatalf("event type = %q, want message.deleted", ev.Type)
	}
	raw, err := json.Marshal(ev.Data)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	var payload struct {
		ID              string   `json:"id"`
		ParentID        string   `json:"parentID"`
		ParentMessageID string   `json:"parentMessageID"`
		Body            string   `json:"body"`
		Deleted         bool     `json:"deleted"`
		AttachmentIDs   []string `json:"attachmentIDs"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	if payload.ParentMessageID != "m-root" {
		t.Errorf("parentMessageID = %q, want m-root", payload.ParentMessageID)
	}
	if payload.ID != "m-reply" || payload.ParentID != "ch1" {
		t.Errorf("payload = %+v, expected id=m-reply parentID=ch1", payload)
	}
	if !payload.Deleted {
		t.Error("expected deleted tombstone payload")
	}
	if payload.Body != "" {
		t.Errorf("payload body = %q, want empty", payload.Body)
	}
	if len(payload.AttachmentIDs) != 0 {
		t.Errorf("payload attachments = %v, want empty", payload.AttachmentIDs)
	}
}

func TestMessageService_Delete_CascadesThreadReplies(t *testing.T) {
	svc, messages, memberships, _, publisher := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}

	// A thread: one root + two replies, plus an unrelated top-level
	// message that must be left untouched.
	messages.messages["ch1#root"] = &model.Message{
		ID: "root", ParentID: "ch1", AuthorID: "user-1", Body: "root", ReplyCount: 2,
	}
	messages.messages["ch1#r1"] = &model.Message{
		ID: "r1", ParentID: "ch1", AuthorID: "user-2", ParentMessageID: "root", Body: "first reply",
	}
	messages.messages["ch1#r2"] = &model.Message{
		ID: "r2", ParentID: "ch1", AuthorID: "user-3", ParentMessageID: "root", Body: "second reply",
	}
	messages.messages["ch1#other"] = &model.Message{
		ID: "other", ParentID: "ch1", AuthorID: "user-1", Body: "unrelated",
	}

	if err := svc.Delete(ctx, "user-1", "ch1", ParentChannel, "root"); err != nil {
		t.Fatalf("Delete root: %v", err)
	}

	for _, id := range []string{"root", "r1", "r2"} {
		got := messages.messages["ch1#"+id]
		if !got.Deleted {
			t.Errorf("%s: expected Deleted=true after cascade", id)
		}
		if got.Body != "" {
			t.Errorf("%s: expected body cleared, got %q", id, got.Body)
		}
	}
	if messages.messages["ch1#other"].Deleted {
		t.Error("unrelated top-level message must not be cascade-deleted")
	}

	// One message.deleted event per tombstoned message: root + 2 replies.
	deletedEvents := 0
	for _, p := range publisher.published {
		if p.event.Type == "message.deleted" {
			deletedEvents++
		}
	}
	if deletedEvents != 3 {
		t.Errorf("message.deleted events = %d, want 3 (root + 2 replies)", deletedEvents)
	}
}

func TestMessageService_Delete_ReplyDoesNotCascade(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "user-1", Body: "root"}
	messages.messages["ch1#r1"] = &model.Message{ID: "r1", ParentID: "ch1", AuthorID: "user-1", ParentMessageID: "root", Body: "keep me"}
	messages.messages["ch1#r2"] = &model.Message{ID: "r2", ParentID: "ch1", AuthorID: "user-1", ParentMessageID: "root", Body: "delete me"}

	if err := svc.Delete(ctx, "user-1", "ch1", ParentChannel, "r2"); err != nil {
		t.Fatalf("Delete reply: %v", err)
	}

	if !messages.messages["ch1#r2"].Deleted {
		t.Error("deleted reply should be Deleted=true")
	}
	if messages.messages["ch1#root"].Deleted {
		t.Error("deleting a reply must not delete the thread root")
	}
	if messages.messages["ch1#r1"].Deleted {
		t.Error("deleting a reply must not delete sibling replies")
	}
}

// A reply whose tombstone Update fails is logged but doesn't fail the root
// delete — the root tombstone already closed the thread to new replies.
func TestMessageService_Delete_CascadeReplyUpdateError_Swallowed(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "user-1", Body: "root"}
	messages.messages["ch1#r1"] = &model.Message{ID: "r1", ParentID: "ch1", AuthorID: "user-1", ParentMessageID: "root", Body: "reply"}
	// Fail the Update for the reply only — the root tombstone must still succeed.
	messages.updateErrID = "r1"

	if err := svc.Delete(ctx, "user-1", "ch1", ParentChannel, "root"); err != nil {
		t.Fatalf("Delete root should swallow reply cascade error: %v", err)
	}
	if !messages.messages["ch1#root"].Deleted {
		t.Error("root should be tombstoned despite reply cascade failure")
	}
}

// If the cascade scan fails after the root is tombstoned, the root delete
// still succeeds — the scan error is best-effort and logged.
func TestMessageService_Delete_CascadeScanError_Swallowed(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#root"] = &model.Message{ID: "root", ParentID: "ch1", AuthorID: "user-1", Body: "root"}
	// GetMessage + UpdateMessage (root delete) still work; only the
	// reply-scan via ListMessages fails.
	messages.listErr = errors.New("boom")

	if err := svc.Delete(ctx, "user-1", "ch1", ParentChannel, "root"); err != nil {
		t.Fatalf("Delete root should swallow cascade scan error: %v", err)
	}
	if !messages.messages["ch1#root"].Deleted {
		t.Error("root should be tombstoned despite cascade scan failure")
	}
}

func TestMessageService_Send_RejectsReplyToDeletedThread(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	// A soft-deleted thread root: the thread is closed for good.
	messages.messages["ch1#root"] = &model.Message{
		ID: "root", ParentID: "ch1", AuthorID: "user-1", Deleted: true,
	}

	_, err := svc.Send(ctx, "user-1", "ch1", ParentChannel, "late reply", "root")
	if !errors.Is(err, ErrThreadDeleted) {
		t.Fatalf("Send to deleted thread err = %v, want ErrThreadDeleted", err)
	}
	// No message row should have been created for the rejected reply.
	if len(messages.messages) != 1 {
		t.Errorf("expected no new message, store has %d", len(messages.messages))
	}
}

func TestMessageService_Send_ThreadRootMissing(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}

	_, err := svc.Send(ctx, "user-1", "ch1", ParentChannel, "orphan reply", "no-such-root")
	if err == nil {
		t.Fatal("expected error replying to a non-existent thread root")
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
			var payload model.Message
			if err := json.Unmarshal(e.event.Data, &payload); err != nil {
				t.Fatalf("unmarshal message.new: %v", err)
			}
			if payload.ParentType != ParentChannel {
				t.Fatalf("message.new parentType = %q, want %q", payload.ParentType, ParentChannel)
			}
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

type inspectingPublisher struct {
	onPublish func(eventType string)
}

func (p *inspectingPublisher) Publish(_ context.Context, _ string, event *events.Event) error {
	if p.onPublish != nil {
		p.onPublish(event.Type)
	}
	return nil
}

func TestSendMessage_ThreadStateReadyBeforeMessageNew(t *testing.T) {
	messages := newMockMessageStore()
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	follows := newMockThreadFollowStore()
	ctx := context.Background()

	for _, userID := range []string{"u-root", "u-replier", "u-mentioned"} {
		memberships.memberships["ch-race#"+userID] = &model.ChannelMembership{
			ChannelID: "ch-race",
			UserID:    userID,
			Role:      model.ChannelRoleMember,
		}
	}
	messages.messages["ch-race#root-msg"] = &model.Message{
		ID:       "root-msg",
		ParentID: "ch-race",
		AuthorID: "u-root",
		Body:     "root",
	}

	var sawMessageNew bool
	publisher := &inspectingPublisher{
		onPublish: func(eventType string) {
			if eventType != events.EventMessageNew {
				return
			}
			sawMessageNew = true
			if got := messages.messages["ch-race#root-msg"].ReplyCount; got != 1 {
				t.Errorf("root ReplyCount at message.new = %d, want 1", got)
			}
			if _, ok := follows.follows[threadFollowMockKey("u-mentioned", "ch-race", "root-msg")]; !ok {
				t.Errorf("mentioned user follow missing before message.new")
			}
		},
	}
	svc := NewMessageService(messages, memberships, conversations, publisher, newMockBroker())
	svc.SetThreadFollowStore(follows)

	if _, err := svc.Send(ctx, "u-replier", "ch-race", ParentChannel, "reply @[u-mentioned|Mentioned]", "root-msg"); err != nil {
		t.Fatalf("Send reply: %v", err)
	}
	if !sawMessageNew {
		t.Fatal("expected message.new event")
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

// An un-backfilled thread (GSI returns nothing but the root records replies)
// falls back to the parent scan so historical threads stay complete.
func TestMessageService_ListThreadMessages_FallbackScan(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch-fb#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-fb", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch-fb#01-root"] = &model.Message{
		ID: "01-root", ParentID: "ch-fb", AuthorID: "user-1", Body: "root", ReplyCount: 2,
	}
	messages.messages["ch-fb#02-r1"] = &model.Message{
		ID: "02-r1", ParentID: "ch-fb", AuthorID: "user-1", Body: "r1", ParentMessageID: "01-root",
	}
	messages.messages["ch-fb#03-r2"] = &model.Message{
		ID: "03-r2", ParentID: "ch-fb", AuthorID: "user-1", Body: "r2", ParentMessageID: "01-root",
	}
	// Index empty (pre-migration) → service must scan to find the replies.
	messages.noThreadIndex = true

	thread, err := svc.ListThreadMessages(ctx, "user-1", "ch-fb", ParentChannel, "01-root")
	if err != nil {
		t.Fatalf("ListThreadMessages: %v", err)
	}
	if len(thread) != 3 {
		t.Fatalf("len(thread) = %d, want 3 via scan fallback", len(thread))
	}

	// And the fallback scan propagates its errors.
	messages.listErr = errors.New("scan boom")
	if _, err := svc.ListThreadMessages(ctx, "user-1", "ch-fb", ParentChannel, "01-root"); err == nil {
		t.Fatal("expected scan-fallback error")
	}
}

// A non-NotFound error fetching the root surfaces as an error.
func TestMessageService_ListThreadMessages_RootGetError(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch-rge#user-1"] = &model.ChannelMembership{
		ChannelID: "ch-rge", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.getErr = errors.New("get boom")
	if _, err := svc.ListThreadMessages(context.Background(), "user-1", "ch-rge", ParentChannel, "root"); err == nil {
		t.Fatal("expected root-get error")
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

// recordingNotifier captures the message IDs NotifyForMessage is invoked with,
// so a test can assert which send paths do (and do not) fan out a user-facing
// notification. NotifyForMessage runs in a detached goroutine, hence the
// buffered channel.
type recordingNotifier struct {
	calls chan string
}

func (r *recordingNotifier) NotifyForMessage(_ context.Context, msg *model.Message, _ string) {
	r.calls <- msg.ID
}

// Reacting to a message must NEVER produce a user-facing notification (sound /
// popup / push). A reaction only publishes message.edited to refresh the UI;
// it does not go through the notifier. A user reported "I got a ping when
// someone reacted" — this guards against that, and against a future change that
// wires the shared message.edited path into notifications. The positive control
// (a real Send DOES notify) guarantees the negative assertion isn't vacuous:
// once Send's notification has landed, a reaction notification (spawned earlier)
// would have landed too.
func TestMessageService_ToggleReaction_DoesNotNotify(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	rec := &recordingNotifier{calls: make(chan string, 8)}
	svc.SetNotifier(rec)
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	messages.messages["ch1#m1"] = &model.Message{ID: "m1", ParentID: "ch1", AuthorID: "user-2", Body: "hi"}

	// Reacting — must not notify.
	if _, err := svc.ToggleReaction(ctx, "user-1", "ch1", ParentChannel, "m1", "👍"); err != nil {
		t.Fatalf("ToggleReaction: %v", err)
	}
	// Positive control — a real send DOES notify.
	sent, err := svc.Send(ctx, "user-1", "ch1", ParentChannel, "real message", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	select {
	case id := <-rec.calls:
		if id == "m1" {
			t.Fatalf("reaction on m1 triggered a notification; reactions must never notify")
		}
		if id != sent.ID {
			t.Fatalf("unexpected notification for %q, want the sent message %q", id, sent.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("positive control failed: a real Send did not notify")
	}
	// No further notification may arrive — in particular not the reaction's.
	select {
	case extra := <-rec.calls:
		t.Fatalf("a second notification fired for %q; the reaction must not notify", extra)
	case <-time.After(200 * time.Millisecond):
	}
}

// Adding a 17th distinct emoji to a message must be rejected. Toggling
// an emoji that's already on the message (whether the user reacted with
// it or not) must still work — the cap is on distinct *kinds* of
// reactions, not on the number of users.
func TestMessageService_ToggleReaction_DistinctEmojiCap(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	memberships.memberships["ch1#user-1"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "user-1", Role: model.ChannelRoleMember,
	}
	// Pre-fill 16 distinct reactions from another user.
	existing := map[string][]string{}
	for i := 0; i < MaxDistinctReactions; i++ {
		existing[string(rune('a'+i))] = []string{"user-2"}
	}
	messages.messages["ch1#m1"] = &model.Message{
		ID: "m1", ParentID: "ch1", AuthorID: "user-2", Body: "hi", Reactions: existing,
	}

	// 17th distinct emoji from a third party → rejected.
	if _, err := svc.ToggleReaction(ctx, "user-1", "ch1", ParentChannel, "m1", "👍"); !errorsIs(err, ErrTooManyReactions) {
		t.Errorf("got %v, want ErrTooManyReactions", err)
	}

	// Toggling an existing emoji (joining or leaving the group) is
	// always allowed — it doesn't grow the distinct-set.
	if _, err := svc.ToggleReaction(ctx, "user-1", "ch1", ParentChannel, "m1", "a"); err != nil {
		t.Errorf("toggling existing emoji rejected: %v", err)
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

// A reply that mentions multiple eligible members must drive the
// auto-follow path through SetThreadFollowMany once, not a per-user
// SetThreadFollow loop. Regression for the N round-trips bug on the
// message-send hot path.
func TestMessageService_Send_ThreadReplyBatchesMentionFollows(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	ctx := context.Background()

	memberships.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author", Role: model.ChannelRoleMember}
	for _, id := range []string{"u-bob", "u-cara", "u-dave"} {
		memberships.memberships["ch1#"+id] = &model.ChannelMembership{ChannelID: "ch1", UserID: id, Role: model.ChannelRoleMember}
	}
	messages.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-other", Body: "root"}

	body := "ping @[u-bob|Bob] @[u-cara|Cara] @[u-dave|Dave]"
	if _, err := svc.Send(ctx, "u-author", "ch1", ParentChannel, body, "m-root"); err != nil {
		t.Fatalf("Send: %v", err)
	}

	if follows.setManyCalls != 1 {
		t.Fatalf("SetThreadFollowMany called %d times, want exactly 1", follows.setManyCalls)
	}
	if follows.setManyMaxBatch != 3 {
		t.Errorf("max batch size = %d, want 3 (one per mentioned member)", follows.setManyMaxBatch)
	}
	if follows.setCalls != 0 {
		t.Errorf("per-user SetThreadFollow called %d times; the batch path should be exclusive on the auto-follow flow", follows.setCalls)
	}
	for _, id := range []string{"u-bob", "u-cara", "u-dave"} {
		got, err := follows.GetThreadFollow(ctx, id, "ch1", "m-root")
		if err != nil || !got.Following {
			t.Errorf("%s should be following thread, got %+v err=%v", id, got, err)
		}
	}
}

// Duplicate mentions of the same user (e.g. @bob @bob) must not
// produce duplicate batch entries — that would inflate write cost
// and could resurrect a stale UpdatedAt for a user who already
// unfollowed.
func TestMessageService_Send_ThreadReplyDeduplicatesRepeatedMentions(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	ctx := context.Background()

	memberships.memberships["ch1#u-author"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-author", Role: model.ChannelRoleMember}
	memberships.memberships["ch1#u-bob"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-bob", Role: model.ChannelRoleMember}
	messages.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-other", Body: "root"}

	body := "@[u-bob|Bob] hey @[u-bob|Bob] still there?"
	if _, err := svc.Send(ctx, "u-author", "ch1", ParentChannel, body, "m-root"); err != nil {
		t.Fatalf("Send: %v", err)
	}

	if follows.setManyMaxBatch != 1 {
		t.Errorf("expected dedup to a single batch entry, got %d", follows.setManyMaxBatch)
	}
}

// ListPinned via the index must return ONLY pinned messages — and
// must do so without the legacy 1000-message scan (the index store
// is the single source of truth in this test, no message-list scan
// would ever surface the pinned IDs).
func TestMessageService_ListPinned_UsesIndex(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	ctx := context.Background()

	memberships.memberships["ch-pin#u-bob"] = &model.ChannelMembership{ChannelID: "ch-pin", UserID: "u-bob", Role: model.ChannelRoleMember}
	messages.messages["ch-pin#m-1"] = &model.Message{ID: "m-1", ParentID: "ch-pin", AuthorID: "u-bob", Body: "first", Pinned: true}
	messages.messages["ch-pin#m-2"] = &model.Message{ID: "m-2", ParentID: "ch-pin", AuthorID: "u-bob", Body: "noisy"}
	messages.messages["ch-pin#m-3"] = &model.Message{ID: "m-3", ParentID: "ch-pin", AuthorID: "u-bob", Body: "third", Pinned: true}
	// Index says only m-1 and m-3 are pinned.
	now := time.Now()
	_ = idx.SetPinIndex(ctx, "ch-pin", "m-1", "u-bob", now)
	_ = idx.SetPinIndex(ctx, "ch-pin", "m-3", "u-bob", now)

	got, err := svc.ListPinned(ctx, "u-bob", "ch-pin", ParentChannel)
	if err != nil {
		t.Fatalf("ListPinned: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d messages, want 2", len(got))
	}
	seen := map[string]bool{}
	for _, m := range got {
		seen[m.ID] = true
	}
	if !seen["m-1"] || !seen["m-3"] {
		t.Errorf("expected m-1 and m-3 to be returned, got %v", seen)
	}
}

// SetPinned must mirror state into the index (pin → row created,
// unpin → row deleted) so subsequent ListPinned returns the right
// set without a scan fallback.
func TestMessageService_SetPinned_MaintainsIndex(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	ctx := context.Background()

	memberships.memberships["ch-x#u-alice"] = &model.ChannelMembership{ChannelID: "ch-x", UserID: "u-alice", Role: model.ChannelRoleMember}
	messages.messages["ch-x#m-x"] = &model.Message{ID: "m-x", ParentID: "ch-x", AuthorID: "u-alice", Body: "hello"}

	if _, err := svc.SetPinned(ctx, "u-alice", "ch-x", ParentChannel, "m-x", true); err != nil {
		t.Fatalf("Pin: %v", err)
	}
	rows, _ := idx.ListPinIndex(ctx, "ch-x")
	if len(rows) != 1 || rows[0].MessageID != "m-x" {
		t.Errorf("after pin: expected one index row for m-x, got %+v", rows)
	}

	if _, err := svc.SetPinned(ctx, "u-alice", "ch-x", ParentChannel, "m-x", false); err != nil {
		t.Fatalf("Unpin: %v", err)
	}
	rows, _ = idx.ListPinIndex(ctx, "ch-x")
	if len(rows) != 0 {
		t.Errorf("after unpin: expected empty index, got %+v", rows)
	}
}

// Send with attachments must populate the FILE# index — so ListFiles
// returns the attachment without a message-list scan.
func TestMessageService_Send_PopulatesFileIndex(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	ctx := context.Background()
	memberships.memberships["ch-files#u-alice"] = &model.ChannelMembership{ChannelID: "ch-files", UserID: "u-alice", Role: model.ChannelRoleMember}

	msg, err := svc.Send(ctx, "u-alice", "ch-files", ParentChannel, "see attached", "", "att-A", "att-B")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	rows, _ := idx.ListFileIndex(ctx, "ch-files")
	if len(rows) != 2 {
		t.Fatalf("expected 2 file index rows, got %d", len(rows))
	}
	seen := map[string]string{}
	for _, r := range rows {
		seen[r.AttachmentID] = r.MessageID
	}
	if seen["att-A"] != msg.ID || seen["att-B"] != msg.ID {
		t.Errorf("file index didn't capture both attachments: %v", seen)
	}
}

// ListFiles via the index returns rows in reverse-chronological
// order (newest share first) without scanning messages.
func TestMessageService_ListFiles_UsesIndex(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	ctx := context.Background()
	memberships.memberships["ch-files-list#u-bob"] = &model.ChannelMembership{ChannelID: "ch-files-list", UserID: "u-bob", Role: model.ChannelRoleMember}

	older := time.Now().Add(-1 * time.Hour)
	newer := time.Now()
	_ = idx.SetFileIndex(ctx, "ch-files-list", "att-old", "m-old", "u-bob", older)
	_ = idx.SetFileIndex(ctx, "ch-files-list", "att-new", "m-new", "u-bob", newer)

	files, err := svc.ListFiles(ctx, "u-bob", "ch-files-list", ParentChannel)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("got %d files, want 2", len(files))
	}
	if files[0].AttachmentID != "att-new" {
		t.Errorf("expected newest first, got %q", files[0].AttachmentID)
	}
}

// Deleting a message that owned a FILE# row must clear the row so
// ListFiles doesn't surface a tombstone reference. If a different
// message has since claimed the row (re-share), that row must
// survive — the test sets that up explicitly.
func TestMessageService_Delete_CleansUpIndexRows(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	ctx := context.Background()

	memberships.memberships["ch-del#u-alice"] = &model.ChannelMembership{ChannelID: "ch-del", UserID: "u-alice", Role: model.ChannelRoleMember}
	messages.messages["ch-del#m-pinned"] = &model.Message{ID: "m-pinned", ParentID: "ch-del", AuthorID: "u-alice", Body: "x", Pinned: true, AttachmentIDs: []string{"att-only"}}
	messages.messages["ch-del#m-shared-old"] = &model.Message{ID: "m-shared-old", ParentID: "ch-del", AuthorID: "u-alice", Body: "y", AttachmentIDs: []string{"att-resshared"}}
	now := time.Now()
	_ = idx.SetPinIndex(ctx, "ch-del", "m-pinned", "u-alice", now)
	_ = idx.SetFileIndex(ctx, "ch-del", "att-only", "m-pinned", "u-alice", now)
	// "att-resshared" is currently owned by a NEWER message in the
	// index — deleting m-shared-old must not touch this row.
	_ = idx.SetFileIndex(ctx, "ch-del", "att-resshared", "m-newer", "u-alice", now.Add(time.Hour))

	if err := svc.Delete(ctx, "u-alice", "ch-del", ParentChannel, "m-pinned"); err != nil {
		t.Fatalf("Delete pinned: %v", err)
	}
	if rows, _ := idx.ListPinIndex(ctx, "ch-del"); len(rows) != 0 {
		t.Errorf("pin index should be empty after delete, got %+v", rows)
	}
	files, _ := idx.ListFileIndex(ctx, "ch-del")
	if len(files) != 1 || files[0].AttachmentID != "att-resshared" {
		t.Errorf("file index should retain only the still-shared file, got %+v", files)
	}

	// Now delete m-shared-old — its only attachment is owned by a
	// newer message in the index, so the row must NOT be removed.
	if err := svc.Delete(ctx, "u-alice", "ch-del", ParentChannel, "m-shared-old"); err != nil {
		t.Fatalf("Delete old: %v", err)
	}
	files, _ = idx.ListFileIndex(ctx, "ch-del")
	if len(files) != 1 || files[0].MessageID != "m-newer" {
		t.Errorf("re-shared file row should survive delete of older sharer, got %+v", files)
	}
}

// ListPinned must self-heal stale index rows: if the index references
// a message that no longer exists, or a message whose Pinned flag was
// flipped off out-of-band, the list should drop that row from the
// response and best-effort delete it from the index.
func TestMessageService_ListPinned_SelfHealsStaleIndexRows(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	ctx := context.Background()

	memberships.memberships["ch-stale#u-bob"] = &model.ChannelMembership{ChannelID: "ch-stale", UserID: "u-bob", Role: model.ChannelRoleMember}
	messages.messages["ch-stale#m-real"] = &model.Message{ID: "m-real", ParentID: "ch-stale", AuthorID: "u-bob", Body: "alive", Pinned: true}
	// A live row.
	now := time.Now()
	_ = idx.SetPinIndex(ctx, "ch-stale", "m-real", "u-bob", now)
	// A row pointing at a missing message — simulates a deletion-cleanup race.
	_ = idx.SetPinIndex(ctx, "ch-stale", "m-missing", "u-bob", now)
	// A row whose underlying message is no longer flagged Pinned.
	messages.messages["ch-stale#m-unpinned"] = &model.Message{ID: "m-unpinned", ParentID: "ch-stale", AuthorID: "u-bob", Body: "x", Pinned: false}
	_ = idx.SetPinIndex(ctx, "ch-stale", "m-unpinned", "u-bob", now)

	got, err := svc.ListPinned(ctx, "u-bob", "ch-stale", ParentChannel)
	if err != nil {
		t.Fatalf("ListPinned: %v", err)
	}
	if len(got) != 1 || got[0].ID != "m-real" {
		t.Errorf("expected only the live pinned message, got %+v", got)
	}
	// Stale rows should have been cleaned up.
	rows, _ := idx.ListPinIndex(ctx, "ch-stale")
	if len(rows) != 1 {
		t.Errorf("expected stale rows to be reaped, got %d", len(rows))
	}
}

// Edit that changes the attachment list must add new FILE# rows and
// drop rows that pointed at removed attachments — but only when the
// row's MessageID still points at the message being edited (a more-
// recent share of the same SHA must survive).
func TestMessageService_Edit_MaintainsFileIndex(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	idx := newMockParentIndex()
	svc.SetParentIndex(idx)
	ctx := context.Background()

	memberships.memberships["ch-edit#u-alice"] = &model.ChannelMembership{ChannelID: "ch-edit", UserID: "u-alice", Role: model.ChannelRoleMember}
	now := time.Now()
	original := &model.Message{ID: "m-edit", ParentID: "ch-edit", AuthorID: "u-alice", Body: "x", AttachmentIDs: []string{"att-old"}, CreatedAt: now}
	messages.messages["ch-edit#m-edit"] = original
	// Pre-populate the file index for the original attachment.
	_ = idx.SetFileIndex(ctx, "ch-edit", "att-old", "m-edit", "u-alice", now)
	// Also: a row owned by a different message must NOT be removed.
	_ = idx.SetFileIndex(ctx, "ch-edit", "att-survives", "m-other", "u-alice", now.Add(time.Hour))

	if _, err := svc.Edit(ctx, "u-alice", "ch-edit", ParentChannel, "m-edit", "x edited", []string{"att-new", "att-survives"}); err != nil {
		t.Fatalf("Edit: %v", err)
	}

	rows, _ := idx.ListFileIndex(ctx, "ch-edit")
	gotIDs := make(map[string]string)
	for _, r := range rows {
		gotIDs[r.AttachmentID] = r.MessageID
	}
	// att-old must be removed (the only message that pointed at it
	// dropped the attachment).
	if _, present := gotIDs["att-old"]; present {
		t.Error("att-old row should have been removed after edit dropped the attachment")
	}
	// att-new is freshly added, owned by m-edit.
	if gotIDs["att-new"] != "m-edit" {
		t.Errorf("att-new should be owned by m-edit, got %v", gotIDs)
	}
	// att-survives is still owned by m-other (newer share). The edit
	// must NOT clobber that row with m-edit even though m-edit also
	// references att-survives.
	if gotIDs["att-survives"] != "m-other" {
		t.Errorf("att-survives must keep its newer-share owner m-other, got %v", gotIDs)
	}
}

// Index failures must be logged but not block the operation that
// triggered them — the message itself is the source of truth.
// These tests cover the slog Warn fallback branches.
func TestMessageService_IndexFailuresDoNotBlockOperations(t *testing.T) {
	t.Run("Send tolerates file index errors", func(t *testing.T) {
		svc, _, memberships, _, _ := setupMessageService()
		svc.SetParentIndex(erroringParentIndex{})
		ctx := context.Background()
		memberships.memberships["ch-err#u-alice"] = &model.ChannelMembership{ChannelID: "ch-err", UserID: "u-alice", Role: model.ChannelRoleMember}

		msg, err := svc.Send(ctx, "u-alice", "ch-err", ParentChannel, "x", "", "att-1", "att-2")
		if err != nil {
			t.Fatalf("Send blocked by index error: %v", err)
		}
		if msg == nil {
			t.Fatal("Send returned nil message")
		}
	})

	t.Run("SetPinned tolerates pin index errors", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		svc.SetParentIndex(erroringParentIndex{})
		ctx := context.Background()
		memberships.memberships["ch-err2#u-alice"] = &model.ChannelMembership{ChannelID: "ch-err2", UserID: "u-alice", Role: model.ChannelRoleMember}
		messages.messages["ch-err2#m-1"] = &model.Message{ID: "m-1", ParentID: "ch-err2", AuthorID: "u-alice", Body: "x"}

		if _, err := svc.SetPinned(ctx, "u-alice", "ch-err2", ParentChannel, "m-1", true); err != nil {
			t.Fatalf("Pin blocked by index error: %v", err)
		}
		if _, err := svc.SetPinned(ctx, "u-alice", "ch-err2", ParentChannel, "m-1", false); err != nil {
			t.Fatalf("Unpin blocked by index error: %v", err)
		}
	})

	t.Run("Delete tolerates index errors", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		svc.SetParentIndex(erroringParentIndex{})
		ctx := context.Background()
		memberships.memberships["ch-err3#u-alice"] = &model.ChannelMembership{ChannelID: "ch-err3", UserID: "u-alice", Role: model.ChannelRoleMember}
		messages.messages["ch-err3#m-1"] = &model.Message{ID: "m-1", ParentID: "ch-err3", AuthorID: "u-alice", Body: "x", Pinned: true, AttachmentIDs: []string{"att-1"}}

		if err := svc.Delete(ctx, "u-alice", "ch-err3", ParentChannel, "m-1"); err != nil {
			t.Fatalf("Delete blocked by index error: %v", err)
		}
	})

	t.Run("Edit tolerates index errors", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		svc.SetParentIndex(erroringParentIndex{})
		ctx := context.Background()
		memberships.memberships["ch-err4#u-alice"] = &model.ChannelMembership{ChannelID: "ch-err4", UserID: "u-alice", Role: model.ChannelRoleMember}
		messages.messages["ch-err4#m-1"] = &model.Message{ID: "m-1", ParentID: "ch-err4", AuthorID: "u-alice", Body: "x", AttachmentIDs: []string{"att-old"}, CreatedAt: time.Now()}

		if _, err := svc.Edit(ctx, "u-alice", "ch-err4", ParentChannel, "m-1", "y", []string{"att-new"}); err != nil {
			t.Fatalf("Edit blocked by index error: %v", err)
		}
	})

	t.Run("ListPinned propagates list errors as caller-visible failures", func(t *testing.T) {
		svc, _, memberships, _, _ := setupMessageService()
		svc.SetParentIndex(erroringParentIndex{})
		ctx := context.Background()
		memberships.memberships["ch-list#u-alice"] = &model.ChannelMembership{ChannelID: "ch-list", UserID: "u-alice", Role: model.ChannelRoleMember}
		if _, err := svc.ListPinned(ctx, "u-alice", "ch-list", ParentChannel); err == nil {
			t.Error("expected ListPinned to surface index list error")
		}
	})

	t.Run("ListFiles propagates list errors as caller-visible failures", func(t *testing.T) {
		svc, _, memberships, _, _ := setupMessageService()
		svc.SetParentIndex(erroringParentIndex{})
		ctx := context.Background()
		memberships.memberships["ch-list-f#u-alice"] = &model.ChannelMembership{ChannelID: "ch-list-f", UserID: "u-alice", Role: model.ChannelRoleMember}
		if _, err := svc.ListFiles(ctx, "u-alice", "ch-list-f", ParentChannel); err == nil {
			t.Error("expected ListFiles to surface index list error")
		}
	})
}
