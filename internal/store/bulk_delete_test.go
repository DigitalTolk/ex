//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func countPartition(t *testing.T, db *DB, pk string) int {
	t.Helper()
	keys, err := db.partitionKeys(context.Background(), pk)
	if err != nil {
		t.Fatal(err)
	}
	return len(keys)
}

func TestDeleteMessagesIndexRowsAndFollows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	msgs := bulkMessages("chan-del", 30)
	if err := ms.PutNewMessages(ctx, msgs); err != nil {
		t.Fatal(err)
	}
	pi := NewParentIndexStore(db)
	at := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := pi.SetIndexRows(ctx, []PinIndexEntry{{ParentID: "chan-del", MessageID: msgs[0].ID, PinnedBy: "u1", PinnedAt: at}},
		[]FileIndexEntry{{ParentID: "chan-del", AttachmentID: "att-1", MessageID: msgs[0].ID, AuthorID: "u1", CreatedAt: at}}); err != nil {
		t.Fatal(err)
	}
	tf := NewThreadFollowStore(db)
	follow := &model.ThreadFollow{UserID: "u1", ParentID: "chan-del", ParentType: "channel", ThreadRootID: msgs[0].ID, Following: true, UpdatedAt: at}
	if err := tf.SetThreadFollow(ctx, follow); err != nil {
		t.Fatal(err)
	}

	ids := make([]string, len(msgs))
	for i, m := range msgs {
		ids[i] = m.ID
	}
	if err := ms.DeleteMessages(ctx, "chan-del", ids); err != nil {
		t.Fatal(err)
	}
	if err := pi.DeleteIndexRows(ctx, "chan-del", []string{msgs[0].ID}, []string{"att-1"}); err != nil {
		t.Fatal(err)
	}
	if err := tf.DeleteThreadFollows(ctx, []*model.ThreadFollow{follow}); err != nil {
		t.Fatal(err)
	}
	if n := countPartition(t, db, channelPK("chan-del")); n != 0 {
		t.Fatalf("%d rows left in partition", n)
	}
	if fs, err := tf.ListThreadFollows(ctx, "chan-del", msgs[0].ID); err != nil || len(fs) != 0 {
		t.Fatalf("follows = %v %v", fs, err)
	}
	// Deleting again is a no-op.
	if err := ms.DeleteMessages(ctx, "chan-del", ids); err != nil {
		t.Fatal(err)
	}
}

