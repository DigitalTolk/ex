//go:build integration

package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

func makeThreadFollow(userID, parentID, rootID string) *model.ThreadFollow {
	return &model.ThreadFollow{
		UserID:       userID,
		ParentID:     parentID,
		ParentType:   "channel",
		ThreadRootID: rootID,
		Following:    true,
		UpdatedAt:    time.Now().Truncate(time.Millisecond),
	}
}

// SDK-call error branches in the thread-follow store, exercised via faultClient.

func TestThreadFollowStore_Set_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.Set(ctx, makeThreadFollow("u-tf", "ch-tf", "root-1"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Set: want errInjected, got %v", err)
	}
}

func TestThreadFollowStore_SetMany_BatchWriteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failBatchWriteItem = true }))
	err := s.SetMany(ctx, []*model.ThreadFollow{makeThreadFollow("u-tf", "ch-tf", "root-1")})
	if !errors.Is(err, errInjected) {
		t.Fatalf("SetMany: want errInjected, got %v", err)
	}
}

// SetMany with no follows is a no-op success.
func TestThreadFollowStore_SetMany_Empty(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(db)
	if err := s.SetMany(ctx, nil); err != nil {
		t.Fatalf("SetMany empty: %v", err)
	}
}

func TestThreadFollowStore_Get_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.Get(ctx, "u-tf", "ch-tf", "root-1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Get: want errInjected, got %v", err)
	}
}

func TestThreadFollowStore_ListUser_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.ListUser(ctx, "u-tf")
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListUser: want errInjected, got %v", err)
	}
}

func TestThreadFollowStore_ListThread_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.ListThread(ctx, "ch-tf", "root-1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListThread: want errInjected, got %v", err)
	}
}

// unprocessedClient delegates BatchWriteItem to the real client but rewrites the
// response's UnprocessedItems so SetMany's retry loop runs. `remaining` controls
// how many leading calls report everything as unprocessed; once it hits zero the
// real (empty) UnprocessedItems pass through, ending the loop.
type unprocessedClient struct {
	DynamoAPI
	table     string
	remaining int
}

func (c *unprocessedClient) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	out, err := c.DynamoAPI.BatchWriteItem(ctx, in, opts...)
	if err != nil {
		return out, err
	}
	if c.remaining > 0 {
		c.remaining--
		// Echo the request items back as unprocessed to drive the retry path.
		out.UnprocessedItems = map[string][]types.WriteRequest{c.table: in.RequestItems[c.table]}
	}
	return out, nil
}

// SetMany retries when the first BatchWriteItem reports UnprocessedItems, then
// succeeds on the retry (covering the reassign + eventual break).
func TestThreadFollowStore_SetMany_RetriesOnUnprocessed(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	uc := &unprocessedClient{DynamoAPI: db.Client, table: db.Table, remaining: 1}
	s := NewThreadFollowStore(&DB{Client: uc, Table: db.Table})
	if err := s.SetMany(ctx, []*model.ThreadFollow{makeThreadFollow("u-tf-r", "ch-tf", "root-r")}); err != nil {
		t.Fatalf("SetMany retry: %v", err)
	}
}

// SetMany gives up after exhausting its retry budget when every BatchWriteItem
// keeps reporting UnprocessedItems.
func TestThreadFollowStore_SetMany_ExhaustsRetries(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	uc := &unprocessedClient{DynamoAPI: db.Client, table: db.Table, remaining: 99}
	s := NewThreadFollowStore(&DB{Client: uc, Table: db.Table})
	err := s.SetMany(ctx, []*model.ThreadFollow{makeThreadFollow("u-tf-x", "ch-tf", "root-x")})
	if err == nil || !strings.Contains(err.Error(), "unprocessed after retries") {
		t.Fatalf("SetMany exhausted: want 'unprocessed after retries' error, got %v", err)
	}
}
