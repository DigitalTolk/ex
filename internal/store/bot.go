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

// Bot accounts, the users behind the Mattermost-compatible API. A bot is a
// user row like any other; what only a bot has lives here: the claim on its
// username, which keeps usernames unique, and its access tokens, each keyed by
// the SHA-256 of its secret so a request finds its token in one read.

func botUsernamePK(username string) string { return "BOTNAME#" + username }
func botTokenPK(hash string) string        { return "BOTTOKEN#" + hash }
func botTokensGSI1PK(botID string) string  { return "BOTTOKENS#" + botID }

type botUsernameItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	UserID string `dynamodbav:"userID"`
}

type botTokenItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK"`
	GSI1SK string `dynamodbav:"GSI1SK"`
	model.BotToken
}

// BotStoreImpl stores bot accounts and their tokens in DynamoDB.
type BotStoreImpl struct {
	*DB
}

// NewBotStore returns a BotStoreImpl.
func NewBotStore(db *DB) *BotStoreImpl {
	return &BotStoreImpl{DB: db}
}

// putNew is a transaction step that writes item only where nothing is.
func (s *BotStoreImpl) putNew(item any) types.TransactWriteItem {
	return types.TransactWriteItem{Put: &types.Put{
		TableName:           aws.String(s.Table),
		Item:                mustAttrs(attributevalue.MarshalMap(item)),
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	}}
}

// transact runs a bot write; conditionFailed when one of its conditions
// failed.
func (s *BotStoreImpl) transact(ctx context.Context, what string, items []types.TransactWriteItem, conditionFailed error) error {
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return conditionFailed
		}
		return fmt.Errorf("store: %s: %w", what, err)
	}
	return nil
}

// CreateBot writes a new bot account: its user row, the row mapping its email
// to it and the claim on its username, all or nothing. ErrAlreadyExists when
// any of them is taken.
func (s *BotStoreImpl) CreateBot(ctx context.Context, u *model.User) error {
	u.Email = normalizeStoredEmail(u.Email)
	return s.transact(ctx, "create bot", []types.TransactWriteItem{
		s.putNew(newUserItem(u)),
		s.putNew(userEmailItem{PK: userEmailPK(u.Email), SK: profileSK(), UserID: u.ID}),
		s.putNew(botUsernameItem{PK: botUsernamePK(u.Username), SK: metaSK(), UserID: u.ID}),
		s.noUserGroupHandled(u.Username),
	}, ErrAlreadyExists)
}

// noUserGroupHandled is a transaction step that fails while a user group holds
// username as its handle: a bot and a group never share a name.
func (s *BotStoreImpl) noUserGroupHandled(username string) types.TransactWriteItem {
	return types.TransactWriteItem{ConditionCheck: &types.ConditionCheck{
		TableName:           aws.String(s.Table),
		Key:                 compositeKey(userGroupHandlePK(username), metaSK()),
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	}}
}

// UpdateBot writes a bot's profile fields (display name, username,
// description) and nothing else, so it can't undo a status change made in the
// meantime. A new username takes its claim, and the previous one (when there
// was one) is let go. ErrAlreadyExists when the new username is taken or the
// bot is gone.
func (s *BotStoreImpl) UpdateBot(ctx context.Context, u *model.User, previousUsername string) error {
	upd := expression.
		Set(expression.Name("displayName"), expression.Value(u.DisplayName)).
		Set(expression.Name("username"), expression.Value(u.Username)).
		Set(expression.Name("botDescription"), expression.Value(u.BotDescription)).
		Set(expression.Name("updatedAt"), expression.Value(u.UpdatedAt))
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(expression.Name("PK").AttributeExists()).Build())
	items := []types.TransactWriteItem{{Update: &types.Update{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(userPK(u.ID), profileSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}}}
	if u.Username != previousUsername {
		items = append(items,
			s.putNew(botUsernameItem{PK: botUsernamePK(u.Username), SK: metaSK(), UserID: u.ID}),
			s.noUserGroupHandled(u.Username),
		)
		if previousUsername != "" {
			items = append(items, types.TransactWriteItem{Delete: &types.Delete{
				TableName: aws.String(s.Table),
				Key:       compositeKey(botUsernamePK(previousUsername), metaSK()),
			}})
		}
	}
	return s.transact(ctx, "update bot", items, ErrAlreadyExists)
}

