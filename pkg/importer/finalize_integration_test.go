//go:build integration

package importer

import (
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/store"
)

// unread is what ex shows a member: MessageSeq - LastReadSeq.
func channelUnread(t *testing.T, e *env, channelID, userID string) int64 {
	t.Helper()
	ctx := context.Background()
	ch, err := store.NewChannelStore(e.db).GetChannel(ctx, channelID)
	mustNoErr(t, err)
	ucs, err := store.NewMembershipStore(e.db).ListUserChannels(ctx, userID)
	mustNoErr(t, err)
	for _, uc := range ucs {
		if uc.ChannelID == channelID {
			return ch.MessageSeq - uc.LastReadSeq
		}
	}
	t.Fatalf("%s is not a member of %s", userID, channelID)
	return 0
}

func TestFinalizeChannel(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	addUsers(t, e, "u1", "u2", "u3")
	_, err := e.im.EnsureChannel(ctx, ChannelSpec{ID: "c1", Slug: "c-one", Type: "public", CreatedAt: t0})
	mustNoErr(t, err)
	_, err = e.im.AddChannelMembers(ctx, "c1", []MemberSpec{{UserID: "u1"}, {UserID: "u2"}})
	mustNoErr(t, err)
	// u2 already had 2 unread ex messages before the import.
	cs := store.NewChannelStore(e.db)
	_, err = cs.AddMessageSeq(ctx, "c1", 2)
	mustNoErr(t, err)
	mustNoErr(t, store.NewMembershipStore(e.db).AddChannelLastRead(ctx, "c1", "u1", 2))

	root := MessageSpec{ID: mid(at(1), 1), AuthorID: "u1", Body: "root", CreatedAt: at(1)}
	r1 := MessageSpec{ID: mid(at(2), 2), AuthorID: "u2", Body: "r1", CreatedAt: at(2), ParentMessageID: root.ID}
	r2 := MessageSpec{ID: mid(at(3), 3), AuthorID: WebhookAuthorID, Body: "r2", CreatedAt: at(3), ParentMessageID: root.ID}
	r3 := MessageSpec{ID: mid(at(4), 4), AuthorID: "u3", Body: "r3", CreatedAt: at(4), ParentMessageID: root.ID}
	r4 := MessageSpec{ID: mid(at(5), 5), AuthorID: "u2", Body: "r4", CreatedAt: at(5), ParentMessageID: root.ID}
	orphan := MessageSpec{ID: mid(at(6), 6), AuthorID: "u1", Body: "o", CreatedAt: at(6), ParentMessageID: mid(at(0), 7)}
	top := MessageSpec{ID: mid(at(7), 8), AuthorID: "u2", Body: "top", CreatedAt: at(7)}
	res, err := e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{root, r1, r2, r3, r4, orphan, top})
	mustNoErr(t, err)

	fr, err := e.im.FinalizeParent(ctx, FinalizeSpec{ParentID: "c1", ParentType: ParentChannel, NewTopLevel: res.TopLevelInserted, ThreadRootIDs: res.ThreadRootIDs})
	mustNoErr(t, err)
	if fr.ThreadsUpdated != 1 || fr.ThreadsMissingRoot != 1 || fr.FollowsWritten != 3 {
		t.Fatalf("finalize = %+v", fr)
	}
	got, _ := store.NewMessageStore(e.db).GetMessage(ctx, "c1", root.ID)
	if got.ReplyCount != 4 || got.LastReplyAt == nil || !got.LastReplyAt.Equal(at(5)) ||
		len(got.RecentReplyAuthorIDs) != 3 || got.RecentReplyAuthorIDs[0] != "u2" || got.RecentReplyAuthorIDs[1] != "u3" {
		t.Fatalf("root metadata = %+v", got)
	}
	follows, err := store.NewThreadFollowStore(e.db).ListThreadFollows(ctx, "c1", root.ID)
	mustNoErr(t, err)
	if len(follows) != 3 {
		t.Fatalf("follows = %+v", follows)
	}
	// Imported history is read; pre-existing unread is unchanged.
	if u1, u2 := channelUnread(t, e, "c1", "u1"), channelUnread(t, e, "c1", "u2"); u1 != 0 || u2 != 2 {
		t.Fatalf("unread u1=%d u2=%d", u1, u2)
	}
	// No new top-level messages: counters untouched.
	_, err = e.im.FinalizeParent(ctx, FinalizeSpec{ParentID: "c1", ParentType: ParentChannel})
	mustNoErr(t, err)
}

func TestFinalizeErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	addUsers(t, e, "u1", "u2")
	_, err := e.im.EnsureChannel(ctx, ChannelSpec{ID: "c1", Slug: "c-one", Type: "public", CreatedAt: t0})
	mustNoErr(t, err)
	_, err = e.im.AddChannelMembers(ctx, "c1", []MemberSpec{{UserID: "u1"}, {UserID: "u2"}})
	mustNoErr(t, err)
	root := MessageSpec{ID: mid(at(1), 1), AuthorID: "u1", Body: "root", CreatedAt: at(1)}
	reply := MessageSpec{ID: mid(at(2), 2), AuthorID: "u2", Body: "r", CreatedAt: at(2), ParentMessageID: root.ID}
	_, err = e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{root, reply})
	mustNoErr(t, err)
	thread := FinalizeSpec{ParentID: "c1", ParentType: ParentChannel, ThreadRootIDs: []string{root.ID}}
	seq := FinalizeSpec{ParentID: "c1", ParentType: ParentChannel, NewTopLevel: 1}

	_, err = e.im.FinalizeParent(ctx, FinalizeSpec{ParentID: "c1", ParentType: "nope"})
	wantErr(t, err, ErrInvalidSpec)
	_, err = e.faulty(failOn("GetItem", 0)).FinalizeParent(ctx, thread)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("Query", 0)).FinalizeParent(ctx, thread)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("UpdateItem", 0)).FinalizeParent(ctx, thread)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("PutItem", 0)).FinalizeParent(ctx, thread)
	wantErr(t, err, errFault)

	_, err = e.faulty(failOn("Query", 0)).FinalizeParent(ctx, seq)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("UpdateItem", 1)).FinalizeParent(ctx, seq)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("UpdateItem", 2)).FinalizeParent(ctx, seq)
	wantErr(t, err, errFault)

	// A root without replies (e.g. replies not indexed yet) is left as is.
	lonely := MessageSpec{ID: mid(at(3), 3), AuthorID: "u1", Body: "solo", CreatedAt: at(3)}
	_, err = e.im.PutMessages(ctx, "c1", ParentChannel, []MessageSpec{lonely})
	mustNoErr(t, err)
	fr, err := e.im.FinalizeParent(ctx, FinalizeSpec{ParentID: "c1", ParentType: ParentChannel, ThreadRootIDs: []string{lonely.ID}})
	if err != nil || fr.ThreadsUpdated != 1 || fr.FollowsWritten != 0 {
		t.Fatalf("lonely root: %+v %v", fr, err)
	}

	// A member whose user-side row is gone is skipped.
	_, err = e.db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(e.db.Table),
		Key:       map[string]types.AttributeValue{"PK": &types.AttributeValueMemberS{Value: "USER#u2"}, "SK": &types.AttributeValueMemberS{Value: "CHAN#c1"}},
	})
	mustNoErr(t, err)
	_, err = e.im.FinalizeParent(ctx, seq)
	mustNoErr(t, err)
}

