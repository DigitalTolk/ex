//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

func makeRunnerToken(id, userID string, created time.Time) *model.RunnerToken {
	return &model.RunnerToken{ID: id, UserID: userID, Label: "mac", CreatedAt: created, ExpiresAt: created.Add(30 * 24 * time.Hour)}
}

func makeRunnerGrant(hash string) *model.RunnerGrant {
	return &model.RunnerGrant{CodeHash: hash, UserID: "u-rt", Challenge: "chal", Label: "mac", ExpiresAt: time.Now().Add(5 * time.Minute).Truncate(time.Millisecond)}
}

func TestRunnerGrant_PutTakeOnce(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(db)

	g := makeRunnerGrant("h1")
	if err := s.PutRunnerGrant(ctx, g); err != nil {
		t.Fatalf("PutRunnerGrant: %v", err)
	}
	if err := s.PutRunnerGrant(ctx, g); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate code: want ErrAlreadyExists, got %v", err)
	}
	got, err := s.TakeRunnerGrant(ctx, "h1")
	if err != nil {
		t.Fatalf("TakeRunnerGrant: %v", err)
	}
	if got.UserID != "u-rt" || got.Challenge != "chal" || got.Label != "mac" || !got.ExpiresAt.Equal(g.ExpiresAt) {
		t.Fatalf("grant = %+v", got)
	}
	if _, err := s.TakeRunnerGrant(ctx, "h1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second take: want ErrNotFound, got %v", err)
	}
}

// Two redemptions racing: the row one of them read is already gone when its
// conditional delete lands, so it loses exactly like an unknown code.
func TestRunnerGrant_TakeLosesTheRace(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	phantom := mustAttrs(attributevalue.MarshalMap(runnerGrantItem{PK: runnerGrantPK("ghost"), SK: metaSK(), RunnerGrant: *makeRunnerGrant("ghost")}))
	s := NewTokenStore(withFault(db, func(f *faultClient) {
		f.transformGetItem = func(o *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
			o.Item = phantom
			return o
		}
	}))
	if _, err := s.TakeRunnerGrant(ctx, "ghost"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("lost race: want ErrNotFound, got %v", err)
	}
}

func TestRunnerToken_Lifecycle(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTokenStore(db)
	now := time.Now().Truncate(time.Millisecond)

	a := makeRunnerToken("rt-a", "u-rt", now.Add(-time.Hour))
	b := makeRunnerToken("rt-b", "u-rt", now)
	other := makeRunnerToken("rt-o", "u-other", now)
	for _, tok := range []*model.RunnerToken{a, b, other} {
		if err := s.PutRunnerToken(ctx, tok); err != nil {
			t.Fatalf("PutRunnerToken %s: %v", tok.ID, err)
		}
	}
	if err := s.PutRunnerToken(ctx, a); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate id: want ErrAlreadyExists, got %v", err)
	}

	got, err := s.GetRunnerToken(ctx, "rt-a")
	if err != nil || got.UserID != "u-rt" || got.Label != "mac" || !got.ExpiresAt.Equal(a.ExpiresAt) {
		t.Fatalf("GetRunnerToken = %+v, %v", got, err)
	}
	if _, err := s.GetRunnerToken(ctx, "rt-missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: want ErrNotFound, got %v", err)
	}

	later := now.Add(60 * 24 * time.Hour)
	if err := s.SetRunnerTokenExpiry(ctx, "rt-a", later); err != nil {
		t.Fatalf("SetRunnerTokenExpiry: %v", err)
	}
	if got, _ := s.GetRunnerToken(ctx, "rt-a"); !got.ExpiresAt.Equal(later) {
		t.Fatalf("expiry not updated: %v", got.ExpiresAt)
	}
	if err := s.SetRunnerTokenExpiry(ctx, "rt-missing", later); !errors.Is(err, ErrNotFound) {
		t.Fatalf("renew missing: want ErrNotFound, got %v", err)
	}

	mine, err := s.ListRunnerTokens(ctx, "u-rt")
	if err != nil || len(mine) != 2 {
		t.Fatalf("ListRunnerTokens = %+v, %v", mine, err)
	}

	if err := s.DeleteRunnerToken(ctx, "rt-b"); err != nil {
		t.Fatalf("DeleteRunnerToken: %v", err)
	}
	if err := s.DeleteRunnerToken(ctx, "rt-b"); err != nil {
		t.Fatalf("deleting twice must be idempotent: %v", err)
	}
	if err := s.DeleteAllRunnerTokensForUser(ctx, "u-rt"); err != nil {
		t.Fatalf("DeleteAllRunnerTokensForUser: %v", err)
	}
	if mine, _ := s.ListRunnerTokens(ctx, "u-rt"); len(mine) != 0 {
		t.Fatalf("tokens survived revoke-all: %+v", mine)
	}
	if _, err := s.GetRunnerToken(ctx, "rt-o"); err != nil {
		t.Fatalf("another user's token must survive: %v", err)
	}
}

