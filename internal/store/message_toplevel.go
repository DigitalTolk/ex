package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"golang.org/x/sync/errgroup"
)

// ErrTopLevelIndexPending means the top-level index can't be trusted yet:
// messages written before it existed carry no index keys until the one-time
// backfill (`migrate top-level-index`) has run. Callers fall back to
// filtering ListMessages.
var ErrTopLevelIndexPending = errors.New("store: top-level message index not backfilled yet")

// topLevelIndexSeededPK marks (with META) that the backfill completed a clean
// pass over the whole table.
const topLevelIndexSeededPK = "TOPMSGIDXSEEDED"

// topLevelIndexRecheck bounds how long a "not seeded yet" answer is reused
// before the marker is read again. A var so tests can force or suppress
// re-reads.
var topLevelIndexRecheck = time.Minute

// topLevelIndexState caches the marker. Seeded is permanent — every write
// path stamps the index — so a yes is kept for the process lifetime; a no is
// re-read at most every topLevelIndexRecheck, so instances adopt the index
// shortly after the backfill finishes without a marker read on every page
// load before then.
type topLevelIndexState struct {
	mu        sync.Mutex
	seeded    bool
	checkedAt time.Time
}

func (s *MessageStoreImpl) topLevelIndexSeeded(ctx context.Context) (bool, error) {
	st := s.topIndex
	st.mu.Lock()
	seeded, known := st.seeded, st.seeded || time.Since(st.checkedAt) < topLevelIndexRecheck
	st.mu.Unlock()
	if known {
		return seeded, nil
	}
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(topLevelIndexSeededPK, metaSK()),
	})
	if err != nil {
		return false, fmt.Errorf("store: get top-level index marker: %w", err)
	}
	st.mu.Lock()
	defer st.mu.Unlock()
	st.seeded = st.seeded || out.Item != nil
	st.checkedAt = time.Now()
	return st.seeded, nil
}

// MarkTopLevelIndexSeeded switches ListTopLevelMessages on table-wide. Only
// the backfill calls it, after a clean full pass.
func (s *MessageStoreImpl) MarkTopLevelIndexSeeded(ctx context.Context) error {
	marker := map[string]types.AttributeValue{
		"PK":       &types.AttributeValueMemberS{Value: topLevelIndexSeededPK},
		"SK":       &types.AttributeValueMemberS{Value: metaSK()},
		"seededAt": &types.AttributeValueMemberS{Value: time.Now().UTC().Format(time.RFC3339)},
	}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.Table), Item: marker}); err != nil {
		return fmt.Errorf("store: mark top-level index seeded: %w", err)
	}
	return nil
}

// ListTopLevelMessages returns up to limit of a parent's top-level messages,
// newest first — strictly older than `before` when it is set — from the GSI2
// top-level index: one bounded read of exactly the rows the page shows, where
// filtering ListMessages pages past every thread reply in between. hasMore
// reports older top-level messages beyond the page. Like every GSI the index
// is eventually consistent; live messages reach clients over the WebSocket.
// Returns ErrTopLevelIndexPending until the backfill has completed.
func (s *MessageStoreImpl) ListTopLevelMessages(ctx context.Context, parentID, before string, limit int) ([]*model.Message, bool, error) {
	pk := expression.Key("GSI2PK").Equal(expression.Value(topLevelGSI2PK(parentID)))
	keyCond := expression.KeyAnd(pk, expression.Key("GSI2SK").BeginsWith("MSG#"))
	if before != "" {
		keyCond = expression.KeyAnd(pk, expression.Key("GSI2SK").LessThan(expression.Value(msgSK(before))))
	}
	return s.queryTopLevel(ctx, keyCond, false, limit)
}

// ListTopLevelMessagesAfter is ListTopLevelMessages scrolling the other way:
// up to limit of a parent's top-level messages strictly newer than `after`,
// the ones nearest the cursor, returned newest first like every message page.
// hasMore reports newer top-level messages beyond the page. An empty cursor
// lists nothing (as ListMessagesAfter). Returns ErrTopLevelIndexPending until
// the backfill has completed.
func (s *MessageStoreImpl) ListTopLevelMessagesAfter(ctx context.Context, parentID, after string, limit int) ([]*model.Message, bool, error) {
	if after == "" {
		return nil, false, nil
	}
	keyCond := expression.KeyAnd(
		expression.Key("GSI2PK").Equal(expression.Value(topLevelGSI2PK(parentID))),
		expression.Key("GSI2SK").GreaterThan(expression.Value(msgSK(after))),
	)
	messages, hasMore, err := s.queryTopLevel(ctx, keyCond, true, limit)
	slices.Reverse(messages)
	return messages, hasMore, err
}

