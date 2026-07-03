//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// These tests drive the SDK-call error branches in the incoming-webhook store by
// routing a single DynamoDB operation through a faultClient. The store wraps the
// injected error, so each assertion is errors.Is(err, errInjected). They pin the
// non-condition error returns that a healthy DynamoDB Local never produces.

func webhookForFault(id string) *model.IncomingWebhook {
	now := time.Now().Truncate(time.Millisecond)
	return &model.IncomingWebhook{
		ID: id, Title: id, ChannelID: "ch-general", CreatedBy: "admin-1", CreatedAt: now, UpdatedAt: now,
	}
}

func TestIncomingWebhookStore_Create_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewIncomingWebhookStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.Create(ctx, webhookForFault("wh-fault-create"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestIncomingWebhookStore_Get_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewIncomingWebhookStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.Get(ctx, "wh-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Get: want errInjected, got %v", err)
	}
}

func TestIncomingWebhookStore_List_ScanError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewIncomingWebhookStore(withFault(db, func(f *faultClient) { f.failScan = true }))
	_, err := s.List(ctx)
	if !errors.Is(err, errInjected) {
		t.Fatalf("List: want errInjected, got %v", err)
	}
}

func TestIncomingWebhookStore_Update_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	wh := webhookForFault("wh-fault-update")
	if err := NewIncomingWebhookStore(db).Create(ctx, wh); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Fault PutItem so the non-condition error branch (not ErrNotFound) runs even
	// though the row exists.
	s := NewIncomingWebhookStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	wh.Title = "Changed"
	err := s.Update(ctx, wh)
	if !errors.Is(err, errInjected) {
		t.Fatalf("Update: want errInjected, got %v", err)
	}
}

func TestIncomingWebhookStore_Delete_DeleteItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewIncomingWebhookStore(withFault(db, func(f *faultClient) { f.failDeleteItem = true }))
	err := s.Delete(ctx, "wh-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("Delete: want errInjected, got %v", err)
	}
}
