package store

import (
	"context"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

type ThreadFollowStore interface {
	Set(ctx context.Context, follow *model.ThreadFollow) error
	SetMany(ctx context.Context, follows []*model.ThreadFollow) error
	Get(ctx context.Context, userID, parentID, threadRootID string) (*model.ThreadFollow, error)
	ListUser(ctx context.Context, userID string) ([]*model.ThreadFollow, error)
	ListThread(ctx context.Context, parentID, threadRootID string) ([]*model.ThreadFollow, error)
}

type ThreadFollowStoreImpl struct {
	*DB
}

var _ ThreadFollowStore = (*ThreadFollowStoreImpl)(nil)

func NewThreadFollowStore(db *DB) *ThreadFollowStoreImpl {
	return &ThreadFollowStoreImpl{DB: db}
}

type threadFollowItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK"`
	GSI1SK string `dynamodbav:"GSI1SK"`
	model.ThreadFollow
}

// dynamoBatchWriteLimit is the per-request cap enforced by DynamoDB's
// BatchWriteItem (25 ops). Callers chunk larger inputs themselves.
const dynamoBatchWriteLimit = 25

// SetMany writes a slice of follows in a single BatchWriteItem call
// (chunked to the 25-op DynamoDB limit). Used when a single message
// touches multiple users at once — e.g. a thread reply that mentions
// several teammates — so we hit DDB once instead of N times.
//
// BatchWriteItem doesn't return an error on per-item conflicts the
// way TransactWriteItems would, but follow records are idempotent
// PutItems anyway: re-writing an existing record with the same body
// is a no-op for the user-visible state.
func (s *ThreadFollowStoreImpl) SetMany(ctx context.Context, follows []*model.ThreadFollow) error {
	if len(follows) == 0 {
		return nil
	}
	requests := make([]types.WriteRequest, 0, len(follows))
	for _, f := range follows {
		item := threadFollowItem{
			PK:           userPK(f.UserID),
			SK:           threadFollowSK(f.ParentID, f.ThreadRootID),
			GSI1PK:       threadFollowGSI1PK(f.ParentID, f.ThreadRootID),
			GSI1SK:       userPK(f.UserID),
			ThreadFollow: *f,
		}
		av, err := attributevalue.MarshalMap(item)
		if err != nil { // coverage-ignore: threadFollowItem has only scalar/string/bool/time fields; MarshalMap cannot fail
			return fmt.Errorf("store: marshal thread follow: %w", err)
		}
		requests = append(requests, types.WriteRequest{PutRequest: &types.PutRequest{Item: av}})
	}
	for i := 0; i < len(requests); i += dynamoBatchWriteLimit {
		end := i + dynamoBatchWriteLimit
		if end > len(requests) {
			end = len(requests)
		}
		chunk := requests[i:end]
		// DynamoDB may return UnprocessedItems on partial throttling;
		// retry the unprocessed slice up to a small bound before
		// surfacing an error. The retry budget is intentionally
		// shallow — this path is best-effort for a UX nicety
		// (auto-follow on mention) and shouldn't stall a message send
		// indefinitely on a hot partition.
		input := &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{s.Table: chunk},
		}
		for attempt := 0; attempt < 3; attempt++ {
			out, err := s.Client.BatchWriteItem(ctx, input)
			if err != nil {
				return fmt.Errorf("store: batch set thread follows: %w", err)
			}
			if len(out.UnprocessedItems[s.Table]) == 0 {
				break
			}
			input.RequestItems = out.UnprocessedItems
			if attempt == 2 {
				return fmt.Errorf("store: batch set thread follows: %d unprocessed after retries", len(out.UnprocessedItems[s.Table]))
			}
		}
	}
	return nil
}

func (s *ThreadFollowStoreImpl) Set(ctx context.Context, follow *model.ThreadFollow) error {
	item := threadFollowItem{
		PK:           userPK(follow.UserID),
		SK:           threadFollowSK(follow.ParentID, follow.ThreadRootID),
		GSI1PK:       threadFollowGSI1PK(follow.ParentID, follow.ThreadRootID),
		GSI1SK:       userPK(follow.UserID),
		ThreadFollow: *follow,
	}
	av, err := attributevalue.MarshalMap(item)
	if err != nil { // coverage-ignore: threadFollowItem has only scalar/string/bool/time fields; MarshalMap cannot fail
		return fmt.Errorf("store: marshal thread follow: %w", err)
	}
	_, err = s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	})
	if err != nil {
		return fmt.Errorf("store: set thread follow: %w", err)
	}
	return nil
}

func (s *ThreadFollowStoreImpl) ListThread(ctx context.Context, parentID, threadRootID string) ([]*model.ThreadFollow, error) {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(threadFollowGSI1PK(parentID, threadRootID)))
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil { // coverage-ignore: static key-condition built from constants; Build cannot fail
		return nil, fmt.Errorf("store: build thread follows expression: %w", err)
	}
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list thread follows: %w", err)
	}
	follows := make([]*model.ThreadFollow, 0, len(out.Items))
	for _, raw := range out.Items {
		var item threadFollowItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil { // coverage-ignore: round-trip of items this store wrote; cannot fail
			return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
		}
		follows = append(follows, &item.ThreadFollow)
	}
	return follows, nil
}

func (s *ThreadFollowStoreImpl) Get(ctx context.Context, userID, parentID, threadRootID string) (*model.ThreadFollow, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), threadFollowSK(parentID, threadRootID)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get thread follow: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item threadFollowItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil { // coverage-ignore: round-trip of an item this store wrote; cannot fail
		return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
	}
	return &item.ThreadFollow, nil
}

func (s *ThreadFollowStoreImpl) ListUser(ctx context.Context, userID string) ([]*model.ThreadFollow, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith("THREAD#"),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil { // coverage-ignore: static key-condition built from constants; Build cannot fail
		return nil, fmt.Errorf("store: build thread follow expression: %w", err)
	}
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list thread follows: %w", err)
	}
	follows := make([]*model.ThreadFollow, 0, len(out.Items))
	for _, raw := range out.Items {
		var item threadFollowItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil { // coverage-ignore: round-trip of items this store wrote; cannot fail
			return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
		}
		follows = append(follows, &item.ThreadFollow)
	}
	return follows, nil
}
