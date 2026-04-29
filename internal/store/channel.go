package store

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/DigitalTolk/ex/internal/model"
)

// ChannelStore defines operations on Channel entities.
type ChannelStore interface {
	Create(ctx context.Context, ch *model.Channel) error
	GetByID(ctx context.Context, id string) (*model.Channel, error)
	GetByName(ctx context.Context, name string) (*model.Channel, error)
	GetBySlug(ctx context.Context, slug string) (*model.Channel, error)
	Update(ctx context.Context, ch *model.Channel) error
	ListPublic(ctx context.Context, limit int, lastKey string) ([]*model.Channel, string, error)
	ListAll(ctx context.Context) ([]*model.Channel, error)
}

// ChannelStoreImpl implements ChannelStore backed by DynamoDB.
type ChannelStoreImpl struct {
	*DB
}

var _ ChannelStore = (*ChannelStoreImpl)(nil)

// NewChannelStore returns a new ChannelStoreImpl.
func NewChannelStore(db *DB) *ChannelStoreImpl {
	return &ChannelStoreImpl{DB: db}
}

// channelItem is the DynamoDB representation of a Channel.
type channelItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK"`
	GSI1SK string `dynamodbav:"GSI1SK"`
	GSI2PK string `dynamodbav:"GSI2PK,omitempty"`
	GSI2SK string `dynamodbav:"GSI2SK,omitempty"`
	model.Channel
}

func (s *ChannelStoreImpl) Create(ctx context.Context, ch *model.Channel) error {
	item := channelItem{
		PK:      channelPK(ch.ID),
		SK:      metaSK(),
		GSI1PK:  chanSlugGSI1PK(ch.Slug),
		GSI1SK:  chanGSI1SK(ch.ID),
		Channel: *ch,
	}

	if ch.Type == model.ChannelTypePublic {
		item.GSI2PK = publicChanGSI2PK()
		item.GSI2SK = ch.CreatedAt.Format(time.RFC3339Nano) + "#" + ch.ID
	}

	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal channel: %w", err)
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
		return fmt.Errorf("store: create channel: %w", err)
	}
	return nil
}

func (s *ChannelStoreImpl) GetByID(ctx context.Context, id string) (*model.Channel, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(channelPK(id), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get channel: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}

	var item channelItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal channel: %w", err)
	}
	return &item.Channel, nil
}

