package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// stubUserGroupMentions turns "@oncall" into the oncall group's token and
// resolves its members.
type stubUserGroupMentions struct {
	members      map[string][]string
	err          error
	canonicalize []string // author IDs CanonicalizeMentions was called for
}

func (s *stubUserGroupMentions) CanonicalizeMentions(_ context.Context, authorID, body string) string {
	s.canonicalize = append(s.canonicalize, authorID)
	return strings.ReplaceAll(body, "@oncall", "@[group-oncall|oncall]")
}

func (s *stubUserGroupMentions) MentionedMembers(_ context.Context, _ string, ids []string) (map[string][]string, error) {
	if s.err != nil {
		return nil, s.err
	}
	out := map[string][]string{}
	for _, id := range ids {
		out[id] = s.members[id]
	}
	return out, nil
}

func TestMessageService_SendStoresTypedHandlesAsGroupMentions(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	groups := &stubUserGroupMentions{}
	svc.SetUserGroups(groups)
	seedMembership(memberships, "ch1", "user-1")

	msg, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, "db down @oncall", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if msg.Body != "db down @[group-oncall|oncall]" {
		t.Fatalf("Body = %q, want the typed handle stored as the group's mention", msg.Body)
	}
	if len(groups.canonicalize) != 1 || groups.canonicalize[0] != "user-1" {
		t.Fatalf("canonicalized for %v, want the author", groups.canonicalize)
	}
}

func TestMessageService_AgentPostsKeepTypedHandles(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	groups := &stubUserGroupMentions{}
	svc.SetUserGroups(groups)
	seedMembership(memberships, "ch1", "user-1")

	// An agent posting on someone's behalf (author ≠ accessor) never turns a
	// handle into a ping.
	msg, err := svc.send(context.Background(), "agent-1", "user-1", "ch1", ParentChannel, "ask @oncall", "", false)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if msg.Body != "ask @oncall" || len(groups.canonicalize) != 0 {
		t.Fatalf("agent post body = %q (canonicalized %v), want it as typed", msg.Body, groups.canonicalize)
	}
}

func TestMessageService_WebhookStoresTypedHandlesAsGroupMentions(t *testing.T) {
	svc, _, _, _, _ := setupMessageService()
	groups := &stubUserGroupMentions{}
	svc.SetUserGroups(groups)

	msg, err := svc.SendWebhook(context.Background(), WebhookMessageInput{ChannelID: "ch1", Body: "ALERT @oncall"})
	if err != nil {
		t.Fatalf("SendWebhook: %v", err)
	}
	if msg.Body != "ALERT @[group-oncall|oncall]" || groups.canonicalize[0] != WebhookAuthorID {
		t.Fatalf("Body = %q (author %v), want the group mention", msg.Body, groups.canonicalize)
	}
}

func TestMessageService_EditStoresTypedHandlesButDoesNotNotify(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	groups := &stubUserGroupMentions{members: map[string][]string{"group-oncall": {"user-2"}}}
	svc.SetUserGroups(groups)
	rec := &recordingNotifier{calls: make(chan notifierCall, 8)}
	svc.SetNotifier(rec)
	seedMembership(memberships, "ch1", "user-1")
	seedMembership(memberships, "ch1", "user-2")
	messages.messages["ch1#msg-1"] = &model.Message{ID: "msg-1", ParentID: "ch1", AuthorID: "user-1", Body: "original"}

	// Parity with a direct @-mention: an edit that adds one notifies nobody,
	// and neither does an edit that adds a group.
	for _, body := range []string{"now @[user-2|Bob]", "now @oncall"} {
		edited, err := svc.Edit(context.Background(), "user-1", "ch1", ParentChannel, "msg-1", body, nil)
		if err != nil {
			t.Fatalf("Edit: %v", err)
		}
		if body == "now @oncall" && edited.Body != "now @[group-oncall|oncall]" {
			t.Fatalf("edited Body = %q, want the group mention", edited.Body)
		}
	}
	// Positive control: a real send does notify, so the silence above is real.
	sent, err := svc.Send(context.Background(), "user-1", "ch1", ParentChannel, "control", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	select {
	case call := <-rec.calls:
		if call.msgID != sent.ID {
			t.Fatalf("notification for %q, want only the sent message %q", call.msgID, sent.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the control send never notified")
	}
}

func TestMessageService_ThreadReplyFollowsGroupMembers(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	svc.SetUserGroups(&stubUserGroupMentions{members: map[string][]string{"group-oncall": {"u-author", "u-bob", "u-cara", "u-outsider"}}})
	for _, id := range []string{"u-author", "u-bob", "u-cara"} {
		seedMembership(memberships, "ch1", id)
	}
	messages.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-other", Body: "root"}

	if _, err := svc.Send(context.Background(), "u-author", "ch1", ParentChannel, "@[u-bob|Bob] and @[group-oncall|oncall]", "m-root"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	for _, id := range []string{"u-bob", "u-cara"} {
		if got, err := follows.GetThreadFollow(context.Background(), id, "ch1", "m-root"); err != nil || !got.Following {
			t.Errorf("%s should follow the thread, got %+v err=%v", id, got, err)
		}
	}
	if _, ok := follows.follows[threadFollowMockKey("u-outsider", "ch1", "m-root")]; ok {
		t.Error("a group member outside the channel must not follow its thread")
	}
	// Bob (named and in the group) once, Cara; not the author, not the outsider.
	if follows.setManyMaxBatch != 2 {
		t.Errorf("batch = %d, want 2: bob deduped across his name and the group, plus cara", follows.setManyMaxBatch)
	}
}

func TestMessageService_ThreadFollowSurvivesAGroupLookupFailure(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	follows := newMockThreadFollowStore()
	svc.SetThreadFollowStore(follows)
	svc.SetUserGroups(&stubUserGroupMentions{err: errors.New("down")})
	seedMembership(memberships, "ch1", "u-author")
	seedMembership(memberships, "ch1", "u-bob")
	messages.messages["ch1#m-root"] = &model.Message{ID: "m-root", ParentID: "ch1", AuthorID: "u-other", Body: "root"}

	if _, err := svc.Send(context.Background(), "u-author", "ch1", ParentChannel, "@[u-bob|Bob] @[group-oncall|oncall]", "m-root"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if got, err := follows.GetThreadFollow(context.Background(), "u-bob", "ch1", "m-root"); err != nil || !got.Following {
		t.Fatalf("named mention should still follow, got %+v err=%v", got, err)
	}
}

func TestMessageService_WiredNamesUserGroups(t *testing.T) {
	err := (&MessageService{}).Wired()
	if err == nil || !strings.Contains(err.Error(), "user groups") {
		t.Fatalf("Wired = %v, want it to name the user groups", err)
	}
}
