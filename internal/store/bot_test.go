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

// The bot store, against DynamoDB Local. Two shapes drive the layout: bot
// metadata is keyed by the bot's user id, and token rows are keyed by the token's
// SHA-256 hash so authentication is a single keyed GetItem. A directory row holds
// the id set so the admin list never Scans the shared table.

func botFixture(id string) *model.BotAccount {
	now := time.Now().Truncate(time.Millisecond)
	return &model.BotAccount{
		UserID:      id,
		Name:        "Bot " + id,
		Description: "fixture",
		CreatedBy:   "admin-1",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func botTokenFixture(hash, botUserID string) *model.BotToken {
	return &model.BotToken{
		TokenHash: hash,
		TokenID:   "tid-" + hash,
		BotUserID: botUserID,
		Label:     "prod",
		CreatedAt: time.Now().Truncate(time.Millisecond),
	}
}

func TestBotStore_CreateGetList(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)

	bot := botFixture("bot-create-1")
	if err := s.CreateBot(ctx, bot); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}

	got, err := s.GetBot(ctx, bot.UserID)
	if err != nil {
		t.Fatalf("GetBot: %v", err)
	}
	if got.Name != bot.Name || got.CreatedBy != "admin-1" {
		t.Errorf("GetBot = %+v, want the stored row", got)
	}

	// The META row and its directory entry commit together, so a ConsistentRead
	// list can never miss a just-created bot.
	list, err := s.ListBots(ctx)
	if err != nil {
		t.Fatalf("ListBots: %v", err)
	}
	if !containsBotID(list, bot.UserID) {
		t.Errorf("ListBots = %+v, want it to include %s", list, bot.UserID)
	}
}

func TestBotStore_CreateDuplicateRejected(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)

	if err := s.CreateBot(ctx, botFixture("bot-dup")); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	if err := s.CreateBot(ctx, botFixture("bot-dup")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second CreateBot: %v, want ErrAlreadyExists", err)
	}
}

func TestBotStore_GetMissing(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewBotStore(db)
	if _, err := s.GetBot(context.Background(), "bot-absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("GetBot: %v, want ErrNotFound", err)
	}
}

// UpdateBot overwrites the META row and must leave the directory entry alone —
// otherwise setting a webhook would drop the bot out of the admin listing.
func TestBotStore_UpdatePreservesDirectoryEntry(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)

	bot := botFixture("bot-update")
	if err := s.CreateBot(ctx, bot); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	bot.CallbackURL = "https://bot.example.com/hook"
	bot.CallbackSecret = "exwhsec_x"
	bot.Transport = model.BotTransportMattermost
	bot.TriggerWords = []string{"deploy"}
	bot.TriggerWhen = model.BotTriggerWhenContains
	if err := s.UpdateBot(ctx, bot); err != nil {
		t.Fatalf("UpdateBot: %v", err)
	}

	got, err := s.GetBot(ctx, bot.UserID)
	if err != nil {
		t.Fatalf("GetBot: %v", err)
	}
	if got.CallbackURL != bot.CallbackURL || got.CallbackSecret != "exwhsec_x" ||
		got.Transport != model.BotTransportMattermost || got.TriggerWhen != model.BotTriggerWhenContains {
		t.Errorf("GetBot = %+v, want the webhook config persisted", got)
	}
	if len(got.TriggerWords) != 1 || got.TriggerWords[0] != "deploy" {
		t.Errorf("TriggerWords = %+v", got.TriggerWords)
	}
	list, err := s.ListBots(ctx)
	if err != nil {
		t.Fatalf("ListBots: %v", err)
	}
	if !containsBotID(list, bot.UserID) {
		t.Error("UpdateBot dropped the bot from the directory")
	}
}

