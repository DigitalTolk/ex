package store

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/DigitalTolk/ex/internal/model"
)

// MessageStore defines operations on Message entities.
type MessageStore interface {
	Create(ctx context.Context, msg *model.Message) error
	GetByID(ctx context.Context, parentID, msgID string) (*model.Message, error)
	List(ctx context.Context, parentID string, before string, limit int) ([]*model.Message, bool, error)
	Update(ctx context.Context, parentID string, msg *model.Message) error
	Delete(ctx context.Context, parentID, msgID string) error
}

// MessageStoreImpl implements MessageStore backed by DynamoDB.
type MessageStoreImpl struct {
	*DB
}

var _ MessageStore = (*MessageStoreImpl)(nil)

// NewMessageStore returns a new MessageStoreImpl.
func NewMessageStore(db *DB) *MessageStoreImpl {
	return &MessageStoreImpl{DB: db}
}

// messageItem is the DynamoDB representation of a Message.
type messageItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.Message
}

// parentPK returns the partition key for the message's parent (channel or conversation).
// The parentID must already be prefixed (e.g. "CHAN#xxx" or "CONV#xxx") or be a raw ID
// that the caller contextualizes. Here we accept the raw parent ID and determine the
// prefix from the message's ParentID field. Since messages can live under channels or
// conversations, the caller must supply the full PK-ready parentID.
func parentPK(parentID string) string {
	// The parentID is the raw channel or conversation ID. The caller (service layer)
	// decides whether to prefix with CHAN# or CONV#. For the store, we just need
	// a consistent key. Messages use the same PK as their parent entity.
	//
	// Convention: if parentID starts with "dm_" or looks like a conversation ID,
	// use CONV#, otherwise use CHAN#. However, to keep the store layer simple and
	// not encode business logic, we let the caller pass the parentID as-is and
	// the service layer should pass the full PK prefix.
	//
	// For simplicity and consistency with the key patterns described, we'll
	// assume parentID is a channel or conversation ID and we prefix accordingly.
	// The Message model's ParentID stores the raw ID.
	//
	// We use a simple heuristic: if it starts with "dm_" or "grp_" it's a conversation.
	if len(parentID) > 3 && (parentID[:3] == "dm_" || parentID[:4] == "grp_") {
		return convPK(parentID)
	}
	return channelPK(parentID)
}

func (s *MessageStoreImpl) Create(ctx context.Context, msg *model.Message) error {
	item := messageItem{
		PK:      parentPK(msg.ParentID),
		SK:      msgSK(msg.ID),
		Message: *msg,
	}

	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal message: %w", err)
	}

	_, err = s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK) AND attribute_not_exists(SK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create message: %w", err)
	}
	return nil
}

func (s *MessageStoreImpl) GetByID(ctx context.Context, parentID, msgID string) (*model.Message, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(parentPK(parentID), msgSK(msgID)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get message: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}

	var item messageItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal message: %w", err)
	}
	return &item.Message, nil
}

func (s *MessageStoreImpl) List(ctx context.Context, parentID string, before string, limit int) ([]*model.Message, bool, error) {
	pk := parentPK(parentID)

	var keyCond expression.KeyConditionBuilder
	if before != "" {
		// SK < MSG#<before> to paginate backwards.
		keyCond = expression.KeyAnd(
			expression.Key("PK").Equal(expression.Value(pk)),
			expression.Key("SK").Between(
				expression.Value("MSG#"),
				expression.Value(msgSK(before)),
			),
		)
	} else {
		keyCond = expression.KeyAnd(
			expression.Key("PK").Equal(expression.Value(pk)),
			expression.Key("SK").BeginsWith("MSG#"),
		)
	}

	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil {
		return nil, false, fmt.Errorf("store: build expression: %w", err)
	}

	// Fetch limit+1 to determine if there are more results.
	fetchLimit := int32(limit + 1)

	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ScanIndexForward:          aws.Bool(false), // newest first
		Limit:                     aws.Int32(fetchLimit),
	})
	if err != nil {
		return nil, false, fmt.Errorf("store: list messages: %w", err)
	}

	messages := make([]*model.Message, 0, len(out.Items))
	for _, item := range out.Items {
		var mi messageItem
		if err := attributevalue.UnmarshalMap(item, &mi); err != nil {
			return nil, false, fmt.Errorf("store: unmarshal message: %w", err)
		}
		messages = append(messages, &mi.Message)
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	return messages, hasMore, nil
}

func (s *MessageStoreImpl) Update(ctx context.Context, parentID string, msg *model.Message) error {
	item := messageItem{
		PK:      parentPK(parentID),
		SK:      msgSK(msg.ID),
		Message: *msg,
	}

	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal message: %w", err)
	}

	_, err = s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_exists(PK) AND attribute_exists(SK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: update message: %w", err)
	}
	return nil
}

func (s *MessageStoreImpl) Delete(ctx context.Context, parentID, msgID string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(parentPK(parentID), msgSK(msgID)),
	})
	if err != nil {
		return fmt.Errorf("store: delete message: %w", err)
	}
	return nil
}
