//go:build integration

package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// A group message becoming a private channel, against DynamoDB.

func makeGroup(t *testing.T, cs *ConversationStoreImpl, id string, people ...string) *model.Conversation {
	t.Helper()
	now := time.Now().Truncate(time.Millisecond)
	conv := &model.Conversation{ID: id, Type: model.ConversationTypeGroup, ParticipantIDs: people, CreatedBy: people[0], Activated: true, CreatedAt: now, UpdatedAt: now, MessageSeq: 7}
	rows := make([]*model.UserConversation, 0, len(people))
	for _, uid := range people {
		rows = append(rows, &model.UserConversation{UserID: uid, ConversationID: id, Type: model.ConversationTypeGroup, DisplayName: "the group", ParticipantIDs: people, Activated: true, JoinedAt: now})
	}
	if err := cs.CreateConversation(context.Background(), conv, rows); err != nil {
		t.Fatalf("create group: %v", err)
	}
	return conv
}

func convertedMembers(chID string, people []string) []ConvertedMember {
	out := make([]ConvertedMember, 0, len(people))
	for _, uid := range people {
		out = append(out, ConvertedMember{
			Member:      &model.ChannelMembership{ChannelID: chID, UserID: uid, Role: model.ChannelRoleMember, DisplayName: uid},
			UserChannel: &model.UserChannel{UserID: uid, ChannelID: chID, ChannelName: "ops", ChannelType: model.ChannelTypePrivate, Role: model.ChannelRoleMember, LastReadSeq: 5},
		})
	}
	return out
}

func privateChannel(id, slug string) *model.Channel {
	now := time.Now().Truncate(time.Millisecond)
	return &model.Channel{ID: id, Name: slug, Slug: slug, Type: model.ChannelTypePrivate, CreatedBy: "u-a", CreatedAt: now, UpdatedAt: now, MessageSeq: 7}
}

func TestConversationStore_ConvertGroupToChannel(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewConversationStore(db)
	ms := NewMembershipStore(db)
	chs := NewChannelStore(db)
	msgs := NewMessageStore(db)
	people := []string{"u-cv-a", "u-cv-b", "u-cv-c"}
	makeGroup(t, cs, "conv-cv", people...)
	// History written for the group, under its ID.
	if err := msgs.CreateMessage(ctx, &model.Message{ID: "m-cv-1", ParentID: "conv-cv", AuthorID: "u-cv-a", Body: "hello", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}

	rows, err := cs.GetUserConversations(ctx, "conv-cv", append([]string{"u-cv-nobody"}, people...))
	if err != nil || len(rows) != 3 || rows["u-cv-b"].DisplayName != "the group" {
		t.Fatalf("GetUserConversations = %v, %v", rows, err)
	}

	ch := privateChannel("conv-cv", "ops-cv")
	if err := cs.ConvertGroupToChannel(ctx, ch, convertedMembers(ch.ID, people), time.Now()); err != nil {
		t.Fatalf("convert: %v", err)
	}

	conv, err := cs.GetConversation(ctx, "conv-cv")
	if err != nil || conv.ConvertedToChannelID != "conv-cv" || conv.ConvertedAt == nil {
		t.Fatalf("conversation after = %+v, %v", conv, err)
	}
	got, err := chs.GetChannelBySlug(ctx, "ops-cv")
	if err != nil || got.ID != "conv-cv" || got.Type != model.ChannelTypePrivate || got.MessageSeq != 7 {
		t.Fatalf("channel = %+v, %v", got, err)
	}
	for _, uid := range people {
		if convs, _ := cs.ListUserConversations(ctx, uid); len(convs) != 0 {
			t.Errorf("%s still lists the group: %+v", uid, convs)
		}
		userChans, _ := ms.ListUserChannels(ctx, uid)
		if len(userChans) != 1 || userChans[0].ChannelID != "conv-cv" || userChans[0].LastReadSeq != 5 {
			t.Errorf("%s channels = %+v", uid, userChans)
		}
		if member, _ := cs.IsMember(ctx, "conv-cv", uid); member {
			t.Errorf("%s is still a member of the group", uid)
		}
	}
	if members, _ := ms.ListMembers(ctx, "conv-cv"); len(members) != 3 {
		t.Fatalf("channel members = %+v", members)
	}
	// The history is the channel's now, untouched.
	if list, _, err := msgs.ListMessages(ctx, "conv-cv", "", 10); err != nil || len(list) != 1 || list[0].Body != "hello" {
		t.Fatalf("history = %+v, %v", list, err)
	}
	// A converted group is listed with the channels, not the conversations.
	all, err := cs.ListAllConversations(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range all {
		if c.ID == "conv-cv" {
			t.Fatal("ListAllConversations lists the converted group")
		}
	}

	// Converting again changes nothing.
	if err := cs.ConvertGroupToChannel(ctx, privateChannel("conv-cv", "ops-cv-2"), convertedMembers("conv-cv", people), time.Now()); !errors.Is(err, ErrConversationConverted) {
		t.Fatalf("second convert = %v, want ErrConversationConverted", err)
	}
	if _, err := chs.GetChannelBySlug(ctx, "ops-cv-2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second convert took a name: %v", err)
	}
}

func TestConversationStore_ConvertGroupToChannel_NameTaken(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewConversationStore(db)
	people := []string{"u-nt-a", "u-nt-b"}
	makeGroup(t, cs, "conv-nt", people...)
	if err := NewChannelStore(db).CreateChannel(ctx, privateChannel("ch-other", "taken")); err != nil {
		t.Fatal(err)
	}
	if err := cs.ConvertGroupToChannel(ctx, privateChannel("conv-nt", "taken"), convertedMembers("conv-nt", people), time.Now()); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("convert = %v, want ErrAlreadyExists", err)
	}
	conv, _ := cs.GetConversation(ctx, "conv-nt")
	if conv.ConvertedToChannelID != "" {
		t.Fatal("a failed conversion marked the group")
	}
	if convs, _ := cs.ListUserConversations(ctx, "u-nt-a"); len(convs) != 1 {
		t.Fatalf("a failed conversion moved members: %+v", convs)
	}
}

