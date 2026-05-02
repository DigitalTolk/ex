package store

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/DigitalTolk/ex/internal/model"
)

// AttachmentStore defines persistence operations for message attachments.
type AttachmentStore interface {
	Create(ctx context.Context, a *model.Attachment) error
	GetByID(ctx context.Context, id string) (*model.Attachment, error)
	GetByHash(ctx context.Context, sha256 string) (*model.Attachment, error)
	AddRef(ctx context.Context, attachmentID, messageID string) error
	RemoveRef(ctx context.Context, attachmentID, messageID string) (*model.Attachment, error)
	Delete(ctx context.Context, id string) error
	// SetDimensions persists detected pixel dimensions on an
	// existing image attachment. Used by the lazy backfill path
	// for attachments uploaded before the upload pipeline started
	// recording dimensions.
	SetDimensions(ctx context.Context, id string, width, height int) error
}

// AttachmentStoreImpl is the DynamoDB implementation of AttachmentStore.
type AttachmentStoreImpl struct {
	*DB
}

var _ AttachmentStore = (*AttachmentStoreImpl)(nil)

// NewAttachmentStore returns a new AttachmentStoreImpl.
func NewAttachmentStore(db *DB) *AttachmentStoreImpl {
	return &AttachmentStoreImpl{DB: db}
}

type attachmentItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK,omitempty"`
	GSI1SK string `dynamodbav:"GSI1SK,omitempty"`
	model.Attachment
}

func attachmentPK(id string) string    { return "ATT#" + id }
func attHashGSI1PK(hash string) string { return "ATTHASH#" + hash }

func (s *AttachmentStoreImpl) Create(ctx context.Context, a *model.Attachment) error {
	item := attachmentItem{
		PK:         attachmentPK(a.ID),
		SK:         metaSK(),
		GSI1PK:     attHashGSI1PK(a.SHA256),
		GSI1SK:     attachmentPK(a.ID),
		Attachment: *a,
	}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal attachment: %w", err)
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
		return fmt.Errorf("store: create attachment: %w", err)
	}
	return nil
}

func (s *AttachmentStoreImpl) GetByID(ctx context.Context, id string) (*model.Attachment, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(attachmentPK(id), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get attachment: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item attachmentItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal attachment: %w", err)
	}
	a := item.Attachment
	return &a, nil
}

// GetByHash looks up an existing attachment by SHA256 via GSI1 so uploads of
// identical content reuse the same S3 object.
func (s *AttachmentStoreImpl) GetByHash(ctx context.Context, sha256 string) (*model.Attachment, error) {
	keyCond := expression.KeyAnd(
		expression.Key("GSI1PK").Equal(expression.Value(attHashGSI1PK(sha256))),
		expression.Key("GSI1SK").BeginsWith("ATT#"),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil {
		return nil, fmt.Errorf("store: build attachment hash query: %w", err)
	}
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		Limit:                     aws.Int32(1),
	})
	if err != nil {
		return nil, fmt.Errorf("store: query attachment by hash: %w", err)
	}
	if len(out.Items) == 0 {
		return nil, ErrNotFound
	}
	var item attachmentItem
	if err := attributevalue.UnmarshalMap(out.Items[0], &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal attachment: %w", err)
	}
	a := item.Attachment
	return &a, nil
}

// AddRef adds a messageID to the attachment's refcount set. Idempotent: adding
// the same message ID twice is a no-op.
func (s *AttachmentStoreImpl) AddRef(ctx context.Context, attachmentID, messageID string) error {
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(attachmentPK(attachmentID), metaSK()),
		UpdateExpression: aws.String("ADD messageIDs :m"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":m": &types.AttributeValueMemberSS{Value: []string{messageID}},
		},
		ConditionExpression: aws.String("attribute_exists(PK)"),
	})
	if err != nil {
		return fmt.Errorf("store: attachment add ref: %w", err)
	}
	return nil
}

// RemoveRef removes a messageID from the refcount set and returns the updated
// attachment so the caller can decide whether to GC the object.
func (s *AttachmentStoreImpl) RemoveRef(ctx context.Context, attachmentID, messageID string) (*model.Attachment, error) {
	out, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(attachmentPK(attachmentID), metaSK()),
		UpdateExpression: aws.String("DELETE messageIDs :m"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":m": &types.AttributeValueMemberSS{Value: []string{messageID}},
		},
		ConditionExpression: aws.String("attribute_exists(PK)"),
		ReturnValues:        types.ReturnValueAllNew,
	})
	if err != nil {
		return nil, fmt.Errorf("store: attachment remove ref: %w", err)
	}
	var item attachmentItem
	if err := attributevalue.UnmarshalMap(out.Attributes, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal attachment: %w", err)
	}
	a := item.Attachment
	return &a, nil
}

func (s *AttachmentStoreImpl) Delete(ctx context.Context, id string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(attachmentPK(id), metaSK()),
	})
	if err != nil {
		return fmt.Errorf("store: delete attachment: %w", err)
	}
	return nil
}

// SetDimensions backfills width/height on an existing attachment item.
// Conditional on attribute_exists(PK) so a deletion racing with the
// backfill doesn't recreate the row.
func (s *AttachmentStoreImpl) SetDimensions(ctx context.Context, id string, width, height int) error {
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:           aws.String(s.Table),
		Key:                 compositeKey(attachmentPK(id), metaSK()),
		UpdateExpression:    aws.String("SET #w = :w, #h = :h"),
		ConditionExpression: aws.String("attribute_exists(PK)"),
		ExpressionAttributeNames: map[string]string{
			"#w": "width",
			"#h": "height",
		},
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":w": &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", width)},
			":h": &types.AttributeValueMemberN{Value: fmt.Sprintf("%d", height)},
		},
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: set attachment dimensions: %w", err)
	}
	return nil
}
