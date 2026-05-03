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

type DraftStoreImpl struct {
	*DB
}

func NewDraftStore(db *DB) *DraftStoreImpl {
	return &DraftStoreImpl{DB: db}
}

type draftItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.MessageDraft
}

func (s *DraftStoreImpl) Upsert(ctx context.Context, draft *model.MessageDraft) error {
	item := draftItem{
		PK:           userPK(draft.UserID),
		SK:           draftSK(draft.ID),
		MessageDraft: *draft,
	}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal draft: %w", err)
	}
	_, err = s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	})
	if err != nil {
		return fmt.Errorf("store: upsert draft: %w", err)
	}
	return nil
}

func (s *DraftStoreImpl) Get(ctx context.Context, userID, id string) (*model.MessageDraft, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), draftSK(id)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get draft: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item draftItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal draft: %w", err)
	}
	return &item.MessageDraft, nil
}

func (s *DraftStoreImpl) List(ctx context.Context, userID string) ([]*model.MessageDraft, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith("DRAFT#"),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil {
		return nil, fmt.Errorf("store: build draft list expression: %w", err)
	}
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list drafts: %w", err)
	}
	drafts := make([]*model.MessageDraft, 0, len(out.Items))
	for _, raw := range out.Items {
		var item draftItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal draft: %w", err)
		}
		drafts = append(drafts, &item.MessageDraft)
	}
	return drafts, nil
}

func (s *DraftStoreImpl) Delete(ctx context.Context, userID, id string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), draftSK(id)),
	})
	if err != nil {
		return fmt.Errorf("store: delete draft: %w", err)
	}
	return nil
}
