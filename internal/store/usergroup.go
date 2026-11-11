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

// User groups. A group is a row (listed through GSI2) and a row per member,
// written on both sides like channel memberships: under the group
// (USERGROUP#<id>, MEMBER#<user>) for its member list and under the user
// (USER#<user>, UGROUP#<id>) for the groups a user is in. Claim rows keep
// handles and linked Entra groups unique. A handle may not equal a bot
// username either: both stores check the other's claim in the same
// transaction.

func userGroupPK(id string) string           { return "USERGROUP#" + id }
func userGroupSK(id string) string           { return "UGROUP#" + id }
func userGroupHandlePK(handle string) string { return "UGHANDLE#" + handle }
func entraGroupClaimPK(id string) string     { return "ENTRAGROUP#" + id }
func allUserGroupsGSI2PK() string            { return "ALL_USERGROUPS" }

// ErrUserGroupChanged is returned when a group write expected a version the
// group no longer has (a concurrent edit won) or the group is gone.
var ErrUserGroupChanged = errors.New("store: user group changed concurrently")

// ErrEntraGroupLinked is returned when the Entra group a write links is
// already linked to another user group: one Entra group feeds one group.
var ErrEntraGroupLinked = errors.New("store: entra group already linked")

// claimKind names what one transaction step guards, so a cancelled
// transaction reports which condition failed.
type claimKind int

const (
	claimRow claimKind = iota
	claimHandle
	claimEntra
	claimOther
)

// transactGroup runs a group transaction, mapping a failed condition to the
// error of the step that failed: the row's version (ErrUserGroupChanged), the
// Entra claim (ErrEntraGroupLinked), or the handle claim or a bot's username
// (ErrAlreadyExists).
func (s *UserGroupStoreImpl) transactGroup(ctx context.Context, what string, items []types.TransactWriteItem, kinds []claimKind) error {
	_, err := s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{TransactItems: items})
	if err == nil {
		return nil
	}
	var tce *types.TransactionCanceledException
	if errors.As(err, &tce) {
		for i, reason := range tce.CancellationReasons {
			if reason.Code == nil || *reason.Code != "ConditionalCheckFailed" || i >= len(kinds) {
				continue
			}
			switch kinds[i] {
			case claimRow:
				return ErrUserGroupChanged
			case claimEntra:
				return ErrEntraGroupLinked
			default:
				return ErrAlreadyExists
			}
		}
	}
	return fmt.Errorf("store: %s: %w", what, err)
}

func (s *UserGroupStoreImpl) claimEntraGroup(entraID, groupID string) types.TransactWriteItem {
	return s.putNew(userGroupHandleItem{PK: entraGroupClaimPK(entraID), SK: metaSK(), GroupID: groupID})
}

func (s *UserGroupStoreImpl) deleteItem(pk string) types.TransactWriteItem {
	return types.TransactWriteItem{Delete: &types.Delete{
		TableName: aws.String(s.Table),
		Key:       compositeKey(pk, metaSK()),
	}}
}

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

// CreateUserGroup writes a new group row (version 1), the claim on its handle
// and the claim on its Entra group — all or nothing. Members are written
// with ApplyUserGroupMembers.
// ErrAlreadyExists when the handle is taken by a group or a bot;
// ErrEntraGroupLinked when the Entra group is linked elsewhere.
func (s *UserGroupStoreImpl) CreateUserGroup(ctx context.Context, g *model.UserGroupDetail) error {
	g.Version = 1
	items := []types.TransactWriteItem{
		s.putNew(newUserGroupItem(g)),
		s.putNew(userGroupHandleItem{PK: userGroupHandlePK(g.Handle), SK: metaSK(), GroupID: g.ID}),
		s.noBotNamed(g.Handle),
	}
	kinds := []claimKind{claimOther, claimHandle, claimHandle}
	if g.EntraGroupID != "" {
		items = append(items, s.claimEntraGroup(g.EntraGroupID, g.ID))
		kinds = append(kinds, claimEntra)
	}
	return s.transactGroup(ctx, "create user group", items, kinds)
}