// DeleteBot marks a bot deleted and lets its username go, both or neither.
// The row itself stays: the bot's messages keep their author. ErrNotFound when
// the bot is gone, or its username is held by another bot.
func (s *BotStoreImpl) DeleteBot(ctx context.Context, id, username string, at time.Time) error {
	upd := expression.
		Set(expression.Name("botDeletedAt"), expression.Value(at)).
		Set(expression.Name("updatedAt"), expression.Value(at)).
		Remove(expression.Name("username"))
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(expression.Name("PK").AttributeExists()).Build())
	items := []types.TransactWriteItem{{Update: &types.Update{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(userPK(id), profileSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}}}
	if username != "" {
		// A migrated bot may hold its username without a claim.
		owned := mustExpr(expression.NewBuilder().WithCondition(expression.Or(
			expression.Name("PK").AttributeNotExists(),
			expression.Name("userID").Equal(expression.Value(id)),
		)).Build())
		items = append(items, types.TransactWriteItem{Delete: &types.Delete{
			TableName:                 aws.String(s.Table),
			Key:                       compositeKey(botUsernamePK(username), metaSK()),
			ConditionExpression:       owned.Condition(),
			ExpressionAttributeNames:  owned.Names(),
			ExpressionAttributeValues: owned.Values(),
		}})
	}
	return s.transact(ctx, "delete bot", items, ErrNotFound)
}

// UsernameOwner returns the ID of the bot holding username; ErrNotFound when
// nobody does.
func (s *BotStoreImpl) UsernameOwner(ctx context.Context, username string) (string, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(botUsernamePK(username), metaSK()),
	})
	if err != nil {
		return "", fmt.Errorf("store: get bot username: %w", err)
	}
	if out.Item == nil {
		return "", ErrNotFound
	}
	var item botUsernameItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return "", fmt.Errorf("store: unmarshal bot username: %w", err)
	}
	return item.UserID, nil
}

// PutBotToken records a new token, listed under its bot oldest first.
func (s *BotStoreImpl) PutBotToken(ctx context.Context, t *model.BotToken) error {
	item := botTokenItem{
		PK:       botTokenPK(t.TokenHash),
		SK:       metaSK(),
		GSI1PK:   botTokensGSI1PK(t.BotUserID),
		GSI1SK:   t.CreatedAt.Format(time.RFC3339Nano) + "#" + t.ID,
		BotToken: *t,
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
		return fmt.Errorf("store: create bot token: %w", err)
	}
	return nil
}

// GetBotToken looks a token up by the hash of its secret; ErrNotFound when
// there is none. The read is consistent: a revoked token stops working at
// once.
func (s *BotStoreImpl) GetBotToken(ctx context.Context, hash string) (*model.BotToken, error) {
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

// ListBotTokens returns a bot's tokens, oldest first.
func (s *BotStoreImpl) ListBotTokens(ctx context.Context, botID string) ([]*model.BotToken, error) {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(botTokensGSI1PK(botID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list bot tokens: %w", err)
	}
	out := make([]*model.BotToken, 0, len(items))
	for _, raw := range items {
		var item botTokenItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal bot token: %w", err)
		}
		tok := item.BotToken
		out = append(out, &tok)
	}
	return out, nil
}

// DeleteBotToken revokes a token. Deleting one that is already gone is not an
// error.
func (s *BotStoreImpl) DeleteBotToken(ctx context.Context, hash string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(botTokenPK(hash), metaSK()),
	})
	if err != nil {
		return fmt.Errorf("store: delete bot token: %w", err)
	}
	return nil
}
