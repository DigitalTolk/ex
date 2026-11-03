//go:build integration

package store

import (
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// readRecorder wraps a real DynamoAPI and keeps every Query and BatchGetItem
// it is asked for.
type readRecorder struct {
	DynamoAPI
	queries []*dynamodb.QueryInput
	batches []*dynamodb.BatchGetItemInput
}

func (r *readRecorder) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	r.queries = append(r.queries, in)
	return r.DynamoAPI.Query(ctx, in, opts...)
}

func (r *readRecorder) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	r.batches = append(r.batches, in)
	return r.DynamoAPI.BatchGetItem(ctx, in, opts...)
}

// Regression: a freshly created DM opened on "1 new message" — the creator's
// own first message. Unread is the member row's LastReadSeq against the
// parent's MessageSeq; the send writes both just before its events make the
// sidebar refetch, and an eventually consistent read of that refetch saw the
// new MessageSeq with the old LastReadSeq. DynamoDB Local is always
// consistent, so what is pinned here is that every read behind the count asks
// for a consistent answer.
func TestUnreadCountReadsAreConsistent(t *testing.T) {
	base := setupDynamoDB(t)
	rec := &readRecorder{DynamoAPI: base.Client}
	db := &DB{Client: rec, Table: base.Table}
	ctx := context.Background()

	reads := []struct {
		name string
		run  func() error
	}{
		{"user conversations", func() error { _, err := NewConversationStore(db).ListUserConversations(ctx, "u-1"); return err }},
		{"conversation seqs", func() error {
			_, err := NewConversationStore(db).GetConversationsByIDs(ctx, []string{"c-1"})
			return err
		}},
		{"user channels", func() error { _, err := NewMembershipStore(db).ListUserChannels(ctx, "u-1"); return err }},
		{"channel seqs", func() error {
			_, err := NewChannelStore(db).GetChannelsByIDsConsistent(ctx, []string{"ch-1"})
			return err
		}},
	}
	for _, read := range reads {
		t.Run(read.name, func(t *testing.T) {
			rec.queries, rec.batches = nil, nil
			if err := read.run(); err != nil {
				t.Fatal(err)
			}
			if len(rec.queries)+len(rec.batches) == 0 {
				t.Fatal("no read was made")
			}
			for _, q := range rec.queries {
				if !aws.ToBool(q.ConsistentRead) {
					t.Fatal("an eventually consistent Query")
				}
			}
			for _, b := range rec.batches {
				for _, keys := range b.RequestItems {
					if !aws.ToBool(keys.ConsistentRead) {
						t.Fatal("an eventually consistent BatchGetItem")
					}
				}
			}
		})
	}
}
