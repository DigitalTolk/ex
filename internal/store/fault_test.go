//go:build integration

package store

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// errInjected is the canonical error returned by a faultClient for the method
// under test. Tests assert it is wrapped (errors.Is) by the store's error path.
var errInjected = errors.New("injected dynamodb fault")

// faultClient wraps a real DynamoAPI and forces a single method to fail. The
// happy path delegates to the embedded real client, so test setup (writes,
// table creation) still works; only the operation under test returns the fault.
// This exercises the SDK-call error branches (`if err != nil { return ... }`)
// that a healthy DynamoDB Local never returns.
type faultClient struct {
	DynamoAPI // embedded real client

	failBatchGetItem       bool
	failBatchWriteItem     bool
	failCreateTable        bool
	failDeleteItem         bool
	failDescribeTable      bool
	failGetItem            bool
	failPutItem            bool
	failQuery              bool
	failScan               bool
	failTransactWriteItems bool
	failUpdateItem         bool
	failUpdateTimeToLive   bool
}

func (f *faultClient) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	if f.failBatchGetItem {
		return nil, errInjected
	}
	return f.DynamoAPI.BatchGetItem(ctx, in, opts...)
}

func (f *faultClient) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	if f.failBatchWriteItem {
		return nil, errInjected
	}
	return f.DynamoAPI.BatchWriteItem(ctx, in, opts...)
}

func (f *faultClient) CreateTable(ctx context.Context, in *dynamodb.CreateTableInput, opts ...func(*dynamodb.Options)) (*dynamodb.CreateTableOutput, error) {
	if f.failCreateTable {
		return nil, errInjected
	}
	return f.DynamoAPI.CreateTable(ctx, in, opts...)
}

func (f *faultClient) DeleteItem(ctx context.Context, in *dynamodb.DeleteItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.DeleteItemOutput, error) {
	if f.failDeleteItem {
		return nil, errInjected
	}
	return f.DynamoAPI.DeleteItem(ctx, in, opts...)
}

func (f *faultClient) DescribeTable(ctx context.Context, in *dynamodb.DescribeTableInput, opts ...func(*dynamodb.Options)) (*dynamodb.DescribeTableOutput, error) {
	if f.failDescribeTable {
		return nil, errInjected
	}
	return f.DynamoAPI.DescribeTable(ctx, in, opts...)
}

func (f *faultClient) GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	if f.failGetItem {
		return nil, errInjected
	}
	return f.DynamoAPI.GetItem(ctx, in, opts...)
}

func (f *faultClient) PutItem(ctx context.Context, in *dynamodb.PutItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.PutItemOutput, error) {
	if f.failPutItem {
		return nil, errInjected
	}
	return f.DynamoAPI.PutItem(ctx, in, opts...)
}

func (f *faultClient) Query(ctx context.Context, in *dynamodb.QueryInput, opts ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	if f.failQuery {
		return nil, errInjected
	}
	return f.DynamoAPI.Query(ctx, in, opts...)
}

func (f *faultClient) Scan(ctx context.Context, in *dynamodb.ScanInput, opts ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	if f.failScan {
		return nil, errInjected
	}
	return f.DynamoAPI.Scan(ctx, in, opts...)
}

func (f *faultClient) TransactWriteItems(ctx context.Context, in *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	if f.failTransactWriteItems {
		return nil, errInjected
	}
	return f.DynamoAPI.TransactWriteItems(ctx, in, opts...)
}

func (f *faultClient) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if f.failUpdateItem {
		return nil, errInjected
	}
	return f.DynamoAPI.UpdateItem(ctx, in, opts...)
}

func (f *faultClient) UpdateTimeToLive(ctx context.Context, in *dynamodb.UpdateTimeToLiveInput, opts ...func(*dynamodb.Options)) (*dynamodb.UpdateTimeToLiveOutput, error) {
	if f.failUpdateTimeToLive {
		return nil, errInjected
	}
	return f.DynamoAPI.UpdateTimeToLive(ctx, in, opts...)
}

// withFault returns a *DB sharing the table/data of base but routing calls
// through a faultClient configured by cfg. Use it after seeding data through
// the real db so the seed succeeds and only the op under test fails.
func withFault(base *DB, cfg func(*faultClient)) *DB {
	fc := &faultClient{DynamoAPI: base.Client}
	cfg(fc)
	return &DB{Client: fc, Table: base.Table}
}
