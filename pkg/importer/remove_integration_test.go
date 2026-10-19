//go:build integration

package importer

import (
	"context"
	"errors"
	"maps"
	"slices"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/DigitalTolk/ex/internal/store"
)

// counting returns an importer over e's table whose client records every call.
func (e *env) counting() (*Importer, *faultDynamo) {
	e.t.Helper()
	fd := &faultDynamo{DynamoAPI: e.db.Client}
	im, err := New(Deps{DB: &store.DB{Client: fd, Table: e.db.Table},
		Objects: e.objects, Search: e.search, Cache: e.cache, TempDir: e.t.TempDir()})
	mustNoErr(e.t, err)
	return im, fd
}

// sweep runs a scenario once while counting DynamoDB calls, then once per
// call with exactly that call failing (on a fresh table each time) and
// requires the injected fault to come back. That reaches every storage error
// arm of the call under test.
func sweep(t *testing.T, setup func(e *env) func(im *Importer) error) {
	t.Helper()
	e := newEnv(t)
	run := setup(e)
	im, fd := e.counting()
	mustNoErr(t, run(im))
	fd.mu.Lock()
	calls := maps.Clone(fd.calls)
	fd.mu.Unlock()
	if len(calls) == 0 {
		t.Fatal("scenario made no storage calls")
	}
	for _, op := range slices.Sorted(maps.Keys(calls)) {
		for i := 1; i <= calls[op]; i++ {
			e2 := newEnv(t)
			if err := setup(e2)(e2.faulty(failOn(op, i))); !errors.Is(err, errFault) {
				t.Errorf("%s call %d: got %v, want the injected fault", op, i, err)
			}
		}
	}
}

// fixture is a channel c1 (members u1, u2) and a conversation between u1 and
// u2, each holding imported history:
//
//	root (u1) ← r1 (u2), r2 (u1, attachment a2)
//	t1 (u1, pinned, attachments a1 + shared)   t2 (u2, attachment shared)
//	sys (system)
//
// plus one native message in c1 that u2 hasn't read.
type fixture struct {
	root, r1, r2, t1, t2, sys, native MessageSpec
	convID                            string
	convMsgs                          []MessageSpec
}

func (f fixture) channelIDs() []string {
	return []string{f.root.ID, f.r1.ID, f.r2.ID, f.t1.ID, f.t2.ID, f.sys.ID}
}

