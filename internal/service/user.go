package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
)

const MaxUserDisplayNameLen = 80

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
	tokens    TokenStore    // optional: when set, deactivation invalidates refresh tokens
	runners   RunnerRevoker // optional: when set, deactivation disconnects ex-runners
	indexer   UserIndexer
	searcher  UserSearcher
	// urlCache memoises presigned avatar URLs so repeat fetches return
	// the same URL — the browser then reuses its cached image instead
	// of re-downloading on every render that hits a fresh signature.
	urlCache      *presignedURLCache
	mediaCache    MediaURLCache
	reminders     ReminderCanceller
	automations   AutomationStopper
	avatarObjects AvatarObjects
	// avatarDecoding bounds the memory an avatar decode may take.
	avatarDecoding avatarDecoding
	// audience is told when account notification settings change, so every
	// instance's notification audience cache reloads the user.
	audience AudienceInvalidator
}

// SetAudienceInvalidator wires the notification audience cache's
// invalidation into account notification-settings writes.
func (s *UserService) SetAudienceInvalidator(a AudienceInvalidator) { s.audience = a }

// ReminderCanceller stops a deactivated user's queued reminders. Implemented by
// ReminderService.
type ReminderCanceller interface {
	CancelAllForUser(ctx context.Context, userID string) error
}

// AutomationStopper stops everything an account's agents do on its behalf —
// standing watch/schedule orders and live runs. Implemented by the
// Orchestrator (StopUserAutomations).
type AutomationStopper interface {
	StopUserAutomations(ctx context.Context, userID string) error
}

// RunnerRevoker disconnects every ex-runner a user has paired. Account
// deactivation and password reset call it next to wiping refresh tokens: a
// runner is a machine credential of the same account. Implemented by the
// agents package's RunnerTokenService.
type RunnerRevoker interface {
	RevokeAllForUser(ctx context.Context, userID string) error
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
		urlCache:       newPresignedURLCache(20 * time.Hour),
		avatarDecoding: serverAvatarDecoding,
	}
}

// SetTokenStore wires a TokenStore so deactivating a user invalidates every
// outstanding refresh token they hold — kicking them out of any open session.
func (s *UserService) SetTokenStore(t TokenStore) { s.tokens = t }

// SetRunnerRevoker wires ex-runner revocation into account deactivation.
func (s *UserService) SetRunnerRevoker(r RunnerRevoker) { s.runners = r }

func (s *UserService) SetIndexer(i UserIndexer) { s.indexer = i }

func (s *UserService) SetSearcher(sr UserSearcher) { s.searcher = sr }

func (s *UserService) SetMediaURLCache(c MediaURLCache) { s.mediaCache = c }

// SetAvatarObjects wires the storage uploaded avatars are read from and their
// shrunk copies written to. Without it a new avatar cannot be set.
func (s *UserService) SetAvatarObjects(o AvatarObjects) { s.avatarObjects = o }

// SetReminderCanceller wires reminder cleanup into deactivation, so an account
// that can no longer sign in leaves no reminders queued to fire.
func (s *UserService) SetReminderCanceller(r ReminderCanceller) { s.reminders = r }

// SetAutomationStopper wires agent-automation shutdown into deactivation, so
// a deactivated account's watchers, schedules and runs stop with it.
func (s *UserService) SetAutomationStopper(a AutomationStopper) { s.automations = a }

func (s *UserService) indexUser(ctx context.Context, u *model.User) {
	IndexUser(ctx, s.indexer, u)
}

// IndexUser is the nil-safe hook used by UserService (profile edits),
// AuthService (signup / invite acceptance) and the agents package (shared
// agent users).
func IndexUser(ctx context.Context, idx UserIndexer, u *model.User) {
	if idx == nil || u == nil {
		return
	}
	// Keeps bots out of mention autocomplete and user search.
	if u.IsBot {
		return
	}
	if err := idx.IndexUser(ctx, u); err != nil {
		slog.WarnContext(ctx, "search index user failed", "id", u.ID, "error", err)
	}
}

// avatarURLTTL is how long avatar presigned URLs remain valid. Frontend
// caches user data via React Query, so this can be short.
const avatarURLTTL = 24 * time.Hour

const expiredStatusSweepBatchSize = 200
const maxUserStatusClearAfter = 366 * 24 * time.Hour

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

