package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// The error and edge arms of BotService that the happy-path tests in bot_test.go
// don't reach: built-in provisioning, the read-back pair, and every place a store
// failure has to be reported rather than swallowed.

// botStoreFailingOn wraps fakeBotStore and fails the named operations.
type botStoreFailingOn struct {
	*fakeBotStore
	failGetBot            bool
	failCreateBot         bool
	failUpdateBot         bool
	failListTokens        bool
	failRevoke            bool
	failRemoveFromDir     bool
	failCreateToken       bool
	failGetTokenByHashErr error
}

var errBotStore = errors.New("bot store unavailable")

func (b *botStoreFailingOn) GetBot(ctx context.Context, id string) (*model.BotAccount, error) {
	if b.failGetBot {
		return nil, errBotStore
	}
	return b.fakeBotStore.GetBot(ctx, id)
}

func (b *botStoreFailingOn) CreateBot(ctx context.Context, bot *model.BotAccount) error {
	if b.failCreateBot {
		return errBotStore
	}
	return b.fakeBotStore.CreateBot(ctx, bot)
}

func (b *botStoreFailingOn) UpdateBot(ctx context.Context, bot *model.BotAccount) error {
	if b.failUpdateBot {
		return errBotStore
	}
	return b.fakeBotStore.UpdateBot(ctx, bot)
}

func (b *botStoreFailingOn) ListBotTokens(ctx context.Context, id string) ([]*model.BotToken, error) {
	if b.failListTokens {
		return nil, errBotStore
	}
	return b.fakeBotStore.ListBotTokens(ctx, id)
}

func (b *botStoreFailingOn) RevokeBotToken(ctx context.Context, hash string, at time.Time) error {
	if b.failRevoke {
		return errBotStore
	}
	return b.fakeBotStore.RevokeBotToken(ctx, hash, at)
}

func (b *botStoreFailingOn) RemoveBotFromDirectory(ctx context.Context, id string) error {
	if b.failRemoveFromDir {
		return errBotStore
	}
	return b.fakeBotStore.RemoveBotFromDirectory(ctx, id)
}

func (b *botStoreFailingOn) CreateBotToken(ctx context.Context, tok *model.BotToken) error {
	if b.failCreateToken {
		return errBotStore
	}
	return b.fakeBotStore.CreateBotToken(ctx, tok)
}

func (b *botStoreFailingOn) GetBotTokenByHash(ctx context.Context, hash string) (*model.BotToken, error) {
	if b.failGetTokenByHashErr != nil {
		return nil, b.failGetTokenByHashErr
	}
	return b.fakeBotStore.GetBotTokenByHash(ctx, hash)
}

func failingBotStore() *botStoreFailingOn {
	return &botStoreFailingOn{fakeBotStore: newFakeBotStore()}
}

// userStoreFailingOn wraps mockUserStore to fail specific operations. It embeds
// the concrete mock rather than an interface so it satisfies BOTH the store-level
// and service-level user interfaces (BotService and UserService take different
// ones).
type userStoreFailingOn struct {
	*mockUserStore
	getErr    error
	createErr error
	updateErr error
}

func (u userStoreFailingOn) GetUser(ctx context.Context, id string) (*model.User, error) {
	if u.getErr != nil {
		return nil, u.getErr
	}
	return u.mockUserStore.GetUser(ctx, id)
}

func (u userStoreFailingOn) CreateUser(ctx context.Context, user *model.User) error {
	if u.createErr != nil {
		return u.createErr
	}
	return u.mockUserStore.CreateUser(ctx, user)
}

func (u userStoreFailingOn) UpdateUser(ctx context.Context, user *model.User) error {
	if u.updateErr != nil {
		return u.updateErr
	}
	return u.mockUserStore.UpdateUser(ctx, user)
}

func TestSetUserService(t *testing.T) {
	// Wired after construction to break the initialization cycle between the two.
	svc := NewBotService(newFakeBotStore(), newMockUserStore())
	svc.SetUserService(&UserService{})
	if svc.userSvc == nil {
		t.Error("SetUserService did not take effect")
	}
}