func newFixture(t *testing.T, e *env) fixture {
	t.Helper()
	ctx := context.Background()
	addUsers(t, e, "u1", "u2")
	_, err := e.im.EnsureChannel(ctx, ChannelSpec{ID: "c1", Slug: "c-one", Type: "public", CreatedAt: t0})
	mustNoErr(t, err)
	_, err = e.im.AddChannelMembers(ctx, "c1", []MemberSpec{{UserID: "u1"}, {UserID: "u2"}})
	mustNoErr(t, err)
	for _, id := range []string{"a1", "a2", "shared"} {
		_, err := e.im.PutAttachment(ctx, AttachmentSpec{ID: id, Filename: id + ".txt", ContentType: "text/plain", Size: 2, CreatedBy: "u1", CreatedAt: t0}, bodyOf("hi"))
		mustNoErr(t, err)
	}
	mustNoErr(t, store.NewAttachmentStore(e.db).SetThumbnailKeys(ctx, "a1", "attachments/a1/thumb", ""))
	f := fixture{}
	f.root = MessageSpec{ID: mid(at(1), 1), AuthorID: "u1", Body: "root", CreatedAt: at(1)}
	f.r1 = MessageSpec{ID: mid(at(2), 2), AuthorID: "u2", Body: "r1", CreatedAt: at(2), ParentMessageID: f.root.ID}
	f.r2 = MessageSpec{ID: mid(at(3), 3), AuthorID: "u1", Body: "r2", CreatedAt: at(3), ParentMessageID: f.root.ID, AttachmentIDs: []string{"a2"}}
	pinnedAt := at(4)
	f.t1 = MessageSpec{ID: mid(at(4), 4), AuthorID: "u1", Body: "t1", CreatedAt: at(4), AttachmentIDs: []string{"a1", "shared"},
		Pinned: true, PinnedBy: "u1", PinnedAt: &pinnedAt}
	f.t2 = MessageSpec{ID: mid(at(5), 5), AuthorID: "u2", Body: "t2", CreatedAt: at(5), AttachmentIDs: []string{"shared"}}
	f.sys = MessageSpec{ID: mid(at(6), 6), AuthorID: SystemAuthorID, Body: "U1 joined the channel", CreatedAt: at(6), System: true}
	res, err := e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{f.root, f.r1, f.r2, f.t1, f.t2, f.sys})
	mustNoErr(t, err)
	_, err = e.im.FinalizeParent(ctx, FinalizeSpec{ParentID: "c1", ParentType: ParentChannel, NewTopLevel: res.TopLevelInserted, ThreadRootIDs: res.ThreadRootIDs})
	mustNoErr(t, err)
	// A message written by ex itself after the import, unread by u2.
	f.native = MessageSpec{ID: mid(at(9), 9), AuthorID: "u1", Body: "native", CreatedAt: at(9)}
	_, err = e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{f.native})
	mustNoErr(t, err)
	_, err = store.NewChannelStore(e.db).AddMessageSeq(ctx, "c1", 1)
	mustNoErr(t, err)
	mustNoErr(t, store.NewMembershipStore(e.db).AddChannelLastRead(ctx, "c1", "u1", 1))

	f.convID, _, err = e.im.EnsureConversation(ctx, ConversationSpec{Type: "dm", ParticipantIDs: []string{"u1", "u2"}, CreatedBy: "u1", CreatedAt: t0})
	mustNoErr(t, err)
	f.convMsgs = []MessageSpec{
		{ID: mid(at(1), 21), AuthorID: "u1", Body: "hi", CreatedAt: at(1)},
		{ID: mid(at(2), 22), AuthorID: "u2", Body: "hello", CreatedAt: at(2)},
	}
	res, err = e.im.PutMessages(ctx, f.convID, ParentConversation, f.convMsgs)
	mustNoErr(t, err)
	_, err = e.im.FinalizeParent(ctx, FinalizeSpec{ParentID: f.convID, ParentType: ParentConversation, NewTopLevel: res.TopLevelInserted})
	mustNoErr(t, err)
	return f
}

func TestGetMessages(t *testing.T) {
	e := newEnv(t)
	f := newFixture(t, e)
	got, err := e.im.GetMessages(context.Background(), "c1", []string{f.root.ID, f.t1.ID, f.t1.ID, "missing"})
	mustNoErr(t, err)
	if len(got) != 2 {
		t.Fatalf("got %d messages", len(got))
	}
	byID := map[string]Message{}
	for _, m := range got {
		byID[m.ID] = m
	}
	if r := byID[f.root.ID]; r.ReplyCount != 2 || r.AuthorID != "u1" || r.Body != "root" || !r.CreatedAt.Equal(at(1)) {
		t.Fatalf("root = %+v", r)
	}
	if m := byID[f.t1.ID]; !m.Pinned || len(m.AttachmentIDs) != 2 || m.Deleted || m.System {
		t.Fatalf("t1 = %+v", m)
	}
	sweep(t, func(e *env) func(*Importer) error {
		f := newFixture(t, e)
		return func(im *Importer) error {
			_, err := im.GetMessages(context.Background(), "c1", []string{f.root.ID})
			return err
		}
	})
}

