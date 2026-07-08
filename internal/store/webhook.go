package store

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
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
// message in the shared table). The directory is trusted only once `seeded`
// is true — set by the one-time List backfill below — because webhooks
// created before this row existed would otherwise be invisible.
const webhookDirPK = "WEBHOOKDIR"

type webhookDirRow struct {
	IDs    []string `dynamodbav:"ids,stringset,omitempty"`
	Seeded bool     `dynamodbav:"seeded"`
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

func (s *IncomingWebhookStoreImpl) List(ctx context.Context) ([]*model.IncomingWebhook, error) {
	// Fast path: a seeded directory answers "which webhooks exist" with one
	// ConsistentRead GetItem; the META rows resolve in one ConsistentRead
	// BatchGet. Falls through to the legacy Scan (which then seeds the
	// directory) until the one-time backfill has run.
	dirOut, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.Table),
		Key:            compositeKey(webhookDirPK, metaSK()),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get webhook directory: %w", err)
	}
	if dirOut.Item != nil {
		var dir webhookDirRow
		if err := attributevalue.UnmarshalMap(dirOut.Item, &dir); err != nil {
			return nil, fmt.Errorf("store: unmarshal webhook directory: %w", err)
		}
		if dir.Seeded {
			return s.listByDirectory(ctx, dir.IDs)
		}
	}
	items, err := s.listByScan(ctx)
	if err != nil {
		return nil, err
	}
	s.seedDirectory(ctx, items)
	return items, nil
}

// listByDirectory hydrates the directory's ID set in chunked ConsistentRead
// BatchGets. An ID whose META row is gone (crashed half-delete) is skipped —
// the next Delete or seed prunes it.
func (s *IncomingWebhookStoreImpl) listByDirectory(ctx context.Context, ids []string) ([]*model.IncomingWebhook, error) {
	items := make([]*model.IncomingWebhook, 0, len(ids))
	const batchSize = 100
	for start := 0; start < len(ids); start += batchSize {
		end := min(start+batchSize, len(ids))
		keys := make([]map[string]types.AttributeValue, 0, end-start)
		for _, id := range ids[start:end] {
			keys = append(keys, compositeKey(webhookPK(id), webhookSK()))
		}
		req := map[string]types.KeysAndAttributes{s.Table: {Keys: keys, ConsistentRead: aws.Bool(true)}}
		for {
			res, err := s.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: req})
			if err != nil {
				return nil, fmt.Errorf("store: batch get webhooks: %w", err)
			}
			for _, av := range res.Responses[s.Table] {
				var item webhookItem
				if err := attributevalue.UnmarshalMap(av, &item); err != nil {
					return nil, fmt.Errorf("store: unmarshal webhook: %w", err)
				}
				items = append(items, &item.IncomingWebhook)
			}
			if len(res.UnprocessedKeys) == 0 {
				break
			}
			req = res.UnprocessedKeys
		}
	}
	return items, nil
}

// seedDirectory backfills the directory row from a full scan's result and
// marks it seeded. ADD unions with concurrently-created IDs, so a create
// racing the seed is never lost. Best-effort: a failed seed just means the
// next List scans (and retries) again.
func (s *IncomingWebhookStoreImpl) seedDirectory(ctx context.Context, items []*model.IncomingWebhook) {
	update := "SET seeded = :true"
	values := map[string]types.AttributeValue{
		":true": &types.AttributeValueMemberBOOL{Value: true},
	}
	if len(items) > 0 {
		ids := make([]string, 0, len(items))
		for _, wh := range items {
			ids = append(ids, wh.ID)
		}
		update = "ADD ids :ids " + update
		values[":ids"] = &types.AttributeValueMemberSS{Value: ids}
	}
	if _, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(webhookDirPK, metaSK()),
		UpdateExpression:          aws.String(update),
		ExpressionAttributeValues: values,
	}); err != nil {
		slog.Warn("webhook directory seed failed", "error", err)
	}
}

func (s *IncomingWebhookStoreImpl) listByScan(ctx context.Context) ([]*model.IncomingWebhook, error) {
	filter := expression.Name("SK").Equal(expression.Value(webhookSK())).
		And(expression.Name("PK").BeginsWith("WEBHOOK#"))
	expr := mustExpr(expression.NewBuilder().WithFilter(filter).Build())
	// Page through LastEvaluatedKey. DynamoDB applies the 1MB read limit to the
	// raw items scanned *before* the filter runs, so a single Scan over a
	// non-trivial table returns only the webhooks that happened to fall in the
	// first 1MB scanned — the rest are silently dropped from the admin list even
	// though they still resolve by ID and post fine. As the table grows (every
	// message/channel/membership shares this table) that window stops covering
	// all WEBHOOK# items, so webhooks "disappear" from admin without pagination.
	items := make([]*model.IncomingWebhook, 0)
	var startKey map[string]types.AttributeValue
	for {
		out, err := s.Client.Scan(ctx, &dynamodb.ScanInput{
			TableName:                 aws.String(s.Table),
			FilterExpression:          expr.Filter(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
			ExclusiveStartKey:         startKey,
			// Strongly consistent so a just-created webhook is visible on the
			// admin page's immediate refetch — a default (eventually consistent)
			// scan intermittently omitted it, so creating one looked like it had
			// silently failed until you retried.
			ConsistentRead: aws.Bool(true),
		})
		if err != nil {
			return nil, fmt.Errorf("store: list webhooks: %w", err)
		}
		for _, av := range out.Items {
			var item webhookItem
			if err := attributevalue.UnmarshalMap(av, &item); err != nil {
				return nil, fmt.Errorf("store: unmarshal webhook: %w", err)
			}
			if strings.HasPrefix(item.PK, "WEBHOOK#") {
				items = append(items, &item.IncomingWebhook)
			}
		}
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		startKey = out.LastEvaluatedKey
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
