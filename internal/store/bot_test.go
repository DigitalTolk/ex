//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func newTestBot(id, username string) *model.User {
	now := time.Now().Truncate(time.Millisecond)
	return &model.User{
		ID:             id,
		Email:          id + "@bots.ex.invalid",
		DisplayName:    "Incident Bot",
		Username:       username,
		BotDescription: "Opens incident channels",
		BotOwnerID:     "u-admin",
		SystemRole:     model.SystemRoleMember,
		Status:         "active",
		IsBot:          true,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
}

func TestBotStore_CreateBotWritesUserEmailAndUsername(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)
	users := NewUserStore(db)

	bot := newTestBot("b-1", "incident-bot")
	bot.Email = "B-1@Bots.ex.invalid"
	if err := s.CreateBot(ctx, bot); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	got, err := users.GetUser(ctx, "b-1")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if !got.IsBot || got.Username != "incident-bot" || got.BotDescription != "Opens incident channels" || got.BotOwnerID != "u-admin" {
		t.Fatalf("stored bot = %+v", got)
	}
	if byEmail, err := users.GetUserByEmail(ctx, "b-1@bots.ex.invalid"); err != nil || byEmail.ID != "b-1" {
		t.Fatalf("GetUserByEmail = %v, %v", byEmail, err)
	}
	// Listed with everyone else.
	listed, _, err := users.ListUsers(ctx, 10, "")
	if err != nil || len(listed) != 1 || listed[0].ID != "b-1" {
		t.Fatalf("ListUsers = %v, %v", listed, err)
	}
	if owner, err := s.UsernameOwner(ctx, "incident-bot"); err != nil || owner != "b-1" {
		t.Fatalf("UsernameOwner = %q, %v", owner, err)
	}
}

func TestBotStore_CreateBotRefusesATakenUsername(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)
	if err := s.CreateBot(ctx, newTestBot("b-1", "incident-bot")); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	if err := s.CreateBot(ctx, newTestBot("b-2", "incident-bot")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second CreateBot = %v, want ErrAlreadyExists", err)
	}
	// Nothing of the refused bot was written.
	if _, err := NewUserStore(db).GetUser(ctx, "b-2"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("refused bot's row: %v", err)
	}
}

func TestBotStore_UsernameOwnerOfNobody(t *testing.T) {
	db := setupDynamoDB(t)
	if _, err := NewBotStore(db).UsernameOwner(context.Background(), "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UsernameOwner = %v, want ErrNotFound", err)
	}
}

func TestBotStore_UpdateBotMovesTheUsername(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)
	users := NewUserStore(db)
	bot := newTestBot("b-1", "incident-bot")
	if err := s.CreateBot(ctx, bot); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	// Deactivated in the meantime: the profile write must not undo it.
	deactivated := "deactivated"
	if err := users.PatchUser(ctx, "b-1", UserPatch{Status: &deactivated}); err != nil {
		t.Fatalf("PatchUser: %v", err)
	}

	bot.Username, bot.DisplayName, bot.BotDescription = "incidents", "Incidents", ""
	bot.UpdatedAt = bot.UpdatedAt.Add(time.Minute)
	if err := s.UpdateBot(ctx, bot, "incident-bot"); err != nil {
		t.Fatalf("UpdateBot: %v", err)
	}
	got, err := users.GetUser(ctx, "b-1")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if got.Username != "incidents" || got.DisplayName != "Incidents" || got.BotDescription != "" || got.Status != "deactivated" {
		t.Fatalf("updated bot = %+v", got)
	}
	if !got.UpdatedAt.Equal(bot.UpdatedAt) {
		t.Fatalf("updatedAt = %v, want %v", got.UpdatedAt, bot.UpdatedAt)
	}
	if owner, err := s.UsernameOwner(ctx, "incidents"); err != nil || owner != "b-1" {
		t.Fatalf("new username owner = %q, %v", owner, err)
	}
	if _, err := s.UsernameOwner(ctx, "incident-bot"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("old username still claimed: %v", err)
	}
}

func TestBotStore_UpdateBotKeepingItsUsername(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)
	bot := newTestBot("b-1", "incident-bot")
	if err := s.CreateBot(ctx, bot); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	bot.DisplayName = "Renamed"
	if err := s.UpdateBot(ctx, bot, "incident-bot"); err != nil {
		t.Fatalf("UpdateBot: %v", err)
	}
	if owner, err := s.UsernameOwner(ctx, "incident-bot"); err != nil || owner != "b-1" {
		t.Fatalf("username owner = %q, %v", owner, err)
	}
}