func TestParentStats(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	f := newFixture(t, e)
	old := statsPageSize
	statsPageSize = 2 // walk several pages
	t.Cleanup(func() { statsPageSize = old })

	st, err := e.im.ParentStats(ctx, "c1", ParentChannel)
	mustNoErr(t, err)
	want := ParentStats{TopLevel: 4, Replies: 2, System: 1, Pinned: 1, Files: 3, Members: 2, MessageSeq: 4, MembersUnread: 1}
	if st != want {
		t.Fatalf("stats\n got %+v\nwant %+v", st, want)
	}
	// Thread counts out of sync in both directions, plus a tombstone.
	ms := store.NewMessageStore(e.db)
	mustNoErr(t, ms.SetReplyMetadata(ctx, "c1", f.root.ID, 5, at(3), []string{"u1"}))
	mustNoErr(t, ms.SetReplyMetadata(ctx, "c1", f.t2.ID, 1, at(3), []string{"u1"}))
	mustNoErr(t, e.im.TombstoneMessage(ctx, "c1", f.native.ID))
	st, err = e.im.ParentStats(ctx, "c1", ParentChannel)
	mustNoErr(t, err)
	if st.ThreadsMismatched != 2 || st.Deleted != 1 || st.TopLevel != 3 {
		t.Fatalf("stats = %+v", st)
	}

	st, err = e.im.ParentStats(ctx, f.convID, ParentConversation)
	mustNoErr(t, err)
	if st != (ParentStats{TopLevel: 2, Members: 2, MessageSeq: 2}) {
		t.Fatalf("conversation stats = %+v", st)
	}
	_, err = e.im.ParentStats(ctx, "c1", "thread")
	wantErr(t, err, ErrInvalidSpec)

	sweep(t, func(e *env) func(*Importer) error {
		newFixture(t, e)
		return func(im *Importer) error {
			_, err := im.ParentStats(context.Background(), "c1", ParentChannel)
			return err
		}
	})
	sweep(t, func(e *env) func(*Importer) error {
		f := newFixture(t, e)
		return func(im *Importer) error {
			_, err := im.ParentStats(context.Background(), f.convID, ParentConversation)
			return err
		}
	})
}

func TestAttachmentExists(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	newFixture(t, e)
	delete(e.objects.objects, "attachments/a2")
	got, err := e.im.AttachmentExists(ctx, []string{"a1", "a2", "missing", "a1"})
	mustNoErr(t, err)
	if a := got["a1"]; !a.Record || !a.Object || a.Size != 2 || a.SHA256 == "" || a.ContentType != "text/plain" || a.References != 1 {
		t.Fatalf("a1 = %+v", a)
	}
	if a := got["a2"]; !a.Record || a.Object {
		t.Fatalf("a2 = %+v", a)
	}
	if a, ok := got["missing"]; !ok || a.Record {
		t.Fatalf("missing = %+v %v", a, ok)
	}
	e.objects.headErr = errFault
	_, err = e.im.AttachmentExists(ctx, []string{"a1"})
	wantErr(t, err, errFault)
	noObjects, _ := New(Deps{DB: e.db})
	_, err = noObjects.AttachmentExists(ctx, []string{"a1"})
	wantErr(t, err, ErrNoObjectStore)
	e.objects.headErr = nil
	sweep(t, func(e *env) func(*Importer) error {
		newFixture(t, e)
		return func(im *Importer) error {
			_, err := im.AttachmentExists(context.Background(), []string{"a1"})
			return err
		}
	})
}

