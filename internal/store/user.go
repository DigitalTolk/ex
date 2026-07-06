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

// UserStore defines operations on User entities.
type UserStore interface {
	Create(ctx context.Context, user *model.User) error
	GetByID(ctx context.Context, id string) (*model.User, error)
	GetByEmail(ctx context.Context, email string) (*model.User, error)
	Update(ctx context.Context, user *model.User) error
	List(ctx context.Context, limit int, lastKey string) ([]*model.User, string, error)
}

// UserStoreImpl implements UserStore backed by DynamoDB.
type UserStoreImpl struct {
	*DB
}

var _ UserStore = (*UserStoreImpl)(nil)

// NewUserStore returns a new UserStoreImpl.
func NewUserStore(db *DB) *UserStoreImpl {
	return &UserStoreImpl{DB: db}
}

// userItem is the DynamoDB representation of a User.
type userItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI2PK string `dynamodbav:"GSI2PK,omitempty"`
	GSI2SK string `dynamodbav:"GSI2SK,omitempty"`
	model.User
}

// userEmailItem stores the email-to-userID mapping.
type userEmailItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	UserID string `dynamodbav:"userID"`
}

func normalizeStoredEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func (s *UserStoreImpl) Create(ctx context.Context, user *model.User) error {
	user.Email = normalizeStoredEmail(user.Email)
	if existing, err := s.findByEmailScan(ctx, user.Email); err == nil {
		_ = s.ensureEmailIndex(ctx, existing.Email, existing.ID)
		return ErrAlreadyExists
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}

	item := userItem{
		PK:     userPK(user.ID),
		SK:     profileSK(),
		GSI2PK: allUsersGSI2PK(),
		GSI2SK: user.CreatedAt.Format(time.RFC3339Nano) + "#" + user.ID,
		User:   *user,
	}
	userAV := mustAttrs(attributevalue.MarshalMap(item))

	emailItem := userEmailItem{
		PK:     userEmailPK(user.Email),
		SK:     profileSK(),
		UserID: user.ID,
	}
	emailAV := mustAttrs(attributevalue.MarshalMap(emailItem))

	// Use a transaction to ensure both items are written atomically and
	// that neither the user ID nor the email already exist.
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Put: &types.Put{
					TableName:           aws.String(s.Table),
					Item:                userAV,
					ConditionExpression: aws.String("attribute_not_exists(PK)"),
				},
			},
			{
				Put: &types.Put{
					TableName:           aws.String(s.Table),
					Item:                emailAV,
					ConditionExpression: aws.String("attribute_not_exists(PK)"),
				},
			},
		},
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create user: %w", err)
	}

	return nil
}

func (s *UserStoreImpl) GetByID(ctx context.Context, id string) (*model.User, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(id), profileSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get user: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}

	var item userItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal user: %w", err)
	}
	return &item.User, nil
}

// GetUsersByIDs fetches full user profiles for many IDs in chunked BatchGetItem
// calls (100 per chunk, the DynamoDB limit) instead of N serial GetItems.
// Missing users are simply absent from the result; order is not guaranteed.
func (s *UserStoreImpl) GetUsersByIDs(ctx context.Context, ids []string) ([]*model.User, error) {
	out := make([]*model.User, 0, len(ids))
	const batchSize = 100
	for start := 0; start < len(ids); start += batchSize {
		end := min(start+batchSize, len(ids))
		keys := make([]map[string]types.AttributeValue, 0, end-start)
		for _, id := range ids[start:end] {
			keys = append(keys, compositeKey(userPK(id), profileSK()))
		}
		req := map[string]types.KeysAndAttributes{s.Table: {Keys: keys}}
		for {
			res, err := s.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: req})
			if err != nil {
				return nil, fmt.Errorf("store: batch get users: %w", err)
			}
			for _, raw := range res.Responses[s.Table] {
				var ui userItem
				if err := attributevalue.UnmarshalMap(raw, &ui); err != nil {
					return nil, fmt.Errorf("store: unmarshal user: %w", err)
				}
				u := ui.User
				out = append(out, &u)
			}
			unproc, ok := res.UnprocessedKeys[s.Table]
			if !ok || len(unproc.Keys) == 0 {
				break
			}
			req = map[string]types.KeysAndAttributes{s.Table: unproc}
		}
	}
	return out, nil
}

