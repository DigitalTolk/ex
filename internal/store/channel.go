package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// ChannelStore defines operations on Channel entities.
type ChannelStore interface {
	CreateChannel(ctx context.Context, ch *model.Channel) error
	GetChannel(ctx context.Context, id string) (*model.Channel, error)
	GetByName(ctx context.Context, name string) (*model.Channel, error)
	GetChannelBySlug(ctx context.Context, slug string) (*model.Channel, error)
	PatchChannel(ctx context.Context, id string, p ChannelPatch) error
	RenameChannel(ctx context.Context, id, oldSlug, name, slug string, at time.Time) error
	IncrementMessageSeq(ctx context.Context, channelID string) (int64, error)
	ListPublicChannels(ctx context.Context, limit int, lastKey string) ([]*model.Channel, string, error)
	ListAllChannels(ctx context.Context) ([]*model.Channel, error)
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

func (s *ChannelStoreImpl) CreateChannel(ctx context.Context, ch *model.Channel) error {
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

	av := mustAttrs(attributevalue.MarshalMap(item))

	// Slug-lock item: a separate key derived from the slug. Both
	// the channel item and the slug-lock are written in one
	// TransactWriteItems with conditional puts; if a concurrent
	// Create races on the same slug, exactly one transaction
	// succeeds and the other gets ConditionalCheckFailed. A
	// service-layer GetBySlug pre-check is the fast path for the
	// common case but isn't load-bearing for correctness — this
	// transaction is.
	lockAV := mustAttrs(attributevalue.MarshalMap(map[string]any{
		"PK":        chanSlugGSI1PK(ch.Slug),
		"SK":        metaSK(),
		"ChannelID": ch.ID,
		"CreatedAt": ch.CreatedAt.Format(time.RFC3339Nano),
	}))

	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Put: &types.Put{
					TableName:           aws.String(s.Table),
					Item:                av,
					ConditionExpression: aws.String("attribute_not_exists(PK)"),
				},
			},
			{
				Put: &types.Put{
					TableName:                 aws.String(s.Table),
					Item:                      lockAV,
					ConditionExpression:       aws.String(slugFreeCondition),
					ExpressionAttributeValues: map[string]types.AttributeValue{":true": &types.AttributeValueMemberBOOL{Value: true}},
				},
			},
		},
	})
	if err != nil {
		if isConditionCheckFailed(err) || isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create channel: %w", err)
	}
	return nil
}

func (s *ChannelStoreImpl) GetChannel(ctx context.Context, id string) (*model.Channel, error) {
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

// slugFreeCondition holds a slug-lock put to a slug nobody holds: no lock
// row yet, or only a renamed channel's old slug kept as an alias. An alias
// redirects old links until the name is taken again.
const slugFreeCondition = "attribute_not_exists(PK) OR Alias = :true"

// slugLock is the slug-lock row: the slug's owner, or (Alias) a channel that
// used to be called this.
type slugLock struct {
	PK        string `dynamodbav:"PK"`
	SK        string `dynamodbav:"SK"`
	ChannelID string `dynamodbav:"ChannelID"`
	CreatedAt string `dynamodbav:"CreatedAt"`
	Alias     bool   `dynamodbav:"Alias,omitempty"`
}

// GetChannelBySlug returns the channel called slug — or, when no channel is
// called that any more, the one renamed away from it (its old slug kept as an
// alias), so links made before a rename keep working. The returned channel
// carries its current slug; callers that need the slug itself compare.
func (s *ChannelStoreImpl) GetChannelBySlug(ctx context.Context, slug string) (*model.Channel, error) {
	ch, err := s.channelBySlug(ctx, slug)
	if !errors.Is(err, ErrNotFound) {
		return ch, err
	}
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(chanSlugGSI1PK(slug), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get slug alias: %w", err)
	}
	var lock slugLock
	if out.Item == nil || attributevalue.UnmarshalMap(out.Item, &lock) != nil || !lock.Alias {
		return nil, ErrNotFound
	}
	return s.GetChannel(ctx, lock.ChannelID)
}

func (s *ChannelStoreImpl) channelBySlug(ctx context.Context, slug string) (*model.Channel, error) {
	keyCond := expression.KeyAnd(
		expression.Key("GSI1PK").Equal(expression.Value(chanSlugGSI1PK(slug))),
		expression.Key("GSI1SK").BeginsWith("CHAN#"),
	)
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())

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
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())

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

// ChannelPatch is a field-level channel update: only the non-nil fields are
// written. A whole-item write could roll back what it never meant to touch —
// the MessageSeq every new message bumps above all, which a description edit
// racing a message used to rewind.
type ChannelPatch struct {
	// Description "" removes it.
	Description *string
	Archived    *bool
	// MakePrivate turns a public channel private, taking it out of the
	// public listing (GSI2) the directory and channel browser read.
	MakePrivate bool
	UpdatedAt   time.Time
}

