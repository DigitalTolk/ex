//go:build integration

package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func makeRefreshToken(hash, userID string) *model.RefreshToken {
	now := time.Now().Truncate(time.Millisecond)
	return &model.RefreshToken{
		TokenHash: hash,
		UserID:    userID,
		ExpiresAt: now.Add(24 * time.Hour),
		CreatedAt: now,
	}
}

// SDK-call error branches in the token store, exercised via faultClient.

func TestTokenStore_Create_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.Create(ctx, makeRefreshToken("hash-e1", "u-te"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestTokenStore_GetByHash_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetByHash(ctx, "hash-e1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByHash: want errInjected, got %v", err)
	}
}

func TestTokenStore_Delete_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.Delete(ctx, "hash-e1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete: want errInjected, got %v", err)
	}
}

// DeleteAllForUser's Scan paginator surfaces a scan error.
func TestTokenStore_DeleteAllForUser_ScanError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(withFault(db, func(f *faultClient) { f.failScan = true }))
	err := s.DeleteAllForUser(ctx, "u-te")
	if !errors.Is(err, errInjected) {
		t.Fatalf("DeleteAllForUser scan: want errInjected, got %v", err)
	}
}

// DeleteAllForUser's BatchWriteItem error path: seed a token so the scan finds
// rows to delete, then fault only the batch delete.
func TestTokenStore_DeleteAllForUser_BatchWriteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewTokenStore(db).Create(ctx, makeRefreshToken("hash-bw", "u-bw")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewTokenStore(withFault(db, func(f *faultClient) { f.failBatchWriteItem = true }))
	err := s.DeleteAllForUser(ctx, "u-bw")
	if !errors.Is(err, errInjected) {
		t.Fatalf("DeleteAllForUser batch: want errInjected, got %v", err)
	}
}

// Revocation must drain UnprocessedItems — a throttled batch that reports some
// deletes as unprocessed is retried until they all apply.
func TestTokenStore_DeleteAllForUser_RetriesUnprocessed(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewTokenStore(db).Create(ctx, makeRefreshToken("hash-rt", "u-rt")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	uc := &unprocessedClient{DynamoAPI: db.Client, table: db.Table, remaining: 1}
	s := NewTokenStore(&DB{Client: uc, Table: db.Table})
	if err := s.DeleteAllForUser(ctx, "u-rt"); err != nil {
		t.Fatalf("DeleteAllForUser retry: %v", err)
	}
}

// If every batch keeps reporting UnprocessedItems, revocation surfaces an error
// rather than silently leaving live tokens for the deactivated user.
func TestTokenStore_DeleteAllForUser_ExhaustsRetries(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewTokenStore(db).Create(ctx, makeRefreshToken("hash-ex", "u-ex")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	uc := &unprocessedClient{DynamoAPI: db.Client, table: db.Table, remaining: 99}
	s := NewTokenStore(&DB{Client: uc, Table: db.Table})
	err := s.DeleteAllForUser(ctx, "u-ex")
	if err == nil || !strings.Contains(err.Error(), "unprocessed after retries") {
		t.Fatalf("DeleteAllForUser exhausted: want 'unprocessed after retries', got %v", err)
	}
}
