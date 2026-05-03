package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

type UserIndexer interface {
	IndexUser(ctx context.Context, u *model.User) error
	DeleteUser(ctx context.Context, id string) error
}

// UserSearcher returns matching user IDs; the service hydrates them
// against the user store so the response shape matches the legacy
// in-memory path (avatar URL, status, role, etc.).
type UserSearcher interface {
	Users(ctx context.Context, q string, limit int) ([]string, error)
}

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
	tokens    TokenStore // optional: when set, deactivation invalidates refresh tokens
	indexer   UserIndexer
	searcher  UserSearcher
	// urlCache memoises presigned avatar URLs so repeat fetches return
	// the same URL — the browser then reuses its cached image instead
	// of re-downloading on every render that hits a fresh signature.
	urlCache   *presignedURLCache
	mediaCache MediaURLCache
}

// NewUserService creates a UserService with the given dependencies.
// avatars may be nil; when set, AvatarKey is resolved into a presigned AvatarURL
// on each fetch. publisher may be nil to disable user.updated broadcasts.
func NewUserService(users UserStore, cache Cache, avatars AvatarSigner, publisher Publisher) *UserService {
	return &UserService{
		users:     users,
		cache:     cache,
		avatars:   avatars,
		publisher: publisher,
		// The cache constructor caps this to a short safety window so
		// temporary AWS security tokens embedded in presigned URLs never
		// linger for hours after expiry.
		urlCache: newPresignedURLCache(20 * time.Hour),
	}
}

// SetTokenStore wires a TokenStore so deactivating a user invalidates every
// outstanding refresh token they hold — kicking them out of any open session.
func (s *UserService) SetTokenStore(t TokenStore) { s.tokens = t }

func (s *UserService) SetIndexer(i UserIndexer) { s.indexer = i }

func (s *UserService) SetSearcher(sr UserSearcher) { s.searcher = sr }

func (s *UserService) SetMediaURLCache(c MediaURLCache) { s.mediaCache = c }

func (s *UserService) indexUser(ctx context.Context, u *model.User) {
	indexUser(ctx, s.indexer, u)
}

// indexUser is the nil-safe hook used by both UserService (profile
// edits) and AuthService (signup / invite acceptance).
func indexUser(ctx context.Context, idx UserIndexer, u *model.User) {
	if idx == nil || u == nil {
		return
	}
	if err := idx.IndexUser(ctx, u); err != nil {
		slog.Warn("search index user failed", "id", u.ID, "error", err)
	}
}

// avatarURLTTL is how long avatar presigned URLs remain valid. Frontend
// caches user data via React Query, so this can be short.
const avatarURLTTL = 24 * time.Hour

const expiredStatusSweepBatchSize = 200

