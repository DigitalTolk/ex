package store

import (
	"context"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// MembershipStore defines operations on channel memberships.
type MembershipStore interface {
	AddChannelMember(ctx context.Context, channel *model.Channel, member *model.ChannelMembership, userChan *model.UserChannel) error
	RemoveChannelMember(ctx context.Context, channelID, userID string) error
	GetChannelMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error)
	ListChannelMembers(ctx context.Context, channelID string) ([]*model.ChannelMembership, error)
	ListUserChannels(ctx context.Context, userID string) ([]*model.UserChannel, error)
	UpdateChannelRole(ctx context.Context, channelID, userID string, role model.ChannelRole) error
	SetUserChannelMute(ctx context.Context, channelID, userID string, muted bool) error
}

// MembershipStoreImpl implements MembershipStore backed by DynamoDB.
type MembershipStoreImpl struct {
	*DB
}

var _ MembershipStore = (*MembershipStoreImpl)(nil)

// NewMembershipStore returns a new MembershipStoreImpl.
func NewMembershipStore(db *DB) *MembershipStoreImpl {
	return &MembershipStoreImpl{DB: db}
}

// channelMemberItem is the DynamoDB representation of a ChannelMembership.
type channelMemberItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.ChannelMembership
}

// userChannelItem is the DynamoDB representation of a UserChannel.
type userChannelItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.UserChannel
}

func (s *MembershipStoreImpl) AddChannelMember(ctx context.Context, channel *model.Channel, member *model.ChannelMembership, userChan *model.UserChannel) error {
	memberItem := channelMemberItem{
		PK:                channelPK(channel.ID),
		SK:                memberSK(member.UserID),
		ChannelMembership: *member,
	}
	memberAV, err := attributevalue.MarshalMap(memberItem)
	if err != nil {
		return fmt.Errorf("store: marshal channel member: %w", err)
	}

	ucItem := userChannelItem{
		PK:          userPK(member.UserID),
		SK:          chanSK(channel.ID),
		UserChannel: *userChan,
	}
	ucAV, err := attributevalue.MarshalMap(ucItem)
	if err != nil {
		return fmt.Errorf("store: marshal user channel: %w", err)
	}

	_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Put: &types.Put{
					TableName:           aws.String(s.Table),
					Item:                memberAV,
					ConditionExpression: aws.String("attribute_not_exists(PK)"),
				},
			},
			{
				Put: &types.Put{
					TableName:           aws.String(s.Table),
					Item:                ucAV,
					ConditionExpression: aws.String("attribute_not_exists(PK) OR SK <> :sk"),
					ExpressionAttributeValues: map[string]types.AttributeValue{
						":sk": &types.AttributeValueMemberS{Value: chanSK(channel.ID)},
					},
				},
			},
		},
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: add channel member: %w", err)
	}
	return nil
}

func (s *MembershipStoreImpl) RemoveChannelMember(ctx context.Context, channelID, userID string) error {
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Delete: &types.Delete{
					TableName: aws.String(s.Table),
					Key:       compositeKey(channelPK(channelID), memberSK(userID)),
				},
			},
			{
				Delete: &types.Delete{
					TableName: aws.String(s.Table),
					Key:       compositeKey(userPK(userID), chanSK(channelID)),
				},
			},
		},
	})
	if err != nil {
		return fmt.Errorf("store: remove channel member: %w", err)
	}
	return nil
}

func (s *MembershipStoreImpl) GetChannelMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(channelPK(channelID), memberSK(userID)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get channel membership: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}

	var item channelMemberItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal channel membership: %w", err)
	}
	return &item.ChannelMembership, nil
}

func (s *MembershipStoreImpl) ListChannelMembers(ctx context.Context, channelID string) ([]*model.ChannelMembership, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(channelPK(channelID))),
		expression.Key("SK").BeginsWith("MEMBER#"),
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
		return nil, fmt.Errorf("store: list channel members: %w", err)
	}

	members := make([]*model.ChannelMembership, 0, len(out.Items))
	for _, item := range out.Items {
		var mi channelMemberItem
		if err := attributevalue.UnmarshalMap(item, &mi); err != nil {
			return nil, fmt.Errorf("store: unmarshal channel member: %w", err)
		}
		members = append(members, &mi.ChannelMembership)
	}
	return members, nil
}