// Removing from the directory keeps the META row: messages the bot authored must
// still resolve an author forever.
func TestBotStore_RemoveFromDirectoryKeepsMetaRow(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)

	bot := botFixture("bot-remove")
	if err := s.CreateBot(ctx, bot); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	if err := s.RemoveBotFromDirectory(ctx, bot.UserID); err != nil {
		t.Fatalf("RemoveBotFromDirectory: %v", err)
	}
	list, err := s.ListBots(ctx)
	if err != nil {
		t.Fatalf("ListBots: %v", err)
	}
	if containsBotID(list, bot.UserID) {
		t.Error("the bot is still listed after removal")
	}
	if _, err := s.GetBot(ctx, bot.UserID); err != nil {
		t.Errorf("GetBot after removal: %v, want the META row kept", err)
	}
}

// An id left in the directory whose META row is gone (a crashed half-remove) is
// skipped rather than failing the whole listing.
func TestBotStore_ListSkipsMissingMetaRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)

	bot := botFixture("bot-ghost-sibling")
	if err := s.CreateBot(ctx, bot); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	ghost := botFixture("bot-ghost")
	if err := s.CreateBot(ctx, ghost); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	// Delete only the META row, leaving the directory entry behind.
	if _, err := db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: &db.Table,
		Key:       compositeKey(botPK(ghost.UserID), metaSK()),
	}); err != nil {
		t.Fatalf("DeleteItem: %v", err)
	}

	list, err := s.ListBots(ctx)
	if err != nil {
		t.Fatalf("ListBots: %v", err)
	}
	if containsBotID(list, ghost.UserID) {
		t.Error("a bot with no META row was listed")
	}
	if !containsBotID(list, bot.UserID) {
		t.Error("the surviving bot was dropped")
	}
}

func TestBotStore_TokenLifecycle(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(db)

	bot := botFixture("bot-tokens")
	if err := s.CreateBot(ctx, bot); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	tok := botTokenFixture("hash-live", bot.UserID)
	if err := s.CreateBotToken(ctx, tok); err != nil {
		t.Fatalf("CreateBotToken: %v", err)
	}
	// Same hash twice would mean two rows authenticating the same secret.
	if err := s.CreateBotToken(ctx, tok); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate token: %v, want ErrAlreadyExists", err)
	}

	got, err := s.GetBotTokenByHash(ctx, tok.TokenHash)
	if err != nil {
		t.Fatalf("GetBotTokenByHash: %v", err)
	}
	if got.BotUserID != bot.UserID || got.Label != "prod" || got.Revoked() {
		t.Errorf("token = %+v, want a live token for the bot", got)
	}
	if _, err := s.GetBotTokenByHash(ctx, "hash-absent"); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown hash: %v, want ErrNotFound", err)
	}

	// GSI1 groups a bot's tokens, so listing is a Query rather than a Scan.
	second := botTokenFixture("hash-second", bot.UserID)
	if err := s.CreateBotToken(ctx, second); err != nil {
		t.Fatalf("CreateBotToken: %v", err)
	}
	tokens, err := s.ListBotTokens(ctx, bot.UserID)
	if err != nil {
		t.Fatalf("ListBotTokens: %v", err)
	}
	if len(tokens) != 2 {
		t.Errorf("ListBotTokens = %d, want 2", len(tokens))
	}
	// Another bot's tokens are a different partition.
	if others, err := s.ListBotTokens(ctx, "bot-nobody"); err != nil || len(others) != 0 {
		t.Errorf("ListBotTokens(other) = (%d, %v), want empty", len(others), err)
	}

	// Revocation is idempotent in the useful direction: revoking twice reports
	// ErrNotFound rather than silently succeeding.
	now := time.Now().Truncate(time.Millisecond)
	if err := s.RevokeBotToken(ctx, tok.TokenHash, now); err != nil {
		t.Fatalf("RevokeBotToken: %v", err)
	}
	if err := s.RevokeBotToken(ctx, tok.TokenHash, now); !errors.Is(err, ErrNotFound) {
		t.Errorf("second revoke: %v, want ErrNotFound", err)
	}
	if err := s.RevokeBotToken(ctx, "hash-absent", now); !errors.Is(err, ErrNotFound) {
		t.Errorf("revoke unknown: %v, want ErrNotFound", err)
	}
	revoked, err := s.GetBotTokenByHash(ctx, tok.TokenHash)
	if err != nil {
		t.Fatalf("GetBotTokenByHash: %v", err)
	}
	if !revoked.Revoked() {
		t.Error("the token is not marked revoked")
	}

	// LastUsedAt is credential hygiene metadata, stamped off the request path.
	if err := s.TouchBotTokenLastUsed(ctx, second.TokenHash, now); err != nil {
		t.Fatalf("TouchBotTokenLastUsed: %v", err)
	}
	touched, err := s.GetBotTokenByHash(ctx, second.TokenHash)
	if err != nil {
		t.Fatalf("GetBotTokenByHash: %v", err)
	}
	if touched.LastUsedAt == nil {
		t.Error("LastUsedAt was not stamped")
	}
	if err := s.TouchBotTokenLastUsed(ctx, "hash-absent", now); !errors.Is(err, ErrNotFound) {
		t.Errorf("touch unknown: %v, want ErrNotFound", err)
	}
}

