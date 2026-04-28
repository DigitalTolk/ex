package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// errorsIs is a thin wrapper so the new validation tests don't have to
// import errors at every callsite. The full path is exercised once
// elsewhere in the file.
func errorsIs(err, target error) bool { return errors.Is(err, target) }

// updateRecentAuthors backs the thread-action-bar avatar stack — at
// most 3 entries, newest first, deduped on every reply.
func TestUpdateRecentAuthors(t *testing.T) {
	cases := []struct {
		name string
		prev []string
		next string
		want []string
	}{
		{"empty", nil, "u1", []string{"u1"}},
		{"prepend", []string{"u1"}, "u2", []string{"u2", "u1"}},
		{"trim to three", []string{"u1", "u2", "u3"}, "u4", []string{"u4", "u1", "u2"}},
		{"dedup duplicate front", []string{"u1", "u2"}, "u1", []string{"u1", "u2"}},
		{"dedup duplicate middle", []string{"u1", "u2", "u3"}, "u2", []string{"u2", "u1", "u3"}},
	}
	for _, tc := range cases {
		got := updateRecentAuthors(tc.prev, tc.next)
		if len(got) != len(tc.want) {
			t.Errorf("%s: len(got)=%d want %d (got=%v)", tc.name, len(got), len(tc.want), got)
			continue
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Errorf("%s: got[%d]=%q want %q (full got=%v)", tc.name, i, got[i], tc.want[i], got)
			}
		}
	}
}

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

func TestMessageService_Send_NonMemberMention_PostsSystemMessage(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()

	// Author is a member, the mentioned user is NOT.
	memberships.memberships["ch1#u-author"] = &model.ChannelMembership{
		ChannelID: "ch1", UserID: "u-author", Role: model.ChannelRoleMember,
	}

	_, err := svc.Send(ctx, "u-author", "ch1", ParentChannel, "hi @[u-outsider|Outsider Sue]", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}

	// Two messages should now exist: the user's send + the system message.
	gotSystem := 0
	for _, m := range messages.messages {
		if m.System && m.ParentID == "ch1" {
			gotSystem++
			if !strings.Contains(m.Body, "Outsider Sue") {
				t.Errorf("system body should name the mentioned user; got %q", m.Body)
			}
			if !strings.Contains(m.Body, "isn't a member") {
				t.Errorf("system body should explain non-membership; got %q", m.Body)
			}
		}
	}
	if gotSystem != 1 {
		t.Errorf("expected exactly 1 system message; got %d", gotSystem)
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

func TestMessageService_ListPinned(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-1", Role: model.ChannelRoleMember}
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u-1", Pinned: true}
	messages.messages["ch1#m-2"] = &model.Message{ID: "m-2", ParentID: "ch1", AuthorID: "u-1", Pinned: false}
	messages.messages["ch1#m-3"] = &model.Message{ID: "m-3", ParentID: "ch1", AuthorID: "u-1", Pinned: true}

	pinned, err := svc.ListPinned(ctx, "u-1", "ch1", ParentChannel)
	if err != nil {
		t.Fatalf("ListPinned: %v", err)
	}
	if len(pinned) != 2 {
		t.Fatalf("expected 2 pinned, got %d", len(pinned))
	}
	for _, m := range pinned {
		if !m.Pinned {
			t.Errorf("ListPinned returned non-pinned message %s", m.ID)
		}
	}
}

func TestMessageService_ListPinned_NotMemberRejected(t *testing.T) {
	svc, messages, _, _, _ := setupMessageService()
	ctx := context.Background()
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u-1", Pinned: true}

	if _, err := svc.ListPinned(ctx, "stranger", "ch1", ParentChannel); err == nil {
		t.Fatal("expected ListPinned to reject non-members")
	}
}

func TestMessageService_ListFiles(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-1", Role: model.ChannelRoleMember}
	now := time.Now()
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u-1", AttachmentIDs: []string{"a-1", "a-2"}, CreatedAt: now.Add(-2 * time.Hour)}
	messages.messages["ch1#m-2"] = &model.Message{ID: "m-2", ParentID: "ch1", AuthorID: "u-2", CreatedAt: now.Add(-1 * time.Hour)} // no attachments
	messages.messages["ch1#m-3"] = &model.Message{ID: "m-3", ParentID: "ch1", AuthorID: "u-3", AttachmentIDs: []string{"a-3"}, CreatedAt: now}

	files, err := svc.ListFiles(ctx, "u-1", "ch1", ParentChannel)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("expected 3 file entries, got %d", len(files))
	}
	if files[0].AttachmentID != "a-3" {
		t.Errorf("expected newest first; got %q", files[0].AttachmentID)
	}
	// Two attachments from m-1 should both be present.
	got := map[string]bool{}
	for _, f := range files {
		got[f.AttachmentID] = true
	}
	if !got["a-1"] || !got["a-2"] || !got["a-3"] {
		t.Errorf("missing entries; got %+v", got)
	}
}

func TestMessageService_ListFiles_NotMemberRejected(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	if _, err := svc.ListFiles(context.Background(), "stranger", "ch1", ParentChannel); err == nil {
		t.Fatal("expected ListFiles to reject non-members")
	}
}

func TestMessageService_ListFiles_DedupesByAttachmentID(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	memberships.memberships["ch1#u-1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u-1", Role: model.ChannelRoleMember}
	now := time.Now()
	// Same physical attachment shared in three messages — only the
	// newest one should appear in the file browser.
	messages.messages["ch1#m-1"] = &model.Message{ID: "m-1", ParentID: "ch1", AuthorID: "u-1", AttachmentIDs: []string{"a-1"}, CreatedAt: now.Add(-3 * time.Hour)}
	messages.messages["ch1#m-2"] = &model.Message{ID: "m-2", ParentID: "ch1", AuthorID: "u-2", AttachmentIDs: []string{"a-1"}, CreatedAt: now.Add(-1 * time.Hour)}
	messages.messages["ch1#m-3"] = &model.Message{ID: "m-3", ParentID: "ch1", AuthorID: "u-3", AttachmentIDs: []string{"a-1"}, CreatedAt: now.Add(-2 * time.Hour)}

	files, err := svc.ListFiles(context.Background(), "u-1", "ch1", ParentChannel)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 deduped file, got %d", len(files))
	}
	if files[0].MessageID != "m-2" {
		t.Errorf("expected newest message m-2, got %q", files[0].MessageID)
	}
	if files[0].AuthorID != "u-2" {
		t.Errorf("expected newest author u-2, got %q", files[0].AuthorID)
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
		ID              string `json:"id"`
		ParentID        string `json:"parentID"`
		ParentMessageID string `json:"parentMessageID"`
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
