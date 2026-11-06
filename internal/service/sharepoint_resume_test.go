package service

import (
	"context"
	"errors"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/oauth2"
)

func storeUnfinished(userID, parentID, parentType string) store.SharePointUnfinished {
	return store.SharePointUnfinished{UserID: userID, ParentID: parentID, ParentType: parentType}
}

// signIn is a user's next SSO login: it keeps their token and returns the
// jobs it queued.
func (h *spHarness) signIn(t *testing.T, userID string) []SharePointTask {
	t.Helper()
	before := len(h.queue.tasks)
	if err := h.svc.SaveDelegatedToken(context.Background(), userID, &oauth2.Token{RefreshToken: "r"}); err != nil {
		t.Fatalf("sign in: %v", err)
	}
	return h.queue.tasks[before:]
}

func leftTask(userIDs ...string) SharePointTask {
	return SharePointTask{Kind: sharePointLeft, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: userIDs}
}

func joinedTask(userIDs ...string) SharePointTask {
	return SharePointTask{Kind: sharePointJoined, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: userIDs}
}

func (h *spHarness) removeMember(userID string) {
	h.members.members["ch-sp"] = without(h.members.members["ch-sp"], userID)
}

func TestAccessALapsedSignInCouldntTakeBackGoesAtTheNextSignIn(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))

	h.tokens.missing["alice"] = true
	h.removeMember("bob")
	h.mustRun(t, leftTask("bob"))
	if it := h.records.item("ch-sp", spItemID); it.Grants["bob"] != "perm-oid-bob" {
		t.Fatalf("grants = %v", it.Grants)
	}
	if got := h.records.unfinishedFor("alice"); !slices.Equal(got, []string{"ch-sp:channel"}) {
		t.Fatalf("unfinished = %v", got)
	}

	tasks := h.signIn(t, "alice")
	want := SharePointTask{Kind: sharePointResume, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"alice"}}
	if len(tasks) != 1 || !slices.Equal(tasks[0].UserIDs, want.UserIDs) || tasks[0].Kind != want.Kind || tasks[0].ParentID != want.ParentID || tasks[0].ParentType != want.ParentType {
		t.Fatalf("queued = %+v", tasks)
	}
	h.mustRun(t, tasks[0])
	if !slices.Equal(h.graph.deleted, []string{"perm-oid-bob@tok-alice"}) {
		t.Fatalf("revoked = %v", h.graph.deleted)
	}
	// Carol's own access and the guest's not-shared entry stay.
	it := h.records.item("ch-sp", spItemID)
	if !maps.Equal(it.Grants, map[string]string{"carol": ""}) || !slices.Equal(it.NotShared, []string{"guest", "nooid"}) {
		t.Fatalf("file = %+v", it)
	}
	if got := h.records.unfinishedFor("alice"); len(got) != 0 {
		t.Fatalf("unfinished = %v", got)
	}
	if evs := h.changedEvents(t); len(evs[len(evs)-1].URLs) != 0 {
		t.Fatalf("resume event = %+v (want every link)", evs[len(evs)-1])
	}
	// Nothing left: the next sign-in queues nothing.
	if tasks := h.signIn(t, "alice"); len(tasks) != 0 {
		t.Fatalf("queued = %+v", tasks)
	}
}

func TestAFileWhoseLinkWentWhileTheSignInLapsedIsRetired(t *testing.T) {
	h := newSPHarness(t)
	msg := h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))

	h.tokens.missing["alice"] = true
	msg.Body = "never mind"
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if h.records.link("ch-sp", spLink) != nil {
		t.Fatal("the link must go")
	}
	it := h.records.item("ch-sp", spItemID)
	if it == nil || !it.Retired || it.Grants["bob"] != "perm-oid-bob" {
		t.Fatalf("file = %+v", it)
	}
	// Retired: out of the Files panel, of joins and of leaves.
	if files, err := h.svc.Files(context.Background(), "ch-sp"); err != nil || len(files) != 0 {
		t.Fatalf("files = %+v, %v", files, err)
	}
	h.tokens.missing["alice"] = false
	puts := h.records.putItems
	h.mustRun(t, joinedTask("dave"))
	h.mustRun(t, leftTask("bob"))
	if h.records.putItems != puts || len(h.graph.invited) != 1 || len(h.graph.deleted) != 0 {
		t.Fatalf("a retired file was touched: invited %v, revoked %v", h.graph.invited, h.graph.deleted)
	}

	h.tokens.missing["alice"] = true
	tasks := h.signIn(t, "alice")
	h.mustRun(t, tasks[0])
	if !slices.Equal(h.graph.deleted, []string{"perm-oid-bob@tok-alice"}) {
		t.Fatalf("revoked = %v", h.graph.deleted)
	}
	if h.records.item("ch-sp", spItemID) != nil {
		t.Fatal("the retired file must be forgotten once its access is back")
	}
	if got := h.records.unfinishedFor("alice"); len(got) != 0 {
		t.Fatalf("unfinished = %v", got)
	}
}

