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

// BotStore persists bot accounts and their API tokens.
type BotStore interface {
	CreateBot(ctx context.Context, bot *model.BotAccount) error
	// UpdateBot overwrites an existing bot's META row (e.g. to set its
	// outgoing-webhook config). The directory entry is untouched.
	UpdateBot(ctx context.Context, bot *model.BotAccount) error
	GetBot(ctx context.Context, userID string) (*model.BotAccount, error)
	ListBots(ctx context.Context) ([]*model.BotAccount, error)
	// RemoveBotFromDirectory drops the bot from the admin listing. The META row
	// and the bot's User row are deliberately kept so historical messages it
	// authored still resolve an author.
	RemoveBotFromDirectory(ctx context.Context, userID string) error

	CreateBotToken(ctx context.Context, tok *model.BotToken) error
	GetBotTokenByHash(ctx context.Context, hash string) (*model.BotToken, error)
	ListBotTokens(ctx context.Context, botUserID string) ([]*model.BotToken, error)
	RevokeBotToken(ctx context.Context, hash string, at time.Time) error
	TouchBotTokenLastUsed(ctx context.Context, hash string, at time.Time) error
}

type BotStoreImpl struct {
	*DB
}

var _ BotStore = (*BotStoreImpl)(nil)

func NewBotStore(db *DB) *BotStoreImpl {
	return &BotStoreImpl{DB: db}
}

type botItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.BotAccount
}

type botTokenItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	// GSI1 groups a bot's tokens into one partition so listing them (and
	// revoking them all on bot deletion) is a Query, never a Scan.
	GSI1PK string `dynamodbav:"GSI1PK,omitempty"`
	GSI1SK string `dynamodbav:"GSI1SK,omitempty"`
	model.BotToken
}

// The bot DIRECTORY is a single row holding the ID set of every bot, maintained
// atomically with each create/remove, so the admin list reads "which bots
// exist" with one ConsistentRead GetItem + one BatchGet instead of a
// full-table Scan (whose cost grows with every message in the shared table).
// Unlike the webhook directory this needs no `seeded` flag or Scan fallback:
// bots are a new entity, so no rows predate the directory.
const botDirPK = "BOTDIR"

type botDirRow struct {
	IDs []string `dynamodbav:"ids,stringset,omitempty"`
}

func (s *BotStoreImpl) CreateBot(ctx context.Context, bot *model.BotAccount) error {
	item := botItem{PK: botPK(bot.UserID), SK: metaSK(), BotAccount: *bot}
	av := mustAttrs(attributevalue.MarshalMap(item))
	// The META row and its directory entry commit together, so the admin
	// list's ConsistentRead can never see a just-created bot missing.
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{Put: &types.Put{
				TableName:           aws.String(s.Table),
				Item:                av,
				ConditionExpression: aws.String("attribute_not_exists(PK)"),
			}},
			{Update: &types.Update{
				TableName:        aws.String(s.Table),
				Key:              compositeKey(botDirPK, metaSK()),
				UpdateExpression: aws.String("ADD ids :id"),
				ExpressionAttributeValues: map[string]types.AttributeValue{
					":id": &types.AttributeValueMemberSS{Value: []string{bot.UserID}},
				},
			}},
		},
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create bot: %w", err)
	}
	return nil
}

// UpdateBot overwrites the bot's META row. Callers Get first, so the row exists;
// the directory SS already holds the id, so a plain Put preserves the listing.
func (s *BotStoreImpl) UpdateBot(ctx context.Context, bot *model.BotAccount) error {
	item := botItem{PK: botPK(bot.UserID), SK: metaSK(), BotAccount: *bot}
	av := mustAttrs(attributevalue.MarshalMap(item))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: update bot: %w", err)
	}
	return nil
}

func (s *BotStoreImpl) GetBot(ctx context.Context, userID string) (*model.BotAccount, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(botPK(userID), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get bot: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item botItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal bot: %w", err)
	}
	return &item.BotAccount, nil
}

