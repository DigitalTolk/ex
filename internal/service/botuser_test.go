package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// SECURITY REGRESSION: a webhook's ID is its bearer credential — randomWebhookID
// mints 32 CSPRNG bytes and POST /hooks/{id} has no other authentication, so
// anyone holding it can post as the integration and DM the whole workspace.
// The bot's ID goes the other way: it is published to every recipient as the
// message authorID, listed in the conversation's participantIDs, and echoed
// with the bot's email by /api/v1/users/batch, which any member may call.
//
// So the bot ID must never contain, or be reversible to, the webhook ID. An
// earlier revision derived it as "bot-"+webhookID, which handed a working
// webhook URL to everyone the integration messaged.
func TestWebhookBotUserID_DoesNotLeakTheWebhookCredential(t *testing.T) {
	secret := "kJ3sVQ8pL2nR7tX4wY6zB9cD1fG5hJ0mN2qS4uV8xZa"
	botID := WebhookBotUserID(secret)

	if strings.Contains(botID, secret) {
		t.Fatalf("bot ID %q embeds the webhook credential", botID)
	}
	// Also reject any substantial prefix, which would shortcut a brute force.
	for n := 8; n <= len(secret); n++ {
		if strings.Contains(botID, secret[:n]) {
			t.Fatalf("bot ID %q leaks a %d-char prefix of the webhook credential", botID, n)
		}
	}
	// The bot's email is just as public — /api/v1/users/batch returns it.
	bot, err := NewUserService(newMockUserStore(), nil, nil, nil).EnsureBotUser(context.Background(), botID, "Bot")
	if err != nil {
		t.Fatalf("EnsureBotUser: %v", err)
	}
	if strings.Contains(bot.Email, secret) {
		t.Fatalf("bot email %q embeds the webhook credential", bot.Email)
	}
}

// Derivation must stay a pure function of the webhook ID: that is what makes
// provisioning idempotent under concurrent deliveries without a stored mapping.
func TestWebhookBotUserID_IsStableAndDistinct(t *testing.T) {
	if a, b := WebhookBotUserID("wh-1"), WebhookBotUserID("wh-1"); a != b {
		t.Errorf("derivation is not stable: %q vs %q", a, b)
	}
	if a, b := WebhookBotUserID("wh-1"), WebhookBotUserID("wh-2"); a == b {
		t.Errorf("distinct webhooks derived the same bot ID %q", a)
	}
	// Namespaced so it can never collide with a real user's ULID.
	if got := WebhookBotUserID("wh-1"); !isBotUserID(got) {
		t.Errorf("derived ID %q is not in the machine-account namespace", got)
	}
}

func TestEnsureBotUser_CreatesOnFirstUseAndIsIdempotent(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)
	ctx := context.Background()
	botID := WebhookBotUserID("wh")

	bot, err := svc.EnsureBotUser(ctx, botID, "Deploy Bot")
	if err != nil {
		t.Fatalf("EnsureBotUser: %v", err)
	}
	if !bot.IsBot {
		t.Error("bot account must be flagged IsBot so it stays out of the directory")
	}
	if bot.DisplayName != "Deploy Bot" {
		t.Errorf("display name = %q", bot.DisplayName)
	}
	// RFC 2606 reserves .invalid: the address can never resolve.
	if !strings.HasSuffix(bot.Email, ".invalid") {
		t.Errorf("bot email = %q, want an undeliverable .invalid address", bot.Email)
	}
	if bot.Status != "active" {
		t.Errorf("status = %q, want active so the account can hold a conversation", bot.Status)
	}

	if again, err := svc.EnsureBotUser(ctx, botID, "Deploy Bot"); err != nil || again.ID != bot.ID {
		t.Fatalf("second call = %v, %v; want the existing account", again, err)
	}
	if len(users.users) != 1 {
		t.Errorf("created %d accounts, want 1", len(users.users))
	}
}

