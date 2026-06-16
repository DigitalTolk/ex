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

type IncomingWebhookStore interface {
	Create(ctx context.Context, wh *model.IncomingWebhook) error
	Get(ctx context.Context, id string) (*model.IncomingWebhook, error)
	List(ctx context.Context) ([]*model.IncomingWebhook, error)
	Update(ctx context.Context, wh *model.IncomingWebhook) error
	Delete(ctx context.Context, id string) error
}

type IncomingWebhookStoreImpl struct {
	*DB
}

var _ IncomingWebhookStore = (*IncomingWebhookStoreImpl)(nil)

func NewIncomingWebhookStore(db *DB) *IncomingWebhookStoreImpl {
	return &IncomingWebhookStoreImpl{DB: db}
}

type webhookItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.IncomingWebhook
}

func (s *IncomingWebhookStoreImpl) Create(ctx context.Context, wh *model.IncomingWebhook) error {
	item := webhookItem{PK: webhookPK(wh.ID), SK: webhookSK(), IncomingWebhook: *wh}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal webhook: %w", err)
	}
	_, err = s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create webhook: %w", err)
	}
	return nil
}

func (s *IncomingWebhookStoreImpl) Get(ctx context.Context, id string) (*model.IncomingWebhook, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(webhookPK(id), webhookSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get webhook: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item webhookItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal webhook: %w", err)
	}
	return &item.IncomingWebhook, nil
}

func (s *IncomingWebhookStoreImpl) List(ctx context.Context) ([]*model.IncomingWebhook, error) {
	filter := expression.Name("SK").Equal(expression.Value(webhookSK())).
		And(expression.Name("PK").BeginsWith("WEBHOOK#"))
	expr, err := expression.NewBuilder().WithFilter(filter).Build()
	if err != nil {
		return nil, fmt.Errorf("store: build webhook scan: %w", err)
	}
	out, err := s.Client.Scan(ctx, &dynamodb.ScanInput{
		TableName:                 aws.String(s.Table),
		FilterExpression:          expr.Filter(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		// Strongly consistent so a just-created webhook is visible on the
		// admin page's immediate refetch — a default (eventually consistent)
		// scan intermittently omitted it, so creating one looked like it had
		// silently failed until you retried.
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list webhooks: %w", err)
	}
	items := make([]*model.IncomingWebhook, 0, len(out.Items))
	for _, av := range out.Items {
		var item webhookItem
		if err := attributevalue.UnmarshalMap(av, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal webhook: %w", err)
		}
		if strings.HasPrefix(item.PK, "WEBHOOK#") {
			items = append(items, &item.IncomingWebhook)
		}
	}
	return items, nil
}

func (s *IncomingWebhookStoreImpl) Update(ctx context.Context, wh *model.IncomingWebhook) error {
	item := webhookItem{PK: webhookPK(wh.ID), SK: webhookSK(), IncomingWebhook: *wh}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal webhook: %w", err)
	}
	_, err = s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: update webhook: %w", err)
	}
	return nil
}

func (s *IncomingWebhookStoreImpl) Delete(ctx context.Context, id string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(webhookPK(id), webhookSK()),
	})
	if err != nil {
		return fmt.Errorf("store: delete webhook: %w", err)
	}
	return nil
}
