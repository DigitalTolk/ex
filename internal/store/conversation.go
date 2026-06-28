package store

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ConversationStore defines operations on Conversation entities.
type ConversationStore interface {
	Create(ctx context.Context, conv *model.Conversation, members []*model.UserConversation) error
	GetByID(ctx context.Context, id string) (*model.Conversation, error)
	ListUserConversations(ctx context.Context, userID string) ([]*model.UserConversation, error)
	IsMember(ctx context.Context, convID, userID string) (bool, error)
	Activate(ctx context.Context, convID string, participantIDs []string) error
	Touch(ctx context.Context, convID string, participantIDs []string, at time.Time) error
	IncrementMessageSeq(ctx context.Context, convID string) (int64, error)
	SetConversationLastRead(ctx context.Context, convID, userID string, seq int64) error
	ListAll(ctx context.Context) ([]*model.Conversation, error)
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
	if err != nil { // coverage-ignore: conversationItem has only scalar/string/slice/time fields; MarshalMap cannot fail
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
		if err != nil { // coverage-ignore: convMemberItem has only string fields; MarshalMap cannot fail
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
		if err != nil { // coverage-ignore: userConversationItem has only scalar/string/time fields; MarshalMap cannot fail
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
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil { // coverage-ignore: round-trip of an item this store wrote; cannot fail
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
	if err != nil { // coverage-ignore: static key-condition built from constants; Build cannot fail
		return nil, fmt.Errorf("store: build expression: %w", err)
	}

	input := &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}
	var convs []*model.UserConversation
	for {
		out, err := s.Client.Query(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("store: list user conversations: %w", err)
		}
		for _, item := range out.Items {
			var uci userConversationItem
			if err := attributevalue.UnmarshalMap(item, &uci); err != nil { // coverage-ignore: round-trip of items this store wrote; cannot fail
				return nil, fmt.Errorf("store: unmarshal user conversation: %w", err)
			}
			convs = append(convs, &uci.UserConversation)
		}
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		input.ExclusiveStartKey = out.LastEvaluatedKey
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
	if err != nil { // coverage-ignore: static update expression built from constants; Build cannot fail
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

// Touch updates the conversation activity timestamp on both the canonical
// conversation row and each participant's user-side sidebar row.
func (s *ConversationStoreImpl) Touch(ctx context.Context, convID string, participantIDs []string, at time.Time) error {
	expr, err := expression.NewBuilder().
		WithUpdate(expression.Set(expression.Name("updatedAt"), expression.Value(at))).
		Build()
	if err != nil { // coverage-ignore: static update expression built from a time value; Build cannot fail
		return fmt.Errorf("store: build touch conversation expression: %w", err)
	}

	// One TransactWriteItems instead of a sequential UpdateItem per row: a
	// group-conversation send previously cost 1+N serial round-trips (META +
	// each participant's user-side row). The META row keeps the existence
	// guard so a missing conversation still surfaces as ErrNotFound. Group
	// sizes are far below the 100-item transaction cap.
	txItems := make([]types.TransactWriteItem, 0, 1+len(participantIDs))
	txItems = append(txItems, types.TransactWriteItem{
		Update: &types.Update{
			TableName:                 aws.String(s.Table),
			Key:                       compositeKey(convPK(convID), metaSK()),
			UpdateExpression:          expr.Update(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
			ConditionExpression:       aws.String("attribute_exists(PK)"),
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
		if isTransactionCancelledWithCondition(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: touch conversation: %w", err)
	}
	return nil
}

// IncrementMessageSeq atomically bumps the conversation's MessageSeq by one and
// returns the new value (ADD treats a missing attribute as 0). Mirrors
// ChannelStore.IncrementMessageSeq — the shared per-parent unread counter.
func (s *ConversationStoreImpl) IncrementMessageSeq(ctx context.Context, convID string) (int64, error) {
	upd := expression.Add(expression.Name("messageSeq"), expression.Value(1))
	expr, err := expression.NewBuilder().WithUpdate(upd).Build()
	if err != nil { // coverage-ignore: static single-attribute ADD; Build cannot fail
		return 0, fmt.Errorf("store: build conversation message seq expression: %w", err)
	}

	out, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(convPK(convID), metaSK()),
		UpdateExpression:          expr.Update(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ConditionExpression:       aws.String("attribute_exists(PK)"),
		ReturnValues:              types.ReturnValueUpdatedNew,
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return 0, ErrNotFound
		}
		return 0, fmt.Errorf("store: increment conversation message seq: %w", err)
	}

	var attrs struct {
		MessageSeq int64 `dynamodbav:"messageSeq"`
	}
	if err := attributevalue.UnmarshalMap(out.Attributes, &attrs); err != nil { // coverage-ignore: round-trip of a numeric attribute we just wrote; cannot fail
		return 0, fmt.Errorf("store: unmarshal conversation message seq: %w", err)
	}
	return attrs.MessageSeq, nil
}

// SetConversationLastRead stamps the conversation's current MessageSeq onto the
// user-side row; unread then derives as MessageSeq - LastReadSeq.
func (s *ConversationStoreImpl) SetConversationLastRead(ctx context.Context, convID, userID string, seq int64) error {
	return s.setUserConversationAttribute(ctx, convID, userID, "lastReadSeq", seq)
}

// SetUserConversationFavorite flips the favorite flag on the user-side
// UserConversation row. Per-user — pinning the DM doesn't affect the
// other participants' views.
func (s *ConversationStoreImpl) SetUserConversationFavorite(ctx context.Context, convID, userID string, favorite bool) error {
	return s.setUserConversationAttribute(ctx, convID, userID, "favorite", favorite)
}

// SetUserConversationCategory assigns the DM/group to a sidebar category
// (or clears it when categoryID is empty).
func (s *ConversationStoreImpl) SetUserConversationCategory(ctx context.Context, convID, userID, categoryID string, sidebarPosition *int) error {
	upd := expression.Set(expression.Name("categoryID"), expression.Value(categoryID))
	if sidebarPosition != nil {
		upd = upd.Set(expression.Name("sidebarPosition"), expression.Value(*sidebarPosition))
	}
	return s.updateUserConversation(ctx, convID, userID, upd, "category")
}

// setUserConversationAttribute is the shared helper for one-attribute
// updates to the user-side UserConversation. The attribute_exists guard
// turns a missing row into ErrNotFound rather than silently writing an
// orphan.
func (s *ConversationStoreImpl) setUserConversationAttribute(ctx context.Context, convID, userID, attr string, value any) error {
	upd := expression.Set(expression.Name(attr), expression.Value(value))
	return s.updateUserConversation(ctx, convID, userID, upd, attr)
}

func (s *ConversationStoreImpl) updateUserConversation(ctx context.Context, convID, userID string, upd expression.UpdateBuilder, label string) error {
	expr, err := expression.NewBuilder().WithUpdate(upd).Build()
	if err != nil { // coverage-ignore: update expression built from a single attribute name/value; Build cannot fail
		return fmt.Errorf("store: build user conv %s expression: %w", label, err)
	}
	_, err = s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(userPK(userID), convSK(convID)),
		UpdateExpression:          expr.Update(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ConditionExpression:       aws.String("attribute_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: set user conv %s: %w", label, err)
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

// ListAll walks every conversation in the workspace via Scan with a
// PK-prefix + SK=META filter. Used only by admin maintenance flows
// (search reindex). Pages through Scan's LastEvaluatedKey.
func (s *ConversationStoreImpl) ListAll(ctx context.Context) ([]*model.Conversation, error) {
	convs := make([]*model.Conversation, 0)
	expr, err := expression.NewBuilder().WithFilter(
		expression.Name("PK").BeginsWith("CONV#").And(
			expression.Name("SK").Equal(expression.Value("META")),
		),
	).Build()
	if err != nil { // coverage-ignore: static filter built from constants; Build cannot fail
		return nil, fmt.Errorf("store: build conversations-scan expression: %w", err)
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
			return nil, fmt.Errorf("store: scan conversations: %w", err)
		}
		for _, item := range out.Items {
			var ci conversationItem
			if err := attributevalue.UnmarshalMap(item, &ci); err != nil { // coverage-ignore: round-trip of items this store wrote; cannot fail
				return nil, fmt.Errorf("store: unmarshal conversation: %w", err)
			}
			convs = append(convs, &ci.Conversation)
		}
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		startKey = out.LastEvaluatedKey
	}
	return convs, nil
}