// With no directory row at all, the listing is an empty slice — not an error.
func TestBotStore_ListEmptyDirectory(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewBotStore(withFault(db, func(f *faultClient) {
		f.transformGetItem = func(out *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
			out.Item = nil
			return out
		}
	}))
	list, err := s.ListBots(context.Background())
	if err != nil {
		t.Fatalf("ListBots: %v", err)
	}
	if list == nil || len(list) != 0 {
		t.Errorf("ListBots = %#v, want an empty non-nil slice", list)
	}
}

// --- SDK error arms --------------------------------------------------------

func TestBotStore_CreateTransactError(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewBotStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	if err := s.CreateBot(context.Background(), botFixture("bot-fault-create")); !errors.Is(err, errInjected) {
		t.Fatalf("CreateBot: want errInjected, got %v", err)
	}
}

func TestBotStore_UpdatePutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewBotStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	if err := s.UpdateBot(context.Background(), botFixture("bot-fault-update")); !errors.Is(err, errInjected) {
		t.Fatalf("UpdateBot: want errInjected, got %v", err)
	}
}

func TestBotStore_GetItemErrors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewBotStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	if _, err := s.GetBot(ctx, "anything"); !errors.Is(err, errInjected) {
		t.Fatalf("GetBot: want errInjected, got %v", err)
	}
	if _, err := s.GetBotTokenByHash(ctx, "anything"); !errors.Is(err, errInjected) {
		t.Fatalf("GetBotTokenByHash: want errInjected, got %v", err)
	}
	if _, err := s.ListBots(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("ListBots: want errInjected, got %v", err)
	}
}

func TestBotStore_RemoveFromDirectoryError(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewBotStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if err := s.RemoveBotFromDirectory(context.Background(), "bot-x"); !errors.Is(err, errInjected) {
		t.Fatalf("RemoveBotFromDirectory: want errInjected, got %v", err)
	}
}

func TestBotStore_TokenWriteErrors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	putFault := NewBotStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	if err := putFault.CreateBotToken(ctx, botTokenFixture("hash-fault", "bot-x")); !errors.Is(err, errInjected) {
		t.Fatalf("CreateBotToken: want errInjected, got %v", err)
	}

	updFault := NewBotStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	now := time.Now()
	if err := updFault.RevokeBotToken(ctx, "hash-fault", now); !errors.Is(err, errInjected) {
		t.Fatalf("RevokeBotToken: want errInjected, got %v", err)
	}
	if err := updFault.TouchBotTokenLastUsed(ctx, "hash-fault", now); !errors.Is(err, errInjected) {
		t.Fatalf("TouchBotTokenLastUsed: want errInjected, got %v", err)
	}
}