func TestRemoveMessages(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	f := newFixture(t, e)
	ms := store.NewMessageStore(e.db)

	// Remove a reply and a pinned message holding a private and a shared file.
	res, err := e.im.RemoveMessages(ctx, "c1", ParentChannel, []string{f.r2.ID, f.t1.ID, "missing"})
	mustNoErr(t, err)
	if res.Messages != 2 || res.Attachments != 2 { // a1 and a2; "shared" is still used by t2
		t.Fatalf("result = %+v", res)
	}
	if _, err := ms.GetMessage(ctx, "c1", f.t1.ID); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("t1 still there: %v", err)
	}
	root, _ := ms.GetMessage(ctx, "c1", f.root.ID)
	if root.ReplyCount != 1 || len(root.RecentReplyAuthorIDs) != 1 || root.RecentReplyAuthorIDs[0] != "u2" {
		t.Fatalf("root after removing r2 = %+v", root)
	}
	st, err := e.im.ParentStats(ctx, "c1", ParentChannel)
	mustNoErr(t, err)
	if st.Pinned != 0 || st.Files != 1 || st.MessageSeq != 3 || st.MembersUnread != 1 || st.ThreadsMismatched != 0 {
		t.Fatalf("stats after removal = %+v", st)
	}
	// Unread counts are what they were: u1 read everything, u2 has the native one.
	if u1, u2 := channelUnread(t, e, "c1", "u1"), channelUnread(t, e, "c1", "u2"); u1 != 0 || u2 != 1 {
		t.Fatalf("unread u1=%d u2=%d", u1, u2)
	}
	state, _ := e.im.AttachmentExists(ctx, []string{"a1", "a2", "shared"})
	if state["a1"].Record || state["a2"].Record || !state["shared"].Record || state["shared"].References != 1 {
		t.Fatalf("attachments = %+v", state)
	}
	if !slices.Contains(e.objects.deletedKeys, "attachments/a1/thumb") || !slices.Contains(e.search.deleted, f.t1.ID) ||
		!slices.Contains(e.search.deleted, "a1") {
		t.Fatalf("deleted objects %v, search docs %v", e.objects.deletedKeys, e.search.deleted)
	}

	// Removing the last reply clears the thread; removing the root drops follows.
	_, err = e.im.RemoveMessages(ctx, "c1", ParentChannel, []string{f.r1.ID, f.t2.ID})
	mustNoErr(t, err)
	root, _ = ms.GetMessage(ctx, "c1", f.root.ID)
	if root.ReplyCount != 0 || root.LastReplyAt != nil {
		t.Fatalf("root after removing every reply = %+v", root)
	}
	if state, _ := e.im.AttachmentExists(ctx, []string{"shared"}); state["shared"].Record {
		t.Fatal("shared attachment should be gone with its last message")
	}
	_, err = e.im.RemoveMessages(ctx, "c1", ParentChannel, []string{f.root.ID, f.sys.ID})
	mustNoErr(t, err)
	if fs, _ := store.NewThreadFollowStore(e.db).ListThreadFollows(ctx, "c1", f.root.ID); len(fs) != 0 {
		t.Fatalf("follows left: %+v", fs)
	}
	// Idempotent; and counters never go below zero.
	res, err = e.im.RemoveMessages(ctx, "c1", ParentChannel, f.channelIDs())
	mustNoErr(t, err)
	if res != (RemoveResult{}) {
		t.Fatalf("second removal = %+v", res)
	}
	st, _ = e.im.ParentStats(ctx, "c1", ParentChannel)
	if st.TopLevel != 1 || st.MessageSeq != 1 {
		t.Fatalf("stats at the end = %+v", st)
	}

	// Conversation: counters go down together.
	_, err = e.im.RemoveMessages(ctx, f.convID, ParentConversation, []string{f.convMsgs[0].ID})
	mustNoErr(t, err)
	st, _ = e.im.ParentStats(ctx, f.convID, ParentConversation)
	if st.MessageSeq != 1 || st.MembersUnread != 0 || st.TopLevel != 1 {
		t.Fatalf("conversation stats = %+v", st)
	}
	_, err = e.im.RemoveMessages(ctx, "c1", "thread", nil)
	wantErr(t, err, ErrInvalidSpec)

	sweep(t, func(e *env) func(*Importer) error {
		f := newFixture(t, e)
		return func(im *Importer) error {
			_, err := im.RemoveMessages(context.Background(), "c1", ParentChannel, []string{f.r2.ID, f.t1.ID})
			return err
		}
	})
	sweep(t, func(e *env) func(*Importer) error {
		f := newFixture(t, e)
		return func(im *Importer) error {
			_, err := im.RemoveMessages(context.Background(), "c1", ParentChannel, []string{f.r1.ID, f.r2.ID})
			return err
		}
	})
	sweep(t, func(e *env) func(*Importer) error {
		f := newFixture(t, e)
		return func(im *Importer) error {
			_, err := im.RemoveMessages(context.Background(), f.convID, ParentConversation, []string{f.convMsgs[0].ID})
			return err
		}
	})
}