// Renaming the webhook renames the account, so threads created afterwards
// carry the current name — and the cached profile is dropped, or /users/me
// keeps serving the old one.
func TestEnsureBotUser_RenameUpdatesAccountAndCache(t *testing.T) {
	users, cache := newMockUserStore(), newMockCache()
	svc := NewUserService(users, cache, nil, nil)
	ctx := context.Background()
	botID := WebhookBotUserID("wh")

	if _, err := svc.EnsureBotUser(ctx, botID, "Old"); err != nil {
		t.Fatalf("EnsureBotUser: %v", err)
	}
	cache.values["user:"+botID] = "stale"

	bot, err := svc.EnsureBotUser(ctx, botID, "New")
	if err != nil {
		t.Fatalf("EnsureBotUser rename: %v", err)
	}
	if bot.DisplayName != "New" {
		t.Errorf("display name = %q, want %q", bot.DisplayName, "New")
	}
	if _, stale := cache.values["user:"+botID]; stale {
		t.Error("rename left a stale cached profile behind")
	}

	// A rename that cannot be persisted must not fail the delivery.
	users.updateErr = errors.New("throttled")
	if _, err := svc.EnsureBotUser(ctx, botID, "Newer"); err != nil {
		t.Fatalf("rename failure should not fail provisioning, got %v", err)
	}
}

// Provisioning is an exported write: a human's ULID would overwrite their
// account with IsBot set.
func TestEnsureBotUser_RejectsNonBotID(t *testing.T) {
	if _, err := NewUserService(newMockUserStore(), nil, nil, nil).
		EnsureBotUser(context.Background(), "01H8XUSER", "Nope"); err == nil {
		t.Fatal("provisioning a non-bot ID should fail")
	}
}

// raceLosingUserStore reproduces the interleaving where two deliveries
// provision concurrently: this caller's existence check misses, the other
// caller's create lands first, and this caller's create is rejected.
type raceLosingUserStore struct {
	*mockUserStore
	reads     int
	winner    *model.User
	winnerErr error
}

func (r *raceLosingUserStore) GetUser(context.Context, string) (*model.User, error) {
	r.reads++
	if r.reads == 1 {
		return nil, store.ErrNotFound
	}
	return r.winner, r.winnerErr
}

func (r *raceLosingUserStore) CreateUser(context.Context, *model.User) error {
	return store.ErrAlreadyExists
}

func TestEnsureBotUser_StoreFailures(t *testing.T) {
	botID := WebhookBotUserID("wh")
	for _, tc := range []struct {
		name  string
		store UserStore
		want  string
	}{
		{"read fails", func() UserStore {
			m := newMockUserStore()
			m.getUserErr = errors.New("dynamo down")
			return m
		}(), "get bot"},
		{"create fails", func() UserStore {
			m := newMockUserStore()
			m.createErr = errors.New("throttled")
			return m
		}(), "create bot"},
		{"lost the create race, then cannot read the winner", &raceLosingUserStore{
			mockUserStore: newMockUserStore(), winnerErr: errors.New("dynamo down"),
		}, "after race"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewUserService(tc.store, nil, nil, nil).EnsureBotUser(context.Background(), botID, "Bot")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

// The loser of a create race adopts the winner's row rather than erroring.
func TestEnsureBotUser_AdoptsRaceWinner(t *testing.T) {
	botID := WebhookBotUserID("wh")
	users := &raceLosingUserStore{
		mockUserStore: newMockUserStore(),
		winner:        &model.User{ID: botID, DisplayName: "Winner", IsBot: true},
	}
	bot, err := NewUserService(users, nil, nil, nil).EnsureBotUser(context.Background(), botID, "Winner")
	if err != nil {
		t.Fatalf("EnsureBotUser under race: %v", err)
	}
	if bot.DisplayName != "Winner" {
		t.Errorf("display name = %q, want the winning row's %q", bot.DisplayName, "Winner")
	}
}

// IncomingWebhookService bounds Title and Description but not Username, so an
// unbounded string would otherwise land in every recipient's sidebar.
func TestSanitizeBotDisplayName(t *testing.T) {
	long := strings.Repeat("x", MaxUserDisplayNameLen+25)
	for _, tc := range []struct{ in, want string }{
		{"Deploy Bot", "Deploy Bot"},
		{"  Deploy Bot  ", "Deploy Bot"},
		{"", "Webhook"},
		{"   ", "Webhook"},
		{long, long[:MaxUserDisplayNameLen]},
	} {
		if got := sanitizeBotDisplayName(tc.in); got != tc.want {
			t.Errorf("sanitizeBotDisplayName(%.20q) = %.20q, want %.20q", tc.in, got, tc.want)
		}
	}
}
