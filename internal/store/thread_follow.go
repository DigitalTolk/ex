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
	SetThreadFollow(ctx context.Context, follow *model.ThreadFollow) error
	SetThreadFollowMany(ctx context.Context, follows []*model.ThreadFollow) error
	GetThreadFollow(ctx context.Context, userID, parentID, threadRootID string) (*model.ThreadFollow, error)
	ListUserThreadFollows(ctx context.Context, userID string) ([]*model.ThreadFollow, error)
	ListThreadFollows(ctx context.Context, parentID, threadRootID string) ([]*model.ThreadFollow, error)
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

// SetThreadFollowMany writes a slice of follows in a single BatchWriteItem call
// (chunked to the 25-op DynamoDB limit). Used when a single message
// touches multiple users at once — e.g. a thread reply that mentions
// several teammates — so we hit DDB once instead of N times.
//
// BatchWriteItem doesn't return an error on per-item conflicts the
// way TransactWriteItems would, but follow records are idempotent
// PutItems anyway: re-writing an existing record with the same body
// is a no-op for the user-visible state.
func (s *ThreadFollowStoreImpl) SetThreadFollowMany(ctx context.Context, follows []*model.ThreadFollow) error {
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
		av := mustAttrs(attributevalue.MarshalMap(item))
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

func (s *ThreadFollowStoreImpl) SetThreadFollow(ctx context.Context, follow *model.ThreadFollow) error {
	item := threadFollowItem{
		PK:           userPK(follow.UserID),
		SK:           threadFollowSK(follow.ParentID, follow.ThreadRootID),
		GSI1PK:       threadFollowGSI1PK(follow.ParentID, follow.ThreadRootID),
		GSI1SK:       userPK(follow.UserID),
		ThreadFollow: *follow,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	})
	if err != nil {
		return fmt.Errorf("store: set thread follow: %w", err)
	}
	return nil
}

func (s *ThreadFollowStoreImpl) ListThreadFollows(ctx context.Context, parentID, threadRootID string) ([]*model.ThreadFollow, error) {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(threadFollowGSI1PK(parentID, threadRootID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	// Drain every page: these are the thread's watchers, i.e. notification
	// recipients for a reply, so truncation would drop alerts.
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list thread follows: %w", err)
	}
	follows := make([]*model.ThreadFollow, 0, len(items))
	for _, raw := range items {
		var item threadFollowItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
		}
		follows = append(follows, &item.ThreadFollow)
	}
	return follows, nil
}

func (s *ThreadFollowStoreImpl) GetThreadFollow(ctx context.Context, userID, parentID, threadRootID string) (*model.ThreadFollow, error) {
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
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
	}
	return &item.ThreadFollow, nil
}

func (s *ThreadFollowStoreImpl) ListUserThreadFollows(ctx context.Context, userID string) ([]*model.ThreadFollow, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith("THREAD#"),
	)
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list thread follows: %w", err)
	}
	follows := make([]*model.ThreadFollow, 0, len(items))
	for _, raw := range items {
		var item threadFollowItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
		}
		follows = append(follows, &item.ThreadFollow)
	}
	return follows, nil
}

// threadSeedSK marks that a user's implicit thread participation has been
// backfilled into follow rows (the lazy /threads index migration). Deliberately
// NOT under the THREADFOLLOW# prefix so ListUser's begins_with never sees it.
const threadSeedSK = "THREADSEED"

// SetThreadFollowIfAbsent writes a follow row ONLY when the user has no explicit record
// for that thread yet — the write-time participation index must never clobber
// a deliberate unfollow (Following=false) with an implicit re-follow.
func (s *ThreadFollowStoreImpl) SetThreadFollowIfAbsent(ctx context.Context, follow *model.ThreadFollow) error {
	item := threadFollowItem{
		PK:           userPK(follow.UserID),
		SK:           threadFollowSK(follow.ParentID, follow.ThreadRootID),
		GSI1PK:       threadFollowGSI1PK(follow.ParentID, follow.ThreadRootID),
		GSI1SK:       userPK(follow.UserID),
		ThreadFollow: *follow,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return nil // an explicit record exists — leave it be
		}
		return fmt.Errorf("store: set thread follow if absent: %w", err)
	}
	return nil
}

// IsThreadIndexSeeded reports whether this user's historic thread
// participation has been backfilled into follow rows.
func (s *ThreadFollowStoreImpl) IsThreadIndexSeeded(ctx context.Context, userID string) (bool, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), threadSeedSK),
	})
	if err != nil {
		return false, fmt.Errorf("store: get thread seed marker: %w", err)
	}
	return out.Item != nil, nil
}

// MarkThreadIndexSeeded records that the backfill ran for this user.
func (s *ThreadFollowStoreImpl) MarkThreadIndexSeeded(ctx context.Context, userID string) error {
	item := map[string]types.AttributeValue{
		"PK": &types.AttributeValueMemberS{Value: userPK(userID)},
		"SK": &types.AttributeValueMemberS{Value: threadSeedSK},
	}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.Table), Item: item}); err != nil {
		return fmt.Errorf("store: mark thread seed: %w", err)
	}
	return nil
}
