package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// seedCrossParentThread puts a private thread in "ch-priv" and makes user-1 a
// member of "ch-pub" only — the cross-parent read the thread gate must refuse.
func seedCrossParentThread(messages *mockMessageStore, memberships *mockMembershipStore) {
	memberships.memberships["ch-pub#user-1"] = &model.ChannelMembership{ChannelID: "ch-pub", UserID: "user-1", Role: model.ChannelRoleMember}
	messages.messages["ch-priv#01-root"] = &model.Message{ID: "01-root", ParentID: "ch-priv", AuthorID: "user-2", Body: "secret root", ReplyCount: 2}
	messages.messages["ch-priv#02-r1"] = &model.Message{ID: "02-r1", ParentID: "ch-priv", AuthorID: "user-2", Body: "secret 1", ParentMessageID: "01-root"}
	messages.messages["ch-priv#03-r2"] = &model.Message{ID: "03-r2", ParentID: "ch-priv", AuthorID: "user-2", Body: "secret 2", ParentMessageID: "01-root"}
}

// Regression: the thread reads checked access to the URL's parent only, then
// read replies from the global THREAD#<root> index. A member of a public
// channel could read any private channel's (or DM's) thread by naming its root.
func TestListThreadMessages_RefusesRootFromAnotherParent(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	seedCrossParentThread(messages, memberships)

	got, err := svc.ListThreadMessages(context.Background(), "user-1", "ch-pub", ParentChannel, "01-root")
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound for a root outside the parent", err)
	}
	if len(got) != 0 {
		t.Fatalf("leaked %d private messages: %v", len(got), ids(got))
	}
}

func TestThreadWindowMessages_RefusesRootFromAnotherParent(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	seedCrossParentThread(messages, memberships)

	got, err := svc.ThreadWindowMessages(context.Background(), "user-1", "ch-pub", ParentChannel, "01-root", 10)
	if !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("err = %v, want ErrNotFound for a root outside the parent", err)
	}
	if len(got) != 0 {
		t.Fatalf("leaked %d private messages: %v", len(got), ids(got))
	}
}

// Even with a root in the caller's parent, the global reply index is never
// trusted to scope the read: a reply row that lives in another parent (a
// crafted or mis-imported ParentMessageID) is dropped from both reads.
func TestThreadReads_DropRepliesFromAnotherParent(t *testing.T) {
	svc, messages, memberships, _, _ := setupMessageService()
	ctx := context.Background()
	memberships.memberships["ch-pub#user-1"] = &model.ChannelMembership{ChannelID: "ch-pub", UserID: "user-1", Role: model.ChannelRoleMember}
	messages.messages["ch-pub#01-root"] = &model.Message{ID: "01-root", ParentID: "ch-pub", AuthorID: "user-1", Body: "root", ReplyCount: 1}
	messages.messages["ch-pub#02-r1"] = &model.Message{ID: "02-r1", ParentID: "ch-pub", AuthorID: "user-1", Body: "mine", ParentMessageID: "01-root"}
	messages.messages["ch-priv#03-x"] = &model.Message{ID: "03-x", ParentID: "ch-priv", AuthorID: "user-2", Body: "secret", ParentMessageID: "01-root"}

	thread, err := svc.ListThreadMessages(ctx, "user-1", "ch-pub", ParentChannel, "01-root")
	if err != nil {
		t.Fatalf("ListThreadMessages: %v", err)
	}
	if got := ids(thread); len(got) != 2 || got[0] != "01-root" || got[1] != "02-r1" {
		t.Fatalf("thread = %v, want [01-root 02-r1] (the other parent's reply dropped)", got)
	}

	window, err := svc.ThreadWindowMessages(ctx, "user-1", "ch-pub", ParentChannel, "01-root", 10)
	if err != nil {
		t.Fatalf("ThreadWindowMessages: %v", err)
	}
	if got := ids(window); len(got) != 2 || got[0] != "01-root" || got[1] != "02-r1" {
		t.Fatalf("window = %v, want [01-root 02-r1] (the other parent's reply dropped)", got)
	}
}