// A migrated bot has no username yet: setting one claims it, with nothing to
// let go.
func TestBotStore_UpdateBotGivesAMigratedBotAUsername(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	migrated := newTestBot("b-old", "")
	migrated.Username = ""
	if err := NewUserStore(db).CreateUser(ctx, migrated); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	s := NewBotStore(db)
	migrated.Username = "alerts"
	if err := s.UpdateBot(ctx, migrated, ""); err != nil {
		t.Fatalf("UpdateBot: %v", err)
	}
	if owner, err := s.UsernameOwner(ctx, "alerts"); err != nil || owner != "b-old" {
		t.Fatalf("username owner = %q, %v", owner, err)
	}
}

func TestBotStore_UpdateBotRefusesATakenUsernameOrAMissingBot(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)
	if err := s.CreateBot(ctx, newTestBot("b-1", "incident-bot")); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	other := newTestBot("b-2", "general-bot")
	if err := s.CreateBot(ctx, other); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	other.Username = "incident-bot"
	if err := s.UpdateBot(ctx, other, "general-bot"); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("UpdateBot to a taken username = %v", err)
	}
	if owner, _ := s.UsernameOwner(ctx, "general-bot"); owner != "b-2" {
		t.Fatalf("refused rename let go of the old username: owner %q", owner)
	}
	gone := newTestBot("b-gone", "gone")
	if err := s.UpdateBot(ctx, gone, "gone"); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("UpdateBot of a missing bot = %v", err)
	}
}

// A deleted bot keeps its row (its messages keep their author) and lets its
// username go.
func TestBotStore_DeleteBotKeepsTheRowAndFreesTheUsername(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)
	users := NewUserStore(db)
	if err := s.CreateBot(ctx, newTestBot("b-1", "incident-bot")); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Truncate(time.Millisecond)
	if err := s.DeleteBot(ctx, "b-1", "incident-bot", at); err != nil {
		t.Fatalf("DeleteBot: %v", err)
	}
	got, err := users.GetUser(ctx, "b-1")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if got.BotDeletedAt == nil || !got.BotDeletedAt.Equal(at) || got.Username != "" || got.DisplayName != "Incident Bot" || !got.UpdatedAt.Equal(at) {
		t.Fatalf("deleted bot = %+v", got)
	}
	if _, err := s.UsernameOwner(ctx, "incident-bot"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("UsernameOwner after delete = %v, want not found", err)
	}
	if err := s.CreateBot(ctx, newTestBot("b-2", "incident-bot")); err != nil {
		t.Fatalf("a new bot taking the freed username: %v", err)
	}
}

// A migrated bot may have a username but no claim, or no username at all.
func TestBotStore_DeleteBotOfAMigratedBot(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)
	for _, username := range []string{"alerts", ""} {
		migrated := newTestBot("b-old-"+username, username)
		if err := NewUserStore(db).CreateUser(ctx, migrated); err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		if err := s.DeleteBot(ctx, migrated.ID, username, time.Now()); err != nil {
			t.Fatalf("DeleteBot(%q): %v", username, err)
		}
	}
}

func TestBotStore_DeleteBotRefusesAMissingBotOrAnotherBotsUsername(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)
	if err := s.DeleteBot(ctx, "b-missing", "", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteBot of a missing bot = %v, want not found", err)
	}
	if err := s.CreateBot(ctx, newTestBot("b-1", "incident-bot")); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateBot(ctx, newTestBot("b-2", "other-bot")); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteBot(ctx, "b-2", "incident-bot", time.Now()); !errors.Is(err, ErrNotFound) {
		t.Fatalf("DeleteBot letting go of another bot's username = %v, want not found", err)
	}
	if owner, err := s.UsernameOwner(ctx, "incident-bot"); err != nil || owner != "b-1" {
		t.Fatalf("username owner = %q, %v; want b-1 untouched", owner, err)
	}
}