func (s *UserStoreImpl) GetByEmail(ctx context.Context, email string) (*model.User, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userEmailPK(email), profileSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get user email: %w", err)
	}
	if out.Item == nil {
		user, err := s.findByEmailScan(ctx, email)
		if err != nil {
			return nil, err
		}
		_ = s.ensureEmailIndex(ctx, user.Email, user.ID)
		return user, nil
	}

	var emailEntry userEmailItem
	if err := attributevalue.UnmarshalMap(out.Item, &emailEntry); err != nil {
		return nil, fmt.Errorf("store: unmarshal user email: %w", err)
	}

	return s.GetByID(ctx, emailEntry.UserID)
}

func (s *UserStoreImpl) findByEmailScan(ctx context.Context, email string) (*model.User, error) {
	normalized := strings.ToLower(strings.TrimSpace(email))
	if normalized == "" {
		return nil, ErrNotFound
	}
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allUsersGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	input := &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}
	for {
		out, err := s.Client.Query(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("store: scan users by email fallback: %w", err)
		}
		for _, raw := range out.Items {
			var item userItem
			if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
				return nil, fmt.Errorf("store: unmarshal user by email fallback: %w", err)
			}
			if strings.ToLower(strings.TrimSpace(item.Email)) == normalized {
				u := item.User
				return &u, nil
			}
		}
		if len(out.LastEvaluatedKey) == 0 {
			break
		}
		input.ExclusiveStartKey = out.LastEvaluatedKey
	}
	return nil, ErrNotFound
}

func (s *UserStoreImpl) ensureEmailIndex(ctx context.Context, email, userID string) error {
	emailAV := mustAttrs(attributevalue.MarshalMap(userEmailItem{
		PK:     userEmailPK(email),
		SK:     profileSK(),
		UserID: userID,
	}))
	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                emailAV,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: repair user email index: %w", err)
	}
	return nil
}

func (s *UserStoreImpl) Update(ctx context.Context, user *model.User) error {
	user.Email = normalizeStoredEmail(user.Email)
	item := userItem{
		PK:     userPK(user.ID),
		SK:     profileSK(),
		GSI2PK: allUsersGSI2PK(),
		GSI2SK: user.CreatedAt.Format(time.RFC3339Nano) + "#" + user.ID,
		User:   *user,
	}
	av := mustAttrs(attributevalue.MarshalMap(item))

	_, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrNotFound
		}
		return fmt.Errorf("store: update user: %w", err)
	}
	return nil
}

func (s *UserStoreImpl) List(ctx context.Context, limit int, lastKey string) ([]*model.User, string, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allUsersGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())

	input := &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		Limit:                     aws.Int32(int32(limit)),
	}

	if lastKey != "" {
		input.ExclusiveStartKey = map[string]types.AttributeValue{
			"GSI2PK": &types.AttributeValueMemberS{Value: allUsersGSI2PK()},
			"GSI2SK": &types.AttributeValueMemberS{Value: lastKey},
			"PK":     &types.AttributeValueMemberS{Value: userPK(lastKey)},
			"SK":     &types.AttributeValueMemberS{Value: profileSK()},
		}
	}

	out, err := s.Client.Query(ctx, input)
	if err != nil {
		return nil, "", fmt.Errorf("store: list users: %w", err)
	}

	users := make([]*model.User, 0, len(out.Items))
	for _, item := range out.Items {
		var ui userItem
		if err := attributevalue.UnmarshalMap(item, &ui); err != nil {
			return nil, "", fmt.Errorf("store: unmarshal user: %w", err)
		}
		users = append(users, &ui.User)
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

	return users, nextKey, nil
}

