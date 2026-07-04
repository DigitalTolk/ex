//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
)

// testJobStatus is a stand-in for the search job status structs (any struct
// with dynamodbav tags), exercising the store's generic marshal round-trip.
type testJobStatus struct {
	Running bool   `dynamodbav:"running"`
	Count   int    `dynamodbav:"count"`
	Note    string `dynamodbav:"note,omitempty"`
}

func TestSearchStatusStore_PutAndGet(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSearchStatusStore(db)
	ctx := context.Background()

	if err := s.PutSearchStatus(ctx, "reindex", testJobStatus{Running: true, Count: 7, Note: "hi"}); err != nil {
		t.Fatalf("PutSearchStatus: %v", err)
	}
	var got testJobStatus
	found, err := s.GetSearchStatus(ctx, "reindex", &got)
	if err != nil {
		t.Fatalf("GetSearchStatus: %v", err)
	}
	if !found {
		t.Fatal("expected the stored status to be found")
	}
	if !got.Running || got.Count != 7 || got.Note != "hi" {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestSearchStatusStore_GetMissingIsNotFound(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSearchStatusStore(db)
	var got testJobStatus
	found, err := s.GetSearchStatus(context.Background(), "mapping-rebuild", &got)
	if err != nil || found {
		t.Fatalf("a never-written job must be (false,nil), got found=%v err=%v", found, err)
	}
}

func TestSearchStatusStore_JobsAreIsolated(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSearchStatusStore(db)
	ctx := context.Background()
	if err := s.PutSearchStatus(ctx, "reindex", testJobStatus{Count: 1}); err != nil {
		t.Fatalf("put reindex: %v", err)
	}
	if err := s.PutSearchStatus(ctx, "mapping-rebuild", testJobStatus{Count: 2}); err != nil {
		t.Fatalf("put mapping-rebuild: %v", err)
	}
	var a, b testJobStatus
	if _, err := s.GetSearchStatus(ctx, "reindex", &a); err != nil {
		t.Fatalf("get reindex: %v", err)
	}
	if _, err := s.GetSearchStatus(ctx, "mapping-rebuild", &b); err != nil {
		t.Fatalf("get mapping-rebuild: %v", err)
	}
	if a.Count != 1 || b.Count != 2 {
		t.Errorf("jobs share a row: a=%+v b=%+v", a, b)
	}
}

func TestSearchStatusStore_Overwrites(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSearchStatusStore(db)
	ctx := context.Background()
	if err := s.PutSearchStatus(ctx, "reindex", testJobStatus{Count: 1}); err != nil {
		t.Fatalf("put first: %v", err)
	}
	if err := s.PutSearchStatus(ctx, "reindex", testJobStatus{Count: 9}); err != nil {
		t.Fatalf("put second: %v", err)
	}
	var got testJobStatus
	if _, err := s.GetSearchStatus(ctx, "reindex", &got); err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Count != 9 {
		t.Errorf("Count = %d, want 9 (second write wins)", got.Count)
	}
}

func TestSearchStatusStore_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSearchStatusStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	var got testJobStatus
	if _, err := s.GetSearchStatus(context.Background(), "reindex", &got); !errors.Is(err, errInjected) {
		t.Fatalf("GetSearchStatus: want errInjected, got %v", err)
	}
}

func TestSearchStatusStore_PutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewSearchStatusStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	if err := s.PutSearchStatus(context.Background(), "reindex", testJobStatus{}); !errors.Is(err, errInjected) {
		t.Fatalf("PutSearchStatus: want errInjected, got %v", err)
	}
}

func TestSearchStatusStore_KeyHelper(t *testing.T) {
	if got := searchStatusPK(); got != "SEARCH_JOB" {
		t.Errorf("searchStatusPK = %q, want SEARCH_JOB", got)
	}
}
