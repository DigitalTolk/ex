package service

import (
	"context"
	"log/slog"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
)

// Periodic employee-directory re-sync. Login-time enrichment only refreshes a
// profile when its owner signs in — with month-long sessions, a phone number
// or manager changed in Entra while someone is on vacation would go stale for
// everyone else. This sweep re-reads the directory for every OIDC user on an
// interval; the first sweep runs at boot, which doubles as the initial
// backfill for a workspace that enabled the integration after users existed.
//
// Account standing has a sweep of its own, on a much shorter interval: an
// account disabled or deleted in Entra can no longer sign in, but its Ex
// sessions live on (refresh tokens last weeks) and everyone else still sees
// it as an active colleague until Ex deactivates it too. One tenant-wide
// listing per window answers that for every account at once.

const (
	defaultDirectorySyncInterval   = 12 * time.Hour
	defaultDirectoryStatusInterval = 5 * time.Minute
	directorySyncLockKey           = "msdirsync:lock"
	directoryStatusLockKey         = "msdirstatus:lock"
	directorySyncPageSize          = 200
	// directorySyncMaxConsecutiveErrors aborts a sweep when the directory
	// looks down (every lookup failing) instead of hammering it N-users times.
	directorySyncMaxConsecutiveErrors = 5
	// directorySyncMinDeactivationCap floors the per-sweep deactivation
	// circuit breaker: a sweep may deactivate at most max(this, 10% of the
	// users it checked). A tenant/app-registration misconfiguration makes
	// EVERY account look gone — without the cap that would read as "the
	// whole company was offboarded" and lock everyone out.
	directorySyncMinDeactivationCap = 3
)

// DirectorySyncLocker is the single-runner election capability (RedisCache).
// The winner holds the lock for the whole window, so N instances sweeping on
// the same interval sync the directory exactly once per window.
type DirectorySyncLocker interface {
	AcquireLock(ctx context.Context, key, token string, ttl time.Duration) (bool, error)
}

// DirectoryAccountLister reports every directory account's standing, keyed
// by AAD object id: true while it can sign in, false once disabled; an
// account deleted upstream is absent (MSDirectoryService.ListAccounts).
type DirectoryAccountLister interface {
	ListAccounts(ctx context.Context) (map[string]bool, error)
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
	// accounts and status drive the status sweep: an account disabled or
	// deleted upstream is deactivated, and reactivated once it can sign in
	// again.
	accounts DirectoryAccountLister
	status   DirectoryStatusSetter
}

// SetStatusSync wires offboarding: where account standing comes from and
// what applies it.
func (s *DirectorySyncService) SetStatusSync(accounts DirectoryAccountLister, st DirectoryStatusSetter) {
	s.accounts, s.status = accounts, st
}

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
	s.sweepIsolated(ctx, interval)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.sweepIsolated(ctx, interval)
		}
	}
}

// RunStatus checks account standing immediately and then once per interval
// until the context is cancelled.
func (s *DirectorySyncService) RunStatus(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = defaultDirectoryStatusInterval
	}
	s.statusSweepIsolated(ctx, interval)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.statusSweepIsolated(ctx, interval)
		}
	}
}

// sweepIsolated runs one sweep with its panics confined to it: Run lives on a
// detached goroutine, where an unrecovered panic takes the whole process (and
// every WebSocket client on it) down, and a sweep that recovered only at the
// top of Run would silently end every later sweep too.
func (s *DirectorySyncService) sweepIsolated(ctx context.Context, interval time.Duration) {
	defer safe.Recover()
	s.Sweep(ctx, interval)
}

func (s *DirectorySyncService) statusSweepIsolated(ctx context.Context, interval time.Duration) {
	defer safe.Recover()
	s.SweepStatus(ctx, interval)
}

// elected reports whether this instance owns the window for key. The lock
// TTL is slightly under the interval so the next window's winner can always
// acquire it.
func (s *DirectorySyncService) elected(ctx context.Context, key string, interval time.Duration) bool {
	if s.locker == nil {
		return true
	}
	ok, err := s.locker.AcquireLock(ctx, key, s.newToken(), interval-interval/10)
	if err != nil {
		slog.WarnContext(ctx, "directory sync: lock acquire failed; skipping sweep", "lock", key, "error", err)
		return false
	}
	return ok // false: another instance owns this window
}