// PatchChannel applies p to channel id (ErrNotFound when there is none).
func (s *ChannelStoreImpl) PatchChannel(ctx context.Context, id string, p ChannelPatch) error {
	upd := expression.Set(expression.Name("updatedAt"), expression.Value(p.UpdatedAt))
	if p.Description != nil {
		if *p.Description == "" {
			upd = upd.Remove(expression.Name("description"))
		} else {
			upd = upd.Set(expression.Name("description"), expression.Value(*p.Description))
		}
	}
	if p.Archived != nil {
		upd = upd.Set(expression.Name("archived"), expression.Value(*p.Archived))
	}
	if p.MakePrivate {
		upd = upd.Set(expression.Name("type"), expression.Value(model.ChannelTypePrivate)).
			Remove(expression.Name("GSI2PK")).
			Remove(expression.Name("GSI2SK"))
	}
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(channelPK(id), metaSK()),
		UpdateExpression:          expr.Update(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ConditionExpression:       aws.String("attribute_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: patch channel: %w", err)
	}
	return nil
}

// RenameChannel renames channel id from oldSlug to name / slug in one
// transaction: the channel row (name, slug and its slug index key), the new
// slug's lock — which fails with ErrAlreadyExists when another channel holds
// that slug — and the old slug's lock, kept as an alias so links made before
// the rename still find the channel. A row whose slug is no longer oldSlug
// (renamed meanwhile, or gone) fails with ErrNotFound. A name whose slug
// doesn't change is a plain field update.
func (s *ChannelStoreImpl) RenameChannel(ctx context.Context, id, oldSlug, name, slug string, at time.Time) error {
	upd := expression.Set(expression.Name("name"), expression.Value(name)).
		Set(expression.Name("updatedAt"), expression.Value(at))
	if slug != oldSlug {
		upd = upd.Set(expression.Name("slug"), expression.Value(slug)).
			Set(expression.Name("GSI1PK"), expression.Value(chanSlugGSI1PK(slug)))
	}
	cond := expression.AttributeExists(expression.Name("PK")).
		And(expression.Name("slug").Equal(expression.Value(oldSlug)))
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
	update := &types.Update{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(channelPK(id), metaSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}
	if slug == oldSlug {
		_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName:                 update.TableName,
			Key:                       update.Key,
			UpdateExpression:          update.UpdateExpression,
			ConditionExpression:       update.ConditionExpression,
			ExpressionAttributeNames:  update.ExpressionAttributeNames,
			ExpressionAttributeValues: update.ExpressionAttributeValues,
		})
		if err != nil {
			if isConditionCheckFailed(err) {
				return ErrNotFound
			}
			return fmt.Errorf("store: rename channel: %w", err)
		}
		return nil
	}

	created := at.Format(time.RFC3339Nano)
	newLock := mustAttrs(attributevalue.MarshalMap(slugLock{PK: chanSlugGSI1PK(slug), SK: metaSK(), ChannelID: id, CreatedAt: created}))
	oldLock := mustAttrs(attributevalue.MarshalMap(slugLock{PK: chanSlugGSI1PK(oldSlug), SK: metaSK(), ChannelID: id, CreatedAt: created, Alias: true}))
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Update: update},
			{Put: &types.Put{
				TableName:                 aws.String(s.Table),
				Item:                      newLock,
				ConditionExpression:       aws.String(slugFreeCondition),
				ExpressionAttributeValues: map[string]types.AttributeValue{":true": &types.AttributeValueMemberBOOL{Value: true}},
			}},
			// A channel created before slug locks existed has none to turn
			// into an alias.
			{Put: &types.Put{
				TableName:                 aws.String(s.Table),
				Item:                      oldLock,
				ConditionExpression:       aws.String("attribute_not_exists(PK) OR ChannelID = :id"),
				ExpressionAttributeValues: map[string]types.AttributeValue{":id": &types.AttributeValueMemberS{Value: id}},
			}},
		},
	})
	if err != nil {
		if reason := cancellationReason(err, 1); reason == "ConditionalCheckFailed" {
			return ErrAlreadyExists
		}
		if isTransactionCancelledWithCondition(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: rename channel: %w", err)
	}
	return nil
}

// cancellationReason is the code a cancelled transaction reports for its
// i-th item ("" when it isn't one, or reports none).
func cancellationReason(err error, i int) string {
	var tce *types.TransactionCanceledException
	if !errors.As(err, &tce) || i >= len(tce.CancellationReasons) || tce.CancellationReasons[i].Code == nil {
		return ""
	}
	return *tce.CancellationReasons[i].Code
}

