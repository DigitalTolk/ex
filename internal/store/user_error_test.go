//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
)

// These tests drive the SDK-call error branches in the user store by routing a
// single DynamoDB operation through a faultClient. The store wraps the injected
// error, so each assertion is errors.Is(err, errInjected).

func TestUserStore_Create_FindByEmailScanError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	// Query backs findByEmailScan; faulting it makes Create's dedupe lookup
	// return a non-NotFound error, which Create propagates.
	s := NewUserStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	err := s.CreateUser(ctx, makeUser("u-err-1", "err1@test.com", "Err One"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestUserStore_Create_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.CreateUser(ctx, makeUser("u-err-2", "err2@test.com", "Err Two"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestUserStore_Create_DuplicateEnsureEmailIndexPutError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	real := NewUserStore(db)
	if err := real.CreateUser(ctx, makeUser("u-dup", "dup@test.com", "Dup")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Re-creating with the same email finds the existing user, then calls
	// ensureEmailIndex (whose PutItem we fault) before returning ErrAlreadyExists.
	s := NewUserStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.CreateUser(ctx, makeUser("u-dup-2", "dup@test.com", "Dup Two"))
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("Create duplicate: want ErrAlreadyExists, got %v", err)
	}
}

func TestUserStore_Create_DuplicateIDTransactionConflict(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(db)
	if err := s.CreateUser(ctx, makeUser("u-conflict", "first@test.com", "First")); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Same ID, different email: the email dedupe scan misses, so Create proceeds
	// to the transaction, whose attribute_not_exists(PK) condition fails — the
	// real conflict path that returns ErrAlreadyExists.
	err := s.CreateUser(ctx, makeUser("u-conflict", "second@test.com", "Second"))
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("Create duplicate ID: want ErrAlreadyExists, got %v", err)
	}
}

func TestUserStore_GetByID_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetUser(ctx, "u-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByID: want errInjected, got %v", err)
	}
}

func TestUserStore_GetByEmail_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetUserByEmail(ctx, "nobody@test.com")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByEmail: want errInjected, got %v", err)
	}
}

func TestUserStore_Update_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	u := makeUser("u-upd", "upd@test.com", "Upd")
	if err := NewUserStore(db).CreateUser(ctx, u); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewUserStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	u.DisplayName = "Changed"
	err := s.UpdateUser(ctx, u)
	if !errors.Is(err, errInjected) {
		t.Fatalf("Update: want errInjected, got %v", err)
	}
}

func TestUserStore_List_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, _, err := s.ListUsers(ctx, 10, "")
	if !errors.Is(err, errInjected) {
		t.Fatalf("List: want errInjected, got %v", err)
	}
}

func TestUserStore_HasUsers_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.HasUsers(ctx)
	if !errors.Is(err, errInjected) {
		t.Fatalf("HasUsers: want errInjected, got %v", err)
	}
}

func TestUserStore_GetUsersByIDs_BatchGetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true }))
	_, err := s.GetUsersByIDs(ctx, []string{"u-1", "u-2"})
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetUsersByIDs: want errInjected, got %v", err)
	}
}

// TestUserStore_FindByEmailScan_PaginatesAcrossPages drives the manual
// LastEvaluatedKey drain in findByEmailScan through a second Query iteration.
// pageQueryOnce returns the real first page plus a synthetic cursor, then an
// empty follow-up page — the searched email matches nothing, so the loop must
// carry the cursor forward (input.ExclusiveStartKey = LastEvaluatedKey) before
// terminating with ErrNotFound.
func TestUserStore_FindByEmailScan_PaginatesAcrossPages(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(withFault(db, func(f *faultClient) { f.pageQueryOnce = true }))
	_, err := s.findByEmailScan(ctx, "ghost@test.com")
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("findByEmailScan: want ErrNotFound after paging, got %v", err)
	}
}
