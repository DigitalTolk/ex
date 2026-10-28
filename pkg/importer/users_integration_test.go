//go:build integration

package importer

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/search"
	"github.com/DigitalTolk/ex/internal/store"
)

var t0 = time.Date(2021, 3, 4, 5, 6, 7, 0, time.UTC)

func TestUpsertUserAndUsers(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()

	created, err := e.im.UpsertUser(ctx, UserSpec{ID: "u1", Email: " Alice@Example.COM ", DisplayName: "Alice", CreatedAt: t0})
	if err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	// Idempotent: same ID again is a no-op.
	created, err = e.im.UpsertUser(ctx, UserSpec{ID: "u1", Email: "alice@example.com"})
	if err != nil || created {
		t.Fatalf("re-run: %v %v", created, err)
	}
	// Deactivated user, name falls back to the email local part.
	_, err = e.im.UpsertUser(ctx, UserSpec{ID: "u2", Email: "bob@example.com", Deactivated: true, CreatedAt: t0})
	mustNoErr(t, err)
	// Same email, another ID: never modified, reported with the existing ID.
	_, err = e.im.UpsertUser(ctx, UserSpec{ID: "other", Email: "ALICE@example.com"})
	var taken *EmailTakenError
	if !errors.As(err, &taken) || taken.ExistingID != "u1" || !strings.Contains(err.Error(), "u1") {
		t.Fatalf("want EmailTakenError, got %v", err)
	}
	if _, err := e.im.UpsertUser(ctx, UserSpec{ID: "x"}); err == nil {
		t.Fatal("missing email must fail")
	}

	origPage := usersPageSize
	usersPageSize = 1
	t.Cleanup(func() { usersPageSize = origPage })
	users, err := e.im.Users(ctx)
	mustNoErr(t, err)
	byID := map[string]User{}
	for _, u := range users {
		byID[u.ID] = u
	}
	if len(byID) != 2 || byID["u1"].Email != "alice@example.com" || byID["u1"].AuthProvider != string(model.AuthProviderOIDC) ||
		byID["u1"].SystemRole != string(model.SystemRoleMember) || byID["u1"].Status != "active" {
		t.Fatalf("users = %+v", users)
	}
	if byID["u2"].Status != "deactivated" || byID["u2"].DisplayName != "bob" {
		t.Fatalf("u2 = %+v", byID["u2"])
	}

	_, err = e.faulty(failOn("Query", 0)).Users(ctx)
	wantErr(t, err, errFault)
}

func TestUpsertUserErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	spec := UserSpec{ID: "u1", Email: "a@example.com", CreatedAt: t0}

	_, err := e.faulty(failOn("GetItem", 1)).UpsertUser(ctx, spec)
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("GetItem", 2)).UpsertUser(ctx, spec) // email lookup
	wantErr(t, err, errFault)
	_, err = e.faulty(failOn("TransactWriteItems", 0)).UpsertUser(ctx, spec)
	wantErr(t, err, errFault)

	// Index failures surface (on create and on an existing user).
	idx, _ := New(Deps{DB: e.db, Indexer: errIndexer{}})
	_, err = idx.UpsertUser(ctx, spec)
	wantErr(t, err, errFault)
	_, err = idx.UpsertUser(ctx, spec)
	wantErr(t, err, errFault)
}

func TestUpsertUserRace(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	us := store.NewUserStore(e.db)
	// Another writer creates the same user between the checks and the write.
	im := e.racing(func() {
		mustNoErr(t, us.CreateUser(ctx, &model.User{ID: "u1", Email: "a@example.com", CreatedAt: t0}))
	})
	created, err := im.UpsertUser(ctx, UserSpec{ID: "u1", Email: "a@example.com", CreatedAt: t0})
	if err != nil || created {
		t.Fatalf("race: %v %v", created, err)
	}

	// A dangling email index row (pointing at no user) blocks creation for
	// good: one retry, then the error is returned.
	_, err = e.db.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(e.db.Table),
		Item: map[string]types.AttributeValue{
			"PK":     &types.AttributeValueMemberS{Value: "USEREMAIL#ghost@example.com"},
			"SK":     &types.AttributeValueMemberS{Value: "PROFILE"},
			"userID": &types.AttributeValueMemberS{Value: "nobody"},
		},
	})
	mustNoErr(t, err)
	_, err = e.im.UpsertUser(ctx, UserSpec{ID: "u9", Email: "ghost@example.com", CreatedAt: t0})
	wantErr(t, err, store.ErrAlreadyExists)
}

