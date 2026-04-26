package store

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/DigitalTolk/ex/internal/model"
)

// InviteStore defines operations on Invite entities.
type InviteStore interface {
	Create(ctx context.Context, invite *model.Invite) error
	GetByToken(ctx context.Context, token string) (*model.Invite, error)
	Delete(ctx context.Context, token string) error
}

// InviteStoreImpl implements InviteStore backed by DynamoDB.
type InviteStoreImpl struct {
	*DB
}

var _ InviteStore = (*InviteStoreImpl)(nil)

// NewInviteStore returns a new InviteStoreImpl.
func NewInviteStore(db *DB) *InviteStoreImpl {
	return &InviteStoreImpl{DB: db}
}

// inviteItem is the DynamoDB representation of an Invite.
type inviteItem struct {
	PK  string `dynamodbav:"PK"`
	SK  string `dynamodbav:"SK"`
	TTL int64  `dynamodbav:"ttl"`
	model.Invite
}

func (s *InviteStoreImpl) Create(ctx context.Context, invite *model.Invite) error {
	item := inviteItem{
		PK:     invitePK(invite.Token),
		SK:     metaSK(),
		TTL:    invite.ExpiresAt.Unix(),
		Invite: *invite,
	}

	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal invite: %w", err)
	}

	_, err = s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	})
	if err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create invite: %w", err)
	}
	return nil
}

func (s *InviteStoreImpl) GetByToken(ctx context.Context, token string) (*model.Invite, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(invitePK(token), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get invite: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}

	var item inviteItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal invite: %w", err)
	}
	return &item.Invite, nil
}

func (s *InviteStoreImpl) Delete(ctx context.Context, token string) error {
	_, err := s.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(invitePK(token), metaSK()),
	})
	if err != nil {
		return fmt.Errorf("store: delete invite: %w", err)
	}
	return nil
}