// resolveAvatars resolves avatar URLs for MANY users in two Redis round trips
// (one MGET for the media records, one pipelined write for misses) instead of
// the serial per-user GETs that made avatar resolution dominate /users/batch
// and the directory list. Users the batch can't serve (no media cache, mint
// failure) fall back to the per-user path, which also covers the presigned-URL
// route.
func (s *UserService) resolveAvatars(ctx context.Context, users []*model.User) {
	if s.avatars == nil {
		return
	}
	if s.mediaCache == nil {
		for _, u := range users {
			s.resolveAvatar(ctx, u)
		}
		return
	}
	reqs := make([]MediaURLRequest, 0, len(users))
	for _, u := range users {
		if u == nil || u.AvatarKey == "" {
			continue
		}
		reqs = append(reqs, MediaURLRequest{ID: u.ID + ":" + u.AvatarKey, S3Key: u.AvatarKey, Filename: "avatar"})
	}
	urls := StableMediaURLs(ctx, s.mediaCache, "avatar", reqs)
	for _, u := range users {
		if u == nil || u.AvatarKey == "" {
			continue
		}
		if mediaURL, ok := urls[u.ID+":"+u.AvatarKey]; ok {
			u.AvatarURL = mediaURL
			continue
		}
		s.resolveAvatar(ctx, u)
	}
}

// batchUserCache is the optional MGET/pipeline capability of the user cache
// (implemented by the Redis cache). Asserted at call sites with a per-ID
// fallback, mirroring batchUserStore.
type batchUserCache interface {
	GetUsers(ctx context.Context, ids []string) (map[string]*model.User, error)
	SetUsers(ctx context.Context, users []*model.User) error
}