func TestRemoveMessagesClampsCounters(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	addUsers(t, e, "u1", "u2")
	_, err := e.im.EnsureChannel(ctx, ChannelSpec{ID: "c2", Slug: "c-two", Type: "public", CreatedAt: t0})
	mustNoErr(t, err)
	_, err = e.im.AddChannelMembers(ctx, "c2", []MemberSpec{{UserID: "u1"}})
	mustNoErr(t, err)
	// Written but never finalized: counters are 0 and must stay there.
	m := MessageSpec{ID: mid(at(1), 1), AuthorID: "u1", Body: "x", CreatedAt: at(1)}
	_, err = e.im.PutMessages(ctx, "c2", ParentChannel, []MessageSpec{m})
	mustNoErr(t, err)
	_, err = e.im.RemoveMessages(ctx, "c2", ParentChannel, []string{m.ID})
	mustNoErr(t, err)
	st, _ := e.im.ParentStats(ctx, "c2", ParentChannel)
	if st.MessageSeq != 0 || st.MembersUnread != 0 {
		t.Fatalf("stats = %+v", st)
	}
	// A watermark above the lowered counter is pulled down to it.
	m2 := MessageSpec{ID: mid(at(2), 2), AuthorID: "u1", Body: "y", CreatedAt: at(2)}
	_, err = e.im.PutMessages(ctx, "c2", ParentChannel, []MessageSpec{m2})
	mustNoErr(t, err)
	_, err = store.NewChannelStore(e.db).AddMessageSeq(ctx, "c2", 1)
	mustNoErr(t, err)
	mustNoErr(t, store.NewMembershipStore(e.db).AddChannelLastRead(ctx, "c2", "u1", 3))
	_, err = e.im.RemoveMessages(ctx, "c2", ParentChannel, []string{m2.ID})
	mustNoErr(t, err)
	seqs, _ := store.NewMembershipStore(e.db).LastReadSeqs(ctx, "c2", []string{"u1"})
	if seqs["u1"] != 0 {
		t.Fatalf("watermark = %d", seqs["u1"])
	}
}

func TestRemoveMessagesNonStorageErrors(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name  string
		setup func(e *env)
		ids   func(f fixture) []string
		want  error
	}{
		{"object delete", func(e *env) { e.objects.deleteErr = errFault }, func(f fixture) []string { return []string{f.t1.ID} }, errFault},
		{"file unindex", func(e *env) { e.search.deleteErr = errFault }, func(f fixture) []string { return []string{f.t1.ID} }, errFault},
		{"message unindex", func(e *env) { e.search.deleteErr = errFault }, func(f fixture) []string { return []string{f.root.ID} }, errFault},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			f := newFixture(t, e)
			tc.setup(e)
			_, err := e.im.RemoveMessages(ctx, "c1", ParentChannel, tc.ids(f))
			wantErr(t, err, tc.want)
		})
	}
	e := newEnv(t)
	f := newFixture(t, e)
	noObjects, _ := New(Deps{DB: e.db})
	_, err := noObjects.RemoveMessages(ctx, "c1", ParentChannel, []string{f.t1.ID})
	wantErr(t, err, ErrNoObjectStore)
	// Without search the documents are simply not touched.
	noSearch, _ := New(Deps{DB: e.db, Objects: e.objects})
	_, err = noSearch.RemoveMessages(ctx, "c1", ParentChannel, []string{f.t1.ID})
	mustNoErr(t, err)
}

