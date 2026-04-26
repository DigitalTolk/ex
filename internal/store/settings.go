package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/DigitalTolk/ex/internal/model"
)

// SettingsStore reads and writes the singleton workspace settings.
type SettingsStore interface {
	GetSettings(ctx context.Context) (*model.WorkspaceSettings, error)
	PutSettings(ctx context.Context, s *model.WorkspaceSettings) error
}

// SettingsStoreImpl is the DynamoDB-backed implementation.
type SettingsStoreImpl struct {
	*DB
}

var _ SettingsStore = (*SettingsStoreImpl)(nil)

// NewSettingsStore returns a SettingsStoreImpl.
func NewSettingsStore(db *DB) *SettingsStoreImpl {
	return &SettingsStoreImpl{DB: db}
}

type settingsItem struct {
	PK string `dynamodbav:"PK"`
	SK string `dynamodbav:"SK"`
	model.WorkspaceSettings
}

// GetSettings returns the stored settings. If no record exists yet (fresh
// workspace), returns ErrNotFound — callers fall back to defaults.
func (s *SettingsStoreImpl) GetSettings(ctx context.Context) (*model.WorkspaceSettings, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(settingsPK(), settingsSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get settings: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var item settingsItem
	if err := attributevalue.UnmarshalMap(out.Item, &item); err != nil {
		return nil, fmt.Errorf("store: unmarshal settings: %w", err)
	}
	return &item.WorkspaceSettings, nil
}

// PutSettings replaces the singleton settings record. Idempotent; no
// optimistic-lock check needed since the only writer is the admin UI.
func (s *SettingsStoreImpl) PutSettings(ctx context.Context, ws *model.WorkspaceSettings) error {
	if ws == nil {
		return errors.New("store: nil settings")
	}
	item := settingsItem{
		PK:                settingsPK(),
		SK:                settingsSK(),
		WorkspaceSettings: *ws,
	}
	av, err := attributevalue.MarshalMap(item)
	if err != nil {
		return fmt.Errorf("store: marshal settings: %w", err)
	}
	_, err = s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	})
	if err != nil {
		return fmt.Errorf("store: put settings: %w", err)
	}
	return nil
}