// Sweep re-syncs every OIDC user's profile once, if this instance wins the
// window's election.
func (s *DirectorySyncService) Sweep(ctx context.Context, interval time.Duration) {
	if !s.elected(ctx, directorySyncLockKey, interval) {
		return
	}

	var synced, changed, failures, consecutive int
	cursor := ""
	for {
		users, next, err := s.users.ListUsers(ctx, directorySyncPageSize, cursor)
		if err != nil {
			slog.WarnContext(ctx, "directory sync: list users failed; aborting sweep", "error", err)
			return
		}
		for _, u := range users {
			// Bots are never in the upstream directory. Two incidental guards
			// already skip them, but backfillAuthProvider marks any
			// password-less account OIDC, so say it directly.
			if u.IsBot {
				continue
			}
			if u.AuthProvider != model.AuthProviderOIDC {
				continue // guests aren't in the directory
			}
			synced++
			didChange, err := s.syncUser(ctx, u)
			if err != nil {
				failures++
				consecutive++
				slog.WarnContext(ctx, "directory sync: user sync failed", "userID", u.ID, "error", err)
				if consecutive >= directorySyncMaxConsecutiveErrors {
					slog.WarnContext(ctx, "directory sync: too many consecutive failures — directory looks down; aborting sweep", "failures", failures)
					return
				}
				continue
			}
			consecutive = 0
			if didChange {
				changed++
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}

	slog.InfoContext(ctx, "directory sync: sweep complete",
		"synced", synced, "changed", changed, "failures", failures)
}

// SweepStatus mirrors every SSO account's directory standing onto its Ex
// status, if this instance wins the window's election: disabled or deleted
// upstream → deactivated (sessions ended, behind the circuit breaker); able
// to sign in again → reactivated, unless an admin deactivated it.
//
// Only accounts with a stored AAD object id are judged: matching by email
// can't tell a departed colleague from one whose mail != userPrincipalName.
// The profile sweep backfills the object id from the next lookup.
func (s *DirectorySyncService) SweepStatus(ctx context.Context, interval time.Duration) {
	if !s.elected(ctx, directoryStatusLockKey, interval) {
		return
	}
	accounts, err := s.accounts.ListAccounts(ctx)
	if err != nil {
		slog.WarnContext(ctx, "directory status: listing directory accounts failed; skipping sweep", "error", err)
		return
	}
	if len(accounts) == 0 {
		// A real tenant always has accounts: an empty listing is a
		// misconfiguration, never "everyone left".
		slog.ErrorContext(ctx, "directory status: the directory listed no accounts; skipping sweep — check MS_TENANT_ID / app registration")
		return
	}

	var checked, reactivated int
	var offboarded []*model.User
	cursor := ""
	for {
		users, next, err := s.users.ListUsers(ctx, directorySyncPageSize, cursor)
		if err != nil {
			slog.WarnContext(ctx, "directory status: list users failed; aborting sweep", "error", err)
			return
		}
		for _, u := range users {
			if u.IsBot || u.AuthProvider != model.AuthProviderOIDC || u.MSObjectID == "" {
				continue
			}
			checked++
			enabled, listed := accounts[u.MSObjectID]
			switch {
			case listed && enabled:
				if u.Status != "deactivated" || u.DeactivatedBy == model.DeactivatedByAdmin {
					continue
				}
				if err := s.status.SetStatusFromDirectory(ctx, u.ID, false); err != nil {
					slog.WarnContext(ctx, "directory status: reactivate failed", "userID", u.ID, "error", err)
					continue
				}
				reactivated++
				slog.InfoContext(ctx, "directory status: reactivated user who can sign in again", "userID", u.ID)
			case u.Status == "active":
				// Disabled (listed, not enabled) or deleted (not listed).
				// Applied after the sweep, behind the cap.
				offboarded = append(offboarded, u)
			}
		}
		if next == "" {
			break
		}
		cursor = next
	}

	deactivated := s.applyDeactivations(ctx, offboarded, checked)
	if deactivated > 0 || reactivated > 0 {
		slog.InfoContext(ctx, "directory status: sweep complete",
			"checked", checked, "deactivated", deactivated, "reactivated", reactivated)
	}
}

// applyDeactivations offboards users whose directory accounts are disabled
// or gone, unless the count trips the circuit breaker (suspected
// misconfiguration).
func (s *DirectorySyncService) applyDeactivations(ctx context.Context, offboarded []*model.User, checked int) int {
	if len(offboarded) == 0 {
		return 0
	}
	limit := max(directorySyncMinDeactivationCap, checked/10)
	if len(offboarded) > limit {
		slog.ErrorContext(ctx, "directory status: refusing to deactivate — too many accounts disabled or missing in the directory at once; check MS_TENANT_ID / app registration",
			"offboarded", len(offboarded), "limit", limit, "checked", checked)
		return 0
	}
	deactivated := 0
	for _, u := range offboarded {
		if err := s.status.SetStatusFromDirectory(ctx, u.ID, true); err != nil {
			slog.WarnContext(ctx, "directory status: deactivate failed", "userID", u.ID, "error", err)
			continue
		}
		deactivated++
		slog.InfoContext(ctx, "directory status: deactivated user disabled or deleted in the directory", "userID", u.ID)
	}
	return deactivated
}

// syncUser refreshes one user from the directory, persisting and broadcasting
// only when something actually changed. A user missing from the directory
// keeps previously synced data (same fail-open rule as the login path); the
// status sweep decides whether the miss means offboarding.
func (s *DirectorySyncService) syncUser(ctx context.Context, user *model.User) (changed bool, err error) {
	dp, err := s.directory.LookupProfile(ctx, user.Email, user.MSObjectID)
	if err != nil {
		return false, err
	}
	if dp == nil {
		return false, nil
	}
	if user.Phone == dp.Phone && user.Manager.Equal(dp.Manager) &&
		(dp.ObjectID == "" || user.MSObjectID == dp.ObjectID) {
		return false, nil
	}
	applyDirectoryProfile(user, dp)
	user.UpdatedAt = time.Now()
	// Field-level: the copy came from the sweep's page read, and writing all
	// of it back would undo a status change made since (the status sweep
	// deactivating this very account, say).
	if err := s.users.PatchUser(ctx, user.ID, store.UserPatch{
		Directory:  &store.UserDirectoryFields{Phone: user.Phone, Manager: user.Manager},
		MSObjectID: &user.MSObjectID,
		UpdatedAt:  user.UpdatedAt,
	}); err != nil {
		return false, err
	}
	forgetCachedUser(ctx, s.cache, user.ID)
	publishUserDirectoryUpdated(ctx, s.publisher, user)
	return true, nil
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
