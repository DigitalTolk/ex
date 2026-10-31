package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"golang.org/x/sync/errgroup"
)

type ThreadFollowStore interface {
	SetThreadFollow(ctx context.Context, follow *model.ThreadFollow) error
	SetThreadFollowMany(ctx context.Context, follows []*model.ThreadFollow) error
	GetThreadFollow(ctx context.Context, userID, parentID, threadRootID string) (*model.ThreadFollow, error)
	GetUserThreadFollows(ctx context.Context, userID string, threads []model.ThreadRef) ([]*model.ThreadFollow, error)
	ListUserThreadFollows(ctx context.Context, userID string) ([]*model.ThreadFollow, error)
	ListFollowedThreadsByActivity(ctx context.Context, userID, cursor string, limit int) ([]*model.ThreadFollow, string, error)
	ListThreadFollows(ctx context.Context, parentID, threadRootID string) ([]*model.ThreadFollow, error)
	TouchThreadActivity(ctx context.Context, userIDs []string, parentID, threadRootID string, at time.Time) error
}

type ThreadFollowStoreImpl struct {
	*DB
}

var _ ThreadFollowStore = (*ThreadFollowStoreImpl)(nil)

func NewThreadFollowStore(db *DB) *ThreadFollowStoreImpl {
	return &ThreadFollowStoreImpl{DB: db}
}

type threadFollowItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK"`
	GSI1SK string `dynamodbav:"GSI1SK"`
	// GSI2 holds the row only while the thread is followed and its latest
	// reply known: the user's /threads list, latest reply first.
	GSI2PK string `dynamodbav:"GSI2PK,omitempty"`
	GSI2SK string `dynamodbav:"GSI2SK,omitempty"`
	model.ThreadFollow
}

// threadFollowRow is the stored row for f; every write goes through it, so an
// unfollow (a full put without the GSI2 keys) also takes the thread off the
// activity list.
func threadFollowRow(f *model.ThreadFollow) map[string]types.AttributeValue {
	item := threadFollowItem{
		PK:           userPK(f.UserID),
		SK:           threadFollowSK(f.ParentID, f.ThreadRootID),
		GSI1PK:       threadFollowGSI1PK(f.ParentID, f.ThreadRootID),
		GSI1SK:       userPK(f.UserID),
		ThreadFollow: *f,
	}
	if f.Following && f.LastActivityAt != nil {
		item.GSI2PK = threadActivityGSI2PK(f.UserID)
		item.GSI2SK = threadActivitySK(*f.LastActivityAt, f.ParentID, f.ThreadRootID)
	}
	return mustAttrs(attributevalue.MarshalMap(item))
}

// SetThreadFollowMany writes a slice of follows with BatchWriteItem through
// putAll (chunked to the 25-op DynamoDB limit, UnprocessedItems drained on the
// shared backed-off, capped schedule — a request's ctx deadline bounds the
// wait on the send path). Used when a single message touches multiple users
// at once — e.g. a thread reply that mentions several teammates — so we hit
// DDB once instead of N times.
//
// BatchWriteItem doesn't return an error on per-item conflicts the
// way TransactWriteItems would, but follow records are idempotent
// PutItems anyway: re-writing an existing record with the same body
// is a no-op for the user-visible state.
func (s *ThreadFollowStoreImpl) SetThreadFollowMany(ctx context.Context, follows []*model.ThreadFollow) error {
	items := make([]map[string]types.AttributeValue, len(follows))
	for i, f := range follows {
		items[i] = threadFollowRow(f)
	}
	if err := s.putAll(ctx, items); err != nil {
		return fmt.Errorf("store: batch set thread follows: %w", err)
	}
	return nil
}

func (s *ThreadFollowStoreImpl) SetThreadFollow(ctx context.Context, follow *model.ThreadFollow) error {
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      threadFollowRow(follow),
	})
	if err != nil {
		return fmt.Errorf("store: set thread follow: %w", err)
	}
	return nil
}

func (s *ThreadFollowStoreImpl) ListThreadFollows(ctx context.Context, parentID, threadRootID string) ([]*model.ThreadFollow, error) {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(threadFollowGSI1PK(parentID, threadRootID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	// Drain every page: these are the thread's watchers, i.e. notification
	// recipients for a reply, so truncation would drop alerts.
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list thread follows: %w", err)
	}
	follows := make([]*model.ThreadFollow, 0, len(items))
	for _, raw := range items {
		var item threadFollowItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
		}
		follows = append(follows, &item.ThreadFollow)
	}
	return follows, nil
}

func (s *ThreadFollowStoreImpl) GetThreadFollow(ctx context.Context, userID, parentID, threadRootID string) (*model.ThreadFollow, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), threadFollowSK(parentID, threadRootID)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get thread follow: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item threadFollowItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
	}
	return &item.ThreadFollow, nil
}

func (s *ThreadFollowStoreImpl) ListUserThreadFollows(ctx context.Context, userID string) ([]*model.ThreadFollow, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith("THREAD#"),
	)
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list thread follows: %w", err)
	}
	follows := make([]*model.ThreadFollow, 0, len(items))
	for _, raw := range items {
		var item threadFollowItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal thread follow: %w", err)
		}
		follows = append(follows, &item.ThreadFollow)
	}
	return follows, nil
}