func (s *BotStoreImpl) ListBots(ctx context.Context) ([]*model.BotAccount, error) {
	dirOut, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.Table),
		Key:            compositeKey(botDirPK, metaSK()),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get bot directory: %w", err)
	}
	if dirOut.Item == nil {
		return []*model.BotAccount{}, nil
	}
	var dir botDirRow
	if err := attributevalue.UnmarshalMap(dirOut.Item, &dir); err != nil {
		return nil, fmt.Errorf("store: unmarshal bot directory: %w", err)
	}

	// An ID whose META row is gone (crashed half-remove) is skipped; the next
	// remove prunes it from the set.
	items := make([]*model.BotAccount, 0, len(dir.IDs))
	const batchSize = 100
	for start := 0; start < len(dir.IDs); start += batchSize {
		end := min(start+batchSize, len(dir.IDs))
		keys := make([]map[string]types.AttributeValue, 0, end-start)
		for _, id := range dir.IDs[start:end] {
			keys = append(keys, compositeKey(botPK(id), metaSK()))
		}
		req := map[string]types.KeysAndAttributes{s.Table: {Keys: keys, ConsistentRead: aws.Bool(true)}}
		for {
			res, err := s.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: req})
			if err != nil {
				return nil, fmt.Errorf("store: batch get bots: %w", err)
			}
			for _, av := range res.Responses[s.Table] {
				var item botItem
				if err := attributevalue.UnmarshalMap(av, &item); err != nil {
					return nil, fmt.Errorf("store: unmarshal bot: %w", err)
				}
				items = append(items, &item.BotAccount)
			}
			if len(res.UnprocessedKeys) == 0 {
				break
			}
			req = res.UnprocessedKeys
		}
	}
	return items, nil
}

func (s *BotStoreImpl) RemoveBotFromDirectory(ctx context.Context, userID string) error {
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:        aws.String(s.Table),
		Key:              compositeKey(botDirPK, metaSK()),
		UpdateExpression: aws.String("DELETE ids :id"),
		ExpressionAttributeValues: map[string]types.AttributeValue{
			":id": &types.AttributeValueMemberSS{Value: []string{userID}},
		},
	})
	if err != nil {
		return fmt.Errorf("store: remove bot from directory: %w", err)
	}
	return nil
}

func (s *BotStoreImpl) CreateBotToken(ctx context.Context, tok *model.BotToken) error {
	item := botTokenItem{
		PK:       botTokenPK(tok.TokenHash),
		SK:       metaSK(),
		GSI1PK:   botTokenGSI1PK(tok.BotUserID),
		GSI1SK:   botTokenPK(tok.TokenHash),
		BotToken: *tok,
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
		return fmt.Errorf("store: create bot token: %w", err)
	}
	return nil
}

// GetBotTokenByHash reads a token row strongly consistently: this is the
// authentication path, and an eventually-consistent read could honor a token
// that was just revoked.
func (s *BotStoreImpl) GetBotTokenByHash(ctx context.Context, hash string) (*model.BotToken, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.Table),
		Key:            compositeKey(botTokenPK(hash), metaSK()),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get bot token: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item botTokenItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal bot token: %w", err)
	}
	return &item.BotToken, nil
}

func (s *BotStoreImpl) ListBotTokens(ctx context.Context, botUserID string) ([]*model.BotToken, error) {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(botTokenGSI1PK(botUserID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	paginator := dynamodb.NewQueryPaginator(s.Client, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	tokens := make([]*model.BotToken, 0)
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("store: query bot tokens: %w", err)
		}
		for _, av := range page.Items {
			var item botTokenItem
			if err := attributevalue.UnmarshalMap(av, &item); err != nil {
				return nil, fmt.Errorf("store: unmarshal bot token: %w", err)
			}
			tokens = append(tokens, &item.BotToken)
		}
	}
	return tokens, nil
}

// RevokeBotToken stamps the token revoked. The condition makes it idempotent
// in the useful direction: revoking an already-revoked (or absent) token
// reports ErrNotFound rather than silently succeeding.
func (s *BotStoreImpl) RevokeBotToken(ctx context.Context, hash string, at time.Time) error {
	upd := expression.Set(expression.Name("revokedAt"), expression.Value(at))
	cond := expression.Name("PK").AttributeExists().
		And(expression.Name("revokedAt").AttributeNotExists())
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(botTokenPK(hash), metaSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: revoke bot token: %w", err)
	}
	return nil
}

func (s *BotStoreImpl) TouchBotTokenLastUsed(ctx context.Context, hash string, at time.Time) error {
	upd := expression.Set(expression.Name("lastUsedAt"), expression.Value(at))
	cond := expression.Name("PK").AttributeExists()
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(botTokenPK(hash), metaSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: touch bot token: %w", err)
	}
	return nil
}