func TestRemoveChannelAndConversation(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	f := newFixture(t, e)

	_, err := e.im.RemoveChannel(ctx, RemoveChannelSpec{ChannelID: "c1", ImportedMessageIDs: f.channelIDs()})
	var foreignErr *ForeignMessagesError
	if !errors.As(err, &foreignErr) || foreignErr.Count != 1 || foreignErr.Error() == "" {
		t.Fatalf("want foreign-messages refusal, got %v", err)
	}
	res, err := e.im.RemoveChannel(ctx, RemoveChannelSpec{ChannelID: "c1", ImportedMessageIDs: f.channelIDs(), Force: true})
	mustNoErr(t, err)
	if res.Messages != 7 || res.Attachments != 3 {
		t.Fatalf("result = %+v", res)
	}
	if _, err := store.NewChannelStore(e.db).GetChannel(ctx, "c1"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("channel still there: %v", err)
	}
	if ucs, _ := store.NewMembershipStore(e.db).ListUserChannels(ctx, "u2"); len(ucs) != 0 {
		t.Fatalf("u2 still a member: %+v", ucs)
	}
	if !slices.Contains(e.search.deleted, "c1") {
		t.Fatalf("channel not unindexed: %v", e.search.deleted)
	}
	// The slug is free again, and removing twice is a no-op.
	_, err = e.im.EnsureChannel(ctx, ChannelSpec{ID: "c9", Slug: "c-one", Type: "public", CreatedAt: t0})
	mustNoErr(t, err)
	if res, err := e.im.RemoveChannel(ctx, RemoveChannelSpec{ChannelID: "c1"}); err != nil || res != (RemoveResult{}) {
		t.Fatalf("second removal = %+v %v", res, err)
	}

	ids := []string{f.convMsgs[0].ID}
	_, err = e.im.RemoveConversation(ctx, RemoveConversationSpec{ConversationID: f.convID, ImportedMessageIDs: ids})
	if !errors.As(err, &foreignErr) || foreignErr.Count != 1 {
		t.Fatalf("want foreign-messages refusal, got %v", err)
	}
	ids = append(ids, f.convMsgs[1].ID)
	res, err = e.im.RemoveConversation(ctx, RemoveConversationSpec{ConversationID: f.convID, ImportedMessageIDs: ids})
	mustNoErr(t, err)
	if res.Messages != 2 {
		t.Fatalf("conversation result = %+v", res)
	}
	if ucs, _ := store.NewConversationStore(e.db).ListUserConversations(ctx, "u1"); len(ucs) != 0 {
		t.Fatalf("u1 still sees the conversation: %+v", ucs)
	}
	if res, err := e.im.RemoveConversation(ctx, RemoveConversationSpec{ConversationID: f.convID}); err != nil || res != (RemoveResult{}) {
		t.Fatalf("second removal = %+v %v", res, err)
	}

	// Search failure on the channel document.
	e2 := newEnv(t)
	f2 := newFixture(t, e2)
	_, err = e2.im.RemoveMessages(ctx, "c1", ParentChannel, append(f2.channelIDs(), f2.native.ID))
	mustNoErr(t, err)
	e2.search.deleteErr = errFault
	_, err = e2.im.RemoveChannel(ctx, RemoveChannelSpec{ChannelID: "c1"})
	wantErr(t, err, errFault)
	// Without search the channel is still removed.
	noSearch, _ := New(Deps{DB: e2.db, Objects: e2.objects})
	_, err = noSearch.RemoveChannel(ctx, RemoveChannelSpec{ChannelID: "c1"})
	mustNoErr(t, err)
	// removeMessages failures surface from both removals.
	e3 := newEnv(t)
	f3 := newFixture(t, e3)
	e3.objects.deleteErr = errFault
	_, err = e3.im.RemoveChannel(ctx, RemoveChannelSpec{ChannelID: "c1", Force: true})
	wantErr(t, err, errFault)
	e3.search.deleteErr = errFault
	_, err = e3.im.RemoveConversation(ctx, RemoveConversationSpec{ConversationID: f3.convID, Force: true})
	wantErr(t, err, errFault)

	sweep(t, func(e *env) func(*Importer) error {
		newFixture(t, e)
		return func(im *Importer) error {
			_, err := im.RemoveChannel(context.Background(), RemoveChannelSpec{ChannelID: "c1", Force: true})
			return err
		}
	})
	sweep(t, func(e *env) func(*Importer) error {
		f := newFixture(t, e)
		return func(im *Importer) error {
			_, err := im.RemoveConversation(context.Background(), RemoveConversationSpec{ConversationID: f.convID, Force: true})
			return err
		}
	})
}

