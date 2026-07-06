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
	Create(ctx context.Context, token *model.RefreshToken) error
	GetByHash(ctx context.Context, hash string) (*model.RefreshToken, error)
	MarkRotated(ctx context.Context, hash string, rotatedAt time.Time, supersededBy string) error
	Delete(ctx context.Context, hash string) error
	DeleteAllForUser(ctx context.Context, userID string) error
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
	PK  string `dynamodbav:"PK"`
	SK  string `dynamodbav:"SK"`
	TTL int64  `dynamodbav:"ttl"`
	model.RefreshToken
}

func (s *TokenStoreImpl) Create(ctx context.Context, token *model.RefreshToken) error {
	item := refreshTokenItem{
		PK:           rtokenPK(token.TokenHash),
		SK:           metaSK(),
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

func (s *TokenStoreImpl) GetByHash(ctx context.Context, hash string) (*model.RefreshToken, error) {
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

// MarkRotated stamps a refresh token as used-and-superseded without deleting
// it. The row keeps its original TTL; whether a later reuse is honored is the
// service's call (allowed only while the successor is itself unused).
func (s *TokenStoreImpl) MarkRotated(ctx context.Context, hash string, rotatedAt time.Time, supersededBy string) error {
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

func (s *TokenStoreImpl) Delete(ctx context.Context, hash string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(rtokenPK(hash), metaSK()),
	})
	if err != nil {
		return fmt.Errorf("store: delete refresh token: %w", err)
	}
	return nil
}

func (s *TokenStoreImpl) DeleteAllForUser(ctx context.Context, userID string) error {
	// Scan for all RTOKEN# items belonging to this user, then batch delete.
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

		if len(page.Items) == 0 {
			continue
		}

		// BatchWriteItem supports up to 25 items per call.
		for i := 0; i < len(page.Items); i += 25 {
			end := i + 25
			if end > len(page.Items) {
				end = len(page.Items)
			}

			batch := make([]types.WriteRequest, 0, end-i)
			for _, item := range page.Items[i:end] {
				batch = append(batch, types.WriteRequest{
					DeleteRequest: &types.DeleteRequest{
						Key: map[string]types.AttributeValue{
							"PK": item["PK"],
							"SK": item["SK"],
						},
					},
				})
			}

			// Drain UnprocessedItems with a bounded retry: under throttling a
			// hot partition returns deletes that were silently NOT applied. This
			// is the account-deactivation revocation path, so a dropped delete
			// leaves a live refresh token the deactivated user can keep redeeming
			// — failing to drain here is a security gap, not a UX nicety.
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
	}

	return nil
}
