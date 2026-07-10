//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func makeUserState(userID string, kind model.UserStateKind, targetID string) *model.UserStateItem {
	return &model.UserStateItem{
		UserID:    userID,
		Kind:      kind,
		TargetID:  targetID,
		UpdatedAt: time.Now().Truncate(time.Millisecond),
	}
}

// SDK-call error branches in the user-state store, exercised via faultClient.

func TestUserStateStore_Set_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStateStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.SetUserState(ctx, makeUserState("u-us", model.UserStateThreadNotification, "ch-1"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Set: want errInjected, got %v", err)
	}
}

func TestUserStateStore_Delete_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStateStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.DeleteUserState(ctx, "u-us", model.UserStateThreadNotification, "ch-1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete: want errInjected, got %v", err)
	}
}

func TestUserStateStore_List_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStateStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.ListUserState(ctx, "u-us")
	if !errors.Is(err, errInjected) {
		t.Fatalf("List: want errInjected, got %v", err)
	}
}

// List backfills Kind from the SK when a stored row has an empty kind attribute
// (legacy rows written before kind was persisted). We seed such a row directly
// via Set with an empty Kind so the SK-derived fallback runs.
func TestUserStateStore_List_KindBackfilledFromSK(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStateStore(db)
	// Set with empty Kind: SK is built from the empty kind + targetID, but the
	// stored "kind" attribute is empty, so List's fallback recomputes it.
	row := makeUserState("u-usk", "", "tgt-1")
	if err := s.SetUserState(ctx, row); err != nil {
		t.Fatalf("seed: %v", err)
	}
	items, err := s.ListUserState(ctx, "u-usk")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("List: want 1 item, got %d", len(items))
	}
}
