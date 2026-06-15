//go:build integration

package store

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// SDK-call error branches in the settings store, exercised via faultClient.

func TestSettingsStore_GetSettings_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewSettingsStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetSettings(ctx)
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetSettings: want errInjected, got %v", err)
	}
}

func TestSettingsStore_PutSettings_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewSettingsStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.PutSettings(ctx, &model.WorkspaceSettings{})
	if !errors.Is(err, errInjected) {
		t.Fatalf("PutSettings: want errInjected, got %v", err)
	}
}
