package importer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/limits"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// User is an existing ex user as seen by the importer.
type User struct {
	ID           string `json:"id"`
	Email        string `json:"email"` // lowercased
	DisplayName  string `json:"displayName"`
	Status       string `json:"status"` // "active" | "deactivated"
	SystemRole   string `json:"systemRole"`
	AuthProvider string `json:"authProvider"`
}

// usersPageSize is a var so tests can force pagination.
var usersPageSize = 200

// Users lists every ex user.
func (im *Importer) Users(ctx context.Context) ([]User, error) {
	var out []User
	cursor := ""
	for {
		page, next, err := im.users.ListUsers(ctx, usersPageSize, cursor)
		if err != nil {
			return nil, fmt.Errorf("importer: list users: %w", err)
		}
		for _, u := range page {
			out = append(out, User{
				ID:           u.ID,
				Email:        strings.ToLower(u.Email),
				DisplayName:  u.DisplayName,
				Status:       u.Status,
				SystemRole:   string(u.SystemRole),
				AuthProvider: string(u.AuthProvider),
			})
		}
		if next == "" || len(page) == 0 {
			return out, nil
		}
		cursor = next
	}
}

// UserSpec describes a user to create.
type UserSpec struct {
	ID          string
	Email       string
	DisplayName string
	Deactivated bool
	CreatedAt   time.Time
	// Bot makes a machine account, like the ones ex creates for incoming
	// webhooks: nobody signs in as it, and it is left out of search, the
	// people directory and directory sync. Email is ignored: a bot gets an
	// undeliverable ID@bots.ex.invalid address.
	Bot bool
}

// botEmailDomain matches the bot accounts ex creates (internal/service/botuser.go).
const botEmailDomain = "bots.ex.invalid"

// EmailTakenError reports that the email already belongs to another ex user.
// Existing users are never modified; map the source user to ExistingID instead.
type EmailTakenError struct {
	Email      string
	ExistingID string
}

func (e *EmailTakenError) Error() string {
	return fmt.Sprintf("importer: email %s already belongs to user %s", e.Email, e.ExistingID)
}

// UpsertUser creates a single-sign-on member account (no password), or a bot
// account for spec.Bot, when no user with spec.ID exists yet. An existing user
// with that ID is left untouched, except that spec.Bot turns it into a bot
// account; an existing user with the same email but another ID yields
// *EmailTakenError. The display name is trimmed and capped like the sign-in
// flow does. A person is (re)indexed for search either way, a bot is removed
// from it.
func (im *Importer) UpsertUser(ctx context.Context, spec UserSpec) (bool, error) {
	return im.upsertUser(ctx, spec, false)
}

func (im *Importer) upsertUser(ctx context.Context, spec UserSpec, retried bool) (bool, error) {
	email := strings.ToLower(strings.TrimSpace(spec.Email))
	if spec.Bot && spec.ID != "" {
		email = strings.ToLower(spec.ID) + "@" + botEmailDomain
	}
	if spec.ID == "" || email == "" {
		return false, errors.New("importer: user ID and email are required")
	}
	existing, err := im.users.GetUser(ctx, spec.ID)
	if err == nil {
		if spec.Bot && !existing.IsBot {
			return false, im.makeBot(ctx, existing)
		}
		return false, im.indexUser(ctx, existing)
	}
	if !errors.Is(err, store.ErrNotFound) {
		return false, fmt.Errorf("importer: get user: %w", err)
	}
	other, err := im.users.GetUserByEmail(ctx, email)
	if err == nil {
		return false, &EmailTakenError{Email: email, ExistingID: other.ID}
	}
	if !errors.Is(err, store.ErrNotFound) {
		return false, fmt.Errorf("importer: get user by email: %w", err)
	}
	status := "active"
	if spec.Deactivated {
		status = "deactivated"
	}
	u := &model.User{
		ID:           spec.ID,
		Email:        email,
		DisplayName:  displayName(spec.DisplayName, email),
		SystemRole:   model.SystemRoleMember,
		AuthProvider: model.AuthProviderOIDC,
		Status:       status,
		CreatedAt:    spec.CreatedAt,
		UpdatedAt:    spec.CreatedAt,
	}
	if spec.Bot {
		u.AuthProvider, u.IsBot = "", true
	}
	if err := im.users.CreateUser(ctx, u); err != nil {
		// A concurrent writer won the race for this ID or email: look again
		// once so it is reported the same way the checks above would.
		if errors.Is(err, store.ErrAlreadyExists) && !retried {
			return im.upsertUser(ctx, spec, true)
		}
		return false, fmt.Errorf("importer: create user: %w", err)
	}
	return true, im.indexUser(ctx, u)
}

// makeBot turns an existing account into a bot account (an earlier import
// created it as a person) and takes it out of search.
func (im *Importer) makeBot(ctx context.Context, u *model.User) error {
	u.IsBot, u.AuthProvider, u.UpdatedAt = true, "", time.Now()
	if err := im.users.UpdateUser(ctx, u); err != nil {
		return fmt.Errorf("importer: make bot: %w", err)
	}
	if err := im.InvalidateUsers(ctx, []string{u.ID}); err != nil {
		return err
	}
	return im.indexUser(ctx, u)
}

// indexUser indexes a person for search and removes a bot from it.
func (im *Importer) indexUser(ctx context.Context, u *model.User) error {
	if u.IsBot {
		if err := im.indexer.DeleteUser(ctx, u.ID); err != nil {
			return fmt.Errorf("importer: remove bot from search: %w", err)
		}
		return nil
	}
	if err := im.indexer.IndexUser(ctx, u); err != nil {
		return fmt.Errorf("importer: index user: %w", err)
	}
	return nil
}

// displayName trims and caps the name, falling back to the email's local part.
func displayName(name, email string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		name, _, _ = strings.Cut(email, "@")
	}
	if utf8.RuneCountInString(name) > limits.MaxDisplayNameChars {
		name = string([]rune(name)[:limits.MaxDisplayNameChars])
	}
	return name
}

// InvalidateUsers drops ex's cached records for the given users so the next
// read sees what was written. No-op without a cache.
func (im *Importer) InvalidateUsers(ctx context.Context, ids []string) error {
	if im.cache == nil || len(ids) == 0 {
		return nil
	}
	if err := im.cache.DeleteUsers(ctx, ids); err != nil {
		return fmt.Errorf("importer: invalidate users: %w", err)
	}
	return nil
}
