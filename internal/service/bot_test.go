package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// --- Mock BotStore ---

type mockBotStore struct {
	bots      map[string]*model.BotAccount
	tokens    map[string]*model.BotToken // by hash
	directory map[string]bool
	touches   []string

	createBotErr   error
	createTokenErr error
	listTokensErr  error
}

func newMockBotStore() *mockBotStore {
	return &mockBotStore{
		bots:      make(map[string]*model.BotAccount),
		tokens:    make(map[string]*model.BotToken),
		directory: make(map[string]bool),
	}
}

func (m *mockBotStore) CreateBot(_ context.Context, b *model.BotAccount) error {
	if m.createBotErr != nil {
		return m.createBotErr
	}
	if _, exists := m.bots[b.UserID]; exists {
		return store.ErrAlreadyExists
	}
	cp := *b
	m.bots[b.UserID] = &cp
	m.directory[b.UserID] = true
	return nil
}

func (m *mockBotStore) GetBot(_ context.Context, userID string) (*model.BotAccount, error) {
	b, ok := m.bots[userID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return b, nil
}

func (m *mockBotStore) UpdateBot(_ context.Context, b *model.BotAccount) error {
	if _, ok := m.bots[b.UserID]; !ok {
		return store.ErrNotFound
	}
	cp := *b
	m.bots[b.UserID] = &cp
	return nil
}

func (m *mockBotStore) ListBots(_ context.Context) ([]*model.BotAccount, error) {
	out := make([]*model.BotAccount, 0, len(m.directory))
	for id := range m.directory {
		if b, ok := m.bots[id]; ok {
			out = append(out, b)
		}
	}
	return out, nil
}

func (m *mockBotStore) RemoveBotFromDirectory(_ context.Context, userID string) error {
	delete(m.directory, userID)
	return nil
}

func (m *mockBotStore) CreateBotToken(_ context.Context, t *model.BotToken) error {
	if m.createTokenErr != nil {
		return m.createTokenErr
	}
	if _, exists := m.tokens[t.TokenHash]; exists {
		return store.ErrAlreadyExists
	}
	cp := *t
	m.tokens[t.TokenHash] = &cp
	return nil
}

func (m *mockBotStore) GetBotTokenByHash(_ context.Context, hash string) (*model.BotToken, error) {
	t, ok := m.tokens[hash]
	if !ok {
		return nil, store.ErrNotFound
	}
	return t, nil
}

func (m *mockBotStore) ListBotTokens(_ context.Context, botUserID string) ([]*model.BotToken, error) {
	if m.listTokensErr != nil {
		return nil, m.listTokensErr
	}
	out := make([]*model.BotToken, 0)
	for _, t := range m.tokens {
		if t.BotUserID == botUserID {
			out = append(out, t)
		}
	}
	return out, nil
}

func (m *mockBotStore) RevokeBotToken(_ context.Context, hash string, at time.Time) error {
	t, ok := m.tokens[hash]
	if !ok || t.RevokedAt != nil {
		return store.ErrNotFound
	}
	t.RevokedAt = &at
	return nil
}

func (m *mockBotStore) TouchBotTokenLastUsed(_ context.Context, hash string, at time.Time) error {
	t, ok := m.tokens[hash]
	if !ok {
		return store.ErrNotFound
	}
	t.LastUsedAt = &at
	m.touches = append(m.touches, hash)
	return nil
}

// uniqueEmailUserStore wraps the shared mock to enforce the real store's
// per-email uniqueness constraint (a USEREMAIL# row written with
// attribute_not_exists), which is what makes a shared/blank bot email a
// second-bot-creation failure rather than a cosmetic detail.
type uniqueEmailUserStore struct {
	*mockUserStore
}

func (u uniqueEmailUserStore) CreateUser(ctx context.Context, user *model.User) error {
	if _, taken := u.emailIndex[user.Email]; taken {
		return store.ErrAlreadyExists
	}
	return u.mockUserStore.CreateUser(ctx, user)
}

func newBotServiceForTest() (*BotService, *mockBotStore, *mockUserStore) {
	bots := newMockBotStore()
	users := newMockUserStore()
	return NewBotService(bots, uniqueEmailUserStore{users}), bots, users
}

func TestCreateBotProvisionsMemberUser(t *testing.T) {
	svc, bots, users := newBotServiceForTest()

	user, bot, err := svc.CreateBot(context.Background(), "admin-1", "CliffHub", "MCP integration")
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}

	if !strings.HasPrefix(user.ID, model.BotUserIDPrefix) {
		t.Errorf("user ID = %q, want the %q prefix", user.ID, model.BotUserIDPrefix)
	}
	// A bot with an admin role would hand workspace administration to whoever
	// holds its token.
	if user.SystemRole != model.SystemRoleMember {
		t.Errorf("SystemRole = %q, want member", user.SystemRole)
	}
	if !user.IsBot() {
		t.Errorf("AuthProvider = %q, want the user to report IsBot", user.AuthProvider)
	}
	if user.Status != "active" {
		t.Errorf("Status = %q, want active", user.Status)
	}
	if bot.UserID != user.ID {
		t.Errorf("bot.UserID = %q, want the user's ID %q", bot.UserID, user.ID)
	}
	if bot.CreatedBy != "admin-1" {
		t.Errorf("CreatedBy = %q, want admin-1", bot.CreatedBy)
	}
	// The user row is what makes the bot a real member, so it must be persisted.
	if _, ok := users.users[user.ID]; !ok {
		t.Error("bot user was not written to the user store")
	}
	if _, ok := bots.bots[user.ID]; !ok {
		t.Error("bot metadata was not written to the bot store")
	}
}

