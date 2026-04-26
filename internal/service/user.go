package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// AvatarSigner generates time-limited GET URLs for avatar storage keys.
type AvatarSigner interface {
	PresignedGetURL(ctx context.Context, key string, expires time.Duration) (string, error)
}

// UserService provides user profile operations.
type UserService struct {
	users     UserStore
	cache     Cache
	avatars   AvatarSigner
	publisher Publisher
}

// NewUserService creates a UserService with the given dependencies.
// avatars may be nil; when set, AvatarKey is resolved into a presigned AvatarURL
// on each fetch. publisher may be nil to disable user.updated broadcasts.
func NewUserService(users UserStore, cache Cache, avatars AvatarSigner, publisher Publisher) *UserService {
	return &UserService{users: users, cache: cache, avatars: avatars, publisher: publisher}
}

// avatarURLTTL is how long avatar presigned URLs remain valid. Frontend
// caches user data via React Query, so this can be short.
const avatarURLTTL = 6 * time.Hour

// resolveAvatar populates user.AvatarURL from user.AvatarKey using the signer.
// Mutates the user in place. No-op if no signer or no key.
func (s *UserService) resolveAvatar(ctx context.Context, user *model.User) {
	if s.avatars == nil || user == nil || user.AvatarKey == "" {
		return
	}
	url, err := s.avatars.PresignedGetURL(ctx, user.AvatarKey, avatarURLTTL)
	if err == nil {
		user.AvatarURL = url
	}
}

// backfillAuthProvider derives the auth provider for users created before the
// field was introduced. The rule mirrors how new users are created: any user
// with a stored password came in via invite acceptance (guest); everyone
// else logged in via OIDC. Without this, legacy SSO users would slip past
// the display-name lock because their AuthProvider is empty.
func backfillAuthProvider(user *model.User) {
	if user == nil || user.AuthProvider != "" {
		return
	}
	if user.PasswordHash != "" {
		user.AuthProvider = model.AuthProviderGuest
	} else {
		user.AuthProvider = model.AuthProviderOIDC
	}
}

// GetByID returns a user by ID, checking the cache first.
func (s *UserService) GetByID(ctx context.Context, id string) (*model.User, error) {
	if s.cache != nil {
		if user, err := s.cache.GetUser(ctx, id); err == nil {
			backfillAuthProvider(user)
			s.resolveAvatar(ctx, user)
			return user, nil
		}
	}

	user, err := s.users.GetUser(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("user: get by id: %w", err)
	}
	backfillAuthProvider(user)

	if s.cache != nil {
		_ = s.cache.SetUser(ctx, user)
	}
	s.resolveAvatar(ctx, user)
	return user, nil
}

// GetByEmail returns a user by email address.
func (s *UserService) GetByEmail(ctx context.Context, email string) (*model.User, error) {
	user, err := s.users.GetUserByEmail(ctx, email)
	if err != nil {
		return nil, fmt.Errorf("user: get by email: %w", err)
	}
	s.resolveAvatar(ctx, user)
	return user, nil
}

// Update modifies optional user profile fields and invalidates the cache.
// avatarKey is the new S3 object key; pass nil to leave it unchanged.
func (s *UserService) Update(ctx context.Context, userID string, displayName, avatarKey *string) (*model.User, error) {
	user, err := s.users.GetUser(ctx, userID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("user: not found: %w", err)
		}
		return nil, fmt.Errorf("user: get: %w", err)
	}

	if displayName != nil && *displayName != user.DisplayName {
		// SSO/OIDC users cannot rename themselves — the display name is owned
		// by the upstream identity provider and is overwritten on every login.
		// Allowing local edits would silently revert on the next sign-in and
		// confuse the user.
		if user.AuthProvider == model.AuthProviderOIDC {
			return nil, errors.New("user: display name is managed by SSO provider and cannot be edited here")
		}
		user.DisplayName = *displayName
	}
	if avatarKey != nil {
		user.AvatarKey = *avatarKey
	}
	user.UpdatedAt = time.Now()

	if err := s.users.UpdateUser(ctx, user); err != nil {
		return nil, fmt.Errorf("user: update: %w", err)
	}

	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+userID)
	}
	s.resolveAvatar(ctx, user)

	// Broadcast a global user.updated event so connected clients refresh stale
	// avatars and display names without a hard reload.
	events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserUpdated, map[string]any{
		"id":          user.ID,
		"displayName": user.DisplayName,
		"avatarURL":   user.AvatarURL,
	})

	return user, nil
}

// GetBatch returns users by a list of IDs. Missing users are silently skipped.
// AvatarURLs are resolved on each user via GetByID.
func (s *UserService) GetBatch(ctx context.Context, ids []string) ([]*model.User, error) {
	users := make([]*model.User, 0, len(ids))
	for _, id := range ids {
		u, err := s.GetByID(ctx, id) // uses cache + resolves avatar
		if err != nil {
			continue // skip missing users
		}
		users = append(users, u)
	}
	return users, nil
}

// Search returns users whose display name or email contains the query string.
// It filters in memory, which is acceptable for small teams.
func (s *UserService) Search(ctx context.Context, query string, limit int) ([]*model.User, error) {
	all, _, err := s.users.ListUsers(ctx, 200, "")
	if err != nil {
		return nil, err
	}
	query = strings.ToLower(query)
	var results []*model.User
	for _, u := range all {
		if strings.Contains(strings.ToLower(u.DisplayName), query) ||
			strings.Contains(strings.ToLower(u.Email), query) {
			s.resolveAvatar(ctx, u)
			results = append(results, u)
			if len(results) >= limit {
				break
			}
		}
	}
	return results, nil
}

// UpdateRole sets the system role on a user. The handler is responsible for
// enforcing that the actor is a system admin; this function performs the
// underlying mutation and invalidates the user cache.
//
// Guest accounts (created via invite acceptance) cannot be promoted to
// member or admin — those roles are reserved for SSO-authenticated
// employees. A guest must re-onboard through SSO to gain a non-guest
// role. Demotions to "guest" remain allowed.
func (s *UserService) UpdateRole(ctx context.Context, _, targetID string, role model.SystemRole) (*model.User, error) {
	user, err := s.users.GetUser(ctx, targetID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("user: not found: %w", err)
		}
		return nil, fmt.Errorf("user: get: %w", err)
	}
	backfillAuthProvider(user)
	if user.AuthProvider == model.AuthProviderGuest && role != model.SystemRoleGuest {
		return nil, errors.New("user: guests cannot be promoted; member and admin roles are SSO-only")
	}
	user.SystemRole = role
	user.UpdatedAt = time.Now()
	if err := s.users.UpdateUser(ctx, user); err != nil {
		return nil, fmt.Errorf("user: update role: %w", err)
	}
	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+targetID)
	}
	s.resolveAvatar(ctx, user)
	return user, nil
}

// List returns a paginated list of users.
func (s *UserService) List(ctx context.Context, limit int, cursor string) ([]*model.User, string, error) {
	users, nextCursor, err := s.users.ListUsers(ctx, limit, cursor)
	if err != nil {
		return nil, "", fmt.Errorf("user: list: %w", err)
	}
	for _, u := range users {
		s.resolveAvatar(ctx, u)
	}
	return users, nextCursor, nil
}
