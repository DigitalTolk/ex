package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// Periodic employee-directory re-sync. Login-time enrichment only refreshes a
// profile when its owner signs in — with month-long sessions, a phone number
// or manager changed in Entra while someone is on vacation would go stale for
// everyone else. This sweep re-reads the directory for every OIDC user on an
// interval; the first sweep runs at boot, which doubles as the initial
// backfill for a workspace that enabled the integration after users existed.

const (
	defaultDirectorySyncInterval = 12 * time.Hour
	directorySyncLockKey         = "msdirsync:lock"
	directorySyncPageSize        = 200
	// directorySyncMaxConsecutiveErrors aborts a sweep when the directory
	// looks down (every lookup failing) instead of hammering it N-users times.
	directorySyncMaxConsecutiveErrors = 5
	// directorySyncMinDeactivationCap floors the per-sweep deactivation
	// circuit breaker: a sweep may deactivate at most max(this, 10% of the
	// users it scanned). A tenant/app-registration misconfiguration makes
	// EVERY oid lookup 404 — without the cap that would read as "the whole
	// company was offboarded" and lock everyone out.
	directorySyncMinDeactivationCap = 3
)

// DirectorySyncLocker is the single-runner election capability (RedisCache).
// The winner holds the lock for the whole window, so N instances sweeping on
// the same interval sync the directory exactly once per window.
type DirectorySyncLocker interface {
	AcquireLock(ctx context.Context, key, token string, ttl time.Duration) (bool, error)
}

// DirectoryStatusSetter flips an SSO account active/deactivated on the
// directory's authority (UserService.SetStatusFromDirectory): deactivation
// wipes refresh tokens and force-logs-out live sessions — SSO removal alone
// doesn't end an existing session.
type DirectoryStatusSetter interface {
	SetStatusFromDirectory(ctx context.Context, targetID string, deactivated bool) error
}

// DirectorySyncService owns the sweep. It reuses the same DirectoryLookup as
// the login path, so both agree on what "synced" means.
type DirectorySyncService struct {
	directory DirectoryLookup
	users     UserStore
	cache     Cache
	publisher Publisher
	locker    DirectorySyncLocker
	newToken  func() string
	// status, when set, mirrors directory existence onto account status:
	// deleted upstream → deactivate (only when the miss is authoritative,
	// i.e. keyed by the stored AAD object id); reappears → reactivate.
	status DirectoryStatusSetter
}

// SetStatusSetter enables offboarding detection (optional).
func (s *DirectorySyncService) SetStatusSetter(st DirectoryStatusSetter) { s.status = st }

// NewDirectorySyncService builds the sweep service. locker may be nil (tests);
// production wires the Redis cache so clustered instances elect one runner.
func NewDirectorySyncService(
	directory DirectoryLookup,
	users UserStore,
	cache Cache,
	publisher Publisher,
	locker DirectorySyncLocker,
	newToken func() string,
) *DirectorySyncService {
	return &DirectorySyncService{
		directory: directory,
		users:     users,
		cache:     cache,
		publisher: publisher,
		locker:    locker,
		newToken:  newToken,
	}
}

// Run sweeps immediately (boot backfill) and then once per interval until the
// context is cancelled. Mirrors RunExpiredStatusSweeper's loop shape.
func (s *DirectorySyncService) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = defaultDirectorySyncInterval
	}
	s.Sweep(ctx, interval)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.Sweep(ctx, interval)
		}
	}
}

