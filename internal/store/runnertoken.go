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
)

// Paired ex-runner tokens and their pairing grants live on TokenStoreImpl
// next to the refresh tokens: same table, same per-user GSI1 revocation
// shape, same batch-delete drain.

func runnerTokenPK(id string) string             { return "RUNNERTOKEN#" + id }
func runnerGrantPK(codeHash string) string       { return "RUNNERGRANT#" + codeHash }
func userRunnerTokenGSI1PK(userID string) string { return "USERRUNNERTOKEN#" + userID }

type runnerTokenItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK"`
	GSI1SK string `dynamodbav:"GSI1SK"`
	TTL    int64  `dynamodbav:"ttl"`
	model.RunnerToken
}

type runnerGrantItem struct {
	PK  string `dynamodbav:"PK"`
	SK  string `dynamodbav:"SK"`
	TTL int64  `dynamodbav:"ttl"`
	model.RunnerGrant
}

// PutRunnerGrant stores a pairing grant under its code hash. TTL reaping is
// lazy, so readers must still check ExpiresAt.
func (s *TokenStoreImpl) PutRunnerGrant(ctx context.Context, g *model.RunnerGrant) error {
	item := runnerGrantItem{
		PK:          runnerGrantPK(g.CodeHash),
		SK:          metaSK(),
		TTL:         g.ExpiresAt.Unix(),
		RunnerGrant: *g,
	}
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                mustAttrs(attributevalue.MarshalMap(item)),
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create runner grant: %w", err)
	}
	return nil
}

// TakeRunnerGrant reads a grant and deletes it in one claim: the delete is
// conditional on the row still existing, so two concurrent redemptions of the
// same code cannot both win — the loser sees ErrNotFound, exactly like an
// unknown code.
func (s *TokenStoreImpl) TakeRunnerGrant(ctx context.Context, codeHash string) (*model.RunnerGrant, error) {
	key := compositeKey(runnerGrantPK(codeHash), metaSK())
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{TableName: aws.String(s.Table), Key: key})
	if err != nil {
		return nil, fmt.Errorf("store: get runner grant: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item runnerGrantItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal runner grant: %w", err)
	}
	_, err = s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName:           aws.String(s.Table),
		Key:                 key,
		ConditionExpression: aws.String("attribute_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("store: consume runner grant: %w", err)
	}
	return &item.RunnerGrant, nil
}

// PutRunnerToken records a newly issued runner token.
func (s *TokenStoreImpl) PutRunnerToken(ctx context.Context, t *model.RunnerToken) error {
	item := runnerTokenItem{
		PK:          runnerTokenPK(t.ID),
		SK:          metaSK(),
		GSI1PK:      userRunnerTokenGSI1PK(t.UserID),
		GSI1SK:      runnerTokenPK(t.ID),
		TTL:         t.ExpiresAt.Unix(),
		RunnerToken: *t,
	}
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                mustAttrs(attributevalue.MarshalMap(item)),
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create runner token: %w", err)
	}
	return nil
}

// GetRunnerToken loads one runner token record.
func (s *TokenStoreImpl) GetRunnerToken(ctx context.Context, id string) (*model.RunnerToken, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(runnerTokenPK(id), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get runner token: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item runnerTokenItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal runner token: %w", err)
	}
	return &item.RunnerToken, nil
}

// SetRunnerTokenExpiry extends a token on renewal, moving the self-reaping
// TTL with it. Conditional on the row existing, so renewing a token that was
// revoked mid-flight cannot resurrect it.
func (s *TokenStoreImpl) SetRunnerTokenExpiry(ctx context.Context, id string, expiresAt time.Time) error {
	upd := expression.
		Set(expression.Name("expiresAt"), expression.Value(expiresAt)).
		Set(expression.Name("ttl"), expression.Value(expiresAt.Unix()))
	cond := expression.Name("PK").AttributeExists()
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(runnerTokenPK(id), metaSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: renew runner token: %w", err)
	}
	return nil
}

// ListRunnerTokens returns every runner token recorded for the user, expired
// rows the TTL reaper has not reached yet included; callers filter on
// ExpiresAt.
func (s *TokenStoreImpl) ListRunnerTokens(ctx context.Context, userID string) ([]*model.RunnerToken, error) {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(userRunnerTokenGSI1PK(userID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list runner tokens: %w", err)
	}
	out := make([]*model.RunnerToken, 0, len(items))
	for _, raw := range items {
		var item runnerTokenItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal runner token: %w", err)
		}
		tok := item.RunnerToken
		out = append(out, &tok)
	}
	return out, nil
}

// DeleteRunnerToken revokes one runner token. Deleting a missing row is not
// an error — revocation is idempotent.
func (s *TokenStoreImpl) DeleteRunnerToken(ctx context.Context, id string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(runnerTokenPK(id), metaSK()),
	})
	if err != nil {
		return fmt.Errorf("store: delete runner token: %w", err)
	}
	return nil
}

// DeleteAllRunnerTokensForUser revokes every runner the user has paired
// (account deactivation, password reset). Rows are always written with their
// GSI1 attributes, so the per-user Query alone is complete — no legacy Scan
// fallback is needed, unlike the refresh tokens.
func (s *TokenStoreImpl) DeleteAllRunnerTokensForUser(ctx context.Context, userID string) error {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(userRunnerTokenGSI1PK(userID)))
	proj := expression.NamesList(expression.Name("PK"), expression.Name("SK"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).WithProjection(proj).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ProjectionExpression:      expr.Projection(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return fmt.Errorf("store: query runner tokens: %w", err)
	}
	return s.batchDeleteTokenKeys(ctx, items)
}