func (s *MembershipStoreImpl) ListUserChannels(ctx context.Context, userID string) ([]*model.UserChannel, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith("CHAN#"),
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
		return nil, fmt.Errorf("store: list user channels: %w", err)
	}

	channels := make([]*model.UserChannel, 0, len(out.Items))
	for _, item := range out.Items {
		var uci userChannelItem
		if err := attributevalue.UnmarshalMap(item, &uci); err != nil {
			return nil, fmt.Errorf("store: unmarshal user channel: %w", err)
		}
		channels = append(channels, &uci.UserChannel)
	}
	return channels, nil
}

func (s *MembershipStoreImpl) UpdateChannelRole(ctx context.Context, channelID, userID string, role model.ChannelRole) error {
	// Update both the channel-side membership and user-side channel items.
	memberUpdate := expression.Set(expression.Name("role"), expression.Value(role))
	memberExpr, err := expression.NewBuilder().WithUpdate(memberUpdate).Build()
	if err != nil {
		return fmt.Errorf("store: build member update expression: %w", err)
	}

	userUpdate := expression.Set(expression.Name("role"), expression.Value(role))
	userExpr, err := expression.NewBuilder().WithUpdate(userUpdate).Build()
	if err != nil {
		return fmt.Errorf("store: build user channel update expression: %w", err)
	}

	_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Update: &types.Update{
					TableName:                 aws.String(s.Table),
					Key:                       compositeKey(channelPK(channelID), memberSK(userID)),
					UpdateExpression:          memberExpr.Update(),
					ExpressionAttributeNames:  memberExpr.Names(),
					ExpressionAttributeValues: memberExpr.Values(),
					ConditionExpression:       aws.String("attribute_exists(PK)"),
				},
			},
			{
				Update: &types.Update{
					TableName:                 aws.String(s.Table),
					Key:                       compositeKey(userPK(userID), chanSK(channelID)),
					UpdateExpression:          userExpr.Update(),
					ExpressionAttributeNames:  userExpr.Names(),
					ExpressionAttributeValues: userExpr.Values(),
					ConditionExpression:       aws.String("attribute_exists(PK)"),
				},
			},
		},
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: update channel role: %w", err)
	}
	return nil
}

// SetUserChannelMute toggles the muted flag on the user-side UserChannel
// record. Mute is a per-user preference, so unlike role changes we do not
// need to dual-write the channel-side membership.
func (s *MembershipStoreImpl) SetUserChannelMute(ctx context.Context, channelID, userID string, muted bool) error {
	return s.setUserChannelAttribute(ctx, channelID, userID, "muted", muted)
}

// SetUserChannelFavorite flips the favorite flag on the user-side
// UserChannel — used to pin a channel to the "Favorites" sidebar section.
func (s *MembershipStoreImpl) SetUserChannelFavorite(ctx context.Context, channelID, userID string, favorite bool) error {
	return s.setUserChannelAttribute(ctx, channelID, userID, "favorite", favorite)
}

// SetUserChannelCategory assigns the channel to a user-defined sidebar
// category. Empty string clears the assignment.
func (s *MembershipStoreImpl) SetUserChannelCategory(ctx context.Context, channelID, userID, categoryID string, sidebarPosition *int) error {
	upd := expression.Set(expression.Name("categoryID"), expression.Value(categoryID))
	if sidebarPosition != nil {
		upd = upd.Set(expression.Name("sidebarPosition"), expression.Value(*sidebarPosition))
	}
	return s.updateUserChannel(ctx, channelID, userID, upd, "category")
}

// setUserChannelAttribute is a small helper for the family of single-
// attribute updates on the user-side UserChannel row. Each one needs the
// same condition-exists guard so a missing membership maps to
// ErrNotFound instead of silently creating an orphan row.
func (s *MembershipStoreImpl) setUserChannelAttribute(ctx context.Context, channelID, userID, attr string, value any) error {
	upd := expression.Set(expression.Name(attr), expression.Value(value))
	return s.updateUserChannel(ctx, channelID, userID, upd, attr)
}

func (s *MembershipStoreImpl) updateUserChannel(ctx context.Context, channelID, userID string, upd expression.UpdateBuilder, label string) error {
	expr, err := expression.NewBuilder().WithUpdate(upd).Build()
	if err != nil {
		return fmt.Errorf("store: build user channel %s expression: %w", label, err)
	}

	_, err = s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(userPK(userID), chanSK(channelID)),
		UpdateExpression:          expr.Update(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ConditionExpression:       aws.String("attribute_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: set user channel %s: %w", label, err)
	}
	return nil
}
