//go:build integration

package store

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
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

// CheckTTL is a boot-time assertion, not a gate: every arm only logs. It
// exists because TTL is enabled by EnsureTable (development only), so a
// production table provisioned elsewhere with TTL off silently accumulates
// runner registrations, claims, follows and thread-scoped watchers forever.
func TestCheckTTL_Arms(t *testing.T) {
	base := setupDynamoDB(t)
	ctx := context.Background()

	// Enabled on `ttl` (what EnsureTable set up) — the quiet, healthy path.
	base.CheckTTL(ctx)

	// Describe fails → warn, no panic.
	withFault(base, func(f *faultClient) { f.failDescribeTTL = true }).CheckTTL(ctx)

	// Disabled, and the nil-description shape.
	withFault(base, func(f *faultClient) {
		f.ttlDesc = &types.TimeToLiveDescription{TimeToLiveStatus: types.TimeToLiveStatusDisabled}
	}).CheckTTL(ctx)
	withFault(base, func(f *faultClient) {
		f.ttlDesc = &types.TimeToLiveDescription{}
	}).CheckTTL(ctx)

	// Enabled on the WRONG attribute — the subtle misconfiguration.
	withFault(base, func(f *faultClient) {
		f.ttlDesc = &types.TimeToLiveDescription{
			TimeToLiveStatus: types.TimeToLiveStatusEnabled,
			AttributeName:    aws.String("expiresAt"),
		}
	}).CheckTTL(ctx)
	withFault(base, func(f *faultClient) {
		f.ttlDesc = &types.TimeToLiveDescription{TimeToLiveStatus: types.TimeToLiveStatusEnabled}
	}).CheckTTL(ctx)
}