// UpdateUserGroup replaces a group's row when it still has the version of
// previous (the row as read), and bumps g.Version. A changed handle or Entra
// link moves its claim in the same transaction. ErrUserGroupChanged when the
// group moved on (or is gone); ErrAlreadyExists when the new handle is taken;
// ErrEntraGroupLinked when the new Entra group is linked elsewhere.
func (s *UserGroupStoreImpl) UpdateUserGroup(ctx context.Context, g, previous *model.UserGroupDetail) error {
	g.Version = previous.Version + 1
	cond := mustExpr(expression.NewBuilder().WithCondition(
		expression.Name("version").Equal(expression.Value(previous.Version)),
	).Build())
	items := []types.TransactWriteItem{{Put: &types.Put{
		TableName:                 aws.String(s.Table),
		Item:                      mustAttrs(attributevalue.MarshalMap(newUserGroupItem(g))),
		ConditionExpression:       cond.Condition(),
		ExpressionAttributeNames:  cond.Names(),
		ExpressionAttributeValues: cond.Values(),
	}}}
	kinds := []claimKind{claimRow}
	if g.Handle != previous.Handle {
		items = append(items,
			s.putNew(userGroupHandleItem{PK: userGroupHandlePK(g.Handle), SK: metaSK(), GroupID: g.ID}),
			s.noBotNamed(g.Handle),
			s.deleteItem(userGroupHandlePK(previous.Handle)),
		)
		kinds = append(kinds, claimHandle, claimHandle, claimOther)
	}
	if g.EntraGroupID != previous.EntraGroupID {
		if g.EntraGroupID != "" {
			items = append(items, s.claimEntraGroup(g.EntraGroupID, g.ID))
			kinds = append(kinds, claimEntra)
		}
		if previous.EntraGroupID != "" {
			items = append(items, s.deleteItem(entraGroupClaimPK(previous.EntraGroupID)))
			kinds = append(kinds, claimOther)
		}
	}
	if err := s.transactGroup(ctx, "update user group", items, kinds); err != nil {
		g.Version = previous.Version
		return err
	}
	return nil
}

// GetUserGroup reads one group's row (no members), strongly consistent.
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

// GetUserGroups reads the rows (no members) of the groups with these IDs,
// strongly consistent. Unknown IDs are absent; order is not guaranteed.
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

// ListUserGroups returns every group's row (no members), disabled ones
// included, by handle.
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

type userGroupMemberItem struct {
	PK      string `dynamodbav:"PK"`
	SK      string `dynamodbav:"SK"`
	UserID  string `dynamodbav:"userID"`
	GroupID string `dynamodbav:"groupID"`
}

func userGroupMemberItems(groupID, userID string) []userGroupMemberItem {
	return []userGroupMemberItem{
		{PK: userGroupPK(groupID), SK: memberSK(userID), UserID: userID, GroupID: groupID},
		{PK: userPK(userID), SK: userGroupSK(groupID), UserID: userID, GroupID: groupID},
	}
}

// ApplyUserGroupMembers adds and removes members, writing both sides of each
// membership in batches. Writes are idempotent (re-adding a member or
// removing a non-member changes nothing), so a run cut short is completed by
// the next one.
func (s *UserGroupStoreImpl) ApplyUserGroupMembers(ctx context.Context, groupID string, add, remove []string) error {
	puts := make([]map[string]types.AttributeValue, 0, 2*len(add))
	for _, uid := range add {
		for _, it := range userGroupMemberItems(groupID, uid) {
			puts = append(puts, mustAttrs(attributevalue.MarshalMap(it)))
		}
	}
	if err := s.putAll(ctx, puts); err != nil {
		return fmt.Errorf("store: add user group members: %w", err)
	}
	keys := make([]map[string]types.AttributeValue, 0, 2*len(remove))
	for _, uid := range remove {
		for _, it := range userGroupMemberItems(groupID, uid) {
			keys = append(keys, compositeKey(it.PK, it.SK))
		}
	}
	if err := s.deleteAll(ctx, keys); err != nil {
		return fmt.Errorf("store: remove user group members: %w", err)
	}
	return nil
}

// UserGroupMemberIDs lists a group's members, strongly consistent: a sync
// diffs against it and a mention alerts it.
func (s *UserGroupStoreImpl) UserGroupMemberIDs(ctx context.Context, groupID string) ([]string, error) {
	items, err := s.queryPartition(ctx, userGroupPK(groupID), "MEMBER#", "user group members")
	if err != nil {
		return nil, err
	}
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.UserID
	}
	return out, nil
}

// UserGroupIDsForUser lists the groups a user is a member of, strongly
// consistent.
func (s *UserGroupStoreImpl) UserGroupIDsForUser(ctx context.Context, userID string) ([]string, error) {
	items, err := s.queryPartition(ctx, userPK(userID), "UGROUP#", "user's groups")
	if err != nil {
		return nil, err
	}
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.GroupID
	}
	return out, nil
}

func (s *UserGroupStoreImpl) queryPartition(ctx context.Context, pk, skPrefix, what string) ([]userGroupMemberItem, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(pk)),
		expression.Key("SK").BeginsWith(skPrefix),
	)
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	return queryAllOf[userGroupMemberItem](ctx, s.DB, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		ConsistentRead:            aws.Bool(true),
	}, what)
}