func TestARetiredFileSharedAgainComesBack(t *testing.T) {
	h := newSPHarness(t)
	msg := h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	h.tokens.missing["alice"] = true
	msg.Body = "never mind"
	h.mustRun(t, messagesTask("ch-sp", "m-1"))

	h.tokens.missing["alice"] = false
	h.post("m-2", "ch-sp", "alice", "again "+spLink, 5)
	h.mustRun(t, messagesTask("ch-sp", "m-2"))
	it := h.records.item("ch-sp", spItemID)
	if it.Retired || it.Grants["bob"] != "perm-oid-bob" || it.MessageID != "m-2" {
		t.Fatalf("file = %+v", it)
	}
	// Bob's grant was still there: he isn't invited twice.
	if n := strings.Count(strings.Join(h.graph.invites(), ","), "oid-bob"); n != 1 {
		t.Fatalf("bob invited %d times", n)
	}
}

func TestNewcomersALapsedSignInMissedAreSharedWithAtTheNextSignIn(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))

	h.tokens.missing["alice"] = true
	h.members.members["ch-sp"] = append(h.members.members["ch-sp"], "dave")
	h.mustRun(t, joinedTask("dave"))
	if it := h.records.item("ch-sp", spItemID); !slices.Contains(it.NotShared, "dave") {
		t.Fatalf("not shared = %v", it.NotShared)
	}

	// Still lapsed when the job runs: the parent stays unfinished.
	resume := SharePointTask{Kind: sharePointResume, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"alice"}}
	h.mustRun(t, resume)
	if got := h.records.unfinishedFor("alice"); len(got) != 1 {
		t.Fatalf("unfinished = %v", got)
	}

	tasks := h.signIn(t, "alice")
	h.mustRun(t, tasks[0])
	it := h.records.item("ch-sp", spItemID)
	if it.Grants["dave"] != "perm-oid-dave" || slices.Contains(it.NotShared, "dave") {
		t.Fatalf("file = %+v", it)
	}
	if !slices.Contains(h.graph.invites(), "oid-dave@tok-alice") {
		t.Fatalf("invites = %v", h.graph.invites())
	}
	if got := h.records.unfinishedFor("alice"); len(got) != 0 {
		t.Fatalf("unfinished = %v", got)
	}
}

func TestMembersMicrosoftFailedOnTheLastRunAreSharedWithAtTheNextSignIn(t *testing.T) {
	h := newSPHarness(t)
	h.members.members["ch-sp"] = []string{"alice", "bob", "dave"}
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.graph.inviteErr["oid-dave"] = errors.New("503")
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	if got := h.records.unfinishedFor("alice"); !slices.Equal(got, []string{"ch-sp:channel"}) {
		t.Fatalf("unfinished = %v", got)
	}

	delete(h.graph.inviteErr, "oid-dave")
	h.mustRun(t, h.signIn(t, "alice")[0])
	if it := h.records.item("ch-sp", spItemID); it.Grants["dave"] != "perm-oid-dave" || len(it.NotShared) != 0 {
		t.Fatalf("file = %+v", it)
	}
}

func TestResumeOnlyTouchesTheGrantorsFiles(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "bob", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	puts := h.records.putItems
	h.mustRun(t, SharePointTask{Kind: sharePointResume, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"alice"}})
	if h.records.putItems != puts {
		t.Fatal("resumed someone else's file")
	}
}

