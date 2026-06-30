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
	SetChannelLastRead(ctx context.Context, channelID, userID string, seq int64) error
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
	if err != nil { // coverage-ignore: channelMemberItem has only scalar/string/time fields; MarshalMap cannot fail
		return fmt.Errorf("store: marshal channel member: %w", err)
	}

	ucItem := userChannelItem{
		PK:          userPK(member.UserID),
		SK:          chanSK(channel.ID),
		UserChannel: *userChan,
	}
	ucAV, err := attributevalue.MarshalMap(ucItem)
	if err != nil { // coverage-ignore: userChannelItem has only scalar/string/time fields; MarshalMap cannot fail
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
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil { // coverage-ignore: round-trip of an item this store wrote; cannot fail
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
	if err != nil { // coverage-ignore: static key-condition built from constants; Build cannot fail
		return nil, fmt.Errorf("store: build expression: %w", err)
	}

	// Drain every page: this is the notification audience for a channel, so a
	// 1MB Query cap that silently truncated a large incident channel would drop
	// alert recipients.
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list channel members: %w", err)
	}
	members := make([]*model.ChannelMembership, 0, len(items))
	for _, item := range items {
		var mi channelMemberItem
		if err := attributevalue.UnmarshalMap(item, &mi); err != nil { // coverage-ignore: round-trip of items this store wrote; cannot fail
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
	if err != nil { // coverage-ignore: static key-condition built from constants; Build cannot fail
		return nil, fmt.Errorf("store: build expression: %w", err)
	}

	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list user channels: %w", err)
	}
	channels := make([]*model.UserChannel, 0, len(items))
	for _, item := range items {
		var uci userChannelItem
		if err := attributevalue.UnmarshalMap(item, &uci); err != nil { // coverage-ignore: round-trip of items this store wrote; cannot fail
			return nil, fmt.Errorf("store: unmarshal user channel: %w", err)
		}
		channels = append(channels, &uci.UserChannel)
	}
	return channels, nil
}

// UserChannelNotifPrefs returns, for one channel, each supplied user's
// per-channel notification override (the muted flag plus the five inherit-or-
// override fields). It batch-reads the user-side membership rows (point reads,
// chunked into BatchGetItem calls of 100) instead of issuing a full
// ListUserChannels query per user. The notifier calls this once per channel
// message, so the previous per-member fan-out (O(members) queries, each
// returning all of a user's channels) was the dominant cost on large channels.
//
// A user with no row (or one whose override attributes are absent) simply
// won't appear / will appear with nil override pointers — both resolve to
// "inherit account defaults" downstream.
func (s *MembershipStoreImpl) UserChannelNotifPrefs(ctx context.Context, channelID string, userIDs []string) (map[string]*model.UserChannel, error) {
	prefs := make(map[string]*model.UserChannel)
	const batchSize = 100 // DynamoDB BatchGetItem hard limit
	for start := 0; start < len(userIDs); start += batchSize {
		end := min(start+batchSize, len(userIDs))
		keys := make([]map[string]types.AttributeValue, 0, end-start)
		for _, uid := range userIDs[start:end] {
			keys = append(keys, compositeKey(userPK(uid), chanSK(channelID)))
		}
		req := map[string]types.KeysAndAttributes{
			s.Table: {
				Keys:                 keys,
				ProjectionExpression: aws.String("#uid, #muted, #d, #m, #t, #i, #f"),
				ExpressionAttributeNames: map[string]string{
					"#uid":   "userID",
					"#muted": "muted",
					"#d":     "notifDesktopLevel",
					"#m":     "notifMobileLevel",
					"#t":     "notifThreadReplies",
					"#i":     "notifIgnoreGroupMentions",
					"#f":     "notifFollowAllThreads",
				},
			},
		}
		// Drain UnprocessedKeys (BatchGetItem may return a partial result under
		// throttling) before moving to the next chunk.
		for {
			out, err := s.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: req})
			if err != nil {
				return nil, fmt.Errorf("store: batch get notif prefs: %w", err)
			}
			for _, item := range out.Responses[s.Table] {
				var uc model.UserChannel
				if err := attributevalue.UnmarshalMap(item, &uc); err != nil { // coverage-ignore: round-trip of rows this store wrote; cannot fail
					return nil, fmt.Errorf("store: unmarshal notif pref row: %w", err)
				}
				if uc.UserID != "" {
					row := uc
					prefs[uc.UserID] = &row
				}
			}
			unproc, ok := out.UnprocessedKeys[s.Table]
			if !ok || len(unproc.Keys) == 0 {
				break
			}
			req = map[string]types.KeysAndAttributes{s.Table: unproc}
		}
	}
	return prefs, nil
}