// Only a group converts.
func TestConversationStore_ConvertGroupToChannel_DM(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewConversationStore(db)
	conv, members := makeConv("conv-dm-cv", "u-dm-a", "u-dm-b")
	if err := cs.CreateConversation(ctx, conv, members); err != nil {
		t.Fatal(err)
	}
	if err := cs.ConvertGroupToChannel(ctx, privateChannel("conv-dm-cv", "dm-cv"), convertedMembers("conv-dm-cv", conv.ParticipantIDs), time.Now()); !errors.Is(err, ErrConversationConverted) {
		t.Fatalf("convert a DM = %v", err)
	}
}

// More people than one transaction holds move in several.
func TestConversationStore_ConvertGroupToChannel_LargeGroup(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewConversationStore(db)
	people := make([]string, 0, 40)
	for i := range 40 {
		people = append(people, fmt.Sprintf("u-lg-%02d", i))
	}
	makeGroup(t, cs, "conv-lg", people...)
	if err := cs.ConvertGroupToChannel(ctx, privateChannel("conv-lg", "large"), convertedMembers("conv-lg", people), time.Now()); err != nil {
		t.Fatalf("convert: %v", err)
	}
	members, err := NewMembershipStore(db).ListMembers(ctx, "conv-lg")
	if err != nil || len(members) != 40 {
		t.Fatalf("members = %d, %v", len(members), err)
	}
	if convs, _ := cs.ListUserConversations(ctx, "u-lg-39"); len(convs) != 0 {
		t.Fatal("the last member still lists the group")
	}
}

func TestConversationStore_ConvertErrors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	failTx := NewConversationStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	if err := failTx.ConvertGroupToChannel(ctx, privateChannel("conv-x", "x"), nil, time.Now()); !errors.Is(err, errInjected) {
		t.Fatalf("convert = %v", err)
	}
	if err := failTx.MoveMembersToChannel(ctx, "conv-x", convertedMembers("conv-x", []string{"u"})); !errors.Is(err, errInjected) {
		t.Fatalf("move = %v", err)
	}
	failGet := NewConversationStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true }))
	if _, err := failGet.GetUserConversations(ctx, "conv-x", []string{"u"}); !errors.Is(err, errInjected) {
		t.Fatalf("get rows = %v", err)
	}
	corrupt := NewConversationStore(withFault(db, func(f *faultClient) {
		f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
			out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {corruptRow()}}
			out.UnprocessedKeys = nil
			return out
		}
	}))
	_, err := corrupt.GetUserConversations(ctx, "conv-x", []string{"u"})
	assertUnmarshalErr(t, err, "GetUserConversations")

	// Keys DynamoDB defers are read again.
	cs := NewConversationStore(db)
	makeGroup(t, cs, "conv-up", "u-up-a", "u-up-b")
	deferred := false
	drained := NewConversationStore(&DB{Client: &faultClient{DynamoAPI: db.Client, transformBatchGetItem: func(o *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
		if deferred {
			return o
		}
		deferred = true
		return &dynamodb.BatchGetItemOutput{UnprocessedKeys: map[string]types.KeysAndAttributes{db.Table: {
			Keys: []map[string]types.AttributeValue{compositeKey(userPK("u-up-b"), convSK("conv-up"))},
		}}}
	}}, Table: db.Table})
	rows, err := drained.GetUserConversations(ctx, "conv-up", []string{"u-up-a", "u-up-b"})
	if err != nil || len(rows) != 1 || rows["u-up-b"] == nil {
		t.Fatalf("drained rows = %v, %v", rows, err)
	}
}

func TestNextGroupConversationID(t *testing.T) {
	first := DeriveGroupConversationID([]string{"a", "b"})
	next := NextGroupConversationID(first)
	if next == first || next != NextGroupConversationID(first) || len(next) != len(first) {
		t.Fatalf("next = %q after %q", next, first)
	}
}