func TestDeleteChannelConversationUser(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	at := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)

	cs := NewChannelStore(db)
	ch := &model.Channel{ID: "c-del", Name: "c-del", Slug: "c-del", Type: model.ChannelTypePublic, CreatedAt: at}
	if err := cs.CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	if err := NewMessageStore(db).PutNewMessages(ctx, bulkMessages("c-del", 3)); err != nil {
		t.Fatal(err)
	}
	if err := cs.DeleteChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	if n := countPartition(t, db, channelPK("c-del")); n != 0 {
		t.Fatalf("%d channel rows left", n)
	}
	if n := countPartition(t, db, chanSlugGSI1PK("c-del")); n != 0 {
		t.Fatal("slug lock left")
	}

	conv := NewConversationStore(db)
	c := &model.Conversation{ID: "conv-del", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u1", "u2"}, CreatedAt: at}
	if err := conv.CreateConversation(ctx, c, []*model.UserConversation{
		{UserID: "u1", ConversationID: "conv-del"}, {UserID: "u2", ConversationID: "conv-del"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := NewMessageStore(db).PutNewMessages(ctx, bulkMessages("conv-del", 2)); err != nil {
		t.Fatal(err)
	}
	if err := conv.DeleteConversation(ctx, c); err != nil {
		t.Fatal(err)
	}
	for _, pk := range []string{convPK("conv-del"), parentPK("conv-del")} {
		if n := countPartition(t, db, pk); n != 0 {
			t.Fatalf("%d rows left under %s", n, pk)
		}
	}
	if ucs, err := conv.ListUserConversations(ctx, "u1"); err != nil || len(ucs) != 0 {
		t.Fatalf("u1 conversations = %v %v", ucs, err)
	}

	us := NewUserStore(db)
	u := &model.User{ID: "u-del", Email: "Del@Example.com", DisplayName: "Del", CreatedAt: at}
	if err := us.CreateUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	if err := us.DeleteUser(ctx, u); err != nil {
		t.Fatal(err)
	}
	if _, err := us.GetUser(ctx, "u-del"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("user still there: %v", err)
	}
	if n := countPartition(t, db, userEmailPK(u.Email)); n != 0 {
		t.Fatal("email index left")
	}
}

func TestLastReadSeqs(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	at := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	ch := &model.Channel{ID: "c-seq", Name: "c-seq", Slug: "c-seq", Type: model.ChannelTypePublic, CreatedAt: at}
	if err := NewChannelStore(db).CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	ms := NewMembershipStore(db)
	for _, uid := range []string{"u1", "u2"} {
		if err := ms.AddMember(ctx, &model.ChannelMembership{ChannelID: "c-seq", UserID: uid},
			&model.UserChannel{ChannelID: "c-seq", UserID: uid}); err != nil {
			t.Fatal(err)
		}
	}
	if err := ms.AddChannelLastRead(ctx, "c-seq", "u2", 5); err != nil {
		t.Fatal(err)
	}
	got, err := ms.LastReadSeqs(ctx, "c-seq", []string{"u1", "u2", "ghost"})
	if err != nil || len(got) != 2 || got["u1"] != 0 || got["u2"] != 5 {
		t.Fatalf("channel seqs = %v %v", got, err)
	}

	conv := NewConversationStore(db)
	c := &model.Conversation{ID: "conv-seq", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u1", "u2"}, CreatedAt: at}
	if err := conv.CreateConversation(ctx, c, []*model.UserConversation{
		{UserID: "u1", ConversationID: "conv-seq"}, {UserID: "u2", ConversationID: "conv-seq"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := conv.AddConversationLastRead(ctx, "conv-seq", "u1", 3); err != nil {
		t.Fatal(err)
	}
	got, err = conv.LastReadSeqs(ctx, "conv-seq", []string{"u1", "u2"})
	if err != nil || got["u1"] != 3 || got["u2"] != 0 {
		t.Fatalf("conversation seqs = %v %v", got, err)
	}

	// UnprocessedKeys are drained: the first response defers every key.
	deferred := false
	fc := &faultClient{DynamoAPI: db.Client, transformBatchGetItem: func(o *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
		if deferred {
			return o
		}
		deferred = true
		keys := []map[string]types.AttributeValue{compositeKey(userPK("u2"), chanSK("c-seq"))}
		return &dynamodb.BatchGetItemOutput{UnprocessedKeys: map[string]types.KeysAndAttributes{db.Table: {
			Keys: keys, ProjectionExpression: strPtr("#uid, #seq"),
			ExpressionAttributeNames: map[string]string{"#uid": "userID", "#seq": "lastReadSeq"},
		}}}
	}}
	got, err = NewMembershipStore(&DB{Client: fc, Table: db.Table}).LastReadSeqs(ctx, "c-seq", []string{"u1", "u2"})
	if err != nil || len(got) != 1 || got["u2"] != 5 {
		t.Fatalf("drained seqs = %v %v", got, err)
	}
}

func TestBulkDeleteErrors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	writeFail := &DB{Client: &faultClient{DynamoAPI: db.Client, failBatchWriteItem: true}, Table: db.Table}
	if err := NewMessageStore(writeFail).DeleteMessages(ctx, "p", []string{"m"}); !errors.Is(err, errInjected) {
		t.Fatalf("delete messages: %v", err)
	}
	queryFail := &DB{Client: &faultClient{DynamoAPI: db.Client, failQuery: true}, Table: db.Table}
	if err := NewChannelStore(queryFail).DeleteChannel(ctx, &model.Channel{ID: "c", Slug: "c"}); !errors.Is(err, errInjected) {
		t.Fatalf("delete channel: %v", err)
	}
	getFail := &DB{Client: &faultClient{DynamoAPI: db.Client, failBatchGetItem: true}, Table: db.Table}
	if _, err := NewMembershipStore(getFail).LastReadSeqs(ctx, "c", []string{"u"}); !errors.Is(err, errInjected) {
		t.Fatalf("read seqs: %v", err)
	}
	bad := &DB{Client: &faultClient{DynamoAPI: db.Client, transformBatchGetItem: func(*dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
		return &dynamodb.BatchGetItemOutput{Responses: map[string][]map[string]types.AttributeValue{db.Table: {
			{"userID": &types.AttributeValueMemberS{Value: "u"}, "lastReadSeq": &types.AttributeValueMemberS{Value: "not-a-number"}},
		}}}
	}}, Table: db.Table}
	if _, err := NewConversationStore(bad).LastReadSeqs(ctx, "c", []string{"u"}); err == nil {
		t.Fatal("want unmarshal error")
	}
}

func TestClearReplyMetadata(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	msgs := bulkMessages("chan-clear", 2)
	if err := ms.PutNewMessages(ctx, msgs); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := ms.SetReplyMetadata(ctx, "chan-clear", msgs[0].ID, 1, at, []string{"u1"}); err != nil {
		t.Fatal(err)
	}
	if err := ms.ClearReplyMetadata(ctx, "chan-clear", msgs[0].ID); err != nil {
		t.Fatal(err)
	}
	got, err := ms.GetMessage(ctx, "chan-clear", msgs[0].ID)
	if err != nil || got.ReplyCount != 0 || got.LastReplyAt != nil || len(got.RecentReplyAuthorIDs) != 0 {
		t.Fatalf("root = %+v %v", got, err)
	}
	if err := ms.ClearReplyMetadata(ctx, "chan-clear", "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	fail := NewMessageStore(&DB{Client: &faultClient{DynamoAPI: db.Client, failUpdateItem: true}, Table: db.Table})
	if err := fail.ClearReplyMetadata(ctx, "chan-clear", msgs[0].ID); !errors.Is(err, errInjected) {
		t.Fatalf("fault: %v", err)
	}
}
