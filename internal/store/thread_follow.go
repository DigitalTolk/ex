package store

import (
	"context"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

type ThreadFollowStore interface {
	Set(ctx context.Context, follow *model.ThreadFollow) error
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

func (s *ThreadFollowStoreImpl) Set(ctx context.Context, follow *model.ThreadFollow) error {
	item := threadFollowItem{
		PK:           userPK(follow.UserID),
		SK:           threadFollowSK(follow.ParentID, follow.ThreadRootID),
		GSI1PK:       threadFollowGSI1PK(follow.ParentID, follow.ThreadRootID),
		GSI1SK:       userPK(follow.UserID),
		ThreadFollow: *follow,
	}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
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
	if err != nil {
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
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
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
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
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
	if err != nil {
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
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
		}
		follows = append(follows, &item.ThreadFollow)
	}
	return follows, nil
}