func TestEnsureBot(t *testing.T) {
	ctx := context.Background()

	t.Run("provisions a built-in bot at a fixed id", func(t *testing.T) {
		bots, users := newFakeBotStore(), newMockUserStore()
		svc := NewBotService(bots, users)
		user, err := svc.EnsureBot(ctx, "bot_cliffy", "Cliffy")
		if err != nil {
			t.Fatalf("EnsureBot: %v", err)
		}
		if user.ID != "bot_cliffy" || user.AuthProvider != model.AuthProviderBot ||
			user.SystemRole != model.SystemRoleMember || user.Status != "active" {
			t.Errorf("user = %+v, want an active bot member at the fixed id", user)
		}
		// The synthetic address is in a reserved domain, so it can't collide with a
		// real one the IdP might issue.
		if !strings.HasSuffix(user.Email, "@"+botEmailDomain) {
			t.Errorf("Email = %q, want the reserved bot domain", user.Email)
		}
		bot, err := bots.GetBot(ctx, "bot_cliffy")
		if err != nil {
			t.Fatalf("GetBot: %v", err)
		}
		if bot.CreatedBy != "system" {
			t.Errorf("CreatedBy = %q, want \"system\" so the admin UI shows it read-only", bot.CreatedBy)
		}
	})

	t.Run("is idempotent across restarts", func(t *testing.T) {
		bots, users := newFakeBotStore(), newMockUserStore()
		svc := NewBotService(bots, users)
		first, err := svc.EnsureBot(ctx, "bot_cliffy", "Cliffy")
		if err != nil {
			t.Fatalf("EnsureBot: %v", err)
		}
		second, err := svc.EnsureBot(ctx, "bot_cliffy", "Cliffy renamed")
		if err != nil {
			t.Fatalf("EnsureBot (again): %v", err)
		}
		if second.ID != first.ID || second.DisplayName != first.DisplayName {
			t.Errorf("second call = %+v, want the existing user returned unchanged", second)
		}
	})

	t.Run("rejects an id without the bot prefix", func(t *testing.T) {
		// Otherwise the id would be indistinguishable from a human's, and
		// IsBotUserID-based loop protection would stop working.
		svc := NewBotService(newFakeBotStore(), newMockUserStore())
		if _, err := svc.EnsureBot(ctx, "cliffy", "Cliffy"); err == nil {
			t.Fatal("want a rejection for an unprefixed id")
		}
	})

	t.Run("a lookup failure other than not-found is reported", func(t *testing.T) {
		users := userStoreFailingOn{mockUserStore: newMockUserStore(), getErr: errors.New("dynamo down")}
		svc := NewBotService(newFakeBotStore(), users)
		if _, err := svc.EnsureBot(ctx, "bot_cliffy", "Cliffy"); err == nil {
			t.Fatal("want the lookup failure reported rather than treated as absent")
		}
	})

	t.Run("a user create failure is fatal", func(t *testing.T) {
		users := userStoreFailingOn{mockUserStore: newMockUserStore(), createErr: errors.New("dynamo down")}
		svc := NewBotService(newFakeBotStore(), users)
		if _, err := svc.EnsureBot(ctx, "bot_cliffy", "Cliffy"); err == nil {
			t.Fatal("want the create failure reported — there is no identity without it")
		}
	})

	t.Run("a metadata failure still yields a usable identity", func(t *testing.T) {
		// The user row is what posting and auth need; the admin metadata is
		// best-effort, so a failed write must not block boot.
		bots := failingBotStore()
		bots.failCreateBot = true
		svc := NewBotService(bots, newMockUserStore())
		user, err := svc.EnsureBot(ctx, "bot_cliffy", "Cliffy")
		if err != nil {
			t.Fatalf("EnsureBot: %v", err)
		}
		if user == nil || user.ID != "bot_cliffy" {
			t.Errorf("user = %+v, want the identity despite the metadata failure", user)
		}
	})
}