func TestResumeRetriesTransientFailures(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	h.tokens.missing["alice"] = true
	h.removeMember("bob")
	h.mustRun(t, leftTask("bob"))
	resume := h.signIn(t, "alice")[0]

	withRetriesLeft()
	h.graph.deleteErr = errors.New("503")
	if err := h.run(t, resume); err == nil {
		t.Fatal("want the resume retried")
	}
	if got := h.records.unfinishedFor("alice"); len(got) != 1 {
		t.Fatalf("a failed resume cleared the mark: %v", got)
	}
	h.graph.deleteErr = nil
	h.members.members["ch-sp"] = append(h.members.members["ch-sp"], "dave")
	h.graph.inviteErr["oid-dave"] = errors.New("503")
	if err := h.run(t, resume); err == nil {
		t.Fatal("want the resume retried")
	}
	// Bob's grant was taken back, and saved, before the invite failed.
	if _, still := h.records.item("ch-sp", spItemID).Grants["bob"]; still {
		t.Fatal("bob's revoked grant wasn't saved")
	}
	if got := h.records.unfinishedFor("alice"); len(got) != 1 {
		t.Fatalf("a failed resume cleared the mark: %v", got)
	}
}

func TestResumeErrors(t *testing.T) {
	h := newSPHarness(t)
	h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	resume := SharePointTask{Kind: sharePointResume, ParentID: "ch-sp", ParentType: ParentChannel, UserIDs: []string{"alice"}}

	h.records.listItemsErr = errors.New("dynamo")
	if err := h.run(t, resume); err == nil || !strings.Contains(err.Error(), "list files") {
		t.Fatalf("err = %v", err)
	}
	h.records.listItemsErr = nil
	h.members.err = errors.New("dynamo")
	if err := h.run(t, resume); err == nil || !strings.Contains(err.Error(), "list members") {
		t.Fatalf("err = %v", err)
	}
	h.members.err = nil
	h.records.putItemErr = errors.New("dynamo")
	if err := h.run(t, resume); err == nil || !strings.Contains(err.Error(), "save file") {
		t.Fatalf("err = %v", err)
	}
	h.records.putItemErr = nil
	h.records.deleteUnfinishedErr = errors.New("dynamo")
	if err := h.run(t, resume); err == nil || !strings.Contains(err.Error(), "clear unfinished") {
		t.Fatalf("err = %v", err)
	}
}

func TestRetiringErrors(t *testing.T) {
	h := newSPHarness(t)
	msg := h.post("m-1", "ch-sp", "alice", spLink, 0)
	h.mustRun(t, messagesTask("ch-sp", "m-1"))
	h.tokens.missing["alice"] = true
	msg.Body = "never mind"

	h.records.putItemErr = errors.New("dynamo")
	if err := h.run(t, messagesTask("ch-sp", "m-1")); err == nil || !strings.Contains(err.Error(), "save file") {
		t.Fatalf("err = %v", err)
	}
	// The link stays until its file is settled, so the job finds it again.
	if h.records.link("ch-sp", spLink) == nil {
		t.Fatal("link dropped before its file was retired")
	}
	h.records.putItemErr = nil
	h.records.putUnfinishedErr = errors.New("dynamo")
	if err := h.run(t, messagesTask("ch-sp", "m-1")); err == nil || !strings.Contains(err.Error(), "save unfinished") {
		t.Fatalf("err = %v", err)
	}
}

func TestSignInWithUnfinishedWork(t *testing.T) {
	h := newSPHarness(t)
	ctx := context.Background()
	tok := &oauth2.Token{RefreshToken: "r"}

	h.tokens.saveErr = errors.New("seal")
	if err := h.svc.SaveDelegatedToken(ctx, "alice", tok); err == nil {
		t.Fatal("want the save error")
	}
	h.tokens.saveErr = nil
	// Unfinished work that can't be read never fails the login.
	h.records.listUnfinishedErr = errors.New("dynamo")
	if err := h.svc.SaveDelegatedToken(ctx, "alice", tok); err != nil || len(h.queue.tasks) != 0 {
		t.Fatalf("err = %v, queued %v", err, h.queue.tasks)
	}
	h.records.listUnfinishedErr = nil
	for _, p := range []struct{ id, kind string }{{"ch-sp", ParentChannel}, {"conv-1", ParentConversation}} {
		h.records.unfinished["alice|"+p.id] = storeUnfinished("alice", p.id, p.kind)
	}
	h.records.unfinished["bob|ch-sp"] = storeUnfinished("bob", "ch-sp", ParentChannel)
	tasks := h.signIn(t, "alice")
	var got []string
	for _, task := range tasks {
		got = append(got, task.Kind+":"+task.ParentID+":"+task.ParentType+":"+strings.Join(task.UserIDs, ","))
	}
	if !slices.Equal(got, []string{"resume:ch-sp:channel:alice", "resume:conv-1:conversation:alice"}) {
		t.Fatalf("queued = %v", got)
	}
}
