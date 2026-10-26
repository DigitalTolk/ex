//go:build integration

package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// The activity touch only re-sorts sidebars, so it must not be a transaction:
// a TransactWriteItems costs twice the write units and is cancelled outright
// when two participants send at the same moment (both touch the same rows),
// losing the re-sort. Independent writes land even when transactions can't.
func TestConversationStore_Touch_IndependentWrites(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	conv, members := makeConv("conv-tx", "u-tx-a", "u-tx-b")
	if err := NewConversationStore(db).CreateConversation(ctx, conv, members); err != nil {
		t.Fatalf("seed: %v", err)
	}
	at := time.Now().Add(time.Hour).Truncate(time.Millisecond)
	noTx := NewConversationStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	if err := noTx.TouchConversation(ctx, conv.ID, conv.ParticipantIDs, at); err != nil {
		t.Fatalf("Touch must not depend on a transaction: %v", err)
	}
	cs := NewConversationStore(db)
	got, err := cs.GetConversation(ctx, conv.ID)
	if err != nil || !got.UpdatedAt.Equal(at) {
		t.Fatalf("META updatedAt = %v (err %v), want %v", got, err, at)
	}
	for _, uid := range conv.ParticipantIDs {
		rows, err := cs.ListUserConversations(ctx, uid)
		if err != nil || len(rows) != 1 || !rows[0].UpdatedAt.Equal(at) {
			t.Fatalf("%s sidebar row = %+v (err %v), want updatedAt %v", uid, rows, err, at)
		}
	}
}

// Without the transaction's all-or-nothing, each write guards itself: a
// missing conversation is ErrNotFound and a participant with no sidebar row
// is skipped — an unconditional update would mint a phantom row holding
// nothing but updatedAt, which the sidebar would then list.
func TestConversationStore_Touch_NeverCreatesRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewConversationStore(db)
	at := time.Now().Truncate(time.Millisecond)

	if err := cs.TouchConversation(ctx, "conv-gone", []string{"u-gone-a"}, at); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing conversation: err = %v, want ErrNotFound", err)
	}
	assertNoRow(t, db, userPK("u-gone-a"), convSK("conv-gone"))
	assertNoRow(t, db, convPK("conv-gone"), metaSK())

	conv, members := makeConv("conv-left", "u-left-a", "u-left-b")
	if err := cs.CreateConversation(ctx, conv, members); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// u-left-c is listed as a participant but has no sidebar row.
	if err := cs.TouchConversation(ctx, conv.ID, []string{"u-left-a", "u-left-c"}, at); err != nil {
		t.Fatalf("Touch: %v", err)
	}
	assertNoRow(t, db, userPK("u-left-c"), convSK(conv.ID))
	rows, err := cs.ListUserConversations(ctx, "u-left-a")
	if err != nil || len(rows) != 1 || !rows[0].UpdatedAt.Equal(at) {
		t.Fatalf("u-left-a sidebar row = %+v (err %v), want updatedAt %v", rows, err, at)
	}
}

// A failing participant write surfaces; the META write's own failure arm is
// covered by TestConversationStore_Touch_UpdateError.
func TestConversationStore_Touch_ParticipantWriteError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	conv, members := makeConv("conv-pe", "u-pe-a", "u-pe-b")
	if err := NewConversationStore(db).CreateConversation(ctx, conv, members); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewConversationStore(&DB{Client: &failUserRowUpdates{DynamoAPI: db.Client}, Table: db.Table})
	if err := s.TouchConversation(ctx, conv.ID, conv.ParticipantIDs, time.Now()); !errors.Is(err, errInjected) {
		t.Fatalf("Touch: want errInjected, got %v", err)
	}
}

// failUserRowUpdates fails UpdateItem on user-partition rows only.
type failUserRowUpdates struct{ DynamoAPI }

func (f *failUserRowUpdates) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, o ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if pk, ok := in.Key["PK"].(*types.AttributeValueMemberS); ok && strings.HasPrefix(pk.Value, "USER#") {
		return nil, errInjected
	}
	return f.DynamoAPI.UpdateItem(ctx, in, o...)
}

func assertNoRow(t *testing.T, db *DB, pk, sk string) {
	t.Helper()
	out, err := db.Client.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName:      aws.String(db.Table),
		Key:            compositeKey(pk, sk),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatalf("get %s/%s: %v", pk, sk, err)
	}
	if out.Item != nil {
		t.Fatalf("row %s/%s exists: %v", pk, sk, out.Item)
	}
}