func TestBotStore_ListTokensQueryError(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewBotStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	if _, err := s.ListBotTokens(context.Background(), "bot-x"); !errors.Is(err, errInjected) {
		t.Fatalf("ListBotTokens: want errInjected, got %v", err)
	}
}

func TestBotStore_ListBatchGetError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewBotStore(db).CreateBot(ctx, botFixture("bot-fault-list")); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	s := NewBotStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true }))
	if _, err := s.ListBots(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("ListBots: want errInjected, got %v", err)
	}
}

// BatchGetItem may defer keys under throttling; the store must retry them rather
// than silently dropping those bots from the admin list.
func TestBotStore_ListRetriesUnprocessedKeys(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if err := NewBotStore(db).CreateBot(ctx, botFixture("bot-unproc")); err != nil {
		t.Fatalf("CreateBot: %v", err)
	}

	first := true
	s := NewBotStore(withFault(db, func(f *faultClient) {
		f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
			if !first {
				out.UnprocessedKeys = nil
				return out
			}
			first = false
			deferred := out.Responses[db.Table]
			keys := make([]map[string]types.AttributeValue, 0, len(deferred))
			for _, row := range deferred {
				keys = append(keys, map[string]types.AttributeValue{"PK": row["PK"], "SK": row["SK"]})
			}
			out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {}}
			out.UnprocessedKeys = map[string]types.KeysAndAttributes{db.Table: {Keys: keys}}
			return out
		}
	}))
	list, err := s.ListBots(ctx)
	if err != nil {
		t.Fatalf("ListBots: %v", err)
	}
	if !containsBotID(list, "bot-unproc") {
		t.Error("a bot deferred via UnprocessedKeys was dropped")
	}
}

// --- corrupt-row arms ------------------------------------------------------

func TestBotStore_CorruptRowArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	corruptGet := withFault(db, func(f *faultClient) {
		f.transformGetItem = func(out *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
			out.Item = corruptRow()
			return out
		}
	})

	t.Run("GetBot", func(t *testing.T) {
		_, err := NewBotStore(corruptGet).GetBot(ctx, "bot-corrupt")
		assertUnmarshalErr(t, err, "GetBot")
	})

	t.Run("GetBotTokenByHash", func(t *testing.T) {
		_, err := NewBotStore(corruptGet).GetBotTokenByHash(ctx, "hash-corrupt")
		assertUnmarshalErr(t, err, "GetBotTokenByHash")
	})

	t.Run("ListBots directory row", func(t *testing.T) {
		// The directory row projects only `ids`, so the corruption must hit it.
		faulted := withFault(db, func(f *faultClient) {
			f.transformGetItem = func(out *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
				out.Item = map[string]types.AttributeValue{
					"ids": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
				}
				return out
			}
		})
		_, err := NewBotStore(faulted).ListBots(ctx)
		assertUnmarshalErr(t, err, "ListBots directory")
	})

	t.Run("ListBots batch page", func(t *testing.T) {
		if err := NewBotStore(db).CreateBot(ctx, botFixture("bot-corrupt-list")); err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		faulted := withFault(db, func(f *faultClient) {
			f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
				out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {corruptRow()}}
				out.UnprocessedKeys = nil
				return out
			}
		})
		_, err := NewBotStore(faulted).ListBots(ctx)
		assertUnmarshalErr(t, err, "ListBots batch")
	})

	t.Run("ListBotTokens page", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) {
			f.transformQuery = func(out *dynamodb.QueryOutput) *dynamodb.QueryOutput {
				out.Items = []map[string]types.AttributeValue{corruptRow()}
				return out
			}
		})
		_, err := NewBotStore(faulted).ListBotTokens(ctx, "bot-x")
		assertUnmarshalErr(t, err, "ListBotTokens")
	})
}

func containsBotID(list []*model.BotAccount, id string) bool {
	for _, b := range list {
		if b != nil && b.UserID == id {
			return true
		}
	}
	return false
}
