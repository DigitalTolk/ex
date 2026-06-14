//go:build integration

package store

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// SDK-call error branches in the channel store, exercised via faultClient.

func TestChannelStore_Create_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.Create(ctx, makeChannel("ch-e1", "Eng", "eng", model.ChannelTypePublic))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestChannelStore_GetByID_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetByID(ctx, "ch-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByID: want errInjected, got %v", err)
	}
}

func TestChannelStore_GetBySlug_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.GetBySlug(ctx, "eng")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetBySlug: want errInjected, got %v", err)
	}
}

func TestChannelStore_GetByName_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.GetByName(ctx, "Eng")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByName: want errInjected, got %v", err)
	}
}

func TestChannelStore_Update_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ch := makeChannel("ch-u", "Eng", "eng-u", model.ChannelTypePublic)
	if err := NewChannelStore(db).Create(ctx, ch); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	ch.Name = "Engineering"
	err := s.Update(ctx, ch)
	if !errors.Is(err, errInjected) {
		t.Fatalf("Update: want errInjected, got %v", err)
	}
}

func TestChannelStore_ListPublic_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, _, err := s.ListPublic(ctx, 10, "")
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListPublic: want errInjected, got %v", err)
	}
}

func TestChannelStore_ListAll_ScanError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failScan = true }))
	_, err := s.ListAll(ctx)
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListAll: want errInjected, got %v", err)
	}
}
