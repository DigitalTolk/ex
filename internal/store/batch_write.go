package store

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/cenkalti/backoff/v5"
)

// batchWriteMax is DynamoDB's BatchWriteItem limit.
const batchWriteMax = 25

// Unprocessed-request retry schedule shared by every batch read and write:
// jittered exponential from batchRetryBase, capped at batchRetryMax, for
// batchRetryAttempts tries. Under sustained load DynamoDB hands back throttled
// keys/items instead of failing the call, so a drain loop needs room to wait
// out partition throttling — and a bound, so it never spins against a hot
// partition. Vars so tests can shrink the waits.
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

// drainBatch sends one BatchWriteItem chunk (≤25 requests) and drains its
// UnprocessedItems on the shared schedule.
func (db *DB) drainBatch(ctx context.Context, reqs []types.WriteRequest) error {
	return drainUnprocessed(ctx, "batch write", "items", func() (int, error) {
		out, err := db.Client.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{db.Table: reqs},
		})
		if err != nil {
			return 0, err
		}
		reqs = out.UnprocessedItems[db.Table]
		return len(reqs), nil
	})
}

// drainUnprocessed repeats one batch round until it reports nothing left over,
// waiting between rounds on the shared backoff schedule. round returns how
// many requests DynamoDB handed back unprocessed (it keeps its own pending set
// between calls). An SDK error is final — the SDK's retryer has already spent
// its own budget on it — and so is a round still incomplete at the attempt
// cap: the caller gets an error, never a silently short result. Cancelling
// ctx interrupts the wait.
func drainUnprocessed(ctx context.Context, op, unit string, round func() (int, error)) error {
	attempt := 0
	_, err := backoff.Retry(ctx, func() (struct{}, error) {
		attempt++
		left, err := round()
		if err != nil {
			return struct{}{}, backoff.Permanent(err)
		}
		if left > 0 {
			return struct{}{}, fmt.Errorf("%d %s unprocessed after %d attempts", left, unit, attempt)
		}
		return struct{}{}, nil
	}, backoff.WithBackOff(newBatchBackOff()),
		backoff.WithMaxTries(uint(batchRetryAttempts)),
		backoff.WithMaxElapsedTime(0)) // the attempt cap (and ctx) bound the drain, not a wall-clock budget
	if err != nil {
		return fmt.Errorf("store: %s: %w", op, err)
	}
	return nil
}

// newBatchBackOff builds the shared schedule. The default ±50% jitter keeps
// concurrent drains against one throttled partition from retrying in lockstep.
func newBatchBackOff() *backoff.ExponentialBackOff {
	b := backoff.NewExponentialBackOff()
	b.InitialInterval = batchRetryBase
	b.MaxInterval = batchRetryMax
	b.Multiplier = 2
	return b
}
