package search

import (
	"context"
	"errors"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
)

// Keys + TTLs for the cluster-coordinated users/channels mapping rebuild.
const (
	// mappingRebuildLockKey elects a single runner cluster-wide: only the
	// instance that wins SET NX runs RecreateUsersChannels. Every other
	// instance (or a still-cooling crashed run) sees the lock and declines,
	// so N parallel containers can never double-run the alias-swap.
	mappingRebuildLockKey = "search:mapping-rebuild:lock"
	// mappingRebuildStatusKey holds the shared progress the admin panel polls,
	// so the button renders identically on every instance and the result
	// outlives the container that started the run.
	mappingRebuildStatusKey = "search:mapping-rebuild:status"

	// mappingRebuildLockTTL bounds two things: how long a crashed run blocks a
	// retry, and the longest a run may take before a second could race in.
	// RecreateUsersChannels is idempotent — each run builds its own timestamped
	// staging index and the LAST alias swap wins — so even an overrun is safe;
	// the TTL only has to comfortably exceed a realistic users+channels rebuild.
	mappingRebuildLockTTL = 15 * time.Minute
	// mappingRebuildStatusTTL keeps the last result visible long after a run so
	// the panel can show "last rebuilt at…". A new run overwrites it.
	mappingRebuildStatusTTL = 24 * time.Hour
)

// MappingRebuildStatus is the cluster-shared snapshot the admin panel polls.
// It lives in Redis (not process memory) so every instance reports the same
// state and it survives the container that kicked the rebuild off.
type MappingRebuildStatus struct {
	Running     bool   `json:"running"`
	Users       int    `json:"users"`
	Channels    int    `json:"channels"`
	LastError   string `json:"lastError,omitempty"`
	StartedAt   int64  `json:"startedAt,omitempty"`   // Unix seconds
	CompletedAt int64  `json:"completedAt,omitempty"` // Unix seconds; zero while running
}

// RebuildStore is the slice of the Redis cache the coordinator needs: a
// token-fenced distributed lock plus JSON get/set for the shared status.
// *cache.RedisCache satisfies it.
type RebuildStore interface {
	AcquireLock(ctx context.Context, key, token string, ttl time.Duration) (bool, error)
	ReleaseLock(ctx context.Context, key, token string) error
	LockHeld(ctx context.Context, key string) (bool, error)
	Set(ctx context.Context, key string, val interface{}, ttl time.Duration) error
	Get(ctx context.Context, key string, dest interface{}) error
}

// MappingRebuilder coordinates the zero-downtime users/channels mapping rebuild
// (RecreateUsersChannels: staging index → atomic alias-swap) across a
// multi-container cluster. A Redis lock elects one runner; the progress lives in
// Redis so the admin button is consistent cluster-wide. Unlike Reindexer (which
// bulk-writes docs into the LIVE indices and keeps status in process memory),
// this is the path that actually rolls a new analyzer onto an existing cluster.
type MappingRebuilder struct {
	rc       IndexRebuilder
	src      UsersChannelsSource
	store    RebuildStore
	newToken func() string
	// recreate is RecreateUsersChannels, injected so tests drive a spy instead
	// of a live OpenSearch cluster.
	recreate func(ctx context.Context, rc IndexRebuilder, src UsersChannelsSource) (users, channels int, err error)
	// spawn runs the detached rebuild; defaults to `go f()`. Tests override it
	// to run synchronously so the goroutine body is deterministically covered.
	spawn func(func())
}

// NewMappingRebuilder wires a coordinator. Returns nil when search isn't
// configured (nil client) or any dependency is missing — handlers treat nil as
// "search not enabled" and answer 503, exactly like NewReindexer.
func NewMappingRebuilder(client *Client, src UsersChannelsSource, store RebuildStore, newToken func() string) *MappingRebuilder {
	if client == nil || src == nil || store == nil || newToken == nil {
		return nil
	}
	return &MappingRebuilder{
		rc:       client,
		src:      src,
		store:    store,
		newToken: newToken,
		recreate: RecreateUsersChannels,
		spawn:    func(f func()) { go f() },
	}
}

// Start elects this instance as the single cluster-wide runner and kicks the
// rebuild off in a detached goroutine. Returns (true, nil) when THIS call won
// the lock and started a run; (false, nil) when another instance already holds
// it (or a crashed run is still within the lock TTL); (false, err) on a Redis
// error. Under concurrency SET NX guarantees exactly one of N racing
// admins/instances wins — the rest get (false, nil) → 409.
func (m *MappingRebuilder) Start(ctx context.Context, now func() int64) (bool, error) {
	token := m.newToken()
	ok, err := m.store.AcquireLock(ctx, mappingRebuildLockKey, token, mappingRebuildLockTTL)
	if err != nil {
		return false, err
	}
	if !ok {
		return false, nil
	}
	startedAt := now()
	// Best-effort: record "running" before detaching so the panel flips
	// immediately. The lock — not this write — is the real guard, so a failed
	// write doesn't abort the run; the panel just lacks a startedAt until the
	// terminal status lands.
	_ = m.store.Set(ctx, mappingRebuildStatusKey, MappingRebuildStatus{Running: true, StartedAt: startedAt}, mappingRebuildStatusTTL)
	// Detach: the rebuild routinely outlives the HTTP request, and reindexes run
	// on a background context immune to request cancellation.
	m.spawn(func() { m.run(context.Background(), token, startedAt, now) })
	return true, nil
}

// run performs the rebuild, records the terminal status, then releases the lock.
// The status is written BEFORE the lock is released so any poll that sees the
// lock gone always finds the final result rather than a stale "running".
func (m *MappingRebuilder) run(ctx context.Context, token string, startedAt int64, now func() int64) {
	users, channels, err := m.recreate(ctx, m.rc, m.src)
	status := MappingRebuildStatus{
		Running:     false,
		Users:       users,
		Channels:    channels,
		StartedAt:   startedAt,
		CompletedAt: now(),
	}
	if err != nil {
		status.LastError = err.Error()
	}
	_ = m.store.Set(ctx, mappingRebuildStatusKey, status, mappingRebuildStatusTTL)
	_ = m.store.ReleaseLock(ctx, mappingRebuildLockKey, token)
}

// Status returns the cluster-shared snapshot for the admin panel. A never-run
// rebuild reports the zero value. If the stored status still says "running" but
// the lock has lapsed, the runner crashed mid-rebuild — we report not-running
// (with an interrupted note) so the panel un-sticks and a retry is possible.
func (m *MappingRebuilder) Status(ctx context.Context) (MappingRebuildStatus, error) {
	var s MappingRebuildStatus
	err := m.store.Get(ctx, mappingRebuildStatusKey, &s)
	if errors.Is(err, cache.ErrCacheMiss) {
		return MappingRebuildStatus{}, nil
	}
	if err != nil {
		return MappingRebuildStatus{}, err
	}
	if s.Running {
		held, herr := m.store.LockHeld(ctx, mappingRebuildLockKey)
		if herr == nil && !held {
			s.Running = false
			if s.LastError == "" {
				s.LastError = "rebuild interrupted (runner exited before completion)"
			}
		}
	}
	return s, nil
}
