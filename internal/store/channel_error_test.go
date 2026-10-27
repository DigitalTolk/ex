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
	err := s.CreateChannel(ctx, makeChannel("ch-e1", "Eng", "eng", model.ChannelTypePublic))
	if !errors.Is(err, errInjected) {
		t.Fatalf("Create: want errInjected, got %v", err)
	}
}

func TestChannelStore_GetByID_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetChannel(ctx, "ch-anything")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetByID: want errInjected, got %v", err)
	}
}

func TestChannelStore_GetBySlug_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.GetChannelBySlug(ctx, "eng")
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

func TestChannelStore_ListPublic_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, _, err := s.ListPublicChannels(ctx, 10, "")
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListPublic: want errInjected, got %v", err)
	}
}

func TestChannelStore_ListAll_ScanError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(withFault(db, func(f *faultClient) { f.failScan = true }))
	_, err := s.ListAllChannels(ctx)
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListAll: want errInjected, got %v", err)
	}
}
