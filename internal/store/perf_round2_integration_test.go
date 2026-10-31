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

func strPtr(s string) *string { return &s }

// Revoking a user's tokens reads their own GSI1 partition: every one of
// their tokens goes, nobody else's does.
func TestTokenStore_DeleteAllForUserReadsTheirPartition(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(db)
	for _, tok := range []*model.RefreshToken{tokenFor("u-a", "a-1"), tokenFor("u-a", "a-2"), tokenFor("u-other", "other-1")} {
		if err := s.StoreRefreshToken(ctx, tok); err != nil {
			t.Fatalf("Create %s: %v", tok.TokenHash, err)
		}
	}
	if err := s.DeleteAllRefreshTokensForUser(ctx, "u-a"); err != nil {
		t.Fatalf("DeleteAllForUser: %v", err)
	}
	for _, h := range []string{"a-1", "a-2"} {
		if _, err := s.GetRefreshToken(ctx, h); !errors.Is(err, ErrNotFound) {
			t.Fatalf("%s after revoke = %v, want gone", h, err)
		}
	}
	if _, err := s.GetRefreshToken(ctx, "other-1"); err != nil {
		t.Fatalf("other user's token must survive: %v", err)
	}
	if err := NewTokenStore(withFault(db, func(f *faultClient) { f.failQuery = true })).DeleteAllRefreshTokensForUser(ctx, "u-other"); !errors.Is(err, errInjected) {
		t.Fatalf("index query fault = %v, want errInjected", err)
	}
}

// --- webhook directory --------------------------------------------------

func webhookRow(id string) *model.IncomingWebhook {
	now := time.Now().Truncate(time.Millisecond)
	return &model.IncomingWebhook{ID: id, Title: id, ChannelID: "ch-1", CreatedBy: "admin", CreatedAt: now, UpdatedAt: now}
}

// The admin list reads the directory row, which every create and delete
// keeps current; before the first webhook there is no row and no webhooks.
func TestWebhookDirectory_ServesList(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewIncomingWebhookStore(db)

	got, err := s.List(ctx)
	if err != nil || len(got) != 0 {
		t.Fatalf("List before any webhook = %+v (err=%v), want empty", got, err)
	}
	for _, id := range []string{"wh-a", "wh-b"} {
		if err := s.Create(ctx, webhookRow(id)); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}
	got, err = s.List(ctx)
	if err != nil || len(got) != 2 {
		t.Fatalf("List = %+v (err=%v), want 2", got, err)
	}
	if err := s.Delete(ctx, "wh-a"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	got, err = s.List(ctx)
	if err != nil || len(got) != 1 || got[0].ID != "wh-b" {
		t.Fatalf("List after delete = %+v (err=%v), want only wh-b", got, err)
	}
}

func TestWebhookDirectory_SkipsHalfDeletedID(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewIncomingWebhookStore(db)
	if err := s.Create(ctx, webhookRow("wh-a")); err != nil {
		t.Fatalf("Create: %v", err)
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
			"PK":  &types.AttributeValueMemberS{Value: webhookDirPK},
			"SK":  &types.AttributeValueMemberS{Value: metaSK()},
			"ids": &types.AttributeValueMemberBOOL{Value: true},
		},
	}); err != nil {
		t.Fatalf("corrupt directory: %v", err)
	}
	_, err = NewIncomingWebhookStore(db).List(ctx)
	assertUnmarshalErr(t, err, "webhook directory row")
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
	if err := s.CreateUser(ctx, u); err != nil {
		t.Fatalf("Create: %v", err)
	}

	now := time.Now().Truncate(time.Millisecond)
	cleared, err := s.ClearUserStatusIfExpired(ctx, u.ID, clearAt, now)
	if err != nil || !cleared {
		t.Fatalf("ClearUserStatusIfExpired = %v (err=%v), want cleared", cleared, err)
	}
	got, err := s.GetUser(ctx, u.ID)
	if err != nil || got.UserStatus != nil {
		t.Fatalf("status after clear = %+v (err=%v), want nil", got.UserStatus, err)
	}

	// A fresh status set since the sweep observed the old one is preserved:
	// the conditional no-ops.
	newClear := time.Now().Add(time.Hour).Truncate(time.Millisecond)
	got.UserStatus = &model.UserStatus{Emoji: ":new:", Text: "back", ClearAt: &newClear}
	if err := s.UpdateUser(ctx, got); err != nil {
		t.Fatalf("Update: %v", err)
	}
	cleared, err = s.ClearUserStatusIfExpired(ctx, u.ID, clearAt, now)
	if err != nil || cleared {
		t.Fatalf("stale clear = %v (err=%v), want no-op", cleared, err)
	}
	fresh, _ := s.GetUser(ctx, u.ID)
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
	if err := s.StoreRefreshToken(ctx, tokenFor("u-bd", "bd-1")); err != nil {
		t.Fatalf("Create: %v", err)
	}
	faulted := NewTokenStore(withFault(db, func(f *faultClient) { f.failBatchWriteItem = true }))
	if err := faulted.DeleteAllRefreshTokensForUser(ctx, "u-bd"); !errors.Is(err, errInjected) {
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
