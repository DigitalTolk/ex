package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// Bot accounts as Mattermost has them: an admin creates a bot (a username, a
// display name, a description), issues it access tokens, and an integration
// written against Mattermost's REST API (/api/v4) acts as that bot with one.
// Like a person, a bot only posts where it is a member. Disabling a bot
// deactivates its account, which stops its tokens too; deleting one also
// revokes them, frees its username and drops it from the bot list.

// Mattermost's limits for a bot: a username of 3 to 22 lowercase letters,
// digits, '.', '-' and '_' starting with a letter, a display name of at most
// 64 characters, a description of at most 1024, a token description of at
// most 255.
const (
	maxBotDisplayNameLen      = 64
	maxBotDescriptionLen      = 1024
	maxBotTokenDescriptionLen = 255
)

var botUsernamePattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{2,21}$`)

// reservedBotUsernames are the group mentions: a bot called "all" would be
// unmentionable.
var reservedBotUsernames = map[string]bool{"all": true, "channel": true, "here": true}

// ErrBotUsernameTaken refuses a username another bot holds.
var ErrBotUsernameTaken = apperr.Reject(ErrAlreadyExists, "that username is taken")

// ErrBotTokenInvalid refuses a request whose bot token is unknown, revoked, or
// belongs to a disabled bot.
var ErrBotTokenInvalid = errors.New("bot: invalid or expired token")

// BotStore is what only a bot has in storage: the claim on its username, and
// its tokens (store.BotStoreImpl).
type BotStore interface {
	CreateBot(ctx context.Context, u *model.User) error
	UpdateBot(ctx context.Context, u *model.User, previousUsername string) error
	UsernameOwner(ctx context.Context, username string) (string, error)
	PutBotToken(ctx context.Context, t *model.BotToken) error
	GetBotToken(ctx context.Context, hash string) (*model.BotToken, error)
	ListBotTokens(ctx context.Context, botID string) ([]*model.BotToken, error)
	DeleteBotToken(ctx context.Context, hash string) error
	DeleteBot(ctx context.Context, id, username string, at time.Time) error
}

// BotAccountDirectory lists the bot accounts and flips their status
// (UserService): disabling a bot is deactivating its account, with everything
// that comes with it.
type BotAccountDirectory interface {
	BotAccounts(ctx context.Context) ([]*model.User, error)
	SetStatus(ctx context.Context, targetID string, deactivated bool) (*model.User, error)
}

// BotActor is the caller, with the stored role the auth middleware put in the
// claims. Only an admin manages bots.
type BotActor struct {
	ID   string
	Role model.SystemRole
}

func (a BotActor) check() error {
	if a.ID == "" || a.Role != model.SystemRoleAdmin {
		return apperr.Forbidden("bot: only admins manage bots")
	}
	return nil
}

// BotInput is what an admin writes about a bot.
type BotInput struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
}

// normalize trims the input, lowercases the username and checks Mattermost's
// rules. A bot without a display name is called by its username.
func (in BotInput) normalize() (BotInput, error) {
	in.Username = strings.ToLower(strings.TrimSpace(in.Username))
	in.DisplayName = strings.TrimSpace(in.DisplayName)
	in.Description = strings.TrimSpace(in.Description)
	if !botUsernamePattern.MatchString(in.Username) || reservedBotUsernames[in.Username] {
		return in, apperr.Invalid("username must be 3 to 22 lowercase letters, digits, '.', '-' or '_', starting with a letter")
	}
	if in.DisplayName == "" {
		in.DisplayName = in.Username
	}
	if utf8.RuneCountInString(in.DisplayName) > maxBotDisplayNameLen {
		return in, apperr.Invalid("display name must be at most %d characters", maxBotDisplayNameLen)
	}
	if utf8.RuneCountInString(in.Description) > maxBotDescriptionLen {
		return in, apperr.Invalid("description must be at most %d characters", maxBotDescriptionLen)
	}
	return in, nil
}

// BotService manages bot accounts and their tokens, and authenticates the
// requests made with them.
type BotService struct {
	bots      BotStore
	users     UserStore
	accounts  BotAccountDirectory
	cache     Cache
	publisher Publisher
}

// NewBotService wires the bot service.
func NewBotService(bots BotStore, users UserStore, accounts BotAccountDirectory, cache Cache, publisher Publisher) *BotService {
	return &BotService{bots: bots, users: users, accounts: accounts, cache: cache, publisher: publisher}
}

// List returns the bot accounts, the migrated ones included.
func (s *BotService) List(ctx context.Context, actor BotActor) ([]*model.User, error) {
	if err := actor.check(); err != nil {
		return nil, err
	}
	return s.accounts.BotAccounts(ctx)
}

// Create makes a bot account owned by the admin creating it.
func (s *BotService) Create(ctx context.Context, actor BotActor, in BotInput) (*model.User, error) {
	if err := actor.check(); err != nil {
		return nil, err
	}
	in, err := in.normalize()
	if err != nil {
		return nil, err
	}
	if err := s.usernameFree(ctx, in.Username, ""); err != nil {
		return nil, err
	}
	now := time.Now()
	id := store.NewID()
	bot := &model.User{
		ID:             id,
		Email:          strings.ToLower(id) + "@" + botEmailDomain,
		DisplayName:    in.DisplayName,
		Username:       in.Username,
		BotDescription: in.Description,
		BotOwnerID:     actor.ID,
		SystemRole:     model.SystemRoleMember,
		Status:         "active",
		IsBot:          true,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.bots.CreateBot(ctx, bot); err != nil {
		// Taken between the check and the write.
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, ErrBotUsernameTaken
		}
		return nil, fmt.Errorf("bot: create: %w", err)
	}
	forgetCachedUser(ctx, s.cache, bot.ID)
	s.publishChanged(ctx)
	return bot, nil
}

// Update rewrites a bot's username, display name and description.
func (s *BotService) Update(ctx context.Context, actor BotActor, id string, in BotInput) (*model.User, error) {
	if err := actor.check(); err != nil {
		return nil, err
	}
	in, err := in.normalize()
	if err != nil {
		return nil, err
	}
	bot, err := s.bot(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := s.usernameFree(ctx, in.Username, bot.ID); err != nil {
		return nil, err
	}
	previous := bot.Username
	bot.Username, bot.DisplayName, bot.BotDescription, bot.UpdatedAt = in.Username, in.DisplayName, in.Description, time.Now()
	if err := s.bots.UpdateBot(ctx, bot, previous); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, ErrBotUsernameTaken
		}
		return nil, fmt.Errorf("bot: update: %w", err)
	}
	forgetCachedUser(ctx, s.cache, bot.ID)
	// Its name shows wherever it posted and in every member list.
	events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserUpdated, map[string]any{"id": bot.ID})
	s.publishChanged(ctx)
	return bot, nil
}

// SetEnabled enables or disables a bot. Disabled, it is a deactivated account:
// its tokens stop working and it can't be added anywhere.
func (s *BotService) SetEnabled(ctx context.Context, actor BotActor, id string, enabled bool) (*model.User, error) {
	if err := actor.check(); err != nil {
		return nil, err
	}
	if _, err := s.bot(ctx, id); err != nil {
		return nil, err
	}
	bot, err := s.accounts.SetStatus(ctx, id, !enabled)
	if err != nil {
		return nil, err
	}
	s.publishChanged(ctx)
	return bot, nil
}

// Delete deletes a bot for good: its account is deactivated (as disabling
// it does), its tokens are revoked, its username is freed for another bot,
// and it leaves the bot list. Its row stays, so its messages keep their
// author. A delete that fails part way is safe to repeat.
func (s *BotService) Delete(ctx context.Context, actor BotActor, id string) error {
	if err := actor.check(); err != nil {
		return err
	}
	bot, err := s.bot(ctx, id)
	if err != nil {
		return err
	}
	if bot.Status != "deactivated" {
		if _, err := s.accounts.SetStatus(ctx, id, true); err != nil {
			return err
		}
	}
	tokens, err := s.bots.ListBotTokens(ctx, id)
	if err != nil {
		return fmt.Errorf("bot: list tokens: %w", err)
	}
	for _, t := range tokens {
		if err := s.bots.DeleteBotToken(ctx, t.TokenHash); err != nil {
			return fmt.Errorf("bot: revoke token: %w", err)
		}
	}
	if err := s.bots.DeleteBot(ctx, id, bot.Username, time.Now()); err != nil {
		return fmt.Errorf("bot: delete: %w", err)
	}
	forgetCachedUser(ctx, s.cache, id)
	events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserUpdated, map[string]any{"id": id})
	s.publishChanged(ctx)
	return nil
}

// ListTokens returns a bot's tokens, oldest first.
func (s *BotService) ListTokens(ctx context.Context, actor BotActor, botID string) ([]*model.BotToken, error) {
	if err := actor.check(); err != nil {
		return nil, err
	}
	if _, err := s.bot(ctx, botID); err != nil {
		return nil, err
	}
	return s.bots.ListBotTokens(ctx, botID)
}

// CreateToken issues a bot a token and returns its secret, which is shown
// this once.
func (s *BotService) CreateToken(ctx context.Context, actor BotActor, botID, description string) (*model.BotTokenIssued, error) {
	if err := actor.check(); err != nil {
		return nil, err
	}
	description = strings.TrimSpace(description)
	if description == "" || utf8.RuneCountInString(description) > maxBotTokenDescriptionLen {
		return nil, apperr.Invalid("token description must be 1 to %d characters", maxBotTokenDescriptionLen)
	}
	if _, err := s.bot(ctx, botID); err != nil {
		return nil, err
	}
	secret := newBotTokenSecret()
	tok := model.BotToken{
		ID:          store.NewID(),
		BotUserID:   botID,
		Description: description,
		CreatedBy:   actor.ID,
		CreatedAt:   time.Now(),
		TokenHash:   hashBotToken(secret),
	}
	if err := s.bots.PutBotToken(ctx, &tok); err != nil {
		return nil, fmt.Errorf("bot: create token: %w", err)
	}
	s.publishChanged(ctx)
	return &model.BotTokenIssued{Token: tok, Secret: secret}, nil
}

// RevokeToken deletes one of a bot's tokens; requests made with it fail from
// then on.
func (s *BotService) RevokeToken(ctx context.Context, actor BotActor, botID, tokenID string) error {
	tokens, err := s.ListTokens(ctx, actor, botID)
	if err != nil {
		return err
	}
	for _, t := range tokens {
		if t.ID == tokenID {
			if err := s.bots.DeleteBotToken(ctx, t.TokenHash); err != nil {
				return fmt.Errorf("bot: revoke token: %w", err)
			}
			s.publishChanged(ctx)
			return nil
		}
	}
	return apperr.NotFound("bot: no such token")
}

// Authenticate resolves a request's token to the bot it acts as.
// ErrBotTokenInvalid when the token is unknown or revoked, or its bot
// disabled; any other error is a failed lookup, not a verdict.
func (s *BotService) Authenticate(ctx context.Context, secret string) (*model.TokenClaims, error) {
	if secret == "" {
		return nil, ErrBotTokenInvalid
	}
	tok, err := s.bots.GetBotToken(ctx, hashBotToken(secret))
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrBotTokenInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("bot: get token: %w", err)
	}
	bot, err := s.users.GetUser(ctx, tok.BotUserID)
	if errors.Is(err, store.ErrNotFound) {
		return nil, ErrBotTokenInvalid
	}
	if err != nil {
		return nil, fmt.Errorf("bot: get bot: %w", err)
	}
	if !isBotAccount(bot) || bot.Status == "deactivated" {
		return nil, ErrBotTokenInvalid
	}
	return &model.TokenClaims{UserID: bot.ID, Email: bot.Email, DisplayName: bot.DisplayName, SystemRole: bot.SystemRole}, nil
}

// bot loads a bot account admins manage; anything else reads as missing.
func (s *BotService) bot(ctx context.Context, id string) (*model.User, error) {
	u, err := s.users.GetUser(ctx, id)
	if errors.Is(err, store.ErrNotFound) || err == nil && !isBotAccount(u) {
		return nil, apperr.NotFound("bot: no such bot")
	}
	if err != nil {
		return nil, fmt.Errorf("bot: get: %w", err)
	}
	return u, nil
}

// usernameFree refuses a username held by another bot than self.
func (s *BotService) usernameFree(ctx context.Context, username, self string) error {
	owner, err := s.bots.UsernameOwner(ctx, username)
	switch {
	case errors.Is(err, store.ErrNotFound):
		return nil
	case err != nil:
		return fmt.Errorf("bot: check username: %w", err)
	case owner != self:
		return ErrBotUsernameTaken
	}
	return nil
}

// publishChanged nudges every client to refetch the bot list. It carries
// nothing: only an admin's list request answers with bots.
func (s *BotService) publishChanged(ctx context.Context) {
	events.Publish(ctx, s.publisher, pubsub.GlobalChannelEvents(), events.EventBotChanged, map[string]any{})
}

// newBotTokenSecret makes a token in Mattermost's format: 26 lowercase base32
// characters, 128 random bits.
func newBotTokenSecret() string {
	return strings.ToLower(rand.Text())
}

func hashBotToken(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}
