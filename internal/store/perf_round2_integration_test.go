//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Round-2 perf work: per-user token partition, webhook directory row,
// conditional status clear.

func tokenFor(userID, hash string) *model.RefreshToken {
	return &model.RefreshToken{
		TokenHash: hash,
		UserID:    userID,
		ExpiresAt: time.Now().Add(time.Hour),
		CreatedAt: time.Now(),
	}
}

// stripTokenGSI simulates a legacy token row (written before the per-user
// partition existed) by removing its GSI attributes.
func stripTokenGSI(t *testing.T, db *DB, hash string) {
	t.Helper()
	_, err := db.Client.UpdateItem(context.Background(), &dynamodb.UpdateItemInput{
		TableName:        &db.Table,
		Key:              compositeKey(rtokenPK(hash), metaSK()),
		UpdateExpression: strPtr("REMOVE GSI1PK, GSI1SK"),
	})
	if err != nil {
		t.Fatalf("strip GSI attrs: %v", err)
	}
}

func strPtr(s string) *string { return &s }

func TestTokenStore_UserTokenIndexLifecycle(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(db)

	// Legacy rows: created then stripped of their index attributes.
	for _, h := range []string{"legacy-1", "legacy-2"} {
		if err := s.Create(ctx, tokenFor("u-legacy", h)); err != nil {
			t.Fatalf("Create %s: %v", h, err)
		}
		stripTokenGSI(t, db, h)
	}
	// A modern row for another user (indexed at create time).
	if err := s.Create(ctx, tokenFor("u-other", "modern-1")); err != nil {
		t.Fatalf("Create modern: %v", err)
	}

	// Unseeded: DeleteAllForUser stays on the Scan path and still revokes
	// the legacy (unindexed) rows — revocation is never incomplete.
	if err := s.DeleteAllForUser(ctx, "u-legacy"); err != nil {
		t.Fatalf("DeleteAllForUser (scan path): %v", err)
	}
	if _, err := s.GetByHash(ctx, "legacy-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("legacy-1 after scan revoke = %v, want gone", err)
	}
	if _, err := s.GetByHash(ctx, "modern-1"); err != nil {
		t.Fatalf("other user's token must survive: %v", err)
	}

	// Backfill: indexes remaining legacy rows and writes the seeded marker.
	if err := s.Create(ctx, tokenFor("u-legacy2", "legacy-3")); err != nil {
		t.Fatalf("Create legacy-3: %v", err)
	}
	stripTokenGSI(t, db, "legacy-3")
	if err := s.EnsureUserTokenIndex(ctx); err != nil {
		t.Fatalf("EnsureUserTokenIndex: %v", err)
	}
	seeded, err := s.isTokenIndexSeeded(ctx)
	if err != nil || !seeded {
		t.Fatalf("seeded = %v (err=%v), want true", seeded, err)
	}
	// Idempotent second run is a no-op.
	if err := s.EnsureUserTokenIndex(ctx); err != nil {
		t.Fatalf("EnsureUserTokenIndex rerun: %v", err)
	}

	// Seeded: DeleteAllForUser takes the GSI Query path and finds the
	// backfilled legacy row.
	if err := s.DeleteAllForUser(ctx, "u-legacy2"); err != nil {
		t.Fatalf("DeleteAllForUser (index path): %v", err)
	}
	if _, err := s.GetByHash(ctx, "legacy-3"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("legacy-3 after index revoke = %v, want gone", err)
	}
	if _, err := s.GetByHash(ctx, "modern-1"); err != nil {
		t.Fatalf("other user's token must survive the index path too: %v", err)
	}
	if err := s.DeleteAllForUser(ctx, "u-other"); err != nil {
		t.Fatalf("DeleteAllForUser modern: %v", err)
	}
	if _, err := s.GetByHash(ctx, "modern-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("modern-1 after revoke = %v, want gone", err)
	}
}

func TestTokenStore_IndexPathFaults(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	// Marker probe failure surfaces (revocation must not silently pick a path).
	s := NewTokenStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	if err := s.DeleteAllForUser(ctx, "u-x"); !errors.Is(err, errInjected) {
		t.Fatalf("marker probe fault = %v, want errInjected", err)
	}
	if err := s.EnsureUserTokenIndex(ctx); !errInjectedIs(err) {
		t.Fatalf("EnsureUserTokenIndex probe fault = %v, want errInjected", err)
	}

	// Backfill scan / update / marker-write failures surface.
	if err := NewTokenStore(withFault(db, func(f *faultClient) { f.failScan = true })).EnsureUserTokenIndex(ctx); !errInjectedIs(err) {
		t.Fatalf("backfill scan fault = %v", err)
	}
	seedLegacy := func(hash string) {
		if err := NewTokenStore(db).Create(ctx, tokenFor("u-f", hash)); err != nil {
			t.Fatalf("Create: %v", err)
		}
		stripTokenGSI(t, db, hash)
	}
	seedLegacy("fault-1")
	if err := NewTokenStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true })).EnsureUserTokenIndex(ctx); !errInjectedIs(err) {
		t.Fatalf("backfill update fault = %v", err)
	}
	if err := NewTokenStore(withFault(db, func(f *faultClient) { f.failPutItem = true })).EnsureUserTokenIndex(ctx); !errInjectedIs(err) {
		t.Fatalf("marker put fault = %v", err)
	}

	// Seed for real, then fail the Query path.
	if err := NewTokenStore(db).EnsureUserTokenIndex(ctx); err != nil {
		t.Fatalf("EnsureUserTokenIndex: %v", err)
	}
	if err := NewTokenStore(withFault(db, func(f *faultClient) { f.failQuery = true })).DeleteAllForUser(ctx, "u-f"); !errInjectedIs(err) {
		t.Fatalf("index query fault = %v", err)
	}
	// Corrupt row in the backfill scan hits the unmarshal arm — needs a fresh
	// unseeded table, covered in TestTokenStore_BackfillCorruptRow.
}

