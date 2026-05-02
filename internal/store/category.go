package store

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/DigitalTolk/ex/internal/model"
)

// CategoryStore manages user-defined sidebar categories — small per-user
// groupings that the frontend uses to lay out the channels list.
type CategoryStore interface {
	Create(ctx context.Context, c *model.UserChannelCategory) error
	Get(ctx context.Context, userID, categoryID string) (*model.UserChannelCategory, error)
	List(ctx context.Context, userID string) ([]*model.UserChannelCategory, error)
	Update(ctx context.Context, c *model.UserChannelCategory) error
	Delete(ctx context.Context, userID, categoryID string) error
}

// CategoryStoreImpl is the DynamoDB-backed implementation of CategoryStore.
type CategoryStoreImpl struct {
	*DB
}

var _ CategoryStore = (*CategoryStoreImpl)(nil)

// NewCategoryStore returns a new CategoryStoreImpl.
func NewCategoryStore(db *DB) *CategoryStoreImpl {
	return &CategoryStoreImpl{DB: db}
}

type categoryItem struct {
	PK string
	SK string
	model.UserChannelCategory
}

type categoryNameItem struct {
	PK         string
	SK         string
	CategoryID string `dynamodbav:"categoryID"`
}

func (s *CategoryStoreImpl) Create(ctx context.Context, c *model.UserChannelCategory) error {
	if c == nil || c.UserID == "" || c.ID == "" {
		return errors.New("store: category requires UserID and ID")
	}
	item := categoryItem{
		PK:                  userPK(c.UserID),
		SK:                  categorySK(c.ID),
		UserChannelCategory: *c,
	}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal category: %w", err)
	}
	nameAV, err := attributevalue.MarshalMap(categoryNameItem{
		PK:         userPK(c.UserID),
		SK:         categoryNameSK(c.Name),
		CategoryID: c.ID,
	})
	if err != nil {
		return fmt.Errorf("store: marshal category name: %w", err)
	}
	_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Put: &types.Put{
					TableName:           aws.String(s.Table),
					Item:                av,
					ConditionExpression: aws.String("attribute_not_exists(PK)"),
				},
			},
			{
				Put: &types.Put{
					TableName:           aws.String(s.Table),
					Item:                nameAV,
					ConditionExpression: aws.String("attribute_not_exists(PK)"),
				},
			},
		},
	})
	if err != nil {
		if isConditionCheckFailed(err) || isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create category: %w", err)
	}
	return nil
}

func (s *CategoryStoreImpl) Get(ctx context.Context, userID, categoryID string) (*model.UserChannelCategory, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(userPK(userID), categorySK(categoryID)),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get category: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item categoryItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal category: %w", err)
	}
	return &item.UserChannelCategory, nil
}

func (s *CategoryStoreImpl) List(ctx context.Context, userID string) ([]*model.UserChannelCategory, error) {
	keyCond := expression.KeyAnd(
		expression.Key("PK").Equal(expression.Value(userPK(userID))),
		expression.Key("SK").BeginsWith("CATEGORY#"),
	)
	expr, err := expression.NewBuilder().WithKeyCondition(keyCond).Build()
	if err != nil {
		return nil, fmt.Errorf("store: build categories expression: %w", err)
	}
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list categories: %w", err)
	}
	cats := make([]*model.UserChannelCategory, 0, len(out.Items))
	for _, raw := range out.Items {
		var item categoryItem
		if err := attributevalue.UnmarshalMap(raw, &item); err != nil {
			continue
		}
		c := item.UserChannelCategory
		cats = append(cats, &c)
	}
	// Sort by Position ASC, ID ASC (stable tiebreaker) so the frontend
	// renders sections in a deterministic order without an extra index.
	sort.SliceStable(cats, func(i, j int) bool {
		if cats[i].Position != cats[j].Position {
			return cats[i].Position < cats[j].Position
		}
		return cats[i].ID < cats[j].ID
	})
	return cats, nil
}

func (s *CategoryStoreImpl) Update(ctx context.Context, c *model.UserChannelCategory) error {
	if c == nil || c.UserID == "" || c.ID == "" {
		return errors.New("store: category requires UserID and ID")
	}
	existing, err := s.Get(ctx, c.UserID, c.ID)
	if err != nil {
		return err
	}
	upd := expression.
		Set(expression.Name("name"), expression.Value(c.Name)).
		Set(expression.Name("position"), expression.Value(c.Position))
	expr, err := expression.NewBuilder().WithUpdate(upd).Build()
	if err != nil {
		return fmt.Errorf("store: build category update: %w", err)
	}
	if normalizeCategoryName(existing.Name) == normalizeCategoryName(c.Name) {
		_, err = s.Client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
			TableName:                 aws.String(s.Table),
			Key:                       compositeKey(userPK(c.UserID), categorySK(c.ID)),
			UpdateExpression:          expr.Update(),
			ExpressionAttributeNames:  expr.Names(),
			ExpressionAttributeValues: expr.Values(),
			ConditionExpression:       aws.String("attribute_exists(PK)"),
		})
		if err != nil {
			if isConditionCheckFailed(err) {
				return ErrNotFound
			}
			return fmt.Errorf("store: update category: %w", err)
		}
		return nil
	}

	nameAV, err := attributevalue.MarshalMap(categoryNameItem{
		PK:         userPK(c.UserID),
		SK:         categoryNameSK(c.Name),
		CategoryID: c.ID,
	})
	if err != nil {
		return fmt.Errorf("store: marshal category name: %w", err)
	}
	_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Put: &types.Put{
					TableName:           aws.String(s.Table),
					Item:                nameAV,
					ConditionExpression: aws.String("attribute_not_exists(PK)"),
				},
			},
			{
				Update: &types.Update{
					TableName:                 aws.String(s.Table),
					Key:                       compositeKey(userPK(c.UserID), categorySK(c.ID)),
					UpdateExpression:          expr.Update(),
					ExpressionAttributeNames:  expr.Names(),
					ExpressionAttributeValues: expr.Values(),
					ConditionExpression:       aws.String("attribute_exists(PK)"),
				},
			},
			{
				Delete: &types.Delete{
					TableName: aws.String(s.Table),
					Key:       compositeKey(userPK(c.UserID), categoryNameSK(existing.Name)),
				},
			},
		},
	})
	if err != nil {
		if isTransactionCancelledWithCondition(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: update category: %w", err)
	}
	return nil
}

func (s *CategoryStoreImpl) Delete(ctx context.Context, userID, categoryID string) error {
	existing, err := s.Get(ctx, userID, categoryID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	_, err = s.Client.TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
		TransactItems: []types.TransactWriteItem{
			{
				Delete: &types.Delete{
					TableName: aws.String(s.Table),
					Key:       compositeKey(userPK(userID), categorySK(categoryID)),
				},
			},
			{
				Delete: &types.Delete{
					TableName: aws.String(s.Table),
					Key:       compositeKey(userPK(userID), categoryNameSK(existing.Name)),
				},
			},
		},
	})
	if err != nil {
		return fmt.Errorf("store: delete category: %w", err)
	}
	return nil
}

func normalizeCategoryName(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}
