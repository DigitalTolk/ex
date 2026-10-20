package store

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// batchWriteMax is DynamoDB's BatchWriteItem limit.
const batchWriteMax = 25

// Unprocessed-item retry schedule for bulk writes: exponential from
// batchRetryBase, capped at batchRetryMax, for batchRetryAttempts tries. Under
// sustained bulk load DynamoDB hands back throttled items instead of failing
// the call, so the drain loop needs room to wait out partition throttling.
// Vars so tests can shrink the waits.
var (
	batchRetryBase     = 50 * time.Millisecond
	batchRetryMax      = 5 * time.Second
	batchRetryAttempts = 10
)

// putAll writes items with BatchWriteItem in chunks of 25, draining
// UnprocessedItems with bounded exponential backoff. Puts are unconditional
// (BatchWriteItem has no condition expressions) and keys must be unique within
// a call. Returns an error if items are still unprocessed after the retries,
// or when ctx is canceled while waiting.
func (db *DB) putAll(ctx context.Context, items []map[string]types.AttributeValue) error {
	for i := 0; i < len(items); i += batchWriteMax {
		chunk := items[i:min(i+batchWriteMax, len(items))]
		reqs := make([]types.WriteRequest, len(chunk))
		for j, it := range chunk {
			reqs[j] = types.WriteRequest{PutRequest: &types.PutRequest{Item: it}}
		}
		if err := db.drainBatch(ctx, reqs); err != nil {
			return err
		}
	}
	return nil
}

func (db *DB) drainBatch(ctx context.Context, reqs []types.WriteRequest) error {
	wait := batchRetryBase
	for attempt := 1; ; attempt++ {
		out, err := db.Client.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{db.Table: reqs},
		})
		if err != nil {
			return fmt.Errorf("store: batch write: %w", err)
		}
		reqs = out.UnprocessedItems[db.Table]
		if len(reqs) == 0 {
			return nil
		}
		if attempt == batchRetryAttempts {
			return fmt.Errorf("store: batch write: %d items unprocessed after %d attempts", len(reqs), attempt)
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("store: batch write: %w", ctx.Err())
		case <-time.After(wait):
		}
		wait = min(wait*2, batchRetryMax)
	}
}