func errInjectedIs(err error) bool { return errors.Is(err, errInjected) }

func TestTokenStore_BackfillSkipsUserlessRow(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(db)
	// A garbage RTOKEN row with no userID is unrevocable — the backfill skips
	// it (it expires via TTL) instead of failing the whole run.
	if err := s.Create(ctx, tokenFor("", "userless-1")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	stripTokenGSI(t, db, "userless-1")
	if err := s.EnsureUserTokenIndex(ctx); err != nil {
		t.Fatalf("EnsureUserTokenIndex: %v", err)
	}
	if seeded, err := s.isTokenIndexSeeded(ctx); err != nil || !seeded {
		t.Fatalf("seeded = %v (err=%v)", seeded, err)
	}
}

func TestTokenStore_BackfillCorruptRow(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewTokenStore(db).Create(ctx, tokenFor("u-c", "corrupt-src")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	stripTokenGSI(t, db, "corrupt-src")
	s := NewTokenStore(withFault(db, func(f *faultClient) { f.transformScan = corruptScan }))
	err := s.EnsureUserTokenIndex(ctx)
	assertUnmarshalErr(t, err, "token backfill")
}

// --- webhook directory --------------------------------------------------

func webhookRow(id string) *model.IncomingWebhook {
	now := time.Now().Truncate(time.Millisecond)
	return &model.IncomingWebhook{ID: id, Title: id, ChannelID: "ch-1", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now}
}

func TestWebhookDirectory_SelfSeedsAndServesList(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewIncomingWebhookStore(db)

	// Simulate a legacy webhook: create, then delete its directory row so
	// only the META row remains (as if written before the directory existed).
	if err := s.Create(ctx, webhookRow("wh-legacy")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &db.Table, Key: compositeKey(webhookDirPK, metaSK()),
	}); err != nil {
		t.Fatalf("drop directory: %v", err)
	}

	// First List: no (seeded) directory → legacy scan, which then seeds.
	got, err := s.List(ctx)
	if err != nil || len(got) != 1 || got[0].ID != "wh-legacy" {
		t.Fatalf("List (scan+seed) = %+v (err=%v)", got, err)
	}

	// Second List: served from the directory; creates/deletes keep it fresh.
	if err := s.Create(ctx, webhookRow("wh-new")); err != nil {
		t.Fatalf("Create wh-new: %v", err)
	}
	got, err = s.List(ctx)
	if err != nil || len(got) != 2 {
		t.Fatalf("List (directory) = %+v (err=%v), want 2", got, err)
	}
	if err := s.Delete(ctx, "wh-legacy"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, err = s.List(ctx)
	if err != nil || len(got) != 1 || got[0].ID != "wh-new" {
		t.Fatalf("List after delete = %+v (err=%v), want only wh-new", got, err)
	}
}

func TestWebhookDirectory_SkipsHalfDeletedID(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewIncomingWebhookStore(db)
	if err := s.Create(ctx, webhookRow("wh-a")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := s.List(ctx); err != nil { // seed the directory
		t.Fatalf("List: %v", err)
	}
	// Remove the META row out-of-band: the directory now holds a dangling ID.
	if _, err := db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &db.Table, Key: compositeKey(webhookPK("wh-a"), webhookSK()),
	}); err != nil {
		t.Fatalf("drop META: %v", err)
	}
	got, err := s.List(ctx)
	if err != nil || len(got) != 0 {
		t.Fatalf("List with dangling ID = %+v (err=%v), want empty", got, err)
	}
}

func TestWebhookDirectory_Faults(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewIncomingWebhookStore(db).Create(ctx, webhookRow("wh-f")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := NewIncomingWebhookStore(db).List(ctx); err != nil { // seed
		t.Fatalf("List: %v", err)
	}
	// Directory GetItem failure surfaces.
	if _, err := NewIncomingWebhookStore(withFault(db, func(f *faultClient) { f.failGetItem = true })).List(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("dir get fault = %v", err)
	}
	// META BatchGet failure surfaces.
	if _, err := NewIncomingWebhookStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true })).List(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("batch get fault = %v", err)
	}
	// Corrupt META row in the directory path hits the unmarshal arm.
	corrupt := NewIncomingWebhookStore(withFault(db, func(f *faultClient) { f.transformBatchGetItem = corruptBatchGetOut(db) }))
	_, err := corrupt.List(ctx)
	assertUnmarshalErr(t, err, "webhook listByDirectory")
	// Corrupt directory row hits its unmarshal arm.
	if _, err := db.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: &db.Table,
		Item: map[string]types.AttributeValue{
			"PK":     &types.AttributeValueMemberS{Value: webhookDirPK},
			"SK":     &types.AttributeValueMemberS{Value: metaSK()},
			"seeded": &types.AttributeValueMemberS{Value: "not-a-bool"},
		},
	}); err != nil {
		t.Fatalf("corrupt directory: %v", err)
	}
	_, err = NewIncomingWebhookStore(db).List(ctx)
	assertUnmarshalErr(t, err, "webhook directory row")
}