// queryTopLevel reads up to limit rows of the top-level index in key order
// (oldest first when forward), plus one look-ahead row for hasMore.
func (s *MessageStoreImpl) queryTopLevel(ctx context.Context, keyCond expression.KeyConditionBuilder, forward bool, limit int) ([]*model.Message, bool, error) {
	seeded, err := s.topLevelIndexSeeded(ctx)
	if err != nil {
		return nil, false, err
	}
	if !seeded {
		return nil, false, ErrTopLevelIndexPending
	}
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	in := &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ScanIndexForward:          aws.Bool(forward),
	}
	// One row past the page detects "has more". A response comes back short
	// of Limit only at DynamoDB's 1MB cap (long bodies): keep reading, so a
	// capped page is neither short nor mistaken for the end of history.
	messages := make([]*model.Message, 0, limit+1)
	for {
		in.Limit = aws.Int32(int32(limit + 1 - len(messages)))
		out, err := s.Client.Query(ctx, in)
		if err != nil {
			return nil, false, fmt.Errorf("store: list top-level messages: %w", err)
		}
		for _, item := range out.Items {
			var mi messageItem
			if err := attributevalue.UnmarshalMap(item, &mi); err != nil {
				return nil, false, fmt.Errorf("store: unmarshal message: %w", err)
			}
			messages = append(messages, &mi.Message)
		}
		if len(messages) > limit || len(out.LastEvaluatedKey) == 0 {
			break
		}
		in.ExclusiveStartKey = out.LastEvaluatedKey
	}
	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}
	return messages, hasMore, nil
}

// TopLevelBackfill counts one BackfillTopLevelIndex run.
type TopLevelBackfill struct {
	// Found is how many top-level message rows lacked the index keys.
	Found int
	// Stamped is how many of them were stamped (would be, in a dry run).
	Stamped int
	// Gone is how many were deleted between the scan and their stamp.
	Gone int
}

// BackfillTopLevelIndex stamps the top-level index keys onto every message row
// written before the index existed.
//
// It Scans the whole table (strongly consistent) rather than walking a parent
// list, so no message partition is missed whatever its parent: a row missed
// here would vanish from its channel once the index is switched on. Each stamp
// is an UpdateItem of the two index keys only — it never clobbers a concurrent
// edit — conditioned on the row still being a top-level message, so a message
// deleted mid-run is not resurrected as a key-only stub. Up to `workers`
// stamps run in parallel. Idempotent and resumable: stamped rows drop out of
// the next run's filter. Run it only once every server runs a build that
// stamps the index on write (and again after any rollback to an older build).
func (s *MessageStoreImpl) BackfillTopLevelIndex(ctx context.Context, dryRun bool, workers int) (TopLevelBackfill, error) {
	var res TopLevelBackfill
	filter := expression.Name("PK").BeginsWith("CHAN#").
		And(expression.Name("SK").BeginsWith("MSG#")).
		And(expression.Name("parentMessageID").AttributeNotExists()).
		And(expression.Name("GSI2PK").AttributeNotExists())
	proj := expression.NamesList(expression.Name("PK"), expression.Name("SK"))
	expr := mustExpr(expression.NewBuilder().WithFilter(filter).WithProjection(proj).Build())
	pages := dynamodb.NewScanPaginator(s.Client, &dynamodb.ScanInput{
		TableName:                 aws.String(s.Table),
		FilterExpression:          expr.Filter(),
		ProjectionExpression:      expr.Projection(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ConsistentRead:            aws.Bool(true),
	})
	for pages.HasMorePages() {
		page, err := pages.NextPage(ctx)
		if err != nil {
			return res, fmt.Errorf("store: scan unindexed messages: %w", err)
		}
		keys := make([]messageKey, len(page.Items))
		for i, item := range page.Items {
			if err := attributevalue.UnmarshalMap(item, &keys[i]); err != nil {
				return res, fmt.Errorf("store: unmarshal message key: %w", err)
			}
		}
		res.Found += len(keys)
		if dryRun {
			res.Stamped += len(keys)
			continue
		}
		stamped, gone, err := s.stampTopLevel(ctx, keys, workers)
		res.Stamped += stamped
		res.Gone += gone
		if err != nil {
			return res, err
		}
	}
	return res, nil
}

type messageKey struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
}

// stampTopLevel stamps one scan page's rows, up to workers at a time.
func (s *MessageStoreImpl) stampTopLevel(ctx context.Context, keys []messageKey, workers int) (int, int, error) {
	var stamped, gone atomic.Int64
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(max(workers, 1))
	for _, k := range keys {
		g.Go(func() error {
			parentID := strings.TrimPrefix(k.PK, "CHAN#")
			upd := expression.Set(expression.Name("GSI2PK"), expression.Value(topLevelGSI2PK(parentID))).
				Set(expression.Name("GSI2SK"), expression.Value(k.SK))
			cond := expression.Name("PK").AttributeExists().And(expression.Name("parentMessageID").AttributeNotExists())
			uexpr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
			_, err := s.Client.UpdateItem(gctx, &dynamodb.UpdateItemInput{
				TableName:                 aws.String(s.Table),
				Key:                       compositeKey(k.PK, k.SK),
				UpdateExpression:          uexpr.Update(),
				ConditionExpression:       uexpr.Condition(),
				ExpressionAttributeNames:  uexpr.Names(),
				ExpressionAttributeValues: uexpr.Values(),
			})
			switch {
			case err == nil:
				stamped.Add(1)
			case isConditionCheckFailed(err):
				gone.Add(1) // hard-deleted since the scan: nothing to index
			default:
				return fmt.Errorf("store: stamp top-level index %s/%s: %w", k.PK, k.SK, err)
			}
			return nil
		})
	}
	err := g.Wait()
	return int(stamped.Load()), int(gone.Load()), err
}
