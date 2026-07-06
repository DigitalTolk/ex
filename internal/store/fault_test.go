//go:build integration

package store

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
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

	failBatchGetItem   bool
	failBatchWriteItem bool
	failCreateTable    bool
	failDeleteItem     bool
	failDescribeTable  bool
	// failDescribeTableFromCall (1-based) fails DescribeTable only from the
	// N-th call on — lets EnsureTable's existence probe pass while the
	// post-create waiter's probe fails.
	failDescribeTableFromCall int
	describeTableCalls        int
	failGetItem               bool
	failPutItem               bool
	failQuery                 bool
	failScan                  bool
	failTransactWriteItems    bool
	failUpdateItem            bool
	failUpdateTimeToLive      bool

	// transform*, when set, rewrite the REAL output before returning — used to
	// feed type-corrupted items (unmarshal error arms), truncated pages and
	// UnprocessedKeys continuations that a healthy DynamoDB Local never
	// produces. The request still hits the real container first, so input
	// validation and store-side key construction stay exercised.
	transformGetItem      func(*dynamodb.GetItemOutput) *dynamodb.GetItemOutput
	transformQuery        func(*dynamodb.QueryOutput) *dynamodb.QueryOutput
	transformScan         func(*dynamodb.ScanOutput) *dynamodb.ScanOutput
	transformBatchGetItem func(*dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput
	transformUpdateItem   func(*dynamodb.UpdateItemOutput) *dynamodb.UpdateItemOutput

	// pageQueryOnce drives a manual LastEvaluatedKey drain loop through a second
	// iteration: the first Query returns the real page plus a synthetic cursor,
	// the follow-up Query (carrying ExclusiveStartKey) returns an empty page to
	// end the loop. Exercises the >1MB pagination-continuation branch that a
	// small DynamoDB Local table never produces on its own.
	pageQueryOnce bool
	// pageScanOnce: same trick for Scan-based drain loops (ListAll).
	pageScanOnce bool
}

func (f *faultClient) BatchGetItem(ctx context.Context, in *dynamodb.BatchGetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.BatchGetItemOutput, error) {
	if f.failBatchGetItem {
		return nil, errInjected
	}
	out, err := f.DynamoAPI.BatchGetItem(ctx, in, opts...)
	if err == nil && f.transformBatchGetItem != nil {
		out = f.transformBatchGetItem(out)
	}
	return out, err
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
	f.describeTableCalls++
	if f.failDescribeTableFromCall > 0 && f.describeTableCalls >= f.failDescribeTableFromCall {
		return nil, errInjected
	}
	return f.DynamoAPI.DescribeTable(ctx, in, opts...)
}

func (f *faultClient) GetItem(ctx context.Context, in *dynamodb.GetItemInput, opts ...func(*dynamodb.Options)) (*dynamodb.GetItemOutput, error) {
	if f.failGetItem {
		return nil, errInjected
	}
	out, err := f.DynamoAPI.GetItem(ctx, in, opts...)
	if err == nil && f.transformGetItem != nil {
		out = f.transformGetItem(out)
	}
	return out, err
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
	if f.pageQueryOnce {
		if in.ExclusiveStartKey != nil {
			return &dynamodb.QueryOutput{}, nil // second page: empty → ends the drain loop
		}
		out, err := f.DynamoAPI.Query(ctx, in, opts...)
		if err != nil {
			return out, err
		}
		out.LastEvaluatedKey = map[string]types.AttributeValue{
			"PK": &types.AttributeValueMemberS{Value: "cursor"},
			"SK": &types.AttributeValueMemberS{Value: "cursor"},
		}
		return out, nil
	}
	out, err := f.DynamoAPI.Query(ctx, in, opts...)
	if err == nil && f.transformQuery != nil {
		out = f.transformQuery(out)
	}
	return out, err
}

func (f *faultClient) Scan(ctx context.Context, in *dynamodb.ScanInput, opts ...func(*dynamodb.Options)) (*dynamodb.ScanOutput, error) {
	if f.failScan {
		return nil, errInjected
	}
	if f.pageScanOnce {
		if in.ExclusiveStartKey != nil {
			return &dynamodb.ScanOutput{}, nil // second page: empty → ends the drain loop
		}
		out, err := f.DynamoAPI.Scan(ctx, in, opts...)
		if err != nil {
			return out, err
		}
		out.LastEvaluatedKey = map[string]types.AttributeValue{
			"PK": &types.AttributeValueMemberS{Value: "cursor"},
			"SK": &types.AttributeValueMemberS{Value: "cursor"},
		}
		return out, nil
	}
	out, err := f.DynamoAPI.Scan(ctx, in, opts...)
	if err == nil && f.transformScan != nil {
		out = f.transformScan(out)
	}
	return out, err
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
	out, err := f.DynamoAPI.UpdateItem(ctx, in, opts...)
	if err == nil && f.transformUpdateItem != nil {
		out = f.transformUpdateItem(out)
	}
	return out, err
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

// corruptRow is an attribute map no store row struct can absorb: every row
// type embeds PK as a string, and unmarshaling a map into a string field
// fails. Used by transform* hooks to reach the unmarshal error arms — the
// runtime condition they guard is exactly "a row this code did not write".
func corruptRow() map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		"PK": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
	}
}

// corruptGetItem / corruptQuery / corruptScan / corruptBatchGet return
// transform hooks that replace the real payload with corruptRow.
func corruptGetItem(out *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
	out.Item = corruptRow()
	return out
}

func corruptQuery(out *dynamodb.QueryOutput) *dynamodb.QueryOutput {
	out.Items = []map[string]types.AttributeValue{corruptRow()}
	out.Count = 1
	return out
}

func corruptScan(out *dynamodb.ScanOutput) *dynamodb.ScanOutput {
	out.Items = []map[string]types.AttributeValue{corruptRow()}
	out.Count = 1
	return out
}
