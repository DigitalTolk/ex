//go:build integration

package store

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// consistencyRecorder records whether each read asked for strong consistency.
type consistencyRecorder struct {
	DynamoAPI
	mu        sync.Mutex
	queries   []bool
	batchGets []bool
}

func (r *consistencyRecorder) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	r.mu.Lock()
	r.queries = append(r.queries, aws.ToBool(in.ConsistentRead))
	r.mu.Unlock()
	return r.DynamoAPI.Query(ctx, in, opts...)
}

func (r *consistencyRecorder) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	r.mu.Lock()
	for _, ka := range in.RequestItems {
		r.batchGets = append(r.batchGets, aws.ToBool(ka.ConsistentRead))
	}
	r.mu.Unlock()
	return r.DynamoAPI.BatchGetItem(ctx, in, opts...)
}

// The notification audience cache keeps what these reads return, so the
// reads that fill it are strongly consistent: an eventually consistent read
// right after a join, mute or settings change could miss it, and the cache
// would then hold the stale audience until the next change.
func TestAudienceReads_AreStronglyConsistent(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	rec := &consistencyRecorder{DynamoAPI: db.Client}
	recDB := &DB{Client: rec, Table: db.Table}
	ms := NewMembershipStore(recDB)
	us := NewUserStore(recDB)

	ch := makeChannel("ch-cons", "cons", "cons-slug", model.ChannelTypePublic)
	if err := NewChannelStore(db).CreateChannel(ctx, ch); err != nil {
		t.Fatalf("Create channel: %v", err)
	}
	member := &model.ChannelMembership{ChannelID: ch.ID, UserID: "u-cons", Role: model.ChannelRoleMember, JoinedAt: time.Now()}
	if err := NewMembershipStore(db).AddChannelMember(ctx, ch, member, &model.UserChannel{UserID: "u-cons", ChannelID: ch.ID, JoinedAt: time.Now()}); err != nil {
		t.Fatalf("AddChannelMember: %v", err)
	}

	got, err := ms.ListMembersConsistent(ctx, ch.ID)
	if err != nil || len(got) != 1 || got[0].UserID != "u-cons" {
		t.Fatalf("ListMembersConsistent = %v, %v", got, err)
	}
	if _, err := ms.ListMembers(ctx, ch.ID); err != nil {
		t.Fatalf("ListMembers: %v", err)
	}
	if len(rec.queries) != 2 || !rec.queries[0] || rec.queries[1] {
		t.Fatalf("query consistency = %v, want [true false] (only the cache fill pays for consistency)", rec.queries)
	}

	if _, err := ms.UserChannelNotifPrefs(ctx, ch.ID, []string{"u-cons"}); err != nil {
		t.Fatalf("UserChannelNotifPrefs: %v", err)
	}
	if _, err := us.NotificationAccountsFor(ctx, []string{"u-cons"}); err != nil {
		t.Fatalf("NotificationAccountsFor: %v", err)
	}
	if len(rec.batchGets) != 2 || !rec.batchGets[0] || !rec.batchGets[1] {
		t.Fatalf("batch-get consistency = %v, want both strongly consistent", rec.batchGets)
	}
}
