package store

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// batchGetMax is DynamoDB's BatchGetItem limit.
const batchGetMax = 100

// batchGetAll point-reads keys with BatchGetItem in chunks of 100 and returns
// the raw items. read carries the per-call options (ProjectionExpression,
// ConsistentRead, …); its Keys are ignored. UnprocessedKeys are drained on the
// shared backed-off, capped schedule (drainUnprocessed), and every retry
// re-applies read's options, so a continuation can't drop the projection or
// the consistency of the first round. Keys DynamoDB still withholds at the cap
// fail the call: a dropped key would read as "row absent". Missing rows are
// simply absent; order is not guaranteed; keys must be unique.
func (db *DB) batchGetAll(ctx context.Context, keys []map[string]types.AttributeValue, read types.KeysAndAttributes, what string) ([]map[string]types.AttributeValue, error) {
	var items []map[string]types.AttributeValue
	for start := 0; start < len(keys); start += batchGetMax {
		pending := keys[start:min(start+batchGetMax, len(keys))]
		err := drainUnprocessed(ctx, "batch get "+what, "keys", func() (int, error) {
			req := read
			req.Keys = pending
			out, err := db.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{
				RequestItems: map[string]types.KeysAndAttributes{db.Table: req},
			})
			if err != nil {
				return 0, err
			}
			items = append(items, out.Responses[db.Table]...)
			pending = out.UnprocessedKeys[db.Table].Keys
			return len(pending), nil
		})
		if err != nil {
			return nil, err
		}
	}
	return items, nil
}

// batchGetOf is batchGetAll with every row unmarshaled into T — the batch
// counterpart to getItem / queryAllOf.
func batchGetOf[T any](ctx context.Context, db *DB, keys []map[string]types.AttributeValue, read types.KeysAndAttributes, what string) ([]T, error) {
	items, err := db.batchGetAll(ctx, keys, read, what)
	if err != nil {
		return nil, err
	}
	out := make([]T, 0, len(items))
	for _, raw := range items {
		var row T
		if err := attributevalue.UnmarshalMap(raw, &row); err != nil {
			return nil, fmt.Errorf("store: unmarshal %s: %w", what, err)
		}
		out = append(out, row)
	}
	return out, nil
}