// Sweep re-syncs every OIDC user once, if this instance wins the window's
// election. The lock TTL is slightly under the interval so the next window's
// winner can always acquire it.
func (s *DirectorySyncService) Sweep(ctx context.Context, interval time.Duration) {
	if s.locker != nil {
		ok, err := s.locker.AcquireLock(ctx, directorySyncLockKey, s.newToken(), interval-interval/10)
		if err != nil {
			slog.Warn("directory sync: lock acquire failed; skipping sweep", "error", err)
			return
		}
		if !ok {
			return // another instance owns this window
		}
	}

	var synced, changed, failures, consecutive, reactivated int
	var missing []*model.User
	cursor := ""
	for {
		users, next, err := s.users.ListUsers(ctx, directorySyncPageSize, cursor)
		if err != nil {
			slog.Warn("directory sync: list users failed; aborting sweep", "error", err)
			return
		}
		for _, u := range users {
			if u.AuthProvider != model.AuthProviderOIDC {
				continue // guests aren't in the directory
			}
			synced++
			didChange, inDirectory, err := s.syncUser(ctx, u)
			if err != nil {
				failures++
				consecutive++
				slog.Warn("directory sync: user sync failed", "userID", u.ID, "error", err)
				if consecutive >= directorySyncMaxConsecutiveErrors {
					slog.Warn("directory sync: too many consecutive failures — directory looks down; aborting sweep", "failures", failures)
					return
				}
				continue
			}
			consecutive = 0
			if didChange {
				changed++
			}
			switch {
			case !inDirectory:
				// Offboarding candidate — but only an AAD-object-id keyed
				// lookup is authoritative: an email-keyed 404 can just mean
				// email != userPrincipalName, never grounds to lock someone
				// out. Deactivations apply after the sweep, behind the cap.
				if s.status != nil && u.MSObjectID != "" && u.Status == "active" {
					missing = append(missing, u)
				}
			case s.status != nil && u.Status == "deactivated":
				// Back in the directory → restore access.
				if err := s.status.SetStatusFromDirectory(ctx, u.ID, false); err != nil {
					slog.Warn("directory sync: reactivate failed", "userID", u.ID, "error", err)
				} else {
					reactivated++
					slog.Info("directory sync: reactivated user found in directory", "userID", u.ID)
				}
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}

	deactivated := s.applyDeactivations(ctx, missing, synced)
	slog.Info("directory sync: sweep complete",
		"synced", synced, "changed", changed, "failures", failures,
		"deactivated", deactivated, "reactivated", reactivated)
}

// applyDeactivations offboards users whose directory accounts are gone,
// unless the count trips the circuit breaker (suspected misconfiguration).
func (s *DirectorySyncService) applyDeactivations(ctx context.Context, missing []*model.User, synced int) int {
	if len(missing) == 0 {
		return 0
	}
	limit := max(directorySyncMinDeactivationCap, synced/10)
	if len(missing) > limit {
		slog.Error("directory sync: refusing to deactivate — too many users missing from the directory at once; check MS_TENANT_ID / app registration",
			"missing", len(missing), "limit", limit, "synced", synced)
		return 0
	}
	deactivated := 0
	for _, u := range missing {
		if err := s.status.SetStatusFromDirectory(ctx, u.ID, true); err != nil {
			slog.Warn("directory sync: deactivate failed", "userID", u.ID, "error", err)
			continue
		}
		deactivated++
		slog.Info("directory sync: deactivated user deleted from directory", "userID", u.ID)
	}
	return deactivated
}

// syncUser refreshes one user from the directory, persisting and broadcasting
// only when something actually changed. A user missing from the directory
// (inDirectory=false) keeps previously synced data (same fail-open rule as
// the login path); the sweep decides whether the miss means offboarding.
func (s *DirectorySyncService) syncUser(ctx context.Context, user *model.User) (changed, inDirectory bool, err error) {
	dp, err := s.directory.LookupProfile(ctx, user.Email, user.MSObjectID)
	if err != nil {
		return false, false, err
	}
	if dp == nil {
		return false, false, nil
	}
	if user.Phone == dp.Phone && user.Manager.Equal(dp.Manager) &&
		(dp.ObjectID == "" || user.MSObjectID == dp.ObjectID) {
		return false, true, nil
	}
	applyDirectoryProfile(user, dp)
	user.UpdatedAt = time.Now()
	if err := s.users.UpdateUser(ctx, user); err != nil {
		return false, true, err
	}
	if s.cache != nil {
		_ = s.cache.Delete(ctx, "user:"+user.ID)
	}
	publishUserDirectoryUpdated(ctx, s.publisher, user)
	return true, true, nil
}

// publishUserDirectoryUpdated broadcasts the profile fields a directory sync
// can change — shared by the login-time path and the periodic sweep so open
// clients (hover cards, directory page) refresh live either way.
func publishUserDirectoryUpdated(ctx context.Context, p Publisher, user *model.User) {
	events.Publish(ctx, p, pubsub.UserEvents(), events.EventUserUpdated, map[string]any{
		"id":          user.ID,
		"displayName": user.DisplayName,
		"avatarURL":   user.AvatarURL,
		"phone":       user.Phone,
		"manager":     user.Manager,
	})
}
