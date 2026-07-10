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
	"golang.org/x/sync/errgroup"
)

// MessageStore defines operations on Message entities.
type MessageStore interface {
	CreateMessage(ctx context.Context, msg *model.Message) error
	GetMessage(ctx context.Context, parentID, msgID string) (*model.Message, error)
	ListMessages(ctx context.Context, parentID string, before string, limit int) ([]*model.Message, bool, error)
	UpdateMessage(ctx context.Context, msg *model.Message) error
	DeleteMessage(ctx context.Context, parentID, msgID string) error
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
	// GSI1 indexes thread replies (only set when ParentMessageID != "") so a
	// thread can be read with a single GSI Query rather than a parent-partition
	// scan. Omitted on roots/standalone messages so they stay out of the index.
	GSI1PK string `dynamodbav:"GSI1PK,omitempty"`
	GSI1SK string `dynamodbav:"GSI1SK,omitempty"`
	model.Message
}

// newMessageItem builds the DynamoDB row for a message, stamping the thread
// GSI keys on replies. Both Create and Update full-Put the whole item, so
// centralising the key derivation here keeps the index consistent on edits and
// soft-delete tombstones (which re-Put the row).
func newMessageItem(parentID string, msg *model.Message) messageItem {
	item := messageItem{
		PK:      parentPK(parentID),
		SK:      msgSK(msg.ID),
		Message: *msg,
	}
	if msg.ParentMessageID != "" {
		item.GSI1PK = threadGSI1PK(msg.ParentMessageID)
		item.GSI1SK = msgSK(msg.ID)
	}
	return item
}

// parentPK returns the partition key for a message's parent. Channels AND
// conversations share the CHAN# message-key namespace: conversation IDs are
// DeriveID ULIDs, so they can never collide with channel IDs, and the store
// only needs write/read consistency — not the parent's entity type. (A
// historical dm_/grp_ prefix sniff used to route to CONV# here, but real
// conversation IDs never carried those prefixes, so every existing message
// row lives under CHAN#; routing by type now would orphan them.)
func parentPK(parentID string) string {
	return channelPK(parentID)
}

