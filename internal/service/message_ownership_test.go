package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// A message may only carry attachments its author uploaded, or ones already
// shared in the same chat. Naming someone else's upload is refused outright.
func TestMessage_Send_AttachmentOwnership(t *testing.T) {
	ctx := context.Background()
	t.Run("someone else's unshared upload is refused", func(t *testing.T) {
		svc, _, memberships, _, _ := setupMessageService()
		grantChannelMember(memberships, "ch1", "u-mallory")
		svc.SetAttachmentManager(&fakeAttachmentRefMgr{
			owners: map[string]string{"secret": "u-bob"},
			refs:   map[string][]string{"secret": {"m-private"}}, // lives in a chat mallory is not in
		})
		_, err := svc.Send(ctx, "u-mallory", "ch1", ParentChannel, "look", "", "secret")
		if !errors.Is(err, ErrForbidden) || !strings.Contains(err.Error(), "uploaded by someone else") {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
	})
	t.Run("a file already in this chat may be re-shared", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		grantChannelMember(memberships, "ch1", "u-carol")
		messages.messages["ch1#m-bob"] = &model.Message{ID: "m-bob", ParentID: "ch1", AuthorID: "u-bob", Body: "here", AttachmentIDs: []string{"shared"}}
		svc.SetAttachmentManager(&fakeAttachmentRefMgr{
			owners: map[string]string{"shared": "u-bob"},
			refs:   map[string][]string{"shared": {"m-elsewhere", "m-bob"}},
		})
		if _, err := svc.Send(ctx, "u-carol", "ch1", ParentChannel, "re-sharing", "", "shared"); err != nil {
			t.Fatalf("re-share: %v", err)
		}
	})
	t.Run("only the first few references are consulted", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		grantChannelMember(memberships, "ch1", "u-carol")
		messages.messages["ch1#m-late"] = &model.Message{ID: "m-late", ParentID: "ch1", AuthorID: "u-bob", Body: "late"}
		refs := make([]string, maxOwnershipRefs)
		for i := range refs {
			refs[i] = "m-other"
		}
		refs = append(refs, "m-late") // past the cap: not consulted
		svc.SetAttachmentManager(&fakeAttachmentRefMgr{owners: map[string]string{"f": "u-bob"}, refs: map[string][]string{"f": refs}})
		if _, err := svc.Send(ctx, "u-carol", "ch1", ParentChannel, "hm", "", "f"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("err = %v, want ErrForbidden", err)
		}
	})
	t.Run("owner lookup failure fails the send", func(t *testing.T) {
		svc, _, memberships, _, _ := setupMessageService()
		grantChannelMember(memberships, "ch1", "u1")
		svc.SetAttachmentManager(&fakeAttachmentRefMgr{ownerErr: errors.New("dynamo down")})
		if _, err := svc.Send(ctx, "u1", "ch1", ParentChannel, "x", "", "a1"); err == nil || !strings.Contains(err.Error(), "owner") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("agent posts carry the run's files", func(t *testing.T) {
		svc, messages, memberships, _, _ := setupMessageService()
		grantChannelMember(memberships, "ch1", "u-alice")
		svc.SetAttachmentManager(&fakeAttachmentRefMgr{owners: map[string]string{"out": "u-gg"}})
		msg, err := svc.SendAsAgentRun(ctx, "u-gg", "u-alice", "ch1", ParentChannel, "done", "", "run-1", "out")
		if err != nil {
			t.Fatalf("agent send: %v", err)
		}
		if got := messages.messages["ch1#"+msg.ID]; got == nil || len(got.AttachmentIDs) != 1 || got.AttachmentIDs[0] != "out" {
			t.Fatalf("stored = %+v", got)
		}
	})
}