// cacheUsers fills the cache for many users — one pipelined write when the
// cache batches, per-user Sets otherwise. Best-effort like SetUser callers.
func (s *UserService) cacheUsers(ctx context.Context, users []*model.User) {
	if s.cache == nil || len(users) == 0 {
		return
	}
	if bc, ok := s.cache.(batchUserCache); ok {
		_ = bc.SetUsers(ctx, users)
		return
	}
	for _, u := range users {
		_ = s.cache.SetUser(ctx, u)
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
	// Populate notification settings with the defaults on read so every client
	// gets concrete values to render, without persisting a default record for
	// users who never customised it.
	if user != nil && user.NotificationSettings == nil {
		def := model.DefaultNotificationSettings()
		user.NotificationSettings = &def
	}
}

// MaxNotificationKeywords / MaxNotificationKeywordLen bound the global keyword
// list so a single user can't bloat their record (and the per-message keyword
// scan) without limit.
const (
	MaxNotificationKeywords   = 50
	MaxNotificationKeywordLen = 100
)

// normalizeKeywords trims, de-dupes (case-insensitively), length-clamps and
// caps the keyword list. Returns nil for an empty result so the attribute is
// omitted entirely.
func normalizeKeywords(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, kw := range in {
		kw = strings.TrimSpace(kw)
		if kw == "" {
			continue
		}
		if utf8.RuneCountInString(kw) > MaxNotificationKeywordLen {
			kw = string([]rune(kw)[:MaxNotificationKeywordLen])
		}
		key := strings.ToLower(kw)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, kw)
		if len(out) >= MaxNotificationKeywords {
			break
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// SetNotificationSettings persists the caller's account-level notification
// settings (levels, toggles, and the global keyword list) and notifies the
// user's own connected clients so every tab/device stays in sync.
func (s *UserService) SetNotificationSettings(ctx context.Context, userID string, settings model.NotificationSettings) (*model.User, error) {
	if !settings.DesktopLevel.Valid() {
		return nil, apperr.Invalid("user: invalid desktop notification level")
	}
	if !settings.MobileLevel.Valid() {
		return nil, apperr.Invalid("user: invalid mobile notification level")
	}
	settings.Keywords = normalizeKeywords(settings.Keywords)

	user, err := s.users.GetUser(ctx, userID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("user: not found: %w", err)
		}
		return nil, fmt.Errorf("user: get: %w", err)
	}
	cp := settings
	user.NotificationSettings = &cp
	user.UpdatedAt = time.Now()

	err = s.users.UpdateUser(ctx, user)
	// Even a failed write may have committed: move the audience on either way.
	if s.audience != nil {
		s.audience.UserAudienceChanged(ctx, userID)
	}
	if err != nil {
		return nil, fmt.Errorf("user: update notification settings: %w", err)
	}
	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+userID)
	}
	s.resolveAvatar(ctx, user)

	// Notification settings are private to the user — fan out only to their own
	// channel, never the global user.updated broadcast.
	events.Publish(ctx, s.publisher, pubsub.UserChannel(userID), events.EventNotificationSettingsUpdated, map[string]any{
		"userID":   userID,
		"settings": settings,
	})
	return user, nil
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

// UserAccess returns just the account status and the STORED system role —
// the auth middleware's deactivation and role check runs on EVERY
// authenticated request and discards everything else, so this path
// deliberately skips the avatar-URL resolution GetByID performs (1-3 extra
// Redis round trips per request for a presigned URL nobody read).
// Cache-first with a store fill on miss, same as GetByID, so steady state is
// one Redis GET per request; every role/status writer evicts the cached copy.
func (s *UserService) UserAccess(ctx context.Context, id string) (string, model.SystemRole, error) {
	if s.cache != nil {
		if user, err := s.cache.GetUser(ctx, id); err == nil {
			return user.Status, user.SystemRole, nil
		}
	}
	user, err := s.users.GetUser(ctx, id)
	if err != nil {
		return "", "", fmt.Errorf("user: get access: %w", err)
	}
	normalizeUserProfile(user)
	if s.cache != nil {
		_ = s.cache.SetUser(ctx, user)
	}
	return user.Status, user.SystemRole, nil
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
			return nil, apperr.Forbidden("user: display name is managed by SSO provider and cannot be edited here")
		}
		name := strings.TrimSpace(*displayName)
		if name == "" || utf8.RuneCountInString(name) > MaxUserDisplayNameLen {
			return nil, apperr.Invalid("user: display name must be 1-%d characters", MaxUserDisplayNameLen)
		}
		user.DisplayName = name
	}
	if avatarKey != nil && *avatarKey != "" && !strings.HasPrefix(*avatarKey, "avatars/"+userID+"/") {
		return nil, apperr.Forbidden("user: avatar key is not owned by this user")
	}
	if emojiSkinTone != nil {
		switch *emojiSkinTone {
		case "", "light", "medium_light", "medium", "medium_dark", "dark":
			user.EmojiSkinTone = *emojiSkinTone
		default:
			return nil, apperr.Invalid("user: emoji skin tone must be empty, light, medium_light, medium, medium_dark, or dark")
		}
	}
	// The avatar goes last: storing it removes the upload, so every other
	// field must already have passed.
	if avatarKey != nil && *avatarKey != user.AvatarKey {
		key := *avatarKey
		if key != "" {
			if key, err = s.storeUploadedAvatar(ctx, userID, key); err != nil {
				return nil, err
			}
		}
		// New key → drop any cached presigned URL for the previous key
		// so an avatar swap shows up immediately rather than after the
		// cache window elapses.
		s.urlCache.invalidate(user.AvatarKey)
		user.AvatarKey = key
	}
	user.UpdatedAt = time.Now()
	return s.saveProfile(ctx, user)
}

