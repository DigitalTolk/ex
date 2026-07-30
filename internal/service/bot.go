package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
)

// ErrBotTokenInvalid is returned for every authentication failure — unknown
// token, revoked token, malformed prefix. It is deliberately undifferentiated:
// the caller turns it into a bare 401, so a probing client learns nothing about
// which tokens exist.
var ErrBotTokenInvalid = errors.New("bot: invalid token")

// botEmailDomain is the synthetic email domain for bot accounts. Every user row
// needs a unique email — the store keeps a USEREMAIL# uniqueness row per user,
// so bots sharing an empty email would collide on the second bot ever created.
// ".invalid" is reserved by RFC 2606 and can never be issued by the IdP, so a
// bot address can't collide with (or be impersonated by) a real one.
const botEmailDomain = "bots.invalid"

// botLastUsedInterval throttles LastUsedAt writes. Stamping it on every request
// would put a DynamoDB write in front of every bot API call for a field only
// used to spot stale credentials; once per interval is accurate enough.
const botLastUsedInterval = 5 * time.Minute

// BotService owns bot identities: their user rows, their API tokens, and the
// token-to-claims validation the auth middleware calls on every bot request.
type BotService struct {
	bots  store.BotStore
	users store.UserStore
	// userSvc is optional. When set, retiring a bot routes through
	// UserService.SetStatus to reuse its cache invalidation, force-logout
	// broadcast, and search re-index instead of duplicating them here.
	userSvc *UserService

	// lastUsed throttles the LastUsedAt stamp per token hash. Per-instance, so
	// an N-instance deployment writes at most N times per interval per token.
	lastUsedMu sync.Mutex
	lastUsed   map[string]time.Time
}

func NewBotService(bots store.BotStore, users store.UserStore) *BotService {
	return &BotService{bots: bots, users: users, lastUsed: make(map[string]time.Time)}
}

// SetUserService wires the user service after construction, breaking the
// initialization cycle between the two (UserService doesn't need BotService,
// but they're built in the same block).
func (s *BotService) SetUserService(u *UserService) { s.userSvc = u }

func botEmail(userID string) string { return userID + "@" + botEmailDomain }

// SetWebhook makes a bot an EXTERNAL (outgoing-webhook) bot: ex POSTs each event
// to callbackURL (validated as a public https endpoint) and posts the response
// back. It returns the HMAC signing secret so the admin can configure the
// receiver to verify X-Ex-Signature — without this, the signature would be
// unverifiable and therefore worthless. The URL must be a public https endpoint.
// An empty url clears the webhook (returns "").
func (s *BotService) SetWebhook(ctx context.Context, botUserID, callbackURL string) (string, error) {
	trimmed := strings.TrimSpace(callbackURL)
	if trimmed != "" {
		if err := validateCallbackURL(trimmed); err != nil {
			return "", err
		}
	}
	bot, err := s.bots.GetBot(ctx, botUserID)
	if err != nil {
		return "", err
	}
	bot.CallbackURL = trimmed
	switch {
	case bot.CallbackURL == "":
		bot.CallbackSecret = ""
	case bot.CallbackSecret == "":
		var b [24]byte
		if _, err := randRead(b[:]); err != nil {
			return "", fmt.Errorf("bot: webhook secret: %w", err)
		}
		bot.CallbackSecret = "exwhsec_" + base64.RawURLEncoding.EncodeToString(b[:])
	}
	bot.UpdatedAt = time.Now()
	if err := s.bots.UpdateBot(ctx, bot); err != nil {
		return "", err
	}
	// The stored secret is revealed here so the operator can configure the
	// receiver. (It is never serialized by the read APIs — json:"-".)
	return bot.CallbackSecret, nil
}

// WebhookBot implements service.BotDirectory.
func (s *BotService) WebhookBot(ctx context.Context, botUserID string) (BotWebhookTarget, bool) {
	bot, err := s.bots.GetBot(ctx, botUserID)
	if err != nil || bot == nil || strings.TrimSpace(bot.CallbackURL) == "" {
		return BotWebhookTarget{}, false
	}
	return BotWebhookTarget{URL: bot.CallbackURL, Secret: bot.CallbackSecret, Name: bot.Name}, true
}