func TestFinalizeConversation(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	addUsers(t, e, "u1", "u2")
	id, _, err := e.im.EnsureConversation(ctx, ConversationSpec{Type: "dm", ParticipantIDs: []string{"u1", "u2"}, CreatedAt: t0})
	mustNoErr(t, err)
	m := MessageSpec{ID: mid(at(10), 1), AuthorID: "u1", Body: "hi", CreatedAt: at(10)}
	res, err := e.im.PutMessages(ctx, id, ParentConversation, []MessageSpec{m})
	mustNoErr(t, err)
	spec := FinalizeSpec{ParentID: id, ParentType: ParentConversation, NewTopLevel: res.TopLevelInserted, LastActivityAt: res.LastCreatedAt}
	_, err = e.im.FinalizeParent(ctx, spec)
	mustNoErr(t, err)
	cv := store.NewConversationStore(e.db)
	conv, _ := cv.GetConversation(ctx, id)
	ucs, _ := cv.ListUserConversations(ctx, "u2")
	if conv.MessageSeq != 1 || len(ucs) != 1 || ucs[0].LastReadSeq != 1 || !ucs[0].UpdatedAt.Equal(at(10)) || !conv.UpdatedAt.Equal(at(10)) {
		t.Fatalf("conv=%+v user=%+v", conv, ucs)
	}
	// Activity never moves backwards; zero new messages leaves counters.
	_, err = e.im.FinalizeParent(ctx, FinalizeSpec{ParentID: id, ParentType: ParentConversation, LastActivityAt: at(1)})
	mustNoErr(t, err)
	conv, _ = cv.GetConversation(ctx, id)
	if !conv.UpdatedAt.Equal(at(10)) || conv.MessageSeq != 1 {
		t.Fatalf("conv moved back: %+v", conv)
	}

	later := spec
	later.LastActivityAt = at(20)
	_, err = e.faulty(failOn("GetItem", 0)).FinalizeParent(ctx, later)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("UpdateItem", 1)).FinalizeParent(ctx, later)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("UpdateItem", 2)).FinalizeParent(ctx, later)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("TransactWriteItems", 0)).FinalizeParent(ctx, later)
	wantErr(t, err, errFault)

	// A participant without a user-side row is skipped.
	_, err = e.db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(e.db.Table),
		Key:       map[string]types.AttributeValue{"PK": &types.AttributeValueMemberS{Value: "USER#u2"}, "SK": &types.AttributeValueMemberS{Value: "CONV#" + id}},
	})
	mustNoErr(t, err)
	_, err = e.im.FinalizeParent(ctx, FinalizeSpec{ParentID: id, ParentType: ParentConversation, NewTopLevel: 1})
	mustNoErr(t, err)
}

func TestIndexParent(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, err := e.im.PutAttachment(ctx, AttachmentSpec{ID: "a1", Filename: "f.txt"}, bodyOf("x"))
	mustNoErr(t, err)
	msgs := []MessageSpec{
		{ID: mid(at(1), 1), AuthorID: "u1", Body: "one", CreatedAt: at(1), AttachmentIDs: []string{"a1"}},
		{ID: mid(at(2), 2), AuthorID: "u1", Body: "two", CreatedAt: at(2)},
		{ID: mid(at(3), 3), AuthorID: "u1", Body: "three", CreatedAt: at(3)},
		{ID: mid(at(4), 4), AuthorID: SystemAuthorID, Body: "joined", CreatedAt: at(4), System: true},
	}
	_, err = e.im.PutMessages(ctx, "c1", ParentChannel, msgs)
	mustNoErr(t, err)
	mustNoErr(t, e.im.TombstoneMessage(ctx, "c1", msgs[2].ID))

	orig := indexPageSize
	indexPageSize = 2
	t.Cleanup(func() { indexPageSize = orig })
	n, f, err := e.im.IndexParent(ctx, "c1", ParentChannel)
	if err != nil || n != 2 || f != 1 || e.search.bulk[search.IndexMessages] != 2 || e.search.bulk[search.IndexFiles] != 1 {
		t.Fatalf("index = %d %d %v bulk=%v", n, f, err, e.search.bulk)
	}

	_, _, err = e.im.IndexParent(ctx, "c1", "nope")
	wantErr(t, err, ErrInvalidSpec)
	noSearch, _ := New(Deps{DB: e.db})
	if n, f, err := noSearch.IndexParent(ctx, "c1", ParentChannel); n != 0 || f != 0 || err != nil {
		t.Fatalf("no search: %d %d %v", n, f, err)
	}
	_, _, err = e.faulty(failOn("Query", 0)).IndexParent(ctx, "c1", ParentChannel)
	wantErr(t, err, errFault)
	e.search.bulkErr = errFault
	_, _, err = e.im.IndexParent(ctx, "c1", ParentChannel)
	wantErr(t, err, errFault)
	e.search.bulkErr = nil

	// Attachment lookups that fail just leave files out.
	r := attachmentResolver{e.faulty(failOn("BatchGetItem", 0))}
	if r.ResolveAttachments(ctx, []string{"a1"}) != nil {
		t.Fatal("want nil on lookup failure")
	}
	if names := (attachmentResolver{e.im}).ResolveFilenames(ctx, []string{"a1"}); len(names) != 1 || names[0] != "f.txt" {
		t.Fatalf("names = %v", names)
	}
}
