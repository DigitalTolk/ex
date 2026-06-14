//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

// SDK-call error branches in the parent-index store, exercised via faultClient.

func TestParentIndexStore_SetPinIndex_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewParentIndexStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.SetPinIndex(ctx, "ch-pi", "m-1", "u-a", time.Now())
	if !errors.Is(err, errInjected) {
		t.Fatalf("SetPinIndex: want errInjected, got %v", err)
	}
}

func TestParentIndexStore_DeletePinIndex_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewParentIndexStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.DeletePinIndex(ctx, "ch-pi", "m-1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("DeletePinIndex: want errInjected, got %v", err)
	}
}

func TestParentIndexStore_ListPinIndex_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewParentIndexStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.ListPinIndex(ctx, "ch-pi")
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListPinIndex: want errInjected, got %v", err)
	}
}

func TestParentIndexStore_SetFileIndex_EmptyAttachmentID(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewParentIndexStore(db)
	if err := s.SetFileIndex(ctx, "ch-fi", "", "m-1", "u-a", time.Now()); err == nil {
		t.Fatal("SetFileIndex with empty attachmentID: want error, got nil")
	}
}

func TestParentIndexStore_SetFileIndex_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewParentIndexStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.SetFileIndex(ctx, "ch-fi", "att-1", "m-1", "u-a", time.Now())
	if !errors.Is(err, errInjected) {
		t.Fatalf("SetFileIndex: want errInjected, got %v", err)
	}
}

func TestParentIndexStore_DeleteFileIndex_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewParentIndexStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.DeleteFileIndex(ctx, "ch-fi", "att-1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("DeleteFileIndex: want errInjected, got %v", err)
	}
}

func TestParentIndexStore_ListFileIndex_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewParentIndexStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.ListFileIndex(ctx, "ch-fi")
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListFileIndex: want errInjected, got %v", err)
	}
}