// SetUserChannelNotifPrefs writes the per-channel notification overrides on the
// user-side UserChannel row. Each field is SET when the user chose an explicit
// value and REMOVED when they chose "use my default" (nil) — so reverting to
// inherit leaves no attribute behind for the resolver to pick up. Like the
// other per-user toggles this is a single-row write (no channel-side mirror).
func (s *MembershipStoreImpl) SetUserChannelNotifPrefs(ctx context.Context, channelID, userID string, o model.ChannelNotificationOverride) error {
	upd := expression.UpdateBuilder{}
	if o.DesktopLevel != nil {
		upd = upd.Set(expression.Name("notifDesktopLevel"), expression.Value(*o.DesktopLevel))
	} else {
		upd = upd.Remove(expression.Name("notifDesktopLevel"))
	}
	if o.MobileLevel != nil {
		upd = upd.Set(expression.Name("notifMobileLevel"), expression.Value(*o.MobileLevel))
	} else {
		upd = upd.Remove(expression.Name("notifMobileLevel"))
	}
	if o.ThreadReplies != nil {
		upd = upd.Set(expression.Name("notifThreadReplies"), expression.Value(*o.ThreadReplies))
	} else {
		upd = upd.Remove(expression.Name("notifThreadReplies"))
	}
	if o.IgnoreGroupMentions != nil {
		upd = upd.Set(expression.Name("notifIgnoreGroupMentions"), expression.Value(*o.IgnoreGroupMentions))
	} else {
		upd = upd.Remove(expression.Name("notifIgnoreGroupMentions"))
	}
	if o.FollowAllThreads != nil {
		upd = upd.Set(expression.Name("notifFollowAllThreads"), expression.Value(*o.FollowAllThreads))
	} else {
		upd = upd.Remove(expression.Name("notifFollowAllThreads"))
	}
	return s.updateUserChannel(ctx, channelID, userID, upd, "notif prefs")
}

func (s *MembershipStoreImpl) UpdateChannelRole(ctx context.Context, channelID, userID string, role model.ChannelRole) error {
	// Update both the channel-side membership and user-side channel items.
	memberUpdate := expression.Set(expression.Name("role"), expression.Value(role))
	memberExpr, err := expression.NewBuilder().WithUpdate(memberUpdate).Build()
	if err != nil { // coverage-ignore: static update expression built from constants; Build cannot fail
		return fmt.Errorf("store: build member update expression: %w", err)
	}

	userUpdate := expression.Set(expression.Name("role"), expression.Value(role))
	userExpr, err := expression.NewBuilder().WithUpdate(userUpdate).Build()
	if err != nil { // coverage-ignore: static update expression built from constants; Build cannot fail
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

// SetChannelLastRead records how far this user has read in the channel by
// stamping the channel's current MessageSeq onto their user-side row. unread
// then derives as Channel.MessageSeq - LastReadSeq.
func (s *MembershipStoreImpl) SetChannelLastRead(ctx context.Context, channelID, userID string, seq int64) error {
	return s.setUserChannelAttribute(ctx, channelID, userID, "lastReadSeq", seq)
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
	if err != nil { // coverage-ignore: update expression built from a single attribute name/value; Build cannot fail
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
