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

// EmojiStore defines persistence operations for custom emojis.
type EmojiStore interface {
	Create(ctx context.Context, e *model.CustomEmoji) error
	GetByName(ctx context.Context, name string) (*model.CustomEmoji, error)
	List(ctx context.Context) ([]*model.CustomEmoji, error)
	Delete(ctx context.Context, name string) error
}

// EmojiStoreImpl implements EmojiStore backed by DynamoDB.
type EmojiStoreImpl struct {
	*DB
}

var _ EmojiStore = (*EmojiStoreImpl)(nil)

// NewEmojiStore returns a new EmojiStoreImpl.
func NewEmojiStore(db *DB) *EmojiStoreImpl {
	return &EmojiStoreImpl{DB: db}
}

type emojiItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.CustomEmoji
}

func emojiPK() string             { return "EMOJI" }
func emojiSK(name string) string  { return "NAME#" + name }

func (s *EmojiStoreImpl) Create(ctx context.Context, e *model.CustomEmoji) error {
	item := emojiItem{
		PK:          emojiPK(),
		SK:          emojiSK(e.Name),
		CustomEmoji: *e,
	}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal emoji: %w", err)
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
		return fmt.Errorf("store: create emoji: %w", err)
	}
	return nil
}

func (s *EmojiStoreImpl) GetByName(ctx context.Context, name string) (*model.CustomEmoji, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(emojiPK(), emojiSK(name)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get emoji: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item emojiItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal emoji: %w", err)
	}
	return &item.CustomEmoji, nil
}

func (s *EmojiStoreImpl) List(ctx context.Context) ([]*model.CustomEmoji, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(emojiPK())),
		expression.Key("SK").BeginsWith("NAME#"),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil {
		return nil, fmt.Errorf("store: build expression: %w", err)
	}
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list emojis: %w", err)
	}
	emojis := make([]*model.CustomEmoji, 0, len(out.Items))
	for _, item := range out.Items {
		var ei emojiItem
		if err := attributevalue.UnmarshalMap(item, &ei); err != nil {
			return nil, fmt.Errorf("store: unmarshal emoji: %w", err)
		}
		ec := ei.CustomEmoji
		emojis = append(emojis, &ec)
	}
	return emojis, nil
}

func (s *EmojiStoreImpl) Delete(ctx context.Context, name string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(emojiPK(), emojiSK(name)),
	})
	if err != nil {
		return fmt.Errorf("store: delete emoji: %w", err)
	}
	return nil
}
