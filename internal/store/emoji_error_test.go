//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
)

// SDK-call error branches in the emoji store, exercised via faultClient.

func TestEmojiStore_Create_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewEmojiStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.Create(ctx, makeEmoji("err-emoji"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestEmojiStore_GetByName_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewEmojiStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetByName(ctx, "err-emoji")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByName: want errInjected, got %v", err)
	}
}

func TestEmojiStore_List_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewEmojiStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.List(ctx)
	if !errors.Is(err, errInjected) {
		t.Fatalf("List: want errInjected, got %v", err)
	}
}

func TestEmojiStore_Delete_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewEmojiStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.Delete(ctx, "err-emoji")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete: want errInjected, got %v", err)
	}
}