// The real user store enforces per-email uniqueness, so bots must not share an
// email — otherwise the second bot ever created fails to provision.
func TestCreateBotSecondBotSucceedsWithDistinctEmail(t *testing.T) {
	svc, _, _ := newBotServiceForTest()
	ctx := context.Background()

	first, _, err := svc.CreateBot(ctx, "admin-1", "Bot One", "")
	if err != nil {
		t.Fatalf("first CreateBot: %v", err)
	}
	second, _, err := svc.CreateBot(ctx, "admin-1", "Bot Two", "")
	if err != nil {
		t.Fatalf("second CreateBot: %v", err)
	}
	if first.Email == second.Email {
		t.Fatalf("both bots got email %q; emails must be unique per bot", first.Email)
	}
	if first.Email == "" || second.Email == "" {
		t.Error("bot emails must not be empty")
	}
}

func TestCreateBotRejectsEmptyName(t *testing.T) {
	svc, _, _ := newBotServiceForTest()
	if _, _, err := svc.CreateBot(context.Background(), "admin-1", "   ", ""); err == nil {
		t.Error("expected an error for a blank bot name")
	}
}

// A metadata write failure would otherwise leave a usable bot identity that
// admin can't see or revoke.
func TestCreateBotDeactivatesUserWhenMetadataWriteFails(t *testing.T) {
	bots := newMockBotStore()
	bots.createBotErr = errors.New("dynamo down")
	users := newMockUserStore()
	svc := NewBotService(bots, uniqueEmailUserStore{users})

	if _, _, err := svc.CreateBot(context.Background(), "admin-1", "Doomed", ""); err == nil {
		t.Fatal("expected CreateBot to fail when the metadata write fails")
	}
	for id, u := range users.users {
		if u.Status != "deactivated" {
			t.Errorf("orphaned bot user %s left with status %q, want deactivated", id, u.Status)
		}
	}
}

func TestIssueTokenReturnsPlaintextOnceAndStoresOnlyHash(t *testing.T) {
	svc, bots, _ := newBotServiceForTest()
	ctx := context.Background()
	user, _, err := svc.CreateBot(ctx, "admin-1", "Tokened", "")
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}

	plaintext, tok, err := svc.IssueToken(ctx, user.ID, "ci")
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	if !strings.HasPrefix(plaintext, model.BotTokenPrefix) {
		t.Errorf("token = %q, want the %q prefix", plaintext, model.BotTokenPrefix)
	}
	// A stored plaintext would be replayable straight out of a database dump.
	for hash, stored := range bots.tokens {
		if strings.Contains(hash, plaintext) || strings.Contains(stored.TokenHash, plaintext) {
			t.Fatal("token plaintext leaked into the stored row")
		}
	}
	want := sha256.Sum256([]byte(plaintext))
	if tok.TokenHash != hex.EncodeToString(want[:]) {
		t.Error("stored hash is not sha256 of the full plaintext (including prefix)")
	}
	if tok.Label != "ci" {
		t.Errorf("Label = %q, want ci", tok.Label)
	}
}