func (s *MessageStoreImpl) CreateMessage(ctx context.Context, msg *model.Message) error {
	item := newMessageItem(msg.ParentID, msg)

	av := mustAttrs(attributevalue.MarshalMap(item))

	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
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

func (s *MessageStoreImpl) GetMessage(ctx context.Context, parentID, msgID string) (*model.Message, error) {
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

func (s *MessageStoreImpl) ListMessages(ctx context.Context, parentID string, before string, limit int) ([]*model.Message, bool, error) {
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

	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())

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

// ListThreadReplies returns every reply to threadRootID, oldest first, via the
// GSI1 thread index — one Query (paginated) rather than scanning the parent's
// message partition. The GSI is eventually consistent: a just-posted reply can
// lag, but clients receive it over the WebSocket broadcast, so the index only
// needs to be authoritative for the historical thread. Tombstoned replies keep
// their key (Update re-stamps), so deleted replies still appear as placeholders.
func (s *MessageStoreImpl) ListThreadReplies(ctx context.Context, threadRootID string) ([]*model.Message, error) {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(threadGSI1PK(threadRootID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	var replies []*model.Message
	var startKey map[string]types.AttributeValue
	for {
		out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
			TableName:                 aws.String(s.Table),
			IndexName:                 aws.String("GSI1"),
			KeyConditionExpression:    expr.KeyCondition(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
			ExclusiveStartKey:         startKey,
		})
		if err != nil {
			return nil, fmt.Errorf("store: list thread replies: %w", err)
		}
		for _, av := range out.Items {
			var mi messageItem
			if err := attributevalue.UnmarshalMap(av, &mi); err != nil {
				return nil, fmt.Errorf("store: unmarshal thread reply: %w", err)
			}
			m := mi.Message
			replies = append(replies, &m)
		}
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		startKey = out.LastEvaluatedKey
	}
	return replies, nil
}

// StampThreadIndex sets just the GSI1 thread keys on an existing reply row via
// a targeted UpdateItem — used by the one-off backfill migration so it indexes
// historical replies without rewriting (and potentially clobbering) the rest of
// the message. Idempotent: re-running writes the same keys.
func (s *MessageStoreImpl) StampThreadIndex(ctx context.Context, parentID, msgID, threadRootID string) error {
	upd := expression.
		Set(expression.Name("GSI1PK"), expression.Value(threadGSI1PK(threadRootID))).
		Set(expression.Name("GSI1SK"), expression.Value(msgSK(msgID)))
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(parentPK(parentID), msgSK(msgID)),
		UpdateExpression:          expr.Update(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ConditionExpression:       aws.String("attribute_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: stamp thread index: %w", err)
	}
	return nil
}

// ListAfter returns up to `limit` messages strictly newer than the
// `after` cursor (a message ID), ordered newest-first like List.
// Used by the bidirectional message paginator when a user is anchored
// in mid-history and scrolls down toward the live tail.
func (s *MessageStoreImpl) ListMessagesAfter(ctx context.Context, parentID, after string, limit int) ([]*model.Message, bool, error) {
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
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
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
func (s *MessageStoreImpl) ListMessagesAround(ctx context.Context, parentID, msgID string, before, after int) ([]*model.Message, bool, bool, error) {
	var (
		target                     *model.Message
		older, newer               []*model.Message
		hasMoreOlder, hasMoreNewer bool
	)
	g, gctx := errgroup.WithContext(ctx)
	g.Go(func() error {
		var err error
		target, err = s.GetMessage(gctx, parentID, msgID)
		return err
	})
	g.Go(func() error {
		var err error
		older, hasMoreOlder, err = s.ListMessages(gctx, parentID, msgID, before)
		return err
	})
	g.Go(func() error {
		var err error
		newer, hasMoreNewer, err = s.ListMessagesAfter(gctx, parentID, msgID, after)
		return err
	})
	if err := g.Wait(); err != nil {
		return nil, false, false, err
	}
	out := make([]*model.Message, 0, len(older)+len(newer)+1)
	out = append(out, newer...)
	out = append(out, target)
	out = append(out, older...)
	return out, hasMoreOlder, hasMoreNewer, nil
}

func (s *MessageStoreImpl) UpdateMessage(ctx context.Context, msg *model.Message) error {
	item := newMessageItem(msg.ParentID, msg)

	av := mustAttrs(attributevalue.MarshalMap(item))

	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
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
	parent, err := s.GetMessage(ctx, parentID, msgID)
	if err != nil {
		return nil, err
	}
	authors := mergeRecentAuthors(parent.RecentReplyAuthorIDs, replyAuthorID)
	upd := expression.
		Add(expression.Name("replyCount"), expression.Value(1)).
		Set(expression.Name("lastReplyAt"), expression.Value(replyTime)).
		Set(expression.Name("recentReplyAuthorIDs"), expression.Value(authors))
	cond := expression.Name("PK").AttributeExists()
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
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

func (s *MessageStoreImpl) DeleteMessage(ctx context.Context, parentID, msgID string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(parentPK(parentID), msgSK(msgID)),
	})
	if err != nil {
		return fmt.Errorf("store: delete message: %w", err)
	}
	return nil
}

// GetMessagesByIDs fetches many messages of ONE parent in chunked
// BatchGetItem calls instead of a GetItem per ID (pin resolution, thread-root
// hydration). Missing IDs are absent from the result; order not guaranteed.
func (s *MessageStoreImpl) GetMessagesByIDs(ctx context.Context, parentID string, ids []string) ([]*model.Message, error) {
	out := make([]*model.Message, 0, len(ids))
	const batchSize = 100
	for start := 0; start < len(ids); start += batchSize {
		end := min(start+batchSize, len(ids))
		keys := make([]map[string]types.AttributeValue, 0, end-start)
		for _, id := range ids[start:end] {
			keys = append(keys, compositeKey(parentPK(parentID), msgSK(id)))
		}
		req := map[string]types.KeysAndAttributes{s.Table: {Keys: keys}}
		for {
			res, err := s.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: req})
			if err != nil {
				return nil, fmt.Errorf("store: batch get messages: %w", err)
			}
			for _, item := range res.Responses[s.Table] {
				var rec messageItem
				if err := attributevalue.UnmarshalMap(item, &rec); err != nil {
					return nil, fmt.Errorf("store: unmarshal message: %w", err)
				}
				msg := rec.Message
				out = append(out, &msg)
			}
			// DynamoDB may return unprocessed keys under throttling — drain them.
			if len(res.UnprocessedKeys) == 0 {
				break
			}
			req = res.UnprocessedKeys
		}
	}
	return out, nil
}
