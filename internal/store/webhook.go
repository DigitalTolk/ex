package store

import (
	"context"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
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

// The webhook DIRECTORY is a single row holding the ID set of every webhook,
// maintained atomically with each create/delete. It lets the admin List read
// "which webhooks exist" with one ConsistentRead GetItem + one BatchGet of
// their META rows instead of a full-table Scan (whose cost grew with every
// message in the shared table).
const webhookDirPK = "WEBHOOKDIR"

type webhookDirRow struct {
	IDs []string `dynamodbav:"ids,stringset,omitempty"`
}

func (s *IncomingWebhookStoreImpl) Create(ctx context.Context, wh *model.IncomingWebhook) error {
	item := webhookItem{PK: webhookPK(wh.ID), SK: webhookSK(), IncomingWebhook: *wh}
	av := mustAttrs(attributevalue.MarshalMap(item))
	// The META row and its directory entry commit together so the admin
	// list's ConsistentRead can never see a created webhook missing (the
	// read-your-own-create guarantee the old ConsistentRead Scan provided).
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Put: &types.Put{
				TableName:           aws.String(s.Table),
				Item:                av,
				ConditionExpression: aws.String("attribute_not_exists(PK)"),
			}},
			{Update: &types.Update{
				TableName:        aws.String(s.Table),
				Key:              compositeKey(webhookDirPK, metaSK()),
				UpdateExpression: aws.String("ADD ids :id"),
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":id": &types.AttributeValueMemberSS{Value: []string{wh.ID}},
				},
			}},
		},
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
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

// List answers "which webhooks exist" from the directory with one
// ConsistentRead GetItem, then resolves the META rows in ConsistentRead
// BatchGets. No directory row yet means no webhooks.
func (s *IncomingWebhookStoreImpl) List(ctx context.Context) ([]*model.IncomingWebhook, error) {
	dirOut, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.Table),
		Key:            compositeKey(webhookDirPK, metaSK()),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get webhook directory: %w", err)
	}
	var dir webhookDirRow
	if err := attributevalue.UnmarshalMap(dirOut.Item, &dir); err != nil {
		return nil, fmt.Errorf("store: unmarshal webhook directory: %w", err)
	}
	return s.listByDirectory(ctx, dir.IDs)
}

// listByDirectory hydrates the directory's ID set in chunked ConsistentRead
// BatchGets. An ID whose META row is gone (crashed half-delete) is skipped —
// the next Delete prunes it.
func (s *IncomingWebhookStoreImpl) listByDirectory(ctx context.Context, ids []string) ([]*model.IncomingWebhook, error) {
	keys := make([]map[string]types.AttributeValue, len(ids))
	for i, id := range ids {
		keys[i] = compositeKey(webhookPK(id), webhookSK())
	}
	rows, err := batchGetOf[webhookItem](ctx, s.DB, keys, types.KeysAndAttributes{ConsistentRead: aws.Bool(true)}, "webhooks")
	if err != nil {
		return nil, err
	}
	items := make([]*model.IncomingWebhook, len(rows))
	for i := range rows {
		items[i] = &rows[i].IncomingWebhook
	}
	return items, nil
}

func (s *IncomingWebhookStoreImpl) Update(ctx context.Context, wh *model.IncomingWebhook) error {
	item := webhookItem{PK: webhookPK(wh.ID), SK: webhookSK(), IncomingWebhook: *wh}
	av := mustAttrs(attributevalue.MarshalMap(item))
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
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
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Delete: &types.Delete{
				TableName: aws.String(s.Table),
				Key:       compositeKey(webhookPK(id), webhookSK()),
			}},
			{Update: &types.Update{
				TableName:        aws.String(s.Table),
				Key:              compositeKey(webhookDirPK, metaSK()),
				UpdateExpression: aws.String("DELETE ids :id"),
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":id": &types.AttributeValueMemberSS{Value: []string{id}},
				},
			}},
		},
	})
	if err != nil {
		return fmt.Errorf("store: delete webhook: %w", err)
	}
	return nil
}
