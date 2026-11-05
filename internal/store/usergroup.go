package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// User groups. A group is one row holding its members (at most
// limits.MaxUserGroupMembers, so they fit one item and every membership
// change is a single conditional write), listed through GSI2, plus a claim
// row on its handle that keeps handles unique. A handle may not equal a bot
// username either: both stores check the other's claim in the same
// transaction.

func userGroupPK(id string) string           { return "USERGROUP#" + id }
func userGroupHandlePK(handle string) string { return "UGHANDLE#" + handle }
func allUserGroupsGSI2PK() string            { return "ALL_USERGROUPS" }

// ErrUserGroupChanged is returned when a group write expected a version the
// group no longer has (a concurrent edit won) or the group is gone.
var ErrUserGroupChanged = errors.New("store: user group changed concurrently")

type userGroupItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI2PK string `dynamodbav:"GSI2PK"`
	GSI2SK string `dynamodbav:"GSI2SK"`
	model.UserGroupDetail
}

type userGroupHandleItem struct {
	PK      string `dynamodbav:"PK"`
	SK      string `dynamodbav:"SK"`
	GroupID string `dynamodbav:"groupID"`
}

func newUserGroupItem(g *model.UserGroupDetail) userGroupItem {
	return userGroupItem{
		PK:              userGroupPK(g.ID),
		SK:              metaSK(),
		GSI2PK:          allUserGroupsGSI2PK(),
		GSI2SK:          g.Handle,
		UserGroupDetail: *g,
	}
}

// UserGroupStoreImpl stores user groups in DynamoDB.
type UserGroupStoreImpl struct {
	*DB
}

// NewUserGroupStore returns a UserGroupStoreImpl.
func NewUserGroupStore(db *DB) *UserGroupStoreImpl {
	return &UserGroupStoreImpl{DB: db}
}

func (s *UserGroupStoreImpl) putNew(item any) types.TransactWriteItem {
	return types.TransactWriteItem{Put: &types.Put{
		TableName:           aws.String(s.Table),
		Item:                mustAttrs(attributevalue.MarshalMap(item)),
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	}}
}

// noBotNamed is a transaction step that fails while a bot holds handle as its
// username.
func (s *UserGroupStoreImpl) noBotNamed(handle string) types.TransactWriteItem {
	return types.TransactWriteItem{ConditionCheck: &types.ConditionCheck{
		TableName:           aws.String(s.Table),
		Key:                 compositeKey(botUsernamePK(handle), metaSK()),
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	}}
}

// CreateUserGroup writes a new group (version 1) and the claim on its handle,
// all or nothing. ErrAlreadyExists when the handle is taken by a group or a
// bot.
func (s *UserGroupStoreImpl) CreateUserGroup(ctx context.Context, g *model.UserGroupDetail) error {
	g.Version = 1
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: []types.TransactWriteItem{
		s.putNew(newUserGroupItem(g)),
		s.putNew(userGroupHandleItem{PK: userGroupHandlePK(g.Handle), SK: metaSK(), GroupID: g.ID}),
		s.noBotNamed(g.Handle),
	}})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create user group: %w", err)
	}
	return nil
}

// UpdateUserGroup replaces a group's row when it still has expectedVersion,
// and bumps g.Version. A changed handle takes its new claim and lets go of
// previousHandle in the same transaction. ErrUserGroupChanged when the group
// moved on (or is gone); ErrAlreadyExists when the new handle is taken.
func (s *UserGroupStoreImpl) UpdateUserGroup(ctx context.Context, g *model.UserGroupDetail, previousHandle string, expectedVersion int64) error {
	g.Version = expectedVersion + 1
	cond := mustExpr(expression.NewBuilder().WithCondition(
		expression.Name("version").Equal(expression.Value(expectedVersion)),
	).Build())
	items := []types.TransactWriteItem{{Put: &types.Put{
		TableName:                 aws.String(s.Table),
		Item:                      mustAttrs(attributevalue.MarshalMap(newUserGroupItem(g))),
		ConditionExpression:       cond.Condition(),
		ExpressionAttributeNames:  cond.Names(),
		ExpressionAttributeValues: cond.Values(),
	}}}
	if g.Handle != previousHandle {
		items = append(items,
			s.putNew(userGroupHandleItem{PK: userGroupHandlePK(g.Handle), SK: metaSK(), GroupID: g.ID}),
			s.noBotNamed(g.Handle),
			types.TransactWriteItem{Delete: &types.Delete{
				TableName: aws.String(s.Table),
				Key:       compositeKey(userGroupHandlePK(previousHandle), metaSK()),
			}},
		)
	}
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
	if err == nil {
		return nil
	}
	g.Version = expectedVersion
	var tce *types.TransactionCanceledException
	if errors.As(err, &tce) && len(tce.CancellationReasons) > 0 {
		if code := tce.CancellationReasons[0].Code; code != nil && *code == "ConditionalCheckFailed" {
			return ErrUserGroupChanged
		}
		if isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
	}
	return fmt.Errorf("store: update user group: %w", err)
}

// GetUserGroup reads one group, strongly consistent: membership read right
// after a write must see it.
func (s *UserGroupStoreImpl) GetUserGroup(ctx context.Context, id string) (*model.UserGroupDetail, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.Table),
		Key:            compositeKey(userGroupPK(id), metaSK()),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get user group: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item userGroupItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal user group: %w", err)
	}
	return &item.UserGroupDetail, nil
}

// GetUserGroups reads the groups with these IDs, strongly consistent. Unknown
// IDs are absent; order is not guaranteed.
func (s *UserGroupStoreImpl) GetUserGroups(ctx context.Context, ids []string) ([]*model.UserGroupDetail, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	seen := make(map[string]bool, len(ids))
	keys := make([]map[string]types.AttributeValue, 0, len(ids))
	for _, id := range ids {
		if !seen[id] {
			seen[id] = true
			keys = append(keys, compositeKey(userGroupPK(id), metaSK()))
		}
	}
	rows, err := batchGetOf[userGroupItem](ctx, s.DB, keys, types.KeysAndAttributes{ConsistentRead: aws.Bool(true)}, "user groups")
	if err != nil {
		return nil, err
	}
	out := make([]*model.UserGroupDetail, 0, len(rows))
	for i := range rows {
		out = append(out, &rows[i].UserGroupDetail)
	}
	return out, nil
}

// ListUserGroups returns every group, disabled ones included, by handle.
func (s *UserGroupStoreImpl) ListUserGroups(ctx context.Context) ([]*model.UserGroupDetail, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allUserGroupsGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := queryAllOf[userGroupItem](ctx, s.DB, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}, "user groups")
	if err != nil {
		return nil, err
	}
	out := make([]*model.UserGroupDetail, 0, len(items))
	for i := range items {
		out = append(out, &items[i].UserGroupDetail)
	}
	return out, nil
}

// UserGroupHandleOwner returns the ID of the group holding handle;
// ErrNotFound when no group does.
func (s *UserGroupStoreImpl) UserGroupHandleOwner(ctx context.Context, handle string) (string, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName:      aws.String(s.Table),
		Key:            compositeKey(userGroupHandlePK(handle), metaSK()),
		ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return "", fmt.Errorf("store: get user group handle: %w", err)
	}
	if out.Item == nil {
		return "", ErrNotFound
	}
	var item userGroupHandleItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return "", fmt.Errorf("store: unmarshal user group handle: %w", err)
	}
	return item.GroupID, nil
}