// EnsureBot idempotently provisions a bot with a FIXED user id — for built-in
// system bots (e.g. Cliffy) that need a stable identity across restarts, unlike
// CreateBot which mints a random id. Safe to call on every boot; returns the
// existing bot user if already provisioned.
func (s *BotService) EnsureBot(ctx context.Context, userID, name string) (*model.User, error) {
	if !model.IsBotUserID(userID) {
		return nil, fmt.Errorf("bot: id %q must have %q prefix", userID, model.BotUserIDPrefix)
	}
	if u, err := s.users.GetUser(ctx, userID); err == nil {
		return u, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return nil, fmt.Errorf("bot: ensure lookup: %w", err)
	}
	now := time.Now()
	user := &model.User{
		ID:           userID,
		Email:        botEmail(userID),
		DisplayName:  name,
		SystemRole:   model.SystemRoleMember,
		AuthProvider: model.AuthProviderBot,
		Status:       "active",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.users.CreateUser(ctx, user); err != nil {
		return nil, fmt.Errorf("bot: ensure create user: %w", err)
	}
	bot := &model.BotAccount{
		UserID:      userID,
		Name:        name,
		Description: "Built-in assistant",
		CreatedBy:   "system",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.bots.CreateBot(ctx, bot); err != nil {
		// Metadata is best-effort; the user identity is what posting/auth needs.
		slog.Warn("bot: ensure metadata write failed (identity still usable)", "bot", userID, "error", err)
	}
	return user, nil
}

// CreateBot provisions a new bot: a real user row (so it can hold channel
// memberships, author messages, and be mentioned like anyone else) plus the
// admin metadata record. The returned user's ID is the bot's permanent identity
// — it is the authorID on everything the bot ever posts.
func (s *BotService) CreateBot(ctx context.Context, actorID, name, description string) (*model.User, *model.BotAccount, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > MaxUserDisplayNameLen {
		return nil, nil, fmt.Errorf("bot: name must be 1-%d characters", MaxUserDisplayNameLen)
	}
	description = strings.TrimSpace(description)

	now := time.Now()
	// The bot_ prefix makes the ID recognizable in logs and message authorship,
	// and keeps it disjoint from the pre-existing sentinel author IDs
	// ("webhook", "cliffy") that are not backed by user rows.
	userID := model.BotUserIDPrefix + store.NewID()

	user := &model.User{
		ID:           userID,
		Email:        botEmail(userID),
		DisplayName:  name,
		SystemRole:   model.SystemRoleMember,
		AuthProvider: model.AuthProviderBot,
		Status:       "active",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	if err := s.users.CreateUser(ctx, user); err != nil {
		return nil, nil, fmt.Errorf("bot: create user: %w", err)
	}

	bot := &model.BotAccount{
		UserID:      userID,
		Name:        name,
		Description: description,
		CreatedBy:   actorID,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := s.bots.CreateBot(ctx, bot); err != nil {
		// The two writes can't be one transaction (different stores), so
		// compensate: a bot user with no metadata row would be invisible to
		// admin yet still hold a usable identity. Deactivating it makes the
		// leftover inert.
		user.Status = "deactivated"
		user.UpdatedAt = time.Now()
		if uerr := s.users.UpdateUser(ctx, user); uerr != nil {
			slog.Error("bot: orphaned bot user left active after metadata write failed",
				"userID", userID, "error", uerr)
		}
		return nil, nil, fmt.Errorf("bot: create bot: %w", err)
	}
	return user, bot, nil
}

// GetBot returns the bot's metadata alongside its user row (for display name,
// avatar, and active/deactivated status).
func (s *BotService) GetBot(ctx context.Context, botUserID string) (*model.BotAccount, *model.User, error) {
	bot, err := s.bots.GetBot(ctx, botUserID)
	if err != nil {
		return nil, nil, err
	}
	user, err := s.users.GetUser(ctx, botUserID)
	if err != nil {
		// Metadata without a user row is a broken half-create; report it as
		// missing rather than handing back an unusable bot.
		return nil, nil, fmt.Errorf("bot: get user: %w", err)
	}
	return bot, user, nil
}

func (s *BotService) ListBots(ctx context.Context) ([]*model.BotAccount, error) {
	return s.bots.ListBots(ctx)
}

// DeleteBot retires a bot: every outstanding token is revoked and the user is
// deactivated (which the auth middleware's per-request status check enforces).
// The user row itself is never deleted — messages the bot authored must keep
// resolving an author forever.
func (s *BotService) DeleteBot(ctx context.Context, botUserID string) error {
	if _, err := s.bots.GetBot(ctx, botUserID); err != nil {
		return err
	}

	tokens, err := s.bots.ListBotTokens(ctx, botUserID)
	if err != nil {
		return fmt.Errorf("bot: list tokens: %w", err)
	}
	now := time.Now()
	for _, t := range tokens {
		if t.Revoked() {
			continue
		}
		// A token left live is a working credential for a retired bot, so a
		// revoke failure aborts rather than continuing to deactivation.
		if err := s.bots.RevokeBotToken(ctx, t.TokenHash, now); err != nil && !errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("bot: revoke token: %w", err)
		}
	}

	if err := s.bots.RemoveBotFromDirectory(ctx, botUserID); err != nil {
		return err
	}

	if s.userSvc != nil {
		if _, err := s.userSvc.SetStatus(ctx, botUserID, true); err != nil {
			return fmt.Errorf("bot: deactivate: %w", err)
		}
		return nil
	}
	// No user service wired (tests): deactivate directly.
	user, err := s.users.GetUser(ctx, botUserID)
	if err != nil {
		return fmt.Errorf("bot: get user: %w", err)
	}
	user.Status = "deactivated"
	user.UpdatedAt = time.Now()
	if err := s.users.UpdateUser(ctx, user); err != nil {
		return fmt.Errorf("bot: deactivate: %w", err)
	}
	return nil
}

// IssueToken mints a new bearer credential for the bot. The plaintext is
// returned here and nowhere else — only its hash is stored, so it cannot be
// recovered later (and a database dump can't be replayed). Issuing a second
// token without revoking the first is supported, which is how an integration
// rotates credentials without downtime.
func (s *BotService) IssueToken(ctx context.Context, botUserID, label string) (string, *model.BotToken, error) {
	if _, err := s.bots.GetBot(ctx, botUserID); err != nil {
		return "", nil, err
	}
	user, err := s.users.GetUser(ctx, botUserID)
	if err != nil {
		return "", nil, fmt.Errorf("bot: get user: %w", err)
	}
	if user.Status == "deactivated" {
		return "", nil, errors.New("bot: cannot issue a token for a deactivated bot")
	}

	var b [32]byte
	if _, err := randRead(b[:]); err != nil {
		return "", nil, fmt.Errorf("bot: random token: %w", err)
	}
	plaintext := model.BotTokenPrefix + base64.RawURLEncoding.EncodeToString(b[:])

	tok := &model.BotToken{
		TokenHash: hashBotToken(plaintext),
		TokenID:   store.NewID(),
		BotUserID: botUserID,
		Label:     strings.TrimSpace(label),
		CreatedAt: time.Now(),
	}
	if err := s.bots.CreateBotToken(ctx, tok); err != nil {
		return "", nil, err
	}
	return plaintext, tok, nil
}

func (s *BotService) ListTokens(ctx context.Context, botUserID string) ([]*model.BotToken, error) {
	if _, err := s.bots.GetBot(ctx, botUserID); err != nil {
		return nil, err
	}
	return s.bots.ListBotTokens(ctx, botUserID)
}

// RevokeToken revokes one of a bot's tokens by its admin-visible token ID.
// Scoping the lookup to the bot means a guessed token ID can't revoke another
// bot's credential.
func (s *BotService) RevokeToken(ctx context.Context, botUserID, tokenID string) error {
	tokens, err := s.bots.ListBotTokens(ctx, botUserID)
	if err != nil {
		return fmt.Errorf("bot: list tokens: %w", err)
	}
	for _, t := range tokens {
		if t.TokenID == tokenID {
			return s.bots.RevokeBotToken(ctx, t.TokenHash, time.Now())
		}
	}
	return store.ErrNotFound
}

// ValidateBotToken resolves a bot token into claims shaped exactly like a human
// session's, so every downstream consumer (access checks, rate limiting, role
// gates) treats a bot request identically to a member's.
//
// The token row is read on every request with no positive cache: bot tokens are
// long-lived credentials held outside this system, so a revocation must take
// effect on the very next call rather than after a cache TTL. Do not add
// caching here without accepting that revocation window.
//
// Deactivation is NOT checked here — the auth middleware's shared user-status
// check covers it for bots and humans alike, cache-first.
func (s *BotService) ValidateBotToken(ctx context.Context, token string) (*model.TokenClaims, error) {
	if !strings.HasPrefix(token, model.BotTokenPrefix) {
		return nil, ErrBotTokenInvalid
	}
	tok, err := s.bots.GetBotTokenByHash(ctx, hashBotToken(token))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, ErrBotTokenInvalid
		}
		return nil, fmt.Errorf("bot: lookup token: %w", err)
	}
	if tok.Revoked() {
		return nil, ErrBotTokenInvalid
	}

	s.touchLastUsed(ctx, tok.TokenHash)

	// No second read for the user row: the claims a bot needs are fully
	// determined by its identity (bots are always members, and the email is
	// derived from the ID), and the middleware fetches status separately.
	return &model.TokenClaims{
		UserID:     tok.BotUserID,
		Email:      botEmail(tok.BotUserID),
		SystemRole: model.SystemRoleMember,
	}, nil
}

// touchLastUsed stamps the token's LastUsedAt at most once per
// botLastUsedInterval, off the request path. Best-effort: this is credential
// hygiene metadata, so a failed write is logged at debug and forgotten.
func (s *BotService) touchLastUsed(ctx context.Context, hash string) {
	now := time.Now()
	s.lastUsedMu.Lock()
	if last, ok := s.lastUsed[hash]; ok && now.Sub(last) < botLastUsedInterval {
		s.lastUsedMu.Unlock()
		return
	}
	s.lastUsed[hash] = now
	s.lastUsedMu.Unlock()

	safe.Go(func() {
		bg, cancel := detachedContext(ctx)
		defer cancel()
		if err := s.bots.TouchBotTokenLastUsed(bg, hash, now); err != nil {
			slog.Debug("bot: touch token last-used failed", "error", err)
		}
	})
}

// hashBotToken hashes the FULL plaintext including its prefix, so the stored
// digest is only ever derivable from the exact string the client presents.
func hashBotToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}
