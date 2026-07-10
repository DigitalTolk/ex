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

// TokenStore defines operations on RefreshToken entities.
type TokenStore interface {
	StoreRefreshToken(ctx context.Context, token *model.RefreshToken) error
	GetRefreshToken(ctx context.Context, hash string) (*model.RefreshToken, error)
	MarkRefreshTokenRotated(ctx context.Context, hash string, rotatedAt time.Time, supersededBy string) error
	DeleteRefreshToken(ctx context.Context, hash string) error
	DeleteAllRefreshTokensForUser(ctx context.Context, userID string) error
}

// TokenStoreImpl implements TokenStore backed by DynamoDB.
type TokenStoreImpl struct {
	*DB
}

var _ TokenStore = (*TokenStoreImpl)(nil)

// NewTokenStore returns a new TokenStoreImpl.
func NewTokenStore(db *DB) *TokenStoreImpl {
	return &TokenStoreImpl{DB: db}
}

// refreshTokenItem is the DynamoDB representation of a RefreshToken.
type refreshTokenItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	// GSI1 groups a user's tokens into one partition so account deactivation
	// revokes them with a Query instead of a full-table Scan.
	GSI1PK string `dynamodbav:"GSI1PK,omitempty"`
	GSI1SK string `dynamodbav:"GSI1SK,omitempty"`
	TTL    int64  `dynamodbav:"ttl"`
	model.RefreshToken
}

// userTokenGSI1PK is the per-user token partition on GSI1.
func userTokenGSI1PK(userID string) string { return "USERTOKEN#" + userID }

// tokenIndexSeededPK marks that every live legacy token row has been
// backfilled with GSI attributes (EnsureUserTokenIndex ran to completion), so
// DeleteAllForUser can trust the GSI Query alone. Absent → the legacy Scan
// fallback keeps revocation complete.
const tokenIndexSeededPK = "TOKENIDXSEEDED"

func (s *TokenStoreImpl) StoreRefreshToken(ctx context.Context, token *model.RefreshToken) error {
	item := refreshTokenItem{
		PK:           rtokenPK(token.TokenHash),
		SK:           metaSK(),
		GSI1PK:       userTokenGSI1PK(token.UserID),
		GSI1SK:       rtokenPK(token.TokenHash),
		TTL:          token.ExpiresAt.Unix(),
		RefreshToken: *token,
	}

	av := mustAttrs(attributevalue.MarshalMap(item))

	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create refresh token: %w", err)
	}
	return nil
}

func (s *TokenStoreImpl) GetRefreshToken(ctx context.Context, hash string) (*model.RefreshToken, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(rtokenPK(hash), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get refresh token: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}

	var item refreshTokenItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal refresh token: %w", err)
	}
	return &item.RefreshToken, nil
}

// MarkRefreshTokenRotated stamps a refresh token as used-and-superseded without deleting
// it. The row keeps its original TTL; whether a later reuse is honored is the
// service's call (allowed only while the successor is itself unused).
func (s *TokenStoreImpl) MarkRefreshTokenRotated(ctx context.Context, hash string, rotatedAt time.Time, supersededBy string) error {
	upd := expression.
		Set(expression.Name("rotatedAt"), expression.Value(rotatedAt)).
		Set(expression.Name("supersededBy"), expression.Value(supersededBy))
	cond := expression.Name("PK").AttributeExists()
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(rtokenPK(hash), metaSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: mark refresh token rotated: %w", err)
	}
	return nil
}

func (s *TokenStoreImpl) DeleteRefreshToken(ctx context.Context, hash string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(rtokenPK(hash), metaSK()),
	})
	if err != nil {
		return fmt.Errorf("store: delete refresh token: %w", err)
	}
	return nil
}

func (s *TokenStoreImpl) DeleteAllRefreshTokensForUser(ctx context.Context, userID string) error {
	// Fast path: the user's tokens live in one GSI partition — a Query bounded
	// by the user's own session count instead of a Scan of the entire table.
	// The GSI is trustworthy alone only once the legacy backfill has run
	// (rows written before the index existed have no GSI attributes and are
	// invisible to the Query); before that the Scan below keeps revocation
	// COMPLETE — this is account deactivation, a missed row is a live
	// credential.
	seeded, err := s.isTokenIndexSeeded(ctx)
	if err != nil {
		return err
	}
	if seeded {
		return s.deleteAllForUserByIndex(ctx, userID)
	}
	return s.deleteAllForUserByScan(ctx, userID)
}

func (s *TokenStoreImpl) isTokenIndexSeeded(ctx context.Context) (bool, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(tokenIndexSeededPK, metaSK()),
	})
	if err != nil {
		return false, fmt.Errorf("store: get token index marker: %w", err)
	}
	return out.Item != nil, nil
}

func (s *TokenStoreImpl) deleteAllForUserByIndex(ctx context.Context, userID string) error {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(userTokenGSI1PK(userID)))
	proj := expression.NamesList(expression.Name("PK"), expression.Name("SK"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).WithProjection(proj).Build())
	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ProjectionExpression:      expr.Projection(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("store: query refresh tokens: %w", err)
		}
		if err := s.batchDeleteTokenKeys(ctx, page.Items); err != nil {
			return err
		}
	}
	return nil
}