// CurrentMessageSeq reads the channel's MessageSeq without bumping it — the
// ceiling a mark-unread rewinds a member's last-read watermark from.
func (s *ChannelStoreImpl) CurrentMessageSeq(ctx context.Context, channelID string) (int64, error) {
	ch, err := s.GetChannel(ctx, channelID)
	if err != nil {
		return 0, err
	}
	return ch.MessageSeq, nil
}

// IncrementMessageSeq atomically bumps the channel's MessageSeq by one and
// returns the new value. ADD on a missing attribute treats it as 0, so the
// first message returns 1 — no initialization needed. The same write stamps
// lastMessageAt, which the sidebar's "Recent activity" sort reads — to the
// second, which is all a sort needs and keeps every channel row in the
// sidebar list short.
func (s *ChannelStoreImpl) IncrementMessageSeq(ctx context.Context, channelID string) (int64, error) {
	upd := expression.Add(expression.Name("messageSeq"), expression.Value(1)).
		Set(expression.Name("lastMessageAt"), expression.Value(time.Now().UTC().Truncate(time.Second)))
	return s.updateMessageSeq(ctx, channelID, upd)
}

// AddMessageSeq atomically adds n to the channel's MessageSeq and returns the
// new value — a bulk import of n top-level messages (or their removal) at
// once. It leaves lastMessageAt alone: imported history is not new activity.
func (s *ChannelStoreImpl) AddMessageSeq(ctx context.Context, channelID string, n int64) (int64, error) {
	return s.updateMessageSeq(ctx, channelID, expression.Add(expression.Name("messageSeq"), expression.Value(n)))
}

func (s *ChannelStoreImpl) updateMessageSeq(ctx context.Context, channelID string, upd expression.UpdateBuilder) (int64, error) {
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).Build())

	out, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(channelPK(channelID), metaSK()),
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
		return 0, fmt.Errorf("store: add message seq: %w", err)
	}

	var attrs struct {
		MessageSeq int64 `dynamodbav:"messageSeq"`
	}
	if err := attributevalue.UnmarshalMap(out.Attributes, &attrs); err != nil {
		return 0, fmt.Errorf("store: unmarshal message seq: %w", err)
	}
	return attrs.MessageSeq, nil
}

func (s *ChannelStoreImpl) ListPublicChannels(ctx context.Context, limit int, lastKey string) ([]*model.Channel, string, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(publicChanGSI2PK()))
	builder := expression.NewBuilder().WithKeyCondition(keyCond)

	// Filter out archived channels.
	filt := expression.Name("archived").Equal(expression.Value(false))
	builder = builder.WithFilter(filt)

	expr := mustExpr(builder.Build())

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
		// The cursor is the last row's GSI2SK, "<createdAt>#<channel ID>":
		// its channel ID rebuilds the row's table key.
		input.ExclusiveStartKey = map[string]types.AttributeValue{
			"GSI2PK": &types.AttributeValueMemberS{Value: publicChanGSI2PK()},
			"GSI2SK": &types.AttributeValueMemberS{Value: lastKey},
			"PK":     &types.AttributeValueMemberS{Value: channelPK(lastKey[strings.LastIndex(lastKey, "#")+1:])},
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

// ListAllChannels walks every channel in the workspace via Scan with a
// PK-prefix filter. Used only by admin maintenance flows (search
// reindex, etc.) — the per-user / per-public Query paths cover the
// hot read paths. Pages through Scan's LastEvaluatedKey so private
// channels are included regardless of cluster size.
func (s *ChannelStoreImpl) ListAllChannels(ctx context.Context) ([]*model.Channel, error) {
	channels := make([]*model.Channel, 0)
	expr := mustExpr(expression.NewBuilder().WithFilter(
		expression.Name("PK").BeginsWith("CHAN#").And(
			expression.Name("SK").Equal(expression.Value("META")),
		),
	).Build())
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

// GetChannelsByIDs fetches many channel META rows in chunked BatchGetItem
// calls (100 per chunk) instead of one GetItem per channel — the pattern that
// made the sidebar list (and every WebSocket connect, which reloads it) cost
// a DynamoDB read per membership. Missing IDs are absent from the result.
func (s *ChannelStoreImpl) GetChannelsByIDs(ctx context.Context, ids []string) ([]*model.Channel, error) {
	keys := make([]map[string]types.AttributeValue, len(ids))
	for i, id := range ids {
		keys[i] = compositeKey(channelPK(id), metaSK())
	}
	// Consistent, for the MessageSeq behind each row's unread count (see
	// ConversationStoreImpl.ListUserConversations).
	rows, err := batchGetOf[channelItem](ctx, s.DB, keys, types.KeysAndAttributes{ConsistentRead: aws.Bool(true)}, "channels")
	if err != nil {
		return nil, err
	}
	out := make([]*model.Channel, len(rows))
	for i := range rows {
		out[i] = &rows[i].Channel
	}
	return out, nil
}