func TestGetBot(t *testing.T) {
	ctx := context.Background()

	t.Run("returns metadata alongside the user row", func(t *testing.T) {
		bots, users := newFakeBotStore(), newMockUserStore()
		svc := NewBotService(bots, users)
		created, _, err := svc.CreateBot(ctx, "admin1", "Helper", "does things")
		if err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		bot, user, err := svc.GetBot(ctx, created.ID)
		if err != nil {
			t.Fatalf("GetBot: %v", err)
		}
		if bot.Name != "Helper" || user.ID != created.ID {
			t.Errorf("GetBot = (%+v, %+v)", bot, user)
		}
	})

	t.Run("an unknown bot is not found", func(t *testing.T) {
		svc := NewBotService(newFakeBotStore(), newMockUserStore())
		if _, _, err := svc.GetBot(ctx, "bot_absent"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("metadata without a user row reports as missing", func(t *testing.T) {
		// A broken half-create must not hand back an unusable bot.
		bots := newFakeBotStore()
		if err := bots.CreateBot(ctx, &model.BotAccount{UserID: "bot_orphan", Name: "Orphan"}); err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		svc := NewBotService(bots, newMockUserStore())
		if _, _, err := svc.GetBot(ctx, "bot_orphan"); err == nil {
			t.Fatal("want an error for metadata with no user row")
		}
	})
}

func TestCreateBot_StoreFailures(t *testing.T) {
	ctx := context.Background()

	t.Run("a user create failure is reported", func(t *testing.T) {
		users := userStoreFailingOn{mockUserStore: newMockUserStore(), createErr: errors.New("dynamo down")}
		svc := NewBotService(newFakeBotStore(), users)
		if _, _, err := svc.CreateBot(ctx, "admin1", "Helper", ""); err == nil {
			t.Fatal("want the create failure reported")
		}
	})

	t.Run("an over-long name is rejected", func(t *testing.T) {
		svc := NewBotService(newFakeBotStore(), newMockUserStore())
		long := strings.Repeat("n", MaxUserDisplayNameLen+1)
		if _, _, err := svc.CreateBot(ctx, "admin1", long, ""); err == nil {
			t.Fatal("want a rejection for an over-long name")
		}
	})

	t.Run("the compensating deactivation is itself best-effort", func(t *testing.T) {
		// Metadata write fails → the orphan user is deactivated so the leftover is
		// inert. If THAT write also fails there is nothing more to do but log.
		bots := failingBotStore()
		bots.failCreateBot = true
		users := userStoreFailingOn{mockUserStore: newMockUserStore(), updateErr: errors.New("dynamo down")}
		svc := NewBotService(bots, users)
		if _, _, err := svc.CreateBot(ctx, "admin1", "Helper", ""); err == nil {
			t.Fatal("want the metadata failure reported")
		}
	})
}

func TestDeleteBot_StoreFailures(t *testing.T) {
	ctx := context.Background()

	seed := func(t *testing.T, bots store.BotStore, users store.UserStore) string {
		t.Helper()
		svc := NewBotService(bots, users)
		user, _, err := svc.CreateBot(ctx, "admin1", "Helper", "")
		if err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		return user.ID
	}

	t.Run("deactivates directly when no user service is wired", func(t *testing.T) {
		bots, users := newFakeBotStore(), newMockUserStore()
		id := seed(t, bots, users)
		if err := NewBotService(bots, users).DeleteBot(ctx, id); err != nil {
			t.Fatalf("DeleteBot: %v", err)
		}
		user, err := users.GetUser(ctx, id)
		if err != nil {
			t.Fatalf("GetUser: %v", err)
		}
		if user.Status != "deactivated" {
			t.Errorf("status = %q, want deactivated", user.Status)
		}
	})

	t.Run("an unknown bot is not found", func(t *testing.T) {
		svc := NewBotService(newFakeBotStore(), newMockUserStore())
		if err := svc.DeleteBot(ctx, "bot_absent"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("a token listing failure aborts", func(t *testing.T) {
		bots, users := failingBotStore(), newMockUserStore()
		id := seed(t, bots, users)
		bots.failListTokens = true
		if err := NewBotService(bots, users).DeleteBot(ctx, id); err == nil {
			t.Fatal("want an abort: tokens left live are working credentials")
		}
	})

	t.Run("a revoke failure aborts rather than continuing to deactivation", func(t *testing.T) {
		bots, users := failingBotStore(), newMockUserStore()
		id := seed(t, bots, users)
		svc := NewBotService(bots, users)
		if _, _, err := svc.IssueToken(ctx, id, "prod"); err != nil {
			t.Fatalf("IssueToken: %v", err)
		}
		bots.failRevoke = true
		if err := NewBotService(bots, users).DeleteBot(ctx, id); err == nil {
			t.Fatal("want an abort when a token can't be revoked")
		}
	})

	t.Run("a webhook-clear failure aborts", func(t *testing.T) {
		bots, users := failingBotStore(), newMockUserStore()
		id := seed(t, bots, users)
		bots.failUpdateBot = true
		if err := NewBotService(bots, users).DeleteBot(ctx, id); err == nil {
			t.Fatal("want an abort: a retired bot that stays dispatchable would still reply")
		}
	})

	t.Run("a directory removal failure is reported", func(t *testing.T) {
		bots, users := failingBotStore(), newMockUserStore()
		id := seed(t, bots, users)
		bots.failRemoveFromDir = true
		if err := NewBotService(bots, users).DeleteBot(ctx, id); err == nil {
			t.Fatal("want the removal failure reported")
		}
	})

	t.Run("a deactivation failure is reported", func(t *testing.T) {
		bots := newFakeBotStore()
		base := newMockUserStore()
		id := seed(t, bots, base)
		users := userStoreFailingOn{mockUserStore: base, updateErr: errors.New("dynamo down")}
		if err := NewBotService(bots, users).DeleteBot(ctx, id); err == nil {
			t.Fatal("want the deactivation failure reported")
		}
	})

	t.Run("a missing user row on deactivation is reported", func(t *testing.T) {
		bots := newFakeBotStore()
		base := newMockUserStore()
		id := seed(t, bots, base)
		users := userStoreFailingOn{mockUserStore: base, getErr: store.ErrNotFound}
		if err := NewBotService(bots, users).DeleteBot(ctx, id); err == nil {
			t.Fatal("want the missing user row reported")
		}
	})

	t.Run("an already-revoked token is skipped", func(t *testing.T) {
		bots, users := newFakeBotStore(), newMockUserStore()
		id := seed(t, bots, users)
		svc := NewBotService(bots, users)
		plaintext, tok, err := svc.IssueToken(ctx, id, "prod")
		if err != nil || plaintext == "" {
			t.Fatalf("IssueToken: %v", err)
		}
		if err := svc.RevokeToken(ctx, id, tok.TokenID); err != nil {
			t.Fatalf("RevokeToken: %v", err)
		}
		if err := svc.DeleteBot(ctx, id); err != nil {
			t.Fatalf("DeleteBot: %v", err)
		}
	})
}

func TestIssueToken_Arms(t *testing.T) {
	ctx := context.Background()

	t.Run("an unknown bot is not found", func(t *testing.T) {
		svc := NewBotService(newFakeBotStore(), newMockUserStore())
		if _, _, err := svc.IssueToken(ctx, "bot_absent", ""); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("a missing user row is reported", func(t *testing.T) {
		bots := newFakeBotStore()
		if err := bots.CreateBot(ctx, &model.BotAccount{UserID: "bot_orphan"}); err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		svc := NewBotService(bots, newMockUserStore())
		if _, _, err := svc.IssueToken(ctx, "bot_orphan", ""); err == nil {
			t.Fatal("want an error for a bot with no user row")
		}
	})

	t.Run("a randomness failure is reported", func(t *testing.T) {
		bots, users := newFakeBotStore(), newMockUserStore()
		svc := NewBotService(bots, users)
		user, _, err := svc.CreateBot(ctx, "admin1", "Helper", "")
		if err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		restore := randRead
		randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
		t.Cleanup(func() { randRead = restore })
		if _, _, err := svc.IssueToken(ctx, user.ID, ""); err == nil {
			t.Fatal("want the failure surfaced rather than a weak token")
		}
	})

	t.Run("a token write failure is reported", func(t *testing.T) {
		bots, users := failingBotStore(), newMockUserStore()
		svc := NewBotService(bots, users)
		user, _, err := svc.CreateBot(ctx, "admin1", "Helper", "")
		if err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		bots.failCreateToken = true
		if _, _, err := svc.IssueToken(ctx, user.ID, ""); err == nil {
			t.Fatal("want the write failure reported")
		}
	})
}

func TestListAndRevokeToken_Arms(t *testing.T) {
	ctx := context.Background()

	t.Run("listing an unknown bot's tokens is not found", func(t *testing.T) {
		svc := NewBotService(newFakeBotStore(), newMockUserStore())
		if _, err := svc.ListTokens(ctx, "bot_absent"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})

	t.Run("a listing failure during revoke is reported", func(t *testing.T) {
		bots := failingBotStore()
		bots.failListTokens = true
		svc := NewBotService(bots, newMockUserStore())
		if err := svc.RevokeToken(ctx, "bot_x", "tid"); err == nil {
			t.Fatal("want the listing failure reported")
		}
	})

	t.Run("an unknown token id is not found", func(t *testing.T) {
		// Scoped to the bot, so a guessed token id can't revoke another bot's.
		svc := NewBotService(newFakeBotStore(), newMockUserStore())
		if err := svc.RevokeToken(ctx, "bot_x", "tid-absent"); !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want ErrNotFound", err)
		}
	})
}

func TestValidateBotToken_StoreFailure(t *testing.T) {
	// A lookup failure that isn't "absent" must not be reported as an invalid
	// token: that would turn a Dynamo outage into a silent mass logout.
	bots := failingBotStore()
	bots.failGetTokenByHashErr = errors.New("dynamo down")
	svc := NewBotService(bots, newMockUserStore())
	_, err := svc.ValidateBotToken(context.Background(), model.BotTokenPrefix+"whatever")
	if err == nil || errors.Is(err, ErrBotTokenInvalid) {
		t.Fatalf("err = %v, want a distinct store failure", err)
	}
}

func TestTouchLastUsed_WriteFailureIsBestEffort(t *testing.T) {
	// Credential hygiene metadata: a failed stamp is logged and forgotten, never
	// surfaced into the request that triggered it.
	bots := newFakeBotStore()
	svc := NewBotService(bots, newMockUserStore())
	svc.touchLastUsed(context.Background(), "hash-absent")
}

func TestConfigureWebhook_SecretAndWriteFailures(t *testing.T) {
	ctx := context.Background()

	t.Run("a randomness failure is reported", func(t *testing.T) {
		bots := newFakeBotStore()
		if err := bots.CreateBot(ctx, &model.BotAccount{UserID: "bot_a", Name: "Helper"}); err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		svc := NewBotService(bots, newMockUserStore())
		restore := randRead
		randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
		t.Cleanup(func() { randRead = restore })

		// Without a secret the receiver could never verify a call, so this fails
		// rather than configuring an unauthenticated webhook.
		_, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{CallbackURL: "https://bot.example.com/hook"})
		if err == nil {
			t.Fatal("want the failure surfaced")
		}
	})

	t.Run("a store write failure is reported", func(t *testing.T) {
		bots := failingBotStore()
		if err := bots.CreateBot(ctx, &model.BotAccount{UserID: "bot_a", Name: "Helper"}); err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		bots.failUpdateBot = true
		svc := NewBotService(bots, newMockUserStore())
		if _, err := svc.ConfigureWebhook(ctx, "bot_a", BotWebhookConfig{
			CallbackURL: "https://bot.example.com/hook",
		}); err == nil {
			t.Fatal("want the write failure reported")
		}
	})
}

// With a user service wired (production), retirement routes through it so the
// cache invalidation, force-logout broadcast, and search re-index all run.
func TestDeleteBot_RoutesThroughUserService(t *testing.T) {
	ctx := context.Background()

	t.Run("deactivates via the user service", func(t *testing.T) {
		bots, users := newFakeBotStore(), newMockUserStore()
		botSvc := NewBotService(bots, users)
		user, _, err := botSvc.CreateBot(ctx, "admin1", "Helper", "")
		if err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		botSvc.SetUserService(NewUserService(users, newMockCache(), nil, newMockPublisher()))

		if err := botSvc.DeleteBot(ctx, user.ID); err != nil {
			t.Fatalf("DeleteBot: %v", err)
		}
		got, err := users.GetUser(ctx, user.ID)
		if err != nil {
			t.Fatalf("GetUser: %v", err)
		}
		if got.Status != "deactivated" {
			t.Errorf("status = %q, want deactivated", got.Status)
		}
	})

	t.Run("a deactivation failure is reported", func(t *testing.T) {
		bots := newFakeBotStore()
		base := newMockUserStore()
		botSvc := NewBotService(bots, base)
		user, _, err := botSvc.CreateBot(ctx, "admin1", "Helper", "")
		if err != nil {
			t.Fatalf("CreateBot: %v", err)
		}
		failing := userStoreFailingOn{mockUserStore: base, updateErr: errors.New("dynamo down")}
		botSvc.SetUserService(NewUserService(failing, newMockCache(), nil, newMockPublisher()))
		if err := botSvc.DeleteBot(ctx, user.ID); err == nil {
			t.Fatal("want the deactivation failure reported")
		}
	})
}

// A bot's token is a long-lived credential held outside ex, so granting it admin
// would hand workspace administration to whoever holds that token. Bots stay
// members for their whole lifetime.
func TestUpdateRole_RefusesToPromoteABot(t *testing.T) {
	users := newMockUserStore()
	if err := users.CreateUser(context.Background(), &model.User{
		ID: "bot_x", Email: "bot_x@bots.invalid", AuthProvider: model.AuthProviderBot,
		SystemRole: model.SystemRoleMember, Status: "active",
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	svc := NewUserService(users, newMockCache(), nil, newMockPublisher())
	if _, err := svc.UpdateRole(context.Background(), "u-admin", "bot_x", model.SystemRoleAdmin); err == nil {
		t.Fatal("want a refusal to promote a bot account")
	}
}