func TestValidateBotTokenRoundTrip(t *testing.T) {
	svc, _, _ := newBotServiceForTest()
	ctx := context.Background()
	user, _, err := svc.CreateBot(ctx, "admin-1", "Valid", "")
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	plaintext, _, err := svc.IssueToken(ctx, user.ID, "")
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	claims, err := svc.ValidateBotToken(ctx, plaintext)
	if err != nil {
		t.Fatalf("ValidateBotToken: %v", err)
	}
	if claims.UserID != user.ID {
		t.Errorf("claims.UserID = %q, want %q", claims.UserID, user.ID)
	}
	// Cliffy's handler (and anything else reading claims) requires a non-empty
	// email, so bot claims must carry the synthetic address.
	if claims.Email == "" {
		t.Error("claims.Email is empty; downstream handlers require it")
	}
	if claims.SystemRole != model.SystemRoleMember {
		t.Errorf("claims.SystemRole = %q, want member", claims.SystemRole)
	}
}

func TestValidateBotTokenRejectsUnknownAndUnprefixed(t *testing.T) {
	svc, _, _ := newBotServiceForTest()
	ctx := context.Background()

	for _, tok := range []string{
		"",
		"not-a-bot-token",
		"eyJhbGciOiJIUzI1NiJ9.fake.jwt",
		model.BotTokenPrefix + "never-issued",
	} {
		if _, err := svc.ValidateBotToken(ctx, tok); !errors.Is(err, ErrBotTokenInvalid) {
			t.Errorf("ValidateBotToken(%q) error = %v, want ErrBotTokenInvalid", tok, err)
		}
	}
}

// Revocation must bite on the very next request — the whole reason token
// validation reads through to the store on every call.
func TestRevokeTokenBlocksNextValidation(t *testing.T) {
	svc, _, _ := newBotServiceForTest()
	ctx := context.Background()
	user, _, err := svc.CreateBot(ctx, "admin-1", "Revoked", "")
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	plaintext, tok, err := svc.IssueToken(ctx, user.ID, "")
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if _, err := svc.ValidateBotToken(ctx, plaintext); err != nil {
		t.Fatalf("token should validate before revocation: %v", err)
	}

	if err := svc.RevokeToken(ctx, user.ID, tok.TokenID); err != nil {
		t.Fatalf("RevokeToken: %v", err)
	}
	if _, err := svc.ValidateBotToken(ctx, plaintext); !errors.Is(err, ErrBotTokenInvalid) {
		t.Errorf("revoked token still validates (err = %v)", err)
	}
}

// A guessed token ID must not let one bot's credential be revoked via another.
func TestRevokeTokenIsScopedToItsBot(t *testing.T) {
	svc, _, _ := newBotServiceForTest()
	ctx := context.Background()
	victim, _, _ := svc.CreateBot(ctx, "admin-1", "Victim", "")
	other, _, _ := svc.CreateBot(ctx, "admin-1", "Other", "")

	plaintext, tok, err := svc.IssueToken(ctx, victim.ID, "")
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	if err := svc.RevokeToken(ctx, other.ID, tok.TokenID); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("cross-bot revoke error = %v, want ErrNotFound", err)
	}
	if _, err := svc.ValidateBotToken(ctx, plaintext); err != nil {
		t.Errorf("victim's token was revoked through another bot: %v", err)
	}
}

