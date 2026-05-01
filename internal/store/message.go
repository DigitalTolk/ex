package store

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
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
		// SK BETWEEN MSG# AND MSG#<before>. BETWEEN is inclusive on both
		// ends, so the cursor message itself comes back as the first
		// item — we strip it below to keep pages disjoint.
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

	// Fetch one extra to detect "has more"; one more than that when
	// paginating because the inclusive cursor item gets stripped below.
	fetchLimit := int32(limit + 1)
	if before != "" {
		fetchLimit++
	}

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

	// Strip the cursor message from the head — DDB's BETWEEN is
	// inclusive on the upper bound, so when paginating it comes back
	// as a duplicate of the previous page's last item. We only strip
	// when we actually see it (cursor message could have been deleted
	// since the prior page was fetched).
	if before != "" && len(messages) > 0 && messages[0].ID == before {
		messages = messages[1:]
	}

	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}

	return messages, hasMore, nil
}

// ListAfter returns up to `limit` messages strictly newer than the
// `after` cursor (a message ID), ordered newest-first like List.
// Used by the bidirectional message paginator when a user is anchored
// in mid-history and scrolls down toward the live tail.
func (s *MessageStoreImpl) ListAfter(ctx context.Context, parentID, after string, limit int) ([]*model.Message, bool, error) {
	if after == "" {
		return nil, false, nil
	}
	pk := parentPK(parentID)
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(pk)),
		expression.Key("SK").Between(
			expression.Value(msgSK(after)),
			expression.Value("MSG#~"), // upper bound past any ULID
		),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil {
		return nil, false, fmt.Errorf("store: build expression: %w", err)
	}
	// `after` is exclusive but BETWEEN is inclusive; fetch one extra to
	// strip the cursor below, plus one more for has-more detection.
	fetchLimit := int32(limit + 2)
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ScanIndexForward:          aws.Bool(true),
		Limit:                     aws.Int32(fetchLimit),
	})
	if err != nil {
		return nil, false, fmt.Errorf("store: list messages after: %w", err)
	}
	messages := make([]*model.Message, 0, len(out.Items))
	for _, item := range out.Items {
		var mi messageItem
		if err := attributevalue.UnmarshalMap(item, &mi); err != nil {
			return nil, false, fmt.Errorf("store: unmarshal message: %w", err)
		}
		messages = append(messages, &mi.Message)
	}
	if len(messages) > 0 && messages[0].ID == after {
		messages = messages[1:]
	}
	hasMore := len(messages) > limit
	if hasMore {
		messages = messages[:limit]
	}
	// Reverse to newest-first to match List's contract.
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}
	return messages, hasMore, nil
}

// ListAround returns a window centered on `msgID`: up to `before`
// older messages, the message itself (if it still exists), and up to
// `after` newer messages — newest-first. The three DDB calls
// (target Get, older Query, newer Query) are independent and run
// concurrently; ListAround is on the user-perceived path for every
// "Jump to message" so latency multiplies if they serialize.
func (s *MessageStoreImpl) ListAround(ctx context.Context, parentID, msgID string, before, after int) ([]*model.Message, bool, bool, error) {
	var (
		wg                                   sync.WaitGroup
		target                               *model.Message
		older, newer                         []*model.Message
		hasMoreOlder, hasMoreNewer           bool
		errTarget, errOlder, errNewer        error
	)
	wg.Add(3)
	go func() {
		defer wg.Done()
		target, errTarget = s.GetByID(ctx, parentID, msgID)
	}()
	go func() {
		defer wg.Done()
		older, hasMoreOlder, errOlder = s.List(ctx, parentID, msgID, before)
	}()
	go func() {
		defer wg.Done()
		newer, hasMoreNewer, errNewer = s.ListAfter(ctx, parentID, msgID, after)
	}()
	wg.Wait()
	for _, err := range []error{errTarget, errOlder, errNewer} {
		if err != nil {
			return nil, false, false, err
		}
	}
	out := make([]*model.Message, 0, len(older)+len(newer)+1)
	out = append(out, newer...)
	if target != nil {
		out = append(out, target)
	}
	out = append(out, older...)
	return out, hasMoreOlder, hasMoreNewer, nil
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

// recentReplyAuthorsCap caps the recent-authors list at 3 — drives
// the thread-action-bar avatar stack without unbounded growth.
const recentReplyAuthorsCap = 3

// mergeRecentAuthors prepends authorID to prev, dedupes, and trims to
// recentReplyAuthorsCap entries newest-first.
func mergeRecentAuthors(prev []string, authorID string) []string {
	out := make([]string, 0, recentReplyAuthorsCap)
	out = append(out, authorID)
	for _, id := range prev {
		if id == authorID {
			continue
		}
		out = append(out, id)
		if len(out) >= recentReplyAuthorsCap {
			break
		}
	}
	return out
}

// IncrementReplyMetadata atomically bumps a thread root's ReplyCount
// by one, sets LastReplyAt to replyTime, and updates RecentReplyAuthorIDs
// with replyAuthorID prepended (deduped, capped). Returns the updated
// message; ErrNotFound if the parent is missing.
//
// ReplyCount uses DynamoDB's ADD action so concurrent thread replies
// can't lose-update each other. LastReplyAt and RecentReplyAuthorIDs
// are last-writer-wins; the authors list is computed from a fresh GET
// inside this method, so the race is small but real — at worst one of
// two simultaneous authors is dropped from the avatar stack. Count
// integrity is unaffected.
func (s *MessageStoreImpl) IncrementReplyMetadata(ctx context.Context, parentID, msgID string, replyTime time.Time, replyAuthorID string) (*model.Message, error) {
	parent, err := s.GetByID(ctx, parentID, msgID)
	if err != nil {
		return nil, err
	}
	authors := mergeRecentAuthors(parent.RecentReplyAuthorIDs, replyAuthorID)
	upd := expression.
		Add(expression.Name("replyCount"), expression.Value(1)).
		Set(expression.Name("lastReplyAt"), expression.Value(replyTime)).
		Set(expression.Name("recentReplyAuthorIDs"), expression.Value(authors))
	cond := expression.Name("PK").AttributeExists()
	expr, err := expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build()
	if err != nil {
		return nil, fmt.Errorf("store: build reply-metadata expression: %w", err)
	}
	out, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(parentPK(parentID), msgSK(msgID)),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ReturnValues:              types.ReturnValueAllNew,
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("store: increment reply metadata: %w", err)
	}
	var item messageItem
	if err := attributevalue.UnmarshalMap(out.Attributes, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal updated message: %w", err)
	}
	return &item.Message, nil
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