func (s *ChannelStoreImpl) GetBySlug(ctx context.Context, slug string) (*model.Channel, error) {
	keyCond := expression.KeyAnd(
		expression.Key("GSI1PK").Equal(expression.Value(chanSlugGSI1PK(slug))),
		expression.Key("GSI1SK").BeginsWith("CHAN#"),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil {
		return nil, fmt.Errorf("store: build expression: %w", err)
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
		return nil, fmt.Errorf("store: query channel by slug: %w", err)
	}
	if len(out.Items) == 0 {
		return nil, ErrNotFound
	}

	var item channelItem
	if err := attributevalue.UnmarshalMap(out.Items[0], &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal channel: %w", err)
	}
	return &item.Channel, nil
}

func (s *ChannelStoreImpl) GetByName(ctx context.Context, name string) (*model.Channel, error) {
	keyCond := expression.KeyAnd(
		expression.Key("GSI1PK").Equal(expression.Value(chanNameGSI1PK(name))),
		expression.Key("GSI1SK").BeginsWith("CHAN#"),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil {
		return nil, fmt.Errorf("store: build expression: %w", err)
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
		return nil, fmt.Errorf("store: query channel by name: %w", err)
	}
	if len(out.Items) == 0 {
		return nil, ErrNotFound
	}

	var item channelItem
	if err := attributevalue.UnmarshalMap(out.Items[0], &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal channel: %w", err)
	}
	return &item.Channel, nil
}

func (s *ChannelStoreImpl) Update(ctx context.Context, ch *model.Channel) error {
	item := channelItem{
		PK:      channelPK(ch.ID),
		SK:      metaSK(),
		GSI1PK:  chanSlugGSI1PK(ch.Slug),
		GSI1SK:  chanGSI1SK(ch.ID),
		Channel: *ch,
	}

	if ch.Type == model.ChannelTypePublic {
		item.GSI2PK = publicChanGSI2PK()
		item.GSI2SK = ch.CreatedAt.Format(time.RFC3339Nano) + "#" + ch.ID
	}

	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal channel: %w", err)
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
		return fmt.Errorf("store: update channel: %w", err)
	}
	return nil
}

func (s *ChannelStoreImpl) ListPublic(ctx context.Context, limit int, lastKey string) ([]*model.Channel, string, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(publicChanGSI2PK()))
	builder := expression.NewBuilder().WithKeyCondition(keyCond)

	// Filter out archived channels.
	filt := expression.Name("archived").Equal(expression.Value(false))
	builder = builder.WithFilter(filt)

	expr, err := builder.Build()
	if err != nil {
		return nil, "", fmt.Errorf("store: build expression: %w", err)
	}

	input := &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		FilterExpression:          expr.Filter(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		Limit:                     aws.Int32(int32(limit)),
		ScanIndexForward:          aws.Bool(false), // newest first
	}

	if lastKey != "" {
		input.ExclusiveStartKey = map[string]types.AttributeValue{
			"GSI2PK": &types.AttributeValueMemberS{Value: publicChanGSI2PK()},
			"GSI2SK": &types.AttributeValueMemberS{Value: lastKey},
			"PK":     &types.AttributeValueMemberS{Value: channelPK(lastKey)},
			"SK":     &types.AttributeValueMemberS{Value: metaSK()},
		}
	}

	out, err := s.Client.Query(ctx, input)
	if err != nil {
		return nil, "", fmt.Errorf("store: list public channels: %w", err)
	}

	channels := make([]*model.Channel, 0, len(out.Items))
	for _, item := range out.Items {
		var ci channelItem
		if err := attributevalue.UnmarshalMap(item, &ci); err != nil {
			return nil, "", fmt.Errorf("store: unmarshal channel: %w", err)
		}
		channels = append(channels, &ci.Channel)
	}

	var nextKey string
	if out.LastEvaluatedKey != nil {
		if sk, ok := out.LastEvaluatedKey["GSI2SK"]; ok {
			var skVal string
			if err := attributevalue.Unmarshal(sk, &skVal); err == nil {
				nextKey = skVal
			}
		}
	}

	return channels, nextKey, nil
}

// ListAll walks every channel in the workspace via Scan with a
// PK-prefix filter. Used only by admin maintenance flows (search
// reindex, etc.) — the per-user / per-public Query paths cover the
// hot read paths. Pages through Scan's LastEvaluatedKey so private
// channels are included regardless of cluster size.
func (s *ChannelStoreImpl) ListAll(ctx context.Context) ([]*model.Channel, error) {
	channels := make([]*model.Channel, 0)
	expr, err := expression.NewBuilder().WithFilter(
		expression.Name("PK").BeginsWith("CHAN#").And(
			expression.Name("SK").Equal(expression.Value("META")),
		),
	).Build()
	if err != nil {
		return nil, fmt.Errorf("store: build channels-scan expression: %w", err)
	}
	var startKey map[string]types.AttributeValue
	for {
		out, err := s.Client.Scan(ctx, &dynamodb.ScanInput{
			TableName:                 aws.String(s.Table),
			FilterExpression:          expr.Filter(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
			ExclusiveStartKey:         startKey,
		})
		if err != nil {
			return nil, fmt.Errorf("store: scan channels: %w", err)
		}
		for _, item := range out.Items {
			var ci channelItem
			if err := attributevalue.UnmarshalMap(item, &ci); err != nil {
				return nil, fmt.Errorf("store: unmarshal channel: %w", err)
			}
			channels = append(channels, &ci.Channel)
		}
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		startKey = out.LastEvaluatedKey
	}
	return channels, nil
}