func TestDeleteBotRevokesTokensAndDeactivates(t *testing.T) {
	svc, bots, users := newBotServiceForTest()
	ctx := context.Background()
	user, _, err := svc.CreateBot(ctx, "admin-1", "Retiring", "")
	if err != nil {
		t.Fatalf("CreateBot: %v", err)
	}
	firstToken, _, _ := svc.IssueToken(ctx, user.ID, "one")
	secondToken, _, _ := svc.IssueToken(ctx, user.ID, "two")

	if err := svc.DeleteBot(ctx, user.ID); err != nil {
		t.Fatalf("DeleteBot: %v", err)
	}

	// Every outstanding credential must die, not just the most recent.
	for _, tok := range []string{firstToken, secondToken} {
		if _, err := svc.ValidateBotToken(ctx, tok); !errors.Is(err, ErrBotTokenInvalid) {
			t.Errorf("token still valid after DeleteBot (err = %v)", err)
		}
	}
	if users.users[user.ID].Status != "deactivated" {
		t.Errorf("bot user status = %q, want deactivated", users.users[user.ID].Status)
	}
	// History must keep resolving an author, so the rows survive.
	if _, ok := users.users[user.ID]; !ok {
		t.Error("bot user row was deleted; message authorship would break")
	}
	if _, ok := bots.bots[user.ID]; !ok {
		t.Error("bot metadata row was deleted")
	}
	if bots.directory[user.ID] {
		t.Error("retired bot is still listed in the directory")
	}
}

func TestDeleteBotUnknownReturnsNotFound(t *testing.T) {
	svc, _, _ := newBotServiceForTest()
	if err := svc.DeleteBot(context.Background(), "bot_missing"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("error = %v, want ErrNotFound", err)
	}
}

func TestIssueTokenRejectedForDeactivatedBot(t *testing.T) {
	svc, _, _ := newBotServiceForTest()
	ctx := context.Background()
	user, _, _ := svc.CreateBot(ctx, "admin-1", "Gone", "")
	if err := svc.DeleteBot(ctx, user.ID); err != nil {
		t.Fatalf("DeleteBot: %v", err)
	}
	if _, _, err := svc.IssueToken(ctx, user.ID, ""); err == nil {
		t.Error("expected IssueToken to fail for a deactivated bot")
	}
}

// LastUsedAt is hygiene metadata, so it must not put a write in front of every
// single bot API call.
func TestValidateBotTokenThrottlesLastUsedWrites(t *testing.T) {
	svc, bots, _ := newBotServiceForTest()
	ctx := context.Background()
	user, _, _ := svc.CreateBot(ctx, "admin-1", "Busy", "")
	plaintext, tok, _ := svc.IssueToken(ctx, user.ID, "")

	for range 5 {
		if _, err := svc.ValidateBotToken(ctx, plaintext); err != nil {
			t.Fatalf("ValidateBotToken: %v", err)
		}
	}
	// The touch is dispatched to a goroutine; give it a moment to land.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(bots.touches) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if got := len(bots.touches); got != 1 {
		t.Errorf("last-used writes = %d across 5 validations, want 1", got)
	}

	// Once the interval has elapsed the next validation stamps it again.
	svc.lastUsedMu.Lock()
	svc.lastUsed[tok.TokenHash] = time.Now().Add(-2 * botLastUsedInterval)
	svc.lastUsedMu.Unlock()
	if _, err := svc.ValidateBotToken(ctx, plaintext); err != nil {
		t.Fatalf("ValidateBotToken: %v", err)
	}
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(bots.touches) < 2 {
		time.Sleep(10 * time.Millisecond)
	}
	if got := len(bots.touches); got != 2 {
		t.Errorf("last-used writes = %d after the interval elapsed, want 2", got)
	}
}

func TestListBotsAndTokens(t *testing.T) {
	svc, _, _ := newBotServiceForTest()
	ctx := context.Background()
	user, _, _ := svc.CreateBot(ctx, "admin-1", "Listed", "")
	if _, _, err := svc.IssueToken(ctx, user.ID, "a"); err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	if _, _, err := svc.IssueToken(ctx, user.ID, "b"); err != nil {
		t.Fatalf("IssueToken: %v", err)
	}

	list, err := svc.ListBots(ctx)
	if err != nil {
		t.Fatalf("ListBots: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListBots returned %d bots, want 1", len(list))
	}

	tokens, err := svc.ListTokens(ctx, user.ID)
	if err != nil {
		t.Fatalf("ListTokens: %v", err)
	}
	if len(tokens) != 2 {
		t.Errorf("ListTokens returned %d tokens, want 2", len(tokens))
	}

	if _, err := svc.ListTokens(ctx, "bot_missing"); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("ListTokens for an unknown bot: err = %v, want ErrNotFound", err)
	}
}