// resolveAvatar populates user.AvatarURL from user.AvatarKey using the signer.
// Mutates the user in place. No-op if no signer or no key. The URL is
// cached by S3 key so repeat resolutions hand out the SAME URL —
// otherwise every fresh signature would defeat the browser image cache
// and the same avatar would be re-downloaded on every render.
func (s *UserService) resolveAvatar(ctx context.Context, user *model.User) {
	if s.avatars == nil || user == nil || user.AvatarKey == "" {
		return
	}
	if s.mediaCache != nil {
		if mediaURL, err := StableMediaURL(ctx, s.mediaCache, "avatar", user.ID+":"+user.AvatarKey, user.AvatarKey, "avatar", "", 0); err == nil {
			user.AvatarURL = mediaURL
			return
		}
	}
	url, err := s.urlCache.getOrSign(ctx, presignedKey{op: "get", key: user.AvatarKey},
		func(ctx context.Context) (string, error) {
			return s.avatars.PresignedGetURL(ctx, user.AvatarKey, avatarURLTTL)
		})
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

func normalizeUserProfile(user *model.User) {
	backfillAuthProvider(user)
}

// GetByID returns a user by ID, checking the cache first.
func (s *UserService) GetByID(ctx context.Context, id string) (*model.User, error) {
	if s.cache != nil {
		if user, err := s.cache.GetUser(ctx, id); err == nil {
			normalizeUserProfile(user)
			s.resolveAvatar(ctx, user)
			return user, nil
		}
	}

	user, err := s.users.GetUser(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("user: get by id: %w", err)
	}
	normalizeUserProfile(user)

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
	normalizeUserProfile(user)
	s.resolveAvatar(ctx, user)
	return user, nil
}

// Update modifies optional user profile fields and invalidates the cache.
// avatarKey is the new S3 object key; pass nil to leave it unchanged.
func (s *UserService) Update(ctx context.Context, userID string, displayName, avatarKey, emojiSkinTone *string) (*model.User, error) {
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
		if *avatarKey != "" && !strings.HasPrefix(*avatarKey, "avatars/"+userID+"/") {
			return nil, errors.New("user: avatar key is not owned by this user")
		}
		// New key → drop any cached presigned URL for the previous key
		// so an avatar swap shows up immediately rather than after the
		// cache window elapses.
		s.urlCache.invalidate(user.AvatarKey)
		user.AvatarKey = *avatarKey
	}
	if emojiSkinTone != nil {
		switch *emojiSkinTone {
		case "", "light", "medium_light", "medium", "medium_dark", "dark":
			user.EmojiSkinTone = *emojiSkinTone
		default:
			return nil, errors.New("user: emoji skin tone must be empty, light, medium_light, medium, medium_dark, or dark")
		}
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

	s.indexUser(ctx, user)

	return user, nil
}

// SetUserStatusMessage sets or clears the caller-visible status message.
func (s *UserService) SetUserStatusMessage(ctx context.Context, userID string, status *model.UserStatus, timeZone string) (*model.User, error) {
	user, err := s.users.GetUser(ctx, userID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("user: not found: %w", err)
		}
		return nil, fmt.Errorf("user: get: %w", err)
	}
	normalizeUserProfile(user)
	if status != nil {
		status.Emoji = strings.TrimSpace(status.Emoji)
		status.Text = strings.TrimSpace(status.Text)
		if status.Emoji == "" {
			return nil, errors.New("user: status emoji is required")
		}
		if status.Text == "" {
			return nil, errors.New("user: status text is required")
		}
		if len([]rune(status.Text)) > 32 {
			return nil, errors.New("user: status text must be 32 characters or fewer")
		}
	}
	user.UserStatus = status
	if normalizedTimeZone, ok := normalizeWritableTimeZone(timeZone); ok {
		user.TimeZone = normalizedTimeZone
	}
	user.UpdatedAt = time.Now()
	if err := s.users.UpdateUser(ctx, user); err != nil {
		return nil, fmt.Errorf("user: update status message: %w", err)
	}
	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+userID)
	}
	s.resolveAvatar(ctx, user)
	events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserUpdated, map[string]any{
		"id":         user.ID,
		"userStatus": user.UserStatus,
		"timeZone":   user.TimeZone,
	})
	s.indexUser(ctx, user)
	return user, nil
}

// ClearExpiredStatuses clears persisted statuses whose ClearAt has passed and
// publishes user.updated so every connected client removes the status without
// waiting for that user profile to be read again.
func (s *UserService) ClearExpiredStatuses(ctx context.Context, now time.Time, limit int) (int, error) {
	if limit <= 0 {
		limit = expiredStatusSweepBatchSize
	}

	cleared := 0
	cursor := ""
	for {
		users, nextCursor, err := s.users.ListUsers(ctx, limit, cursor)
		if err != nil {
			return cleared, fmt.Errorf("user: list users for expired statuses: %w", err)
		}
		for _, listedUser := range users {
			if listedUser == nil || listedUser.UserStatus == nil || listedUser.UserStatus.ClearAt == nil || listedUser.UserStatus.ClearAt.After(now) {
				continue
			}

			user, err := s.users.GetUser(ctx, listedUser.ID)
			if err != nil {
				return cleared, fmt.Errorf("user: get expired status user: %w", err)
			}
			if user == nil || user.UserStatus == nil || user.UserStatus.ClearAt == nil || user.UserStatus.ClearAt.After(now) {
				continue
			}

			user.UserStatus = nil
			user.UpdatedAt = now
			if err := s.users.UpdateUser(ctx, user); err != nil {
				return cleared, fmt.Errorf("user: clear expired status: %w", err)
			}
			if s.cache != nil {
				_ = s.cache.Delete(ctx, "user:"+user.ID)
			}
			events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserUpdated, map[string]any{
				"id":         user.ID,
				"userStatus": nil,
				"timeZone":   user.TimeZone,
			})
			s.indexUser(ctx, user)
			cleared++
		}
		if nextCursor == "" {
			return cleared, nil
		}
		cursor = nextCursor
	}
}

// RunExpiredStatusSweeper periodically clears expired statuses from the
// persisted user profiles. Because the expiration timestamp lives in the user
// record, restarting the server only delays the next sweep; it does not lose
// scheduled clears.
func (s *UserService) RunExpiredStatusSweeper(ctx context.Context, interval time.Duration, limit int) {
	if interval <= 0 {
		interval = time.Minute
	}
	run := func() {
		cleared, err := s.ClearExpiredStatuses(ctx, time.Now(), limit)
		if err != nil {
			slog.Warn("user status sweeper failed", "error", err)
			return
		}
		if cleared > 0 {
			slog.Info("user status sweeper cleared expired statuses", "count", cleared)
		}
	}

	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}