func TestRunnerToken_Faults(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewTokenStore(db).PutRunnerGrant(ctx, makeRunnerGrant("h-live")); err != nil {
		t.Fatalf("seed grant: %v", err)
	}
	if err := NewTokenStore(db).PutRunnerToken(ctx, makeRunnerToken("rt-live", "u-rt", time.Now())); err != nil {
		t.Fatalf("seed token: %v", err)
	}
	faulted := func(cfg func(*faultClient)) *TokenStoreImpl { return NewTokenStore(withFault(db, cfg)) }
	wantInjected := func(name string, err error) {
		t.Helper()
		if !errors.Is(err, errInjected) {
			t.Errorf("%s: want errInjected, got %v", name, err)
		}
	}

	put := faulted(func(f *faultClient) { f.failPutItem = true })
	wantInjected("PutRunnerGrant", put.PutRunnerGrant(ctx, makeRunnerGrant("h-x")))
	wantInjected("PutRunnerToken", put.PutRunnerToken(ctx, makeRunnerToken("rt-x", "u-rt", time.Now())))

	get := faulted(func(f *faultClient) { f.failGetItem = true })
	_, err := get.TakeRunnerGrant(ctx, "h-live")
	wantInjected("TakeRunnerGrant get", err)
	_, err = get.GetRunnerToken(ctx, "rt-live")
	wantInjected("GetRunnerToken", err)

	_, err = faulted(func(f *faultClient) { f.failDeleteItem = true }).TakeRunnerGrant(ctx, "h-live")
	wantInjected("TakeRunnerGrant delete", err)
	wantInjected("DeleteRunnerToken", faulted(func(f *faultClient) { f.failDeleteItem = true }).DeleteRunnerToken(ctx, "rt-live"))
	wantInjected("SetRunnerTokenExpiry", faulted(func(f *faultClient) { f.failUpdateItem = true }).SetRunnerTokenExpiry(ctx, "rt-live", time.Now()))

	query := faulted(func(f *faultClient) { f.failQuery = true })
	_, err = query.ListRunnerTokens(ctx, "u-rt")
	wantInjected("ListRunnerTokens", err)
	wantInjected("DeleteAllRunnerTokensForUser", query.DeleteAllRunnerTokensForUser(ctx, "u-rt"))

	corrupt := faulted(func(f *faultClient) { f.transformGetItem = corruptGetItem })
	_, err = corrupt.TakeRunnerGrant(ctx, "h-live")
	assertUnmarshalErr(t, err, "TakeRunnerGrant")
	_, err = corrupt.GetRunnerToken(ctx, "rt-live")
	assertUnmarshalErr(t, err, "GetRunnerToken")
	_, err = faulted(func(f *faultClient) { f.transformQuery = corruptQuery }).ListRunnerTokens(ctx, "u-rt")
	assertUnmarshalErr(t, err, "ListRunnerTokens")
}
