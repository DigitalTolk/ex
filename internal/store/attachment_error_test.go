//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
)

// These tests drive the SDK-call error branches in the attachment store by
// routing a single DynamoDB operation through a faultClient. The store wraps
// the injected error, so each assertion is errors.Is(err, errInjected).

func TestAttachmentStore_Create_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAttachmentStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.Create(ctx, makeAttachment("att-e1", "hash-e1", "x.png"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestAttachmentStore_GetByID_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAttachmentStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetByID(ctx, "att-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByID: want errInjected, got %v", err)
	}
}

func TestAttachmentStore_GetByHash_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAttachmentStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.GetByHash(ctx, "hash-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByHash: want errInjected, got %v", err)
	}
}

func TestAttachmentStore_AddRef_UpdateItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAttachmentStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	err := s.AddRef(ctx, "att-anything", "msg-1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("AddRef: want errInjected, got %v", err)
	}
}

func TestAttachmentStore_RemoveRef_UpdateItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAttachmentStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	_, err := s.RemoveRef(ctx, "att-anything", "msg-1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("RemoveRef: want errInjected, got %v", err)
	}
}

func TestAttachmentStore_Delete_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewAttachmentStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.Delete(ctx, "att-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete: want errInjected, got %v", err)
	}
}

func TestAttachmentStore_SetDimensions_UpdateItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	a := makeAttachment("att-sd", "hash-sd", "x.png")
	if err := NewAttachmentStore(db).Create(ctx, a); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Fault UpdateItem so the non-condition error branch (not ErrNotFound) runs
	// even though the row exists.
	s := NewAttachmentStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	err := s.SetDimensions(ctx, a.ID, 10, 10)
	if !errors.Is(err, errInjected) {
		t.Fatalf("SetDimensions: want errInjected, got %v", err)
	}
}

func TestAttachmentStore_SetThumbnailKeys_UpdateItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	a := makeAttachment("att-tk", "hash-tk", "x.png")
	if err := NewAttachmentStore(db).Create(ctx, a); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewAttachmentStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	err := s.SetThumbnailKeys(ctx, a.ID, "thumb", "square")
	if !errors.Is(err, errInjected) {
		t.Fatalf("SetThumbnailKeys: want errInjected, got %v", err)
	}
}
