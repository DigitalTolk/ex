package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// ContextStore persists shared-context items (CTX# partitions, plan-v2 §8).
type ContextStore struct {
	*DB
}

// NewContextStore returns a ContextStore backed by the shared DB.
func NewContextStore(db *DB) *ContextStore { return &ContextStore{DB: db} }

type ctxItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.ContextItem
}

// PutContextItem creates or replaces one item.
func (s *ContextStore) PutContextItem(ctx context.Context, it *model.ContextItem) error {
	if it.ID == "" || it.ParentID == "" || it.ParentType == "" {
		return errors.New("store: context item id/parent required")
	}
	item := ctxItem{
		PK:          ctxPK(it.ParentType, it.ParentID),
		SK:          ctxSK(it.ID),
		ContextItem: *it,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: put context item: %w", err)
	}
	return nil
}

// GetContextItem fetches one item.
func (s *ContextStore) GetContextItem(ctx context.Context, parentType, parentID, itemID string) (*model.ContextItem, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(ctxPK(parentType, parentID), ctxSK(itemID)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get context item: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item ctxItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal context item: %w", err)
	}
	return &item.ContextItem, nil
}

// ListContextItems returns a parent's items in creation (ULID) order.
func (s *ContextStore) ListContextItems(ctx context.Context, parentType, parentID string) ([]*model.ContextItem, error) {
	keyCond := expression.Key("PK").Equal(expression.Value(ctxPK(parentType, parentID))).
		And(expression.Key("SK").BeginsWith("ITEM#"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list context items: %w", err)
	}
	out := make([]*model.ContextItem, 0, len(items))
	for _, raw := range items {
		var item ctxItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal context item: %w", err)
		}
		out = append(out, &item.ContextItem)
	}
	return out, nil
}

// DeleteContextItem removes one item.
func (s *ContextStore) DeleteContextItem(ctx context.Context, parentType, parentID, itemID string) error {
	if _, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(ctxPK(parentType, parentID), ctxSK(itemID)),
	}); err != nil {
		return fmt.Errorf("store: delete context item: %w", err)
	}
	return nil
}