func TestDisplayName(t *testing.T) {
	long := strings.Repeat("é", 100)
	if got := displayName(long, "x@y"); len([]rune(got)) != 80 {
		t.Fatalf("not capped: %d", len([]rune(got)))
	}
	if displayName("  ", "local@host") != "local" || displayName(" Ann ", "x") != "Ann" {
		t.Fatal("trim/fallback")
	}
}

func TestInvalidateUsers(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	mustNoErr(t, e.im.InvalidateUsers(ctx, nil))
	mustNoErr(t, e.im.InvalidateUsers(ctx, []string{"u1", "u2"}))
	if len(e.cache.deleted) != 2 {
		t.Fatalf("deleted = %v", e.cache.deleted)
	}
	e.cache.err = errFault
	wantErr(t, e.im.InvalidateUsers(ctx, []string{"u1"}), errFault)
	noCache, _ := New(Deps{DB: e.db})
	mustNoErr(t, noCache.InvalidateUsers(ctx, []string{"u1"}))
}

// recIndexer records per-user index calls.
type recIndexer struct {
	search.NoopIndexer
	indexed, deleted []string
	deleteErr        error
}

func (r *recIndexer) IndexUser(_ context.Context, u *model.User) error {
	r.indexed = append(r.indexed, u.ID)
	return nil
}

func (r *recIndexer) DeleteUser(_ context.Context, id string) error {
	r.deleted = append(r.deleted, id)
	return r.deleteErr
}

func TestUpsertBotUser(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	idx := &recIndexer{}
	im, _ := New(Deps{DB: e.db, Indexer: idx, Cache: e.cache})
	us := store.NewUserStore(e.db)

	// A new bot: machine account, undeliverable address, no sign-in, not in search.
	created, err := im.UpsertUser(ctx, UserSpec{ID: "B1", Email: "jira@example.com", DisplayName: "Jira", Bot: true, CreatedAt: t0})
	if err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	b, err := us.GetUser(ctx, "B1")
	mustNoErr(t, err)
	if !b.IsBot || b.Email != "b1@"+botEmailDomain || b.AuthProvider != "" || b.DisplayName != "Jira" {
		t.Fatalf("bot = %+v", b)
	}
	if len(idx.indexed) != 0 || len(idx.deleted) != 1 {
		t.Fatalf("indexed %v, deleted %v", idx.indexed, idx.deleted)
	}

	// A person an earlier import created becomes a bot.
	_, err = im.UpsertUser(ctx, UserSpec{ID: "u1", Email: "remind@example.com", CreatedAt: t0})
	mustNoErr(t, err)
	created, err = im.UpsertUser(ctx, UserSpec{ID: "u1", Bot: true})
	if err != nil || created {
		t.Fatalf("flip: %v %v", created, err)
	}
	u, err := us.GetUser(ctx, "u1")
	mustNoErr(t, err)
	if !u.IsBot || u.AuthProvider != "" || u.Email != "remind@example.com" {
		t.Fatalf("flipped = %+v", u)
	}
	if e.cache.deleted[len(e.cache.deleted)-1] != "u1" || idx.deleted[len(idx.deleted)-1] != "u1" {
		t.Fatalf("cache %v, search %v", e.cache.deleted, idx.deleted)
	}
	// Already a bot: nothing to change.
	_, err = im.UpsertUser(ctx, UserSpec{ID: "u1", Bot: true})
	mustNoErr(t, err)
}

func TestUpsertBotUserErrors(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, err := e.im.UpsertUser(ctx, UserSpec{ID: "u1", Email: "a@example.com", CreatedAt: t0})
	mustNoErr(t, err)

	// The update fails.
	_, err = e.faulty(failOn("PutItem", 1)).UpsertUser(ctx, UserSpec{ID: "u1", Bot: true})
	wantErr(t, err, errFault)
	// The cache can't be invalidated.
	e.cache.err = errFault
	_, err = e.im.UpsertUser(ctx, UserSpec{ID: "u1", Bot: true})
	wantErr(t, err, errFault)
	e.cache.err = nil
	// Search removal fails.
	idx, _ := New(Deps{DB: e.db, Indexer: &recIndexer{deleteErr: errFault}})
	_, err = idx.UpsertUser(ctx, UserSpec{ID: "B2", Bot: true})
	wantErr(t, err, errFault)
}
