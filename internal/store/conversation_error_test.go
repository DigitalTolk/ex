//go:build integration

package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

// SDK-call error branches in the conversation store, exercised via faultClient.

func TestConversationStore_Create_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	conv, members := makeConv("conv-e1", "u-ce-a", "u-ce-b")
	s := NewConversationStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.Create(ctx, conv, members)
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

// Create rejects a conversation whose participant fan-out would exceed the
// 100-item TransactWriteItems limit.
func TestConversationStore_Create_ExceedsTransactionLimit(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	conv, _ := makeConv("conv-big", "u-a", "u-b")
	// txItems = 1 META + len(ParticipantIDs) member items + len(members)
	// user-side items. 110 participants alone → 1 + 110 = 111 > 100.
	ids := make([]string, 0, 110)
	for i := 0; i < 110; i++ {
		ids = append(ids, fmt.Sprintf("u-big-%d", i))
	}
	conv.ParticipantIDs = ids
	s := NewConversationStore(db)
	err := s.Create(ctx, conv, nil)
	if err == nil {
		t.Fatal("Create over limit: want error, got nil")
	}
}

func TestConversationStore_GetByID_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewConversationStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetByID(ctx, "conv-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByID: want errInjected, got %v", err)
	}
}

func TestConversationStore_ListUserConversations_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewConversationStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.ListUserConversations(ctx, "u-ce-a")
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListUserConversations: want errInjected, got %v", err)
	}
}

func TestConversationStore_IsMember_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewConversationStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.IsMember(ctx, "conv-1", "u-ce-a")
	if !errors.Is(err, errInjected) {
		t.Fatalf("IsMember: want errInjected, got %v", err)
	}
}

func TestConversationStore_Activate_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewConversationStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.Activate(ctx, "conv-1", []string{"u-ce-a", "u-ce-b"})
	if !errors.Is(err, errInjected) {
		t.Fatalf("Activate: want errInjected, got %v", err)
	}
}

func TestConversationStore_Touch_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	conv, members := makeConv("conv-t", "u-ct-a", "u-ct-b")
	if err := NewConversationStore(db).Create(ctx, conv, members); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewConversationStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.Touch(ctx, "conv-t", []string{"u-ct-a"}, time.Now())
	if !errors.Is(err, errInjected) {
		t.Fatalf("Touch: want errInjected, got %v", err)
	}
}

func TestConversationStore_SetUserConversationFavorite_UpdateItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	conv, members := makeConv("conv-f", "u-cf2-a", "u-cf2-b")
	if err := NewConversationStore(db).Create(ctx, conv, members); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewConversationStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	err := s.SetUserConversationFavorite(ctx, "conv-f", "u-cf2-a", true)
	if !errors.Is(err, errInjected) {
		t.Fatalf("SetUserConversationFavorite: want errInjected, got %v", err)
	}
}

func TestConversationStore_ListAll_ScanError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewConversationStore(withFault(db, func(f *faultClient) { f.failScan = true }))
	_, err := s.ListAll(ctx)
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListAll: want errInjected, got %v", err)
	}
}
