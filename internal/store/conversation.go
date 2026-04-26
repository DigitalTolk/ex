package store

import (
	"context"
	"fmt"
	"sort"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/DigitalTolk/ex/internal/model"
)

// ConversationStore defines operations on Conversation entities.
type ConversationStore interface {
	Create(ctx context.Context, conv *model.Conversation, members []*model.UserConversation) error
	GetByID(ctx context.Context, id string) (*model.Conversation, error)
	ListUserConversations(ctx context.Context, userID string) ([]*model.UserConversation, error)
	IsMember(ctx context.Context, convID, userID string) (bool, error)
	Activate(ctx context.Context, convID string, participantIDs []string) error
}

// ConversationStoreImpl implements ConversationStore backed by DynamoDB.
type ConversationStoreImpl struct {
	*DB
}

var _ ConversationStore = (*ConversationStoreImpl)(nil)

// NewConversationStore returns a new ConversationStoreImpl.
func NewConversationStore(db *DB) *ConversationStoreImpl {
	return &ConversationStoreImpl{DB: db}
}

// conversationItem is the DynamoDB representation of a Conversation.
type conversationItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.Conversation
}

// convMemberItem is the DynamoDB representation of a conversation member.
type convMemberItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	UserID string `dynamodbav:"userID"`
}

// userConversationItem is the DynamoDB representation of a UserConversation.
type userConversationItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.UserConversation
}

// DeriveDMConversationID deterministically derives a ULID-formatted conversation
// ID for a DM between two users. It sorts their IDs, hashes them, and encodes
// the result as a valid ULID so all entity IDs share the same format.
func DeriveDMConversationID(userID1, userID2 string) string {
	ids := []string{userID1, userID2}
	sort.Strings(ids)
	return DeriveID(ids[0] + ":" + ids[1])
}

func (s *ConversationStoreImpl) Create(ctx context.Context, conv *model.Conversation, members []*model.UserConversation) error {
	// Build transact items: conversation META + member items on CONV side + user-side items.
	txItems := make([]types.TransactWriteItem, 0, 1+len(conv.ParticipantIDs)+len(members))

	// 1. Conversation META item.
	convItem := conversationItem{
		PK:           convPK(conv.ID),
		SK:           metaSK(),
		Conversation: *conv,
	}
	convAV, err := attributevalue.MarshalMap(convItem)
	if err != nil {
		return fmt.Errorf("store: marshal conversation: %w", err)
	}
	txItems = append(txItems, types.TransactWriteItem{
		Put: &types.Put{
			TableName:           aws.String(s.Table),
			Item:                convAV,
			ConditionExpression: aws.String("attribute_not_exists(PK)"),
		},
	})

	// 2. CONV#<id>/MEMBER#<uid> items for membership checks.
	for _, uid := range conv.ParticipantIDs {
		mi := convMemberItem{
			PK:     convPK(conv.ID),
			SK:     memberSK(uid),
			UserID: uid,
		}
		miAV, err := attributevalue.MarshalMap(mi)
		if err != nil {
			return fmt.Errorf("store: marshal conv member: %w", err)
		}
		txItems = append(txItems, types.TransactWriteItem{
			Put: &types.Put{
				TableName: aws.String(s.Table),
				Item:      miAV,
			},
		})
	}

	// 3. USER#<uid>/CONV#<cid> items for listing user conversations.
	for _, uc := range members {
		ucItem := userConversationItem{
			PK:               userPK(uc.UserID),
			SK:               convSK(conv.ID),
			UserConversation: *uc,
		}
		ucAV, err := attributevalue.MarshalMap(ucItem)
		if err != nil {
			return fmt.Errorf("store: marshal user conversation: %w", err)
		}
		txItems = append(txItems, types.TransactWriteItem{
			Put: &types.Put{
				TableName: aws.String(s.Table),
				Item:      ucAV,
			},
		})
	}

	// DynamoDB TransactWriteItems supports up to 100 items.
	if len(txItems) > 100 {
		return fmt.Errorf("store: conversation with %d participants exceeds transaction limit", len(conv.ParticipantIDs))
	}

	_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: txItems,
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create conversation: %w", err)
	}
	return nil
}

func (s *ConversationStoreImpl) GetByID(ctx context.Context, id string) (*model.Conversation, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(convPK(id), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get conversation: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}

	var item conversationItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal conversation: %w", err)
	}
	return &item.Conversation, nil
}

func (s *ConversationStoreImpl) ListUserConversations(ctx context.Context, userID string) ([]*model.UserConversation, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith("CONV#"),
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
		return nil, fmt.Errorf("store: list user conversations: %w", err)
	}

	convs := make([]*model.UserConversation, 0, len(out.Items))
	for _, item := range out.Items {
		var uci userConversationItem
		if err := attributevalue.UnmarshalMap(item, &uci); err != nil {
			return nil, fmt.Errorf("store: unmarshal user conversation: %w", err)
		}
		convs = append(convs, &uci.UserConversation)
	}
	return convs, nil
}

// Activate marks the conversation and each participant's UserConversation row
// as Activated=true. Used by MessageService when the first message is sent so
// non-creator participants can see the conversation in their sidebars.
func (s *ConversationStoreImpl) Activate(ctx context.Context, convID string, participantIDs []string) error {
	expr, err := expression.NewBuilder().
		WithUpdate(expression.Set(expression.Name("activated"), expression.Value(true))).
		Build()
	if err != nil {
		return fmt.Errorf("store: build activate expression: %w", err)
	}

	txItems := make([]types.TransactWriteItem, 0, 1+len(participantIDs))
	txItems = append(txItems, types.TransactWriteItem{
		Update: &types.Update{
			TableName:                 aws.String(s.Table),
			Key:                       compositeKey(convPK(convID), metaSK()),
			UpdateExpression:          expr.Update(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
		},
	})
	for _, uid := range participantIDs {
		txItems = append(txItems, types.TransactWriteItem{
			Update: &types.Update{
				TableName:                 aws.String(s.Table),
				Key:                       compositeKey(userPK(uid), convSK(convID)),
				UpdateExpression:          expr.Update(),
				ExpressionAttributeNames:  expr.Names(),
				ExpressionAttributeValues: expr.Values(),
			},
		})
	}

	if _, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: txItems,
	}); err != nil {
		return fmt.Errorf("store: activate conversation: %w", err)
	}
	return nil
}

func (s *ConversationStoreImpl) IsMember(ctx context.Context, convID, userID string) (bool, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(convPK(convID), memberSK(userID)),
	})
	if err != nil {
		return false, fmt.Errorf("store: check conv membership: %w", err)
	}
	return out.Item != nil, nil
}
