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
	DeleteRefreshTokenFamily(ctx context.Context, userID, familyID string) error
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

// DeleteRefreshTokenFamily deletes every token of one login session (see
// model.RefreshToken.FamilyID) from the user's token partition. Family
// members are written with the per-user GSI attributes, so the Query sees all
// of them; a legacy family root (a pre-family token, whose family ID is its
// own hash) is the caller's to delete by hash.
func (s *TokenStoreImpl) DeleteRefreshTokenFamily(ctx context.Context, userID, familyID string) error {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(userTokenGSI1PK(userID)))
	filt := expression.Name("familyID").Equal(expression.Value(familyID))
	proj := expression.NamesList(expression.Name("PK"), expression.Name("SK"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).WithFilter(filt).WithProjection(proj).Build())
	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		FilterExpression:          expr.Filter(),
		ProjectionExpression:      expr.Projection(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return fmt.Errorf("store: query refresh token family: %w", err)
		}
		if err := s.batchDeleteTokenKeys(ctx, page.Items); err != nil {
			return err
		}
	}
	return nil
}

// DeleteAllRefreshTokensForUser revokes every refresh token the user holds,
// from their own partition of GSI1: a Query bounded by their session count.
func (s *TokenStoreImpl) DeleteAllRefreshTokensForUser(ctx context.Context, userID string) error {
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

// batchDeleteTokenKeys deletes the given PK/SK projections through deleteAll
// (25-item chunks, UnprocessedItems drained on the shared backed-off schedule):
// under throttling a hot partition returns deletes that were silently NOT
// applied. This is the account-deactivation revocation path for refresh AND
// runner tokens, so a dropped delete leaves a live credential the
// deactivated user can keep using — failing to drain here is a security gap,
// not a UX nicety.
func (s *TokenStoreImpl) batchDeleteTokenKeys(ctx context.Context, items []map[string]types.AttributeValue) error {
	if err := s.deleteAll(ctx, primaryKeys(items)); err != nil {
		return fmt.Errorf("store: batch delete tokens: %w", err)
	}
	return nil
}