func TestWebhookDirectory_SeedFailureIsBestEffort(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewIncomingWebhookStore(db).Create(ctx, webhookRow("wh-s")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &db.Table, Key: compositeKey(webhookDirPK, metaSK()),
	}); err != nil {
		t.Fatalf("drop directory: %v", err)
	}
	// Scan works, the seed's UpdateItem fails → the List still answers.
	s := NewIncomingWebhookStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	got, err := s.List(ctx)
	if err != nil || len(got) != 1 {
		t.Fatalf("List with failing seed = %+v (err=%v), want the scan result", got, err)
	}
}

// --- conditional status clear ---------------------------------------------

func TestUserStore_ClearUserStatusIfExpired(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(db)

	clearAt := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
	u := &model.User{
		ID: "u-status", Email: "st@x.io", DisplayName: "S", SystemRole: model.SystemRoleMember,
		Status: "active", CreatedAt: time.Now(),
		UserStatus: &model.UserStatus{Emoji: ":zzz:", Text: "away", ClearAt: &clearAt},
	}
	if err := s.Create(ctx, u); err != nil {
		t.Fatalf("Create: %v", err)
	}

	now := time.Now().Truncate(time.Millisecond)
	cleared, err := s.ClearUserStatusIfExpired(ctx, u.ID, clearAt, now)
	if err != nil || !cleared {
		t.Fatalf("ClearUserStatusIfExpired = %v (err=%v), want cleared", cleared, err)
	}
	got, err := s.GetByID(ctx, u.ID)
	if err != nil || got.UserStatus != nil {
		t.Fatalf("status after clear = %+v (err=%v), want nil", got.UserStatus, err)
	}

	// A fresh status set since the sweep observed the old one is preserved:
	// the conditional no-ops.
	newClear := time.Now().Add(time.Hour).Truncate(time.Millisecond)
	got.UserStatus = &model.UserStatus{Emoji: ":new:", Text: "back", ClearAt: &newClear}
	if err := s.Update(ctx, got); err != nil {
		t.Fatalf("Update: %v", err)
	}
	cleared, err = s.ClearUserStatusIfExpired(ctx, u.ID, clearAt, now)
	if err != nil || cleared {
		t.Fatalf("stale clear = %v (err=%v), want no-op", cleared, err)
	}
	fresh, _ := s.GetByID(ctx, u.ID)
	if fresh.UserStatus == nil || fresh.UserStatus.Text != "back" {
		t.Fatalf("fresh status clobbered: %+v", fresh.UserStatus)
	}

	// SDK failure surfaces.
	sErr := NewUserStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if _, err := sErr.ClearUserStatusIfExpired(ctx, u.ID, newClear, now); !errors.Is(err, errInjected) {
		t.Fatalf("fault = %v, want errInjected", err)
	}
}

// The index path's batch-delete failure arm: the GSI Query succeeds, the
// BatchWriteItem revocation fails → surfaces (a partial revoke is loud).
func TestTokenStore_IndexPathBatchDeleteFault(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(db)
	if err := s.Create(ctx, tokenFor("u-bd", "bd-1")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := s.EnsureUserTokenIndex(ctx); err != nil {
		t.Fatalf("EnsureUserTokenIndex: %v", err)
	}
	faulted := NewTokenStore(withFault(db, func(f *faultClient) { f.failBatchWriteItem = true }))
	if err := faulted.DeleteAllForUser(ctx, "u-bd"); !errors.Is(err, errInjected) {
		t.Fatalf("batch delete fault = %v, want errInjected", err)
	}
}

// The directory list drains UnprocessedKeys continuations.
func TestWebhookDirectory_ListDrainsUnprocessedKeys(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewIncomingWebhookStore(db).Create(ctx, webhookRow("wh-u")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := NewIncomingWebhookStore(db).List(ctx); err != nil { // seed
		t.Fatalf("List: %v", err)
	}
	drained := NewIncomingWebhookStore(withFault(db, func(f *faultClient) {
		f.transformBatchGetItem = unprocessedOnce(db, compositeKey(webhookPK("wh-u"), webhookSK()))
	}))
	got, err := drained.List(ctx)
	if err != nil || len(got) != 1 || got[0].ID != "wh-u" {
		t.Fatalf("unprocessed drain = %+v (err=%v), want the seeded webhook", got, err)
	}
}