// PatchTimeZoneIfChanged records the browser's current local time zone when it
// differs from the stored profile value. It is intentionally quiet on no-op
// calls because /users/me is fetched often.
func (s *UserService) PatchTimeZoneIfChanged(ctx context.Context, userID, timeZone string) (*model.User, error) {
	timeZone, ok := normalizeWritableTimeZone(timeZone)
	if !ok || timeZone == "" {
		return nil, nil
	}
	user, err := s.users.GetUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("user: get: %w", err)
	}
	if user.TimeZone == timeZone {
		return user, nil
	}
	user.TimeZone = timeZone
	user.UpdatedAt = time.Now()
	if err := s.users.UpdateUser(ctx, user); err != nil {
		return nil, fmt.Errorf("user: update time zone: %w", err)
	}
	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+userID)
	}
	events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserUpdated, map[string]any{
		"id":       user.ID,
		"timeZone": user.TimeZone,
	})
	s.indexUser(ctx, user)
	return user, nil
}

func normalizeWritableTimeZone(timeZone string) (string, bool) {
	timeZone = strings.TrimSpace(timeZone)
	if timeZone == "" {
		return "", true
	}
	if _, err := time.LoadLocation(timeZone); err != nil {
		return "", false
	}
	return timeZone, true
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

// Search returns users whose display name or email matches the query.
// When an OpenSearch searcher is wired, the query is routed there and
// hits are hydrated from the user store so the response carries the
// full model (avatar, role, status). Otherwise it falls back to a
// substring scan over the first page of ListUsers — fine for small
// teams, and the same behaviour the app shipped with.
func (s *UserService) Search(ctx context.Context, query string, limit int) ([]*model.User, error) {
	if s.searcher != nil {
		ids, err := s.searcher.Users(ctx, query, limit)
		if err == nil {
			out := make([]*model.User, 0, len(ids))
			for _, id := range ids {
				u, err := s.users.GetUser(ctx, id)
				if err != nil || u == nil {
					continue
				}
				normalizeUserProfile(u)
				s.resolveAvatar(ctx, u)
				out = append(out, u)
			}
			return out, nil
		}
		// Fall through on searcher error so a transient ES outage
		// degrades to "slower" rather than "broken".
	}
	all, _, err := s.users.ListUsers(ctx, 200, "")
	if err != nil {
		return nil, err
	}
	query = strings.ToLower(query)
	var results []*model.User
	for _, u := range all {
		if strings.Contains(strings.ToLower(u.DisplayName), query) ||
			strings.Contains(strings.ToLower(u.Email), query) {
			normalizeUserProfile(u)
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
	s.indexUser(ctx, user)
	return user, nil
}

// SetStatus marks a user active or deactivated. Only guest accounts can be
// deactivated this way — SSO-managed users are governed by the upstream IdP.
// The handler enforces actor admin rights; this performs the mutation and
// emits a user.updated event so connected clients refresh.
func (s *UserService) SetStatus(ctx context.Context, targetID string, deactivated bool) (*model.User, error) {
	user, err := s.users.GetUser(ctx, targetID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("user: not found: %w", err)
		}
		return nil, fmt.Errorf("user: get: %w", err)
	}
	backfillAuthProvider(user)
	if user.AuthProvider != model.AuthProviderGuest {
		return nil, errors.New("user: only guest accounts can be deactivated")
	}
	if deactivated {
		user.Status = "deactivated"
	} else {
		user.Status = "active"
	}
	user.UpdatedAt = time.Now()
	if err := s.users.UpdateUser(ctx, user); err != nil {
		return nil, fmt.Errorf("user: update status: %w", err)
	}
	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+targetID)
	}
	s.resolveAvatar(ctx, user)

	// Deactivation must end any active session. Wipe every refresh token so
	// the user can't silently re-acquire an access token, and broadcast a
	// targeted force-logout to the user's personal channel so any open tab
	// disconnects right now instead of waiting for its short-lived JWT to
	// expire.
	if deactivated {
		if s.tokens != nil {
			_ = s.tokens.DeleteAllRefreshTokensForUser(ctx, targetID)
		}
		events.Publish(ctx, s.publisher, pubsub.UserChannel(targetID), events.EventForceLogout, map[string]any{
			"userID": targetID,
			"reason": "deactivated",
		})
	}

	events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserUpdated, map[string]any{
		"id":     user.ID,
		"status": user.Status,
	})

	s.indexUser(ctx, user)

	return user, nil
}

// List returns a paginated list of users.
func (s *UserService) List(ctx context.Context, limit int, cursor string) ([]*model.User, string, error) {
	users, nextCursor, err := s.users.ListUsers(ctx, limit, cursor)
	if err != nil {
		return nil, "", fmt.Errorf("user: list: %w", err)
	}
	for _, u := range users {
		normalizeUserProfile(u)
		s.resolveAvatar(ctx, u)
	}
	return users, nextCursor, nil
}
