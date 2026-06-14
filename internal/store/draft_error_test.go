//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// SDK-call error branches in the draft store, exercised via faultClient.

func TestDraftStore_Upsert_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewDraftStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.Upsert(ctx, makeDraft("u-d-e", "d-e", "hi", time.Now()))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Upsert: want errInjected, got %v", err)
	}
}

func TestDraftStore_Get_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewDraftStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.Get(ctx, "u-d-e", "d-e")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Get: want errInjected, got %v", err)
	}
}

func TestDraftStore_List_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewDraftStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.List(ctx, "u-d-e")
	if !errors.Is(err, errInjected) {
		t.Fatalf("List: want errInjected, got %v", err)
	}
}

func TestDraftStore_Delete_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewDraftStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.Delete(ctx, "u-d-e", "d-e")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete: want errInjected, got %v", err)
	}
}