// saveProfile writes a changed profile and tells everyone about it.
func (s *UserService) saveProfile(ctx context.Context, user *model.User) (*model.User, error) {
	if err := s.users.UpdateUser(ctx, user); err != nil {
		return nil, fmt.Errorf("user: update: %w", err)
	}

	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+user.ID)
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
// clearAfter is a duration from server time; clients must not supply an
// absolute persisted timestamp because their clock can be wrong.
func (s *UserService) SetUserStatusMessage(ctx context.Context, userID string, status *model.UserStatus, clearAfter *time.Duration, timeZone string) (*model.User, error) {
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
			return nil, apperr.Invalid("user: status emoji is required")
		}
		if status.Text == "" {
			return nil, apperr.Invalid("user: status text is required")
		}
		if len([]rune(status.Text)) > 32 {
			return nil, apperr.Invalid("user: status text must be 32 characters or fewer")
		}
		status.ClearAt = nil
		if clearAfter != nil {
			if *clearAfter <= 0 {
				return nil, apperr.Invalid("user: status clear duration must be positive")
			}
			if *clearAfter > maxUserStatusClearAfter {
				return nil, apperr.Invalid("user: status clear duration is too far in the future")
			}
			clearAt := time.Now().Add(*clearAfter)
			status.ClearAt = &clearAt
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

			user, ok, err := s.clearExpiredStatus(ctx, listedUser, now)
			if err != nil {
				return cleared, err
			}
			if !ok {
				continue
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

// conditionalStatusClearer is the optional atomic form of the status clear
// (the DynamoDB store has it): remove the status only while it still carries
// the clearAt the sweep observed — one surgical write, no read, and a user
// who just set a NEW status keeps it.
type conditionalStatusClearer interface {
	ClearUserStatusIfExpired(ctx context.Context, userID string, seenClearAt time.Time, now time.Time) (bool, error)
}

// clearExpiredStatus clears one user's expired status, returning the user to
// publish for and whether anything was cleared. Prefers the conditional
// single-write path; plain stores keep the legacy re-read + full update.
func (s *UserService) clearExpiredStatus(ctx context.Context, listedUser *model.User, now time.Time) (*model.User, bool, error) {
	if cc, ok := s.users.(conditionalStatusClearer); ok {
		cleared, err := cc.ClearUserStatusIfExpired(ctx, listedUser.ID, *listedUser.UserStatus.ClearAt, now)
		if err != nil {
			return nil, false, fmt.Errorf("user: clear expired status: %w", err)
		}
		if !cleared {
			return nil, false, nil
		}
		u := *listedUser
		u.UserStatus = nil
		u.UpdatedAt = now
		return &u, true, nil
	}
	user, err := s.users.GetUser(ctx, listedUser.ID)
	if err != nil {
		return nil, false, fmt.Errorf("user: get expired status user: %w", err)
	}
	if user == nil || user.UserStatus == nil || user.UserStatus.ClearAt == nil || user.UserStatus.ClearAt.After(now) {
		return nil, false, nil
	}
	user.UserStatus = nil
	user.UpdatedAt = now
	if err := s.users.UpdateUser(ctx, user); err != nil {
		return nil, false, fmt.Errorf("user: clear expired status: %w", err)
	}
	return user, true, nil
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
		// Each sweep is panic-isolated: the sweeper runs detached for the
		// life of the process, so an unrecovered panic here would take the
		// instance — and every WebSocket on it — down. The next tick retries.
		defer safe.Recover()
		cleared, err := s.ClearExpiredStatuses(ctx, time.Now(), limit)
		if err != nil {
			slog.WarnContext(ctx, "user status sweeper failed", "error", err)
			return
		}
		if cleared > 0 {
			slog.InfoContext(ctx, "user status sweeper cleared expired statuses", "count", cleared)
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
	now := time.Now()
	if err := s.users.PatchUser(ctx, userID, store.UserPatch{TimeZone: &timeZone, UpdatedAt: now}); err != nil {
		return nil, fmt.Errorf("user: update time zone: %w", err)
	}
	user.TimeZone = timeZone
	user.UpdatedAt = now
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

// batchUserStore is an optional capability: fetch many users in one batched
// store call. UserService uses it for cache misses when available.
type batchUserStore interface {
	GetUsersByIDs(ctx context.Context, ids []string) ([]*model.User, error)
}

// GetBatch returns users by a list of IDs (input order, missing users skipped).
// Cache hits are served first; the misses are resolved in a SINGLE batched
// store read when the store supports it (instead of N serial GetItems on a cold
// cache), falling back to per-id reads otherwise.
func (s *UserService) GetBatch(ctx context.Context, ids []string) ([]*model.User, error) {
	byID := make(map[string]*model.User, len(ids))
	misses := make([]string, 0, len(ids))
	// One MGET for the whole ID list when the cache batches — the old per-ID
	// loop cost a sequential Redis round trip per user (2N with avatars).
	if bc, ok := s.cache.(batchUserCache); ok {
		if cached, err := bc.GetUsers(ctx, ids); err == nil {
			for _, id := range ids {
				if u, ok := cached[id]; ok {
					normalizeUserProfile(u)
					byID[id] = u
					continue
				}
				misses = append(misses, id)
			}
		} else {
			misses = append(misses, ids...)
		}
	} else {
		for _, id := range ids {
			if s.cache != nil {
				if u, err := s.cache.GetUser(ctx, id); err == nil {
					normalizeUserProfile(u)
					byID[id] = u
					continue
				}
			}
			misses = append(misses, id)
		}
	}

	bs, batchable := s.users.(batchUserStore)
	if batchable && len(misses) > 0 {
		if fetched, err := bs.GetUsersByIDs(ctx, misses); err == nil {
			toCache := make([]*model.User, 0, len(fetched))
			for _, u := range fetched {
				normalizeUserProfile(u)
				byID[u.ID] = u
				toCache = append(toCache, u)
			}
			s.cacheUsers(ctx, toCache)
			misses = nil // resolved via the batch
		}
		// On a batch error, fall through to the per-id resolution below.
	}
	for _, id := range misses {
		if u, err := s.GetByID(ctx, id); err == nil { // cached + avatar
			byID[id] = u
		}
	}

	out := make([]*model.User, 0, len(byID))
	seen := make(map[string]bool, len(byID))
	for _, id := range ids {
		if u, ok := byID[id]; ok && !seen[id] {
			out = append(out, u)
			seen[id] = true
		}
	}
	// ONE batched avatar resolution for the whole result — two Redis round
	// trips total instead of one (or three) per user.
	s.resolveAvatars(ctx, out)
	return out, nil
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
				if err != nil || u == nil || u.IsBot {
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
		if u.IsBot {
			continue
		}
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
		return nil, apperr.Invalid("user: guests cannot be promoted; member and admin roles are SSO-only")
	}
	now := time.Now()
	if err := s.users.PatchUser(ctx, targetID, store.UserPatch{SystemRole: &role, UpdatedAt: now}); err != nil {
		return nil, fmt.Errorf("user: update role: %w", err)
	}
	user.SystemRole = role
	user.UpdatedAt = now
	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+targetID)
	}
	s.resolveAvatar(ctx, user)
	s.indexUser(ctx, user)
	return user, nil
}

// SetStatus marks any account active or deactivated on an admin's behalf —
// SSO accounts included: the IdP can stop new logins, but only this ends the
// sessions and automations the account already has. The handler enforces
// actor admin rights (and refuses self-deactivation); this performs the
// mutation and emits a user.updated event so connected clients refresh.
func (s *UserService) SetStatus(ctx context.Context, targetID string, deactivated bool) (*model.User, error) {
	user, err := s.users.GetUser(ctx, targetID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, fmt.Errorf("user: not found: %w", err)
		}
		return nil, fmt.Errorf("user: get: %w", err)
	}
	backfillAuthProvider(user)
	return s.applyStatus(ctx, user, deactivated, model.DeactivatedByAdmin)
}

// SetStatusFromDirectory flips an SSO-managed account's status on behalf of
// the employee directory (the periodic MS Graph sweep): an account deleted
// upstream is deactivated — ending its live sessions, since SSO removal alone
// doesn't invalidate refresh tokens — and reactivated if it reappears. The
// directory only ever undoes its OWN deactivation: an account an admin
// deactivated stays deactivated however present it is upstream.
func (s *UserService) SetStatusFromDirectory(ctx context.Context, targetID string, deactivated bool) error {
	user, err := s.users.GetUser(ctx, targetID)
	if err != nil {
		return fmt.Errorf("user: get: %w", err)
	}
	backfillAuthProvider(user)
	if user.AuthProvider != model.AuthProviderOIDC {
		return apperr.Invalid("user: directory status only applies to SSO accounts")
	}
	wantStatus := "active"
	if deactivated {
		wantStatus = "deactivated"
	}
	if user.Status == wantStatus {
		return nil
	}
	if !deactivated && user.DeactivatedBy == model.DeactivatedByAdmin {
		return nil
	}
	_, err = s.applyStatus(ctx, user, deactivated, model.DeactivatedByDirectory)
	return err
}

// applyStatus persists an active/deactivated flip and runs every side effect
// deactivation demands: cache eviction, refresh-token and runner revocation
// plus force-logout (a deactivated account must not keep a working session),
// reminder and agent-automation shutdown, and the user.updated broadcast.
//
// The status write is field-level, so it can't be undone by a concurrent
// writer's stale copy. A failed revocation (or automation shutdown) fails
// the call after every other step ran: the admin sees the error and
// retries, rather than believing an account is locked out while a
// credential survives.
func (s *UserService) applyStatus(ctx context.Context, user *model.User, deactivated bool, by string) (*model.User, error) {
	status, deactivatedBy := "active", ""
	if deactivated {
		status, deactivatedBy = "deactivated", by
	}
	now := time.Now()
	if err := s.users.PatchUser(ctx, user.ID, store.UserPatch{Status: &status, DeactivatedBy: &deactivatedBy, UpdatedAt: now}); err != nil {
		return nil, fmt.Errorf("user: update status: %w", err)
	}
	user.Status, user.DeactivatedBy, user.UpdatedAt = status, deactivatedBy, now
	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+user.ID)
	}
	// Every instance's notification audience reloads the account, so the
	// next message alerts (or stops alerting) it straight away.
	if s.audience != nil {
		s.audience.UserAudienceChanged(ctx, user.ID)
	}
	s.resolveAvatar(ctx, user)

	var failed []error
	// Deactivation must end any active session. Wipe every refresh token so
	// the user can't silently re-acquire an access token, and broadcast a
	// targeted force-logout to the user's personal channel so any open tab
	// disconnects right now instead of waiting for its short-lived JWT to
	// expire.
	if deactivated {
		if s.tokens != nil {
			if err := s.tokens.DeleteAllRefreshTokensForUser(ctx, user.ID); err != nil {
				slog.ErrorContext(ctx, "deactivation: revoking refresh tokens failed", "userID", user.ID, "error", err)
				failed = append(failed, fmt.Errorf("revoke sessions: %w", err))
			}
		}
		// Its runners too: a deactivated account's agents must stop running
		// on whatever machines were paired to it.
		if s.runners != nil {
			if err := s.runners.RevokeAllForUser(ctx, user.ID); err != nil {
				slog.ErrorContext(ctx, "deactivation: revoking runner tokens failed", "userID", user.ID, "error", err)
				failed = append(failed, fmt.Errorf("revoke runners: %w", err))
			}
		}
		events.Publish(ctx, s.publisher, pubsub.UserChannel(user.ID), events.EventForceLogout, map[string]any{
			"userID": user.ID,
			"reason": "deactivated",
		})
		// Nobody is left to read a reminder: stop them all now rather than
		// claim, check and drop each one when it comes due. If this fails,
		// the due-time owner check still drops them.
		if s.reminders != nil {
			if err := s.reminders.CancelAllForUser(ctx, user.ID); err != nil {
				slog.WarnContext(ctx, "deactivation: reminder cleanup failed", "userID", user.ID, "error", err)
			}
		}
		// Standing orders and live runs act with the account's permissions:
		// they stop with it.
		if s.automations != nil {
			if err := s.automations.StopUserAutomations(ctx, user.ID); err != nil {
				slog.ErrorContext(ctx, "deactivation: stopping agent automations failed", "userID", user.ID, "error", err)
				failed = append(failed, fmt.Errorf("stop automations: %w", err))
			}
		}
	}

	events.Publish(ctx, s.publisher, pubsub.UserEvents(), events.EventUserUpdated, map[string]any{
		"id":     user.ID,
		"status": user.Status,
	})

	s.indexUser(ctx, user)

	if len(failed) > 0 {
		return nil, fmt.Errorf("user: deactivated, but cleanup failed: %w", errors.Join(failed...))
	}
	return user, nil
}

// List returns a paginated list of users.
func (s *UserService) List(ctx context.Context, limit int, cursor string) ([]*model.User, string, error) {
	users, nextCursor, err := s.users.ListUsers(ctx, limit, cursor)
	if err != nil {
		return nil, "", fmt.Errorf("user: list: %w", err)
	}
	// Filtered after paging, not in the store: a store-side filter would return
	// short pages. Bots are a handful of rows.
	users = slices.DeleteFunc(users, func(u *model.User) bool { return u != nil && u.IsBot })
	for _, u := range users {
		normalizeUserProfile(u)
	}
	// Batched: the old per-user resolveAvatar cost a serial Redis GET each.
	s.resolveAvatars(ctx, users)
	return users, nextCursor, nil
}
