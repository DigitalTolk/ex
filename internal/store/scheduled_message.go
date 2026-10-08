package store

import (
	"context"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Scheduled messages live in DynamoDB (not Redis like drafts and reminders):
// they are content the author expects to be posted, so they must survive a
// cache node being replaced.
//
//   - PK=USER#{userID} SK=SCHEDMSG#{id}       the message (the owner's list is one Query)
//   - GSI1PK=SCHEDMSG_DUE GSI1SK={sendAt}#{id} only while pending: the due queue
//
// Claiming moves GSI1SK forward to a lease (a conditional update on the key
// the poller read), so exactly one poller wins, and a message whose sender
// died mid-delivery comes due again once the lease lapses.
func scheduledMessageSK(id string) string { return "SCHEDMSG#" + id }

const scheduledDueGSI1PK = "SCHEDMSG_DUE"

// ScheduledDueKey is a message's position in the due queue: a lexically
// sortable instant (fixed-width UTC millis) plus its id, so a range query on
// GSI1SK is a time range. A pending message sits at its SendAt.
func ScheduledDueKey(at time.Time, id string) string {
	return at.UTC().Format("2006-01-02T15:04:05.000Z") + "#" + id
}

// DueScheduledMessage is a message read off the due queue, with the position
// it was read at — what a claim must still find to win.
type DueScheduledMessage struct {
	*model.ScheduledMessage
	DueKey string
}

// ScheduledMessageStore persists scheduled messages.
type ScheduledMessageStore interface {
	PutScheduledMessage(ctx context.Context, m *model.ScheduledMessage) error
	GetScheduledMessage(ctx context.Context, userID, id string) (*model.ScheduledMessage, error)
	ListScheduledMessages(ctx context.Context, userID string) ([]*model.ScheduledMessage, error)
	DeleteScheduledMessage(ctx context.Context, userID, id string) error
	ListDueScheduledMessages(ctx context.Context, now time.Time, limit int) ([]DueScheduledMessage, error)
	ClaimScheduledMessage(ctx context.Context, userID, id, dueKey string, leaseUntil time.Time) (bool, error)
}

// ScheduledMessageStoreImpl implements ScheduledMessageStore on DynamoDB.
type ScheduledMessageStoreImpl struct {
	*DB
}

var _ ScheduledMessageStore = (*ScheduledMessageStoreImpl)(nil)

// NewScheduledMessageStore returns a ScheduledMessageStoreImpl.
func NewScheduledMessageStore(db *DB) *ScheduledMessageStoreImpl {
	return &ScheduledMessageStoreImpl{DB: db}
}

type scheduledMessageItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK,omitempty"`
	GSI1SK string `dynamodbav:"GSI1SK,omitempty"`
	model.ScheduledMessage
}

// PutScheduledMessage writes the message whole (create or edit). Only a
// pending message sits in the due queue; a failed one waits for its author.
func (s *ScheduledMessageStoreImpl) PutScheduledMessage(ctx context.Context, m *model.ScheduledMessage) error {
	item := scheduledMessageItem{
		PK:               userPK(m.UserID),
		SK:               scheduledMessageSK(m.ID),
		ScheduledMessage: *m,
	}
	if m.State == model.ScheduledMessagePending {
		item.GSI1PK = scheduledDueGSI1PK
		item.GSI1SK = ScheduledDueKey(m.SendAt, m.ID)
	}
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      mustAttrs(attributevalue.MarshalMap(item)),
	})
	if err != nil {
		return fmt.Errorf("store: put scheduled message: %w", err)
	}
	return nil
}

// GetScheduledMessage returns one of userID's scheduled messages, or
// ErrNotFound (also for someone else's).
func (s *ScheduledMessageStoreImpl) GetScheduledMessage(ctx context.Context, userID, id string) (*model.ScheduledMessage, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), scheduledMessageSK(id)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get scheduled message: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item scheduledMessageItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal scheduled message: %w", err)
	}
	return &item.ScheduledMessage, nil
}

// ListScheduledMessages returns all of userID's scheduled messages, pending
// and failed (unordered; the service sorts).
func (s *ScheduledMessageStoreImpl) ListScheduledMessages(ctx context.Context, userID string) ([]*model.ScheduledMessage, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith(scheduledMessageSK("")),
	)
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list scheduled messages: %w", err)
	}
	due, err := unmarshalScheduledMessages(items)
	if err != nil {
		return nil, err
	}
	out := make([]*model.ScheduledMessage, len(due))
	for i, d := range due {
		out[i] = d.ScheduledMessage
	}
	return out, nil
}

// DeleteScheduledMessage removes one of userID's scheduled messages.
func (s *ScheduledMessageStoreImpl) DeleteScheduledMessage(ctx context.Context, userID, id string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), scheduledMessageSK(id)),
	})
	if err != nil {
		return fmt.Errorf("store: delete scheduled message: %w", err)
	}
	return nil
}

// ListDueScheduledMessages returns up to limit pending messages due at or
// before now — including any whose delivery lease has lapsed — soonest first.
func (s *ScheduledMessageStoreImpl) ListDueScheduledMessages(ctx context.Context, now time.Time, limit int) ([]DueScheduledMessage, error) {
	keyCond := expression.KeyAnd(
		expression.Key("GSI1PK").Equal(expression.Value(scheduledDueGSI1PK)),
		// "~" sorts after every id, so the whole millisecond is included.
		expression.Key("GSI1SK").LessThanEqual(expression.Value(ScheduledDueKey(now, "~"))),
	)
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		Limit:                     aws.Int32(int32(limit)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list due scheduled messages: %w", err)
	}
	return unmarshalScheduledMessages(out.Items)
}

// ClaimScheduledMessage takes a message for delivery (or for a change that
// mustn't race one): it puts the message in the due queue at leaseUntil, but
// only if it is still at dueKey — where it was read — or, with dueKey "",
// only if it isn't queued at all (a failed message). So of several pollers,
// a poller and "Send now", or two clicks, exactly one wins. Returns false
// when someone else got there first, or the message changed or went.
//
// If the claimer dies before finishing, the message simply comes due at
// leaseUntil and is picked up again.
func (s *ScheduledMessageStoreImpl) ClaimScheduledMessage(ctx context.Context, userID, id, dueKey string, leaseUntil time.Time) (bool, error) {
	update := expression.
		Set(expression.Name("GSI1PK"), expression.Value(scheduledDueGSI1PK)).
		Set(expression.Name("GSI1SK"), expression.Value(ScheduledDueKey(leaseUntil, id)))
	cond := expression.Name("GSI1SK").Equal(expression.Value(dueKey))
	if dueKey == "" {
		cond = expression.AttributeExists(expression.Name("PK")).And(expression.AttributeNotExists(expression.Name("GSI1SK")))
	}
	expr := mustExpr(expression.NewBuilder().WithUpdate(update).WithCondition(cond).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(userPK(userID), scheduledMessageSK(id)),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return false, nil
		}
		return false, fmt.Errorf("store: claim scheduled message: %w", err)
	}
	return true, nil
}

func unmarshalScheduledMessages(items []map[string]types.AttributeValue) ([]DueScheduledMessage, error) {
	out := make([]DueScheduledMessage, 0, len(items))
	for _, raw := range items {
		var item scheduledMessageItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal scheduled message: %w", err)
		}
		m := item.ScheduledMessage
		out = append(out, DueScheduledMessage{ScheduledMessage: &m, DueKey: item.GSI1SK})
	}
	return out, nil
}
