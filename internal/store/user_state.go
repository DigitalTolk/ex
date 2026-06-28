package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

type UserStateStore interface {
	Set(ctx context.Context, item *model.UserStateItem) error
	Delete(ctx context.Context, userID string, kind model.UserStateKind, targetID string) error
	List(ctx context.Context, userID string) ([]*model.UserStateItem, error)
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

func (s *UserStateStoreImpl) Set(ctx context.Context, item *model.UserStateItem) error {
	row := userStateItem{
		PK:            userPK(item.UserID),
		SK:            userStateSK(string(item.Kind), item.TargetID),
		UserStateItem: *item,
	}
	av, err := attributevalue.MarshalMap(row)
	if err != nil { // coverage-ignore: userStateItem has only scalar/string/time fields; MarshalMap cannot fail
		return fmt.Errorf("store: marshal user state: %w", err)
	}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: set user state: %w", err)
	}
	return nil
}

func (s *UserStateStoreImpl) Delete(ctx context.Context, userID string, kind model.UserStateKind, targetID string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), userStateSK(string(kind), targetID)),
	}); err != nil {
		return fmt.Errorf("store: delete user state: %w", err)
	}
	return nil
}

func (s *UserStateStoreImpl) List(ctx context.Context, userID string) ([]*model.UserStateItem, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith("STATE#"),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil { // coverage-ignore: static key-condition built from constants; Build cannot fail
		return nil, fmt.Errorf("store: build user state expression: %w", err)
	}
	input := &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}
	var items []*model.UserStateItem
	for {
		out, err := s.Client.Query(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("store: list user state: %w", err)
		}
		for _, raw := range out.Items {
			var item userStateItem
			if err := attributevalue.UnmarshalMap(raw, &item); err != nil { // coverage-ignore: round-trip of items this store wrote; cannot fail
				return nil, fmt.Errorf("store: unmarshal user state: %w", err)
			}
			if item.Kind == "" {
				item.Kind = userStateKindFromSK(item.SK)
			}
			items = append(items, &item.UserStateItem)
		}
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		input.ExclusiveStartKey = out.LastEvaluatedKey
	}
	return items, nil
}

func userStateKindFromSK(sk string) model.UserStateKind {
	parts := strings.SplitN(sk, "#", 3)
	if len(parts) < 2 {
		return ""
	}
	return model.UserStateKind(parts[1])
}