func (s *TokenStoreImpl) deleteAllForUserByScan(ctx context.Context, userID string) error {
	// Legacy path: scan for all RTOKEN# items belonging to this user, then
	// batch delete. Retired per deployment once EnsureUserTokenIndex marks the
	// GSI backfill complete.
	filt := expression.Name("PK").BeginsWith("RTOKEN#").
		And(expression.Name("userID").Equal(expression.Value(userID)))

	proj := expression.NamesList(expression.Name("PK"), expression.Name("SK"))

	expr := mustExpr(expression.NewBuilder().WithFilter(filt).WithProjection(proj).Build())

	input := &dynamodb.ScanInput{
		TableName:                 aws.String(s.Table),
		FilterExpression:          expr.Filter(),
		ProjectionExpression:      expr.Projection(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}

	paginator := dynamodb.NewScanPaginator(s.Client, input)

	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("store: scan refresh tokens: %w", err)
		}
		if err := s.batchDeleteTokenKeys(ctx, page.Items); err != nil {
			return err
		}
	}

	return nil
}

// batchDeleteTokenKeys deletes the given PK/SK projections in 25-item
// BatchWriteItem chunks, draining UnprocessedItems with a bounded retry:
// under throttling a hot partition returns deletes that were silently NOT
// applied. This is the account-deactivation revocation path, so a dropped
// delete leaves a live refresh token the deactivated user can keep redeeming
// — failing to drain here is a security gap, not a UX nicety.
func (s *TokenStoreImpl) batchDeleteTokenKeys(ctx context.Context, items []map[string]types.AttributeValue) error {
	for i := 0; i < len(items); i += 25 {
		end := min(i+25, len(items))
		batch := make([]types.WriteRequest, 0, end-i)
		for _, item := range items[i:end] {
			batch = append(batch, types.WriteRequest{
				DeleteRequest: &types.DeleteRequest{
					Key: map[string]types.AttributeValue{
						"PK": item["PK"],
						"SK": item["SK"],
					},
				},
			})
		}
		input := &dynamodb.BatchWriteItemInput{
			RequestItems: map[string][]types.WriteRequest{s.Table: batch},
		}
		for attempt := 0; attempt < 3; attempt++ {
			out, err := s.Client.BatchWriteItem(ctx, input)
			if err != nil {
				return fmt.Errorf("store: batch delete refresh tokens: %w", err)
			}
			if len(out.UnprocessedItems[s.Table]) == 0 {
				break
			}
			if attempt == 2 {
				return fmt.Errorf("store: batch delete refresh tokens: %d unprocessed after retries", len(out.UnprocessedItems[s.Table]))
			}
			input.RequestItems = out.UnprocessedItems
		}
	}
	return nil
}

// EnsureUserTokenIndex backfills GSI attributes onto legacy refresh-token
// rows (written before the per-user token partition existed) and writes the
// seeded marker so DeleteAllForUser switches from the full-table Scan to the
// per-user Query. Idempotent and concurrency-safe: re-running rewrites the
// same attributes, so every instance may call it at startup. A no-op once the
// marker exists.
func (s *TokenStoreImpl) EnsureUserTokenIndex(ctx context.Context) error {
	seeded, err := s.isTokenIndexSeeded(ctx)
	if err != nil || seeded {
		return err
	}
	filt := expression.Name("PK").BeginsWith("RTOKEN#").
		And(expression.Name("GSI1PK").AttributeNotExists())
	proj := expression.NamesList(expression.Name("PK"), expression.Name("SK"), expression.Name("userID"))
	expr := mustExpr(expression.NewBuilder().WithFilter(filt).WithProjection(proj).Build())
	paginator := dynamodb.NewScanPaginator(s.Client, &dynamodb.ScanInput{
		TableName:                 aws.String(s.Table),
		FilterExpression:          expr.Filter(),
		ProjectionExpression:      expr.Projection(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("store: scan legacy refresh tokens: %w", err)
		}
		for _, item := range page.Items {
			var row struct {
				PK     string `dynamodbav:"PK"`
				SK     string `dynamodbav:"SK"`
				UserID string `dynamodbav:"userID"`
			}
			if err := attributevalue.UnmarshalMap(item, &row); err != nil {
				return fmt.Errorf("store: unmarshal legacy refresh token: %w", err)
			}
			if row.UserID == "" {
				continue // unrevocable garbage row; expires via TTL
			}
			update := expression.Set(expression.Name("GSI1PK"), expression.Value(userTokenGSI1PK(row.UserID))).
				Set(expression.Name("GSI1SK"), expression.Value(row.PK))
			uexpr := mustExpr(expression.NewBuilder().WithUpdate(update).Build())
			if _, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
				TableName:                 aws.String(s.Table),
				Key:                       compositeKey(row.PK, row.SK),
				UpdateExpression:          uexpr.Update(),
				ExpressionAttributeNames:  uexpr.Names(),
				ExpressionAttributeValues: uexpr.Values(),
			}); err != nil {
				return fmt.Errorf("store: backfill refresh token index: %w", err)
			}
		}
	}
	marker := map[string]types.AttributeValue{
		"PK": &types.AttributeValueMemberS{Value: tokenIndexSeededPK},
		"SK": &types.AttributeValueMemberS{Value: metaSK()},
	}
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{TableName: aws.String(s.Table), Item: marker}); err != nil {
		return fmt.Errorf("store: mark token index seeded: %w", err)
	}
	return nil
}
