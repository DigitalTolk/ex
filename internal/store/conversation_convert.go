package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ErrConversationConverted: the group is a channel already (or is no group).
var ErrConversationConverted = errors.New("store: conversation already converted")

// ConvertedMember is one participant's new channel rows.
type ConvertedMember struct {
	Member      *model.ChannelMembership
	UserChannel *model.UserChannel
}

// Four writes move one member; a transaction holds at most 100.
const convertMembersPerTx = 24

// ConvertGroupToChannel turns a group conversation into a private channel
// with the same ID. The channel takes over the history where it already
// lies — messages, threads, pins and files are keyed by the parent ID alone,
// under CHAN#<id> — and each participant's conversation rows become channel
// rows. The conversation's META stays behind, marked with the channel, so old
// links find it and the same people starting a group again get a new one.
//
// The mark, the channel, its name lock and the first members' rows are one
// transaction: converting twice, or to a name that is taken, changes
// nothing. A larger group moves the rest in further transactions; should one
// fail, MoveMembersToChannel finishes the move.
func (s *ConversationStoreImpl) ConvertGroupToChannel(ctx context.Context, ch *model.Channel, members []ConvertedMember, at time.Time) error {
	chanAV := mustAttrs(attributevalue.MarshalMap(channelItem{
		PK:      channelPK(ch.ID),
		SK:      metaSK(),
		GSI1PK:  chanSlugGSI1PK(ch.Slug),
		GSI1SK:  chanGSI1SK(ch.ID),
		Channel: *ch,
	}))
	lockAV := mustAttrs(attributevalue.MarshalMap(map[string]any{
		"PK":        chanSlugGSI1PK(ch.Slug),
		"SK":        metaSK(),
		"ChannelID": ch.ID,
		"CreatedAt": ch.CreatedAt.Format(time.RFC3339Nano),
	}))
	first := members[:min(len(members), convertMembersPerTx)]
	items := []types.TransactWriteItem{
		{Update: &types.Update{
			TableName:           aws.String(s.Table),
			Key:                 compositeKey(convPK(ch.ID), metaSK()),
			UpdateExpression:    aws.String("SET convertedToChannelID = :ch, convertedAt = :at"),
			ConditionExpression: aws.String("attribute_exists(PK) AND #type = :group AND attribute_not_exists(convertedToChannelID)"),
			ExpressionAttributeNames: map[string]string{
				"#type": "type",
			},
			ExpressionAttributeValues: map[string]types.AttributeValue{
				":ch":    &types.AttributeValueMemberS{Value: ch.ID},
				":at":    &types.AttributeValueMemberS{Value: at.UTC().Format(time.RFC3339Nano)},
				":group": &types.AttributeValueMemberS{Value: string(model.ConversationTypeGroup)},
			},
		}},
		{Put: &types.Put{TableName: aws.String(s.Table), Item: chanAV, ConditionExpression: aws.String("attribute_not_exists(PK)")}},
		{Put: &types.Put{TableName: aws.String(s.Table), Item: lockAV, ConditionExpression: aws.String("attribute_not_exists(PK)")}},
	}
	items = append(items, s.memberMoves(ch.ID, first)...)
	if _, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items}); err != nil {
		var tce *types.TransactionCanceledException
		if errors.As(err, &tce) {
			failed := func(i int) bool {
				return i < len(tce.CancellationReasons) && aws.ToString(tce.CancellationReasons[i].Code) == "ConditionalCheckFailed"
			}
			switch {
			case failed(0), failed(1):
				return ErrConversationConverted
			case failed(2):
				return ErrAlreadyExists
			}
		}
		return fmt.Errorf("store: convert conversation: %w", err)
	}
	return s.MoveMembersToChannel(ctx, ch.ID, members[len(first):])
}

// MoveMembersToChannel swaps members' conversation rows for their channel
// rows. Unconditional, so moving someone twice is harmless.
func (s *ConversationStoreImpl) MoveMembersToChannel(ctx context.Context, channelID string, members []ConvertedMember) error {
	for start := 0; start < len(members); start += convertMembersPerTx {
		chunk := members[start:min(start+convertMembersPerTx, len(members))]
		if _, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: s.memberMoves(channelID, chunk)}); err != nil {
			return fmt.Errorf("store: move conversation members: %w", err)
		}
	}
	return nil
}

func (s *ConversationStoreImpl) memberMoves(channelID string, members []ConvertedMember) []types.TransactWriteItem {
	items := make([]types.TransactWriteItem, 0, 4*len(members))
	for _, m := range members {
		uid := m.Member.UserID
		memberAV := mustAttrs(attributevalue.MarshalMap(channelMemberItem{PK: channelPK(channelID), SK: memberSK(uid), ChannelMembership: *m.Member}))
		userAV := mustAttrs(attributevalue.MarshalMap(userChannelItem{PK: userPK(uid), SK: chanSK(channelID), UserChannel: *m.UserChannel}))
		items = append(items,
			types.TransactWriteItem{Put: &types.Put{TableName: aws.String(s.Table), Item: memberAV}},
			types.TransactWriteItem{Put: &types.Put{TableName: aws.String(s.Table), Item: userAV}},
			types.TransactWriteItem{Delete: &types.Delete{TableName: aws.String(s.Table), Key: compositeKey(convPK(channelID), memberSK(uid))}},
			types.TransactWriteItem{Delete: &types.Delete{TableName: aws.String(s.Table), Key: compositeKey(userPK(uid), convSK(channelID))}},
		)
	}
	return items
}

// GetUserConversations returns these users' rows for one conversation (their
// read position, badge and sidebar placement), keyed by user. A user without
// a row is absent.
func (s *ConversationStoreImpl) GetUserConversations(ctx context.Context, convID string, userIDs []string) (map[string]*model.UserConversation, error) {
	out := make(map[string]*model.UserConversation, len(userIDs))
	const batchSize = 100
	for start := 0; start < len(userIDs); start += batchSize {
		keys := make([]map[string]types.AttributeValue, 0, batchSize)
		for _, uid := range userIDs[start:min(start+batchSize, len(userIDs))] {
			keys = append(keys, compositeKey(userPK(uid), convSK(convID)))
		}
		req := map[string]types.KeysAndAttributes{s.Table: {Keys: keys, ConsistentRead: aws.Bool(true)}}
		for {
			res, err := s.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: req})
			if err != nil {
				return nil, fmt.Errorf("store: batch get user conversations: %w", err)
			}
			for _, item := range res.Responses[s.Table] {
				var rec userConversationItem
				if err := attributevalue.UnmarshalMap(item, &rec); err != nil {
					return nil, fmt.Errorf("store: unmarshal user conversation: %w", err)
				}
				uc := rec.UserConversation
				out[uc.UserID] = &uc
			}
			if len(res.UnprocessedKeys) == 0 {
				break
			}
			req = res.UnprocessedKeys
		}
	}
	return out, nil
}