func TestBotStore_Tokens(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)
	base := time.Now().Truncate(time.Millisecond)
	first := &model.BotToken{ID: "t-1", BotUserID: "b-1", Description: "CliffHub", CreatedBy: "u-admin", CreatedAt: base, TokenHash: "hash-1"}
	second := &model.BotToken{ID: "t-2", BotUserID: "b-1", Description: "Staging", CreatedBy: "u-admin", CreatedAt: base.Add(time.Second), TokenHash: "hash-2"}
	otherBot := &model.BotToken{ID: "t-3", BotUserID: "b-2", Description: "Other", CreatedBy: "u-admin", CreatedAt: base, TokenHash: "hash-3"}
	for _, tok := range []*model.BotToken{second, first, otherBot} {
		if err := s.PutBotToken(ctx, tok); err != nil {
			t.Fatalf("PutBotToken: %v", err)
		}
	}
	if err := s.PutBotToken(ctx, first); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("PutBotToken again = %v, want ErrAlreadyExists", err)
	}

	got, err := s.GetBotToken(ctx, "hash-1")
	if err != nil || got.ID != "t-1" || got.BotUserID != "b-1" || got.TokenHash != "hash-1" || !got.CreatedAt.Equal(base) {
		t.Fatalf("GetBotToken = %+v, %v", got, err)
	}

	list, err := s.ListBotTokens(ctx, "b-1")
	if err != nil {
		t.Fatalf("ListBotTokens: %v", err)
	}
	if len(list) != 2 || list[0].ID != "t-1" || list[1].ID != "t-2" {
		t.Fatalf("ListBotTokens = %+v, want t-1 then t-2", list)
	}

	if err := s.DeleteBotToken(ctx, "hash-1"); err != nil {
		t.Fatalf("DeleteBotToken: %v", err)
	}
	if _, err := s.GetBotToken(ctx, "hash-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked token still found: %v", err)
	}
	if err := s.DeleteBotToken(ctx, "hash-1"); err != nil {
		t.Fatalf("deleting a revoked token again: %v", err)
	}
}

func TestBotStore_ErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	tok := &model.BotToken{ID: "t-1", BotUserID: "b-1", CreatedAt: time.Now(), TokenHash: "hash-1"}

	failing := func(cfg func(*faultClient)) *BotStoreImpl { return NewBotStore(withFault(db, cfg)) }
	for name, err := range map[string]error{
		"CreateBot":      failing(func(f *faultClient) { f.failTransactWriteItems = true }).CreateBot(ctx, newTestBot("b-1", "x")),
		"UpdateBot":      failing(func(f *faultClient) { f.failTransactWriteItems = true }).UpdateBot(ctx, newTestBot("b-1", "x"), "x"),
		"PutBotToken":    failing(func(f *faultClient) { f.failPutItem = true }).PutBotToken(ctx, tok),
		"DeleteBotToken": failing(func(f *faultClient) { f.failDeleteItem = true }).DeleteBotToken(ctx, "hash-1"),
		"DeleteBot":      failing(func(f *faultClient) { f.failTransactWriteItems = true }).DeleteBot(ctx, "b-1", "x", time.Now()),
	} {
		if !errors.Is(err, errInjected) {
			t.Errorf("%s = %v, want errInjected", name, err)
		}
	}
	getFails := failing(func(f *faultClient) { f.failGetItem = true })
	if _, err := getFails.UsernameOwner(ctx, "x"); !errors.Is(err, errInjected) {
		t.Errorf("UsernameOwner = %v", err)
	}
	if _, err := getFails.GetBotToken(ctx, "hash-1"); !errors.Is(err, errInjected) {
		t.Errorf("GetBotToken = %v", err)
	}
	if _, err := failing(func(f *faultClient) { f.failQuery = true }).ListBotTokens(ctx, "b-1"); !errors.Is(err, errInjected) {
		t.Errorf("ListBotTokens = %v", err)
	}

	corrupt := failing(func(f *faultClient) {
		f.transformGetItem = corruptGetItem
		f.transformQuery = corruptQuery
	})
	_, err := corrupt.UsernameOwner(ctx, "x")
	assertUnmarshalErr(t, err, "UsernameOwner")
	_, err = corrupt.GetBotToken(ctx, "hash-1")
	assertUnmarshalErr(t, err, "GetBotToken")
	_, err = corrupt.ListBotTokens(ctx, "b-1")
	assertUnmarshalErr(t, err, "ListBotTokens")
}