func (s *UserStoreImpl) HasUsers(ctx context.Context) (bool, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allUsersGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())

	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		Limit:                     aws.Int32(1),
	})
	if err != nil {
		return false, fmt.Errorf("store: has users: %w", err)
	}
	return len(out.Items) > 0, nil
}

// NotificationSettingsFor batch-reads the account-level notification settings
// for the supplied users in a single fan-out (chunked BatchGetItem of 100),
// projecting only the id + settings attributes. Users with no saved settings
// resolve to DefaultNotificationSettings; users with no profile row at all are
// simply absent from the returned map (the caller defaults them).
func (s *UserStoreImpl) NotificationSettingsFor(ctx context.Context, userIDs []string) (map[string]model.NotificationSettings, error) {
	out := make(map[string]model.NotificationSettings)
	const batchSize = 100 // DynamoDB BatchGetItem hard limit
	for start := 0; start < len(userIDs); start += batchSize {
		end := min(start+batchSize, len(userIDs))
		keys := make([]map[string]types.AttributeValue, 0, end-start)
		for _, uid := range userIDs[start:end] {
			keys = append(keys, compositeKey(userPK(uid), profileSK()))
		}
		req := map[string]types.KeysAndAttributes{
			s.Table: {
				Keys:                     keys,
				ProjectionExpression:     aws.String("#id, #ns"),
				ExpressionAttributeNames: map[string]string{"#id": "id", "#ns": "notificationSettings"},
			},
		}
		for {
			res, err := s.Client.BatchGetItem(ctx, &dynamodb.BatchGetItemInput{RequestItems: req})
			if err != nil {
				return nil, fmt.Errorf("store: batch get notification settings: %w", err)
			}
			for _, item := range res.Responses[s.Table] {
				var row struct {
					ID       string                      `dynamodbav:"id"`
					Settings *model.NotificationSettings `dynamodbav:"notificationSettings"`
				}
				if err := attributevalue.UnmarshalMap(item, &row); err != nil {
					return nil, fmt.Errorf("store: unmarshal notification settings row: %w", err)
				}
				if row.ID == "" {
					continue
				}
				if row.Settings != nil {
					out[row.ID] = *row.Settings
				} else {
					out[row.ID] = model.DefaultNotificationSettings()
				}
			}
			unproc, ok := res.UnprocessedKeys[s.Table]
			if !ok || len(unproc.Keys) == 0 {
				break
			}
			req = map[string]types.KeysAndAttributes{s.Table: unproc}
		}
	}
	return out, nil
}

// compositeKey builds a DynamoDB key map from PK and SK strings.
func compositeKey(pk, sk string) map[string]types.AttributeValue {
	return map[string]types.AttributeValue{
		"PK": &types.AttributeValueMemberS{Value: pk},
		"SK": &types.AttributeValueMemberS{Value: sk},
	}
}

// isConditionCheckFailed returns true if the error is a DynamoDB conditional check failure.
func isConditionCheckFailed(err error) bool {
	var ccf *types.ConditionalCheckFailedException
	return isErrorType(err, &ccf)
}

// isTransactionCancelledWithCondition returns true if the error is a transaction
// cancellation where at least one reason is a conditional check failure.
func isTransactionCancelledWithCondition(err error) bool {
	var tce *types.TransactionCanceledException
	if isErrorType(err, &tce) {
		for _, reason := range tce.CancellationReasons {
			if reason.Code != nil && *reason.Code == "ConditionalCheckFailed" {
				return true
			}
		}
	}
	return false
}

// isErrorType is a generic helper for errors.As with typed pointers.
func isErrorType[T error](err error, target *T) bool {
	return errors.As(err, target)
}
