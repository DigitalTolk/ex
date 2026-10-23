//go:build integration

package store

import (
	"context"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// capFirstQuery truncates the first Query response to its first `keep` items
// and hands back their last key as the continuation — what DynamoDB does when
// a page hits the 1MB response cap before Limit (long bodies, big webhook
// payloads). Later queries pass through.
func capFirstQuery(keep int) func(*dynamodb.QueryOutput) *dynamodb.QueryOutput {
	fired := false
	return func(out *dynamodb.QueryOutput) *dynamodb.QueryOutput {
		if fired || len(out.Items) <= keep {
			return out
		}
		fired = true
		out.Items = out.Items[:keep]
		out.Count = int32(keep)
		last := out.Items[keep-1]
		out.LastEvaluatedKey = map[string]types.AttributeValue{"PK": last["PK"], "SK": last["SK"]}
		for _, k := range []string{"GSI2PK", "GSI2SK"} {
			if v, ok := last[k]; ok {
				out.LastEvaluatedKey[k] = v
			}
		}
		return out
	}
}

// A page cut short by the 1MB cap still has history behind it: reporting
// hasMore=false there told the client it had reached the start of the
// channel, and stopped the migrate walkers (forEachMessage) early.
func TestListMessages_CappedPageStillHasMore(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	ids := make([]string, 5)
	for i := range ids {
		m := makeMessage("ch-cap", NewID(), "u1", "m")
		if err := ms.CreateMessage(ctx, m); err != nil {
			t.Fatalf("seed: %v", err)
		}
		ids[i] = m.ID
	}

	older := NewMessageStore(withFault(db, func(f *faultClient) { f.transformQuery = capFirstQuery(2) }))
	msgs, hasMore, err := older.ListMessages(ctx, "ch-cap", "", 10)
	if err != nil || len(msgs) != 2 || !hasMore {
		t.Fatalf("capped older page = %d msgs, hasMore=%v (err %v); want 2 and hasMore", len(msgs), hasMore, err)
	}

	newer := NewMessageStore(withFault(db, func(f *faultClient) { f.transformQuery = capFirstQuery(2) }))
	msgs, hasMore, err = newer.ListMessagesAfter(ctx, "ch-cap", ids[0], 10)
	if err != nil || len(msgs) != 1 || !hasMore {
		t.Fatalf("capped newer page = %d msgs, hasMore=%v (err %v); want 1 and hasMore", len(msgs), hasMore, err)
	}
}