func TestRemoveMembersAndUser(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	f := newFixture(t, e)

	err := e.im.RemoveUser(ctx, RemoveUserSpec{UserID: "u2"})
	var inUse *UserInUseError
	if !errors.As(err, &inUse) || inUse.Channels != 1 || inUse.Conversations != 1 || inUse.SignedIn || inUse.Error() == "" {
		t.Fatalf("want in-use refusal, got %v", err)
	}
	mustNoErr(t, e.im.RemoveMembers(ctx, "c1", []string{"u2", "u2", "nobody"}))
	if ucs, _ := store.NewMembershipStore(e.db).ListUserChannels(ctx, "u2"); len(ucs) != 0 {
		t.Fatalf("u2 still in c1: %+v", ucs)
	}
	_, err = e.im.RemoveConversation(ctx, RemoveConversationSpec{ConversationID: f.convID, Force: true})
	mustNoErr(t, err)
	mustNoErr(t, e.im.RemoveUser(ctx, RemoveUserSpec{UserID: "u2"}))
	if _, err := store.NewUserStore(e.db).GetUser(ctx, "u2"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("u2 still there: %v", err)
	}
	if !slices.Contains(e.search.deleted, "u2") || !slices.Contains(e.cache.deleted, "u2") {
		t.Fatalf("search %v cache %v", e.search.deleted, e.cache.deleted)
	}
	mustNoErr(t, e.im.RemoveUser(ctx, RemoveUserSpec{UserID: "u2"})) // already gone

	// A user who has signed in is refused even without memberships; Force wins.
	us := store.NewUserStore(e.db)
	addUsers(t, e, "u3")
	u3, _ := us.GetUser(ctx, "u3")
	seen := time.Now()
	u3.LastSeenAt = &seen
	mustNoErr(t, us.UpdateUser(ctx, u3))
	err = e.im.RemoveUser(ctx, RemoveUserSpec{UserID: "u3"})
	if !errors.As(err, &inUse) || !inUse.SignedIn {
		t.Fatalf("want signed-in refusal, got %v", err)
	}
	mustNoErr(t, e.im.RemoveUser(ctx, RemoveUserSpec{UserID: "u3", Force: true}))

	// Search and cache failures.
	addUsers(t, e, "u4", "u5")
	e.search.deleteErr = errFault
	wantErr(t, e.im.RemoveUser(ctx, RemoveUserSpec{UserID: "u4"}), errFault)
	e.search.deleteErr, e.cache.err = nil, errFault
	wantErr(t, e.im.RemoveUser(ctx, RemoveUserSpec{UserID: "u5"}), errFault)
	e.cache.err = nil
	addUsers(t, e, "u6")
	noSearch, _ := New(Deps{DB: e.db})
	mustNoErr(t, noSearch.RemoveUser(ctx, RemoveUserSpec{UserID: "u6"}))

	sweep(t, func(e *env) func(*Importer) error {
		newFixture(t, e)
		return func(im *Importer) error { return im.RemoveMembers(context.Background(), "c1", []string{"u2"}) }
	})
	sweep(t, func(e *env) func(*Importer) error {
		addUsers(t, e, "u7")
		return func(im *Importer) error { return im.RemoveUser(context.Background(), RemoveUserSpec{UserID: "u7"}) }
	})
}

// Inconsistent leftovers are skipped: an attachment whose record is gone, a
// reply whose root is gone, and a member without a read-state row.
func TestRemoveMessagesToleratesLeftovers(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	f := newFixture(t, e)
	mustNoErr(t, store.NewAttachmentStore(e.db).Delete(ctx, "a2"))
	orphan := MessageSpec{ID: mid(at(7), 7), AuthorID: "u2", Body: "orphan", CreatedAt: at(7), ParentMessageID: mid(at(0), 8)}
	_, err := e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{orphan})
	mustNoErr(t, err)
	_, err = e.db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: aws.String(e.db.Table), Key: map[string]types.AttributeValue{
		"PK": &types.AttributeValueMemberS{Value: "USER#u2"}, "SK": &types.AttributeValueMemberS{Value: "CHAN#c1"},
	}})
	mustNoErr(t, err)
	res, err := e.im.RemoveMessages(ctx, "c1", ParentChannel, []string{f.r2.ID, orphan.ID, f.t2.ID})
	mustNoErr(t, err)
	if res.Messages != 3 || res.Attachments != 0 {
		t.Fatalf("result = %+v", res)
	}
}