// SetThreadFollowIfAbsent writes a follow row ONLY when the user has no explicit record
// for that thread yet — the write-time participation index must never clobber
// a deliberate unfollow (Following=false) with an implicit re-follow.
func (s *ThreadFollowStoreImpl) SetThreadFollowIfAbsent(ctx context.Context, follow *model.ThreadFollow) error {
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                threadFollowRow(follow),
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return nil // an explicit record exists — leave it be
		}
		return fmt.Errorf("store: set thread follow if absent: %w", err)
	}
	return nil
}

// GetUserThreadFollows reads userID's follow rows for the given threads in
// batched reads; threads without a row are left out.
func (s *ThreadFollowStoreImpl) GetUserThreadFollows(ctx context.Context, userID string, threads []model.ThreadRef) ([]*model.ThreadFollow, error) {
	keys := make([]map[string]types.AttributeValue, len(threads))
	for i, t := range threads {
		keys[i] = compositeKey(userPK(userID), threadFollowSK(t.ParentID, t.ThreadRootID))
	}
	rows, err := batchGetOf[threadFollowItem](ctx, s.DB, keys, types.KeysAndAttributes{}, "thread follows")
	if err != nil {
		return nil, err
	}
	out := make([]*model.ThreadFollow, len(rows))
	for i := range rows {
		out[i] = &rows[i].ThreadFollow
	}
	return out, nil
}

// ListFollowedThreadsByActivity returns up to limit of userID's followed
// threads, latest reply first, after cursor (the previous page's next). next
// is empty once nothing is left. A cursor this store did not hand out is
// rejected rather than guessed at.
func (s *ThreadFollowStoreImpl) ListFollowedThreadsByActivity(ctx context.Context, userID, cursor string, limit int) ([]*model.ThreadFollow, string, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(threadActivityGSI2PK(userID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	input := &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ScanIndexForward:          aws.Bool(false),
		Limit:                     aws.Int32(int32(limit)),
	}
	if cursor != "" {
		start, err := threadActivityStartKey(userID, cursor)
		if err != nil {
			return nil, "", err
		}
		input.ExclusiveStartKey = start
	}
	out, err := s.Client.Query(ctx, input)
	if err != nil {
		return nil, "", fmt.Errorf("store: list followed threads: %w", err)
	}
	follows := make([]*model.ThreadFollow, 0, len(out.Items))
	next := ""
	for _, raw := range out.Items {
		var item threadFollowItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, "", fmt.Errorf("store: unmarshal thread follow: %w", err)
		}
		follows = append(follows, &item.ThreadFollow)
		next = item.GSI2SK
	}
	if len(out.LastEvaluatedKey) == 0 {
		next = ""
	}
	return follows, next, nil
}

// threadActivityStartKey rebuilds the row key behind a cursor (a GSI2SK:
// "<time>#<parentID>#<threadRootID>").
func threadActivityStartKey(userID, cursor string) (map[string]types.AttributeValue, error) {
	n := len(threadActivityTimeLayout)
	if len(cursor) <= n || cursor[n] != '#' {
		return nil, apperr.Invalid("thread list: bad cursor")
	}
	rest := cursor[n+1:]
	cut := strings.LastIndex(rest, "#")
	if cut <= 0 || cut == len(rest)-1 {
		return nil, apperr.Invalid("thread list: bad cursor")
	}
	key := compositeKey(userPK(userID), threadFollowSK(rest[:cut], rest[cut+1:]))
	key["GSI2PK"] = &types.AttributeValueMemberS{Value: threadActivityGSI2PK(userID)}
	key["GSI2SK"] = &types.AttributeValueMemberS{Value: cursor}
	return key, nil
}

// TouchThreadActivity records a reply at `at` on each of userIDs' follow rows
// for the thread, moving it up their /threads lists. Only a followed row
// whose latest reply is older moves: an unfollowed or missing row stays out
// of the list, and a late touch never pulls a thread back down.
func (s *ThreadFollowStoreImpl) TouchThreadActivity(ctx context.Context, userIDs []string, parentID, threadRootID string, at time.Time) error {
	var g errgroup.Group
	g.SetLimit(threadTouchWriters)
	for _, userID := range userIDs {
		g.Go(func() error {
			sk := threadActivitySK(at, parentID, threadRootID)
			cond := expression.Name("following").Equal(expression.Value(true)).And(
				expression.Or(expression.AttributeNotExists(expression.Name("GSI2SK")), expression.Name("GSI2SK").LessThan(expression.Value(sk))))
			update := expression.Set(expression.Name("GSI2PK"), expression.Value(threadActivityGSI2PK(userID))).
				Set(expression.Name("GSI2SK"), expression.Value(sk)).
				Set(expression.Name("lastActivityAt"), expression.Value(at.UTC()))
			expr := mustExpr(expression.NewBuilder().WithCondition(cond).WithUpdate(update).Build())
			_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
				TableName:                 aws.String(s.Table),
				Key:                       compositeKey(userPK(userID), threadFollowSK(parentID, threadRootID)),
				ConditionExpression:       expr.Condition(),
				UpdateExpression:          expr.Update(),
				ExpressionAttributeNames:  expr.Names(),
				ExpressionAttributeValues: expr.Values(),
			})
			if err != nil && !isConditionCheckFailed(err) {
				return fmt.Errorf("store: touch thread activity: %w", err)
			}
			return nil
		})
	}
	return g.Wait()
}

// threadTouchWriters bounds the concurrent row updates of one touch.
const threadTouchWriters = 8
