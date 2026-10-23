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
	CreateUser(ctx context.Context, user *model.User) error
	GetUser(ctx context.Context, id string) (*model.User, error)
	GetUserByEmail(ctx context.Context, email string) (*model.User, error)
	UpdateUser(ctx context.Context, user *model.User) error
	PatchUser(ctx context.Context, id string, p UserPatch) error
	ListUsers(ctx context.Context, limit int, lastKey string) ([]*model.User, string, error)
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

func (s *UserStoreImpl) CreateUser(ctx context.Context, user *model.User) error {
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

func (s *UserStoreImpl) GetUser(ctx context.Context, id string) (*model.User, error) {
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
	keys := make([]map[string]types.AttributeValue, len(ids))
	for i, id := range ids {
		keys[i] = compositeKey(userPK(id), profileSK())
	}
	rows, err := batchGetOf[userItem](ctx, s.DB, keys, types.KeysAndAttributes{}, "users")
	if err != nil {
		return nil, err
	}
	out := make([]*model.User, len(rows))
	for i := range rows {
		out[i] = &rows[i].User
	}
	return out, nil
}

func (s *UserStoreImpl) GetUserByEmail(ctx context.Context, email string) (*model.User, error) {
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

	return s.GetUser(ctx, emailEntry.UserID)
}

func (s *UserStoreImpl) findByEmailScan(ctx context.Context, email string) (*model.User, error) {
	normalized := strings.ToLower(strings.TrimSpace(email))
	if normalized == "" {
		return nil, ErrNotFound
	}
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allUsersGSI2PK()))
	// Project only id + email while walking the all-users partition: GSI2
	// projects ALL, so an unprojected fallback hydrated every full profile
	// just to keep one. The match resolves through GetByID afterwards.
	proj := expression.NamesList(expression.Name("id"), expression.Name("email"))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).WithProjection(proj).Build())
	input := &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ProjectionExpression:      expr.Projection(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}
	for {
		out, err := s.Client.Query(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("store: scan users by email fallback: %w", err)
		}
		for _, raw := range out.Items {
			var item struct {
				ID    string `dynamodbav:"id"`
				Email string `dynamodbav:"email"`
			}
			if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
				return nil, fmt.Errorf("store: unmarshal user by email fallback: %w", err)
			}
			if strings.ToLower(strings.TrimSpace(item.Email)) == normalized {
				return s.GetUser(ctx, item.ID)
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

func (s *UserStoreImpl) UpdateUser(ctx context.Context, user *model.User) error {
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

// ErrIdentityBound reports a PatchUser whose ExpectOIDCSubject no longer
// matches: the account was bound to another identity in the meantime.
var ErrIdentityBound = errors.New("store: account is bound to a different identity")

// UserPatch is a field-level user update. Only the non-nil fields are
// written — each with UpdateItem SET, or REMOVE for an emptied optional
// attribute — so a writer can't clobber a field it never meant to touch.
// The read-then-full-PutItem UpdateUser could: a refresh that read the user
// a moment before an admin deactivated (or demoted) them wrote the old
// status/role straight back.
type UserPatch struct {
	DisplayName  *string
	TimeZone     *string
	SystemRole   *model.SystemRole
	Status       *string
	AuthProvider *model.AuthProvider
	// PasswordHash "" removes the stored hash.
	PasswordHash *string
	LastSeenAt   *time.Time
	MSObjectID   *string
	OIDCIssuer   *string
	OIDCSubject  *string
	// ExpectOIDCSubject makes the write a compare-and-swap on the bound
	// identity: it applies only while the stored subject still equals this
	// value ("" = not bound yet), so two logins racing to bind different
	// identities can't both win — the loser gets ErrIdentityBound.
	ExpectOIDCSubject *string
	// DeactivatedBy records who deactivated the account ("" clears it).
	DeactivatedBy *string
	// Directory writes the directory-owned attributes (phone + manager)
	// together.
	Directory *UserDirectoryFields
	// UpdatedAt is written when non-zero.
	UpdatedAt time.Time
}

// UserDirectoryFields are the directory-synced profile attributes.
type UserDirectoryFields struct {
	Phone   string
	Manager *model.UserManager
}

// PatchUser applies p to the existing user id (ErrNotFound when there is
// none). An empty patch writes nothing.
func (s *UserStoreImpl) PatchUser(ctx context.Context, id string, p UserPatch) error {
	var upd expression.UpdateBuilder
	ops := 0
	set := func(name string, v any) {
		upd = upd.Set(expression.Name(name), expression.Value(v))
		ops++
	}
	setOrRemove := func(name, v string) {
		if v == "" {
			upd = upd.Remove(expression.Name(name))
			ops++
			return
		}
		set(name, v)
	}
	if p.DisplayName != nil {
		set("displayName", *p.DisplayName)
	}
	if p.TimeZone != nil {
		setOrRemove("timeZone", *p.TimeZone)
	}
	if p.SystemRole != nil {
		set("systemRole", *p.SystemRole)
	}
	if p.Status != nil {
		set("status", *p.Status)
	}
	if p.AuthProvider != nil {
		setOrRemove("authProvider", string(*p.AuthProvider))
	}
	if p.PasswordHash != nil {
		setOrRemove("passwordHash", *p.PasswordHash)
	}
	if p.LastSeenAt != nil {
		set("lastSeenAt", *p.LastSeenAt)
	}
	if p.MSObjectID != nil {
		setOrRemove("msObjectID", *p.MSObjectID)
	}
	if p.OIDCIssuer != nil {
		setOrRemove("oidcIssuer", *p.OIDCIssuer)
	}
	if p.OIDCSubject != nil {
		setOrRemove("oidcSubject", *p.OIDCSubject)
	}
	if p.DeactivatedBy != nil {
		setOrRemove("deactivatedBy", *p.DeactivatedBy)
	}
	if p.Directory != nil {
		setOrRemove("phone", p.Directory.Phone)
		if p.Directory.Manager == nil {
			upd = upd.Remove(expression.Name("manager"))
		} else {
			upd = upd.Set(expression.Name("manager"), expression.Value(p.Directory.Manager))
		}
	}
	if !p.UpdatedAt.IsZero() {
		set("updatedAt", p.UpdatedAt)
	}
	if ops == 0 {
		return nil
	}
	cond := expression.Name("PK").AttributeExists()
	if p.ExpectOIDCSubject != nil {
		if *p.ExpectOIDCSubject == "" {
			cond = cond.And(expression.Name("oidcSubject").AttributeNotExists())
		} else {
			cond = cond.And(expression.Name("oidcSubject").Equal(expression.Value(*p.ExpectOIDCSubject)))
		}
	}
	expr := mustExpr(expression.NewBuilder().WithUpdate(upd).WithCondition(cond).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(userPK(id), profileSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			if p.ExpectOIDCSubject != nil {
				return ErrIdentityBound
			}
			return ErrNotFound
		}
		return fmt.Errorf("store: patch user: %w", err)
	}
	return nil
}

func (s *UserStoreImpl) ListUsers(ctx context.Context, limit int, lastKey string) ([]*model.User, string, error) {
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
		// lastKey is the last item's GSI2SK ("<createdAt>#<userID>"); the
		// start key must also carry that item's real table key, or DynamoDB
		// cannot position after it and restarts from the first page.
		lastID := lastKey[strings.LastIndex(lastKey, "#")+1:]
		input.ExclusiveStartKey = map[string]types.AttributeValue{
			"GSI2PK": &types.AttributeValueMemberS{Value: allUsersGSI2PK()},
			"GSI2SK": &types.AttributeValueMemberS{Value: lastKey},
			"PK":     &types.AttributeValueMemberS{Value: userPK(lastID)},
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

// ClearUserStatusIfExpired atomically removes a user's status ONLY while it
// still carries the clearAt the sweeper observed — a user who set a fresh
// status between the sweep's list read and this write keeps it (conditional
// failure returns false). Replaces the sweeper's read-then-full-Put pair with
// one surgical write.
func (s *UserStoreImpl) ClearUserStatusIfExpired(ctx context.Context, userID string, seenClearAt time.Time, now time.Time) (bool, error) {
	update := expression.Remove(expression.Name("userStatus")).
		Set(expression.Name("updatedAt"), expression.Value(now))
	cond := expression.Name("userStatus.clearAt").Equal(expression.Value(seenClearAt))
	expr := mustExpr(expression.NewBuilder().WithUpdate(update).WithCondition(cond).Build())
	_, err := s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName:                 aws.String(s.Table),
		Key:                       compositeKey(userPK(userID), profileSK()),
		UpdateExpression:          expr.Update(),
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return false, nil // status changed since the sweep observed it
		}
		return false, fmt.Errorf("store: clear expired user status: %w", err)
	}
	return true, nil
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
		// Existence only — COUNT skips hydrating a full profile item off the
		// ALL-projected GSI.
		Select: types.SelectCount,
	})
	if err != nil {
		return false, fmt.Errorf("store: has users: %w", err)
	}
	return out.Count > 0, nil
}

// NotificationAccount is what the notification fan-out reads per recipient.
type NotificationAccount struct {
	Settings model.NotificationSettings
	// Machine marks a bot or agent account: nobody reads its activity stream.
	Machine bool
}

// NotificationAccountsFor batch-reads the account-level notification settings
// and machine flags for the supplied users in a single fan-out (chunked
// BatchGetItem of 100), projecting only the attributes it needs. Users with no
// saved settings resolve to DefaultNotificationSettings; users with no profile
// row at all are simply absent from the returned map (the caller defaults
// them).
func (s *UserStoreImpl) NotificationAccountsFor(ctx context.Context, userIDs []string) (map[string]NotificationAccount, error) {
	keys := make([]map[string]types.AttributeValue, len(userIDs))
	for i, uid := range userIDs {
		keys[i] = compositeKey(userPK(uid), profileSK())
	}
	type settingsRow struct {
		ID       string                      `dynamodbav:"id"`
		Settings *model.NotificationSettings `dynamodbav:"notificationSettings"`
		IsBot    bool                        `dynamodbav:"isBot"`
		Kind     model.UserKind              `dynamodbav:"kind"`
	}
	rows, err := batchGetOf[settingsRow](ctx, s.DB, keys, types.KeysAndAttributes{
		// Consistent: the notification audience cache keeps what it reads, so a
		// settings change made a moment earlier must be seen.
		ConsistentRead:           aws.Bool(true),
		ProjectionExpression:     aws.String("#id, #ns, #bot, #kind"),
		ExpressionAttributeNames: map[string]string{"#id": "id", "#ns": "notificationSettings", "#bot": "isBot", "#kind": "kind"},
	}, "notification settings")
	if err != nil {
		return nil, err
	}
	out := make(map[string]NotificationAccount, len(rows))
	for _, row := range rows {
		if row.ID == "" {
			continue
		}
		acct := NotificationAccount{Settings: model.DefaultNotificationSettings(), Machine: row.IsBot || row.Kind == model.UserKindAgent}
		if row.Settings != nil {
			acct.Settings = *row.Settings
		}
		out[row.ID] = acct
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
