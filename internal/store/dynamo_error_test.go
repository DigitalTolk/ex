//go:build integration

package store

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestNew_BuildsClientWithEndpoint(t *testing.T) {
	// New only constructs a client (no network), so it runs without a container.
	// Passing an endpoint exercises the local-dev BaseEndpoint option branch.
	db, err := New(context.Background(), DBConfig{
		Region:   "us-east-1",
		Endpoint: "http://localhost:8000",
		Table:    "any-table",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if db.Client == nil || db.Table != "any-table" {
		t.Fatalf("New returned incomplete DB: %+v", db)
	}
}

func TestEnsureTable_CreateTableError(t *testing.T) {
	base := setupDynamoDB(t)
	ctx := context.Background()
	// A brand-new table name so DescribeTable reports not-found and EnsureTable
	// proceeds to CreateTable, which we fault.
	fresh := &DB{
		Client: &faultClient{DynamoAPI: base.Client, failCreateTable: true},
		Table:  fmt.Sprintf("missing-table-%d", tableCounter.Add(1)),
	}
	err := fresh.EnsureTable(ctx)
	if !errors.Is(err, errInjected) {
		t.Fatalf("EnsureTable: want errInjected, got %v", err)
	}
}

func TestEnsureTable_DescribeTableError(t *testing.T) {
	base := setupDynamoDB(t)
	ctx := context.Background()
	// DescribeTable returns a non-not-found error → the describe-table branch.
	fresh := withFault(base, func(f *faultClient) { f.failDescribeTable = true })
	err := fresh.EnsureTable(ctx)
	if !errors.Is(err, errInjected) {
		t.Fatalf("EnsureTable: want errInjected, got %v", err)
	}
}

func TestEnsureTable_TTLWarningStillSucceeds(t *testing.T) {
	base := setupDynamoDB(t)
	ctx := context.Background()
	// Fault UpdateTimeToLive: EnsureTable logs a warning but still succeeds, since
	// local DynamoDB may not support TTL. Real create + waiter run underneath.
	fresh := &DB{
		Client: &faultClient{DynamoAPI: base.Client, failUpdateTimeToLive: true},
		Table:  fmt.Sprintf("ttl-warn-table-%d", tableCounter.Add(1)),
	}
	if err := fresh.EnsureTable(ctx); err != nil {
		t.Fatalf("EnsureTable should tolerate TTL failure, got %v", err)
	}
}
