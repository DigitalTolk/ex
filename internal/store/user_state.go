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

type UserStateStore interface {
	SetUserState(ctx context.Context, item *model.UserStateItem) error
	DeleteUserState(ctx context.Context, userID string, kind model.UserStateKind, targetID string) error
	GetUserState(ctx context.Context, userID string, kind model.UserStateKind, targetID string) (*model.UserStateItem, error)
	ListUserState(ctx context.Context, userID string, kind model.UserStateKind) ([]*model.UserStateItem, error)
}

type UserStateStoreImpl struct {
	*DB
}

var _ UserStateStore = (*UserStateStoreImpl)(nil)

func NewUserStateStore(db *DB) *UserStateStoreImpl {
	return &UserStateStoreImpl{DB: db}
}

type userStateItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.UserStateItem
}

func (s *UserStateStoreImpl) SetUserState(ctx context.Context, item *model.UserStateItem) error {
	row := userStateItem{
		PK:            userPK(item.UserID),
		SK:            userStateSK(string(item.Kind), item.TargetID),
		UserStateItem: *item,
	}
	av := mustAttrs(attributevalue.MarshalMap(row))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: set user state: %w", err)
	}
	return nil
}

func (s *UserStateStoreImpl) DeleteUserState(ctx context.Context, userID string, kind model.UserStateKind, targetID string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), userStateSK(string(kind), targetID)),
	}); err != nil {
		return fmt.Errorf("store: delete user state: %w", err)
	}
	return nil
}

// GetUserState returns one of userID's state rows; ErrNotFound when it has
// none.
func (s *UserStateStoreImpl) GetUserState(ctx context.Context, userID string, kind model.UserStateKind, targetID string) (*model.UserStateItem, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), userStateSK(string(kind), targetID)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get user state: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item userStateItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal user state: %w", err)
	}
	item.Kind = kind
	return &item.UserStateItem, nil
}

// ListUserState lists userID's state rows of one kind. Never every kind at
// once: thread_seen rows (one per thread the user ever opened, never pruned)
// are nearly all of a user's state, and every other reader needs one small
// kind.
func (s *UserStateStoreImpl) ListUserState(ctx context.Context, userID string, kind model.UserStateKind) ([]*model.UserStateItem, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith(userStateSK(string(kind), "")),
	)
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	rows, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list user state: %w", err)
	}
	items := make([]*model.UserStateItem, 0, len(rows))
	for _, raw := range rows {
		var item userStateItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal user state: %w", err)
		}
		item.Kind = kind
		items = append(items, &item.UserStateItem)
	}
	return items, nil
}
