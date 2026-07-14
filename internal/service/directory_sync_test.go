package service

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// pagedUserStore wraps mockUserStore with real cursor pagination so the
// sweep's page loop is exercised.
type pagedUserStore struct {
	*mockUserStore
	pages [][]*model.User
}

func (p *pagedUserStore) ListUsers(_ context.Context, _ int, cursor string) ([]*model.User, string, error) {
	if p.listErr != nil {
		return nil, "", p.listErr
	}
	idx := 0
	if cursor != "" {
		idx = int(cursor[0] - '0')
	}
	next := ""
	if idx+1 < len(p.pages) {
		next = string(rune('0' + idx + 1))
	}
	return p.pages[idx], next, nil
}

// fakeSyncLocker is a programmable DirectorySyncLocker.
type fakeSyncLocker struct {
	acquired bool
	err      error
	gotTTL   time.Duration
}

func (f *fakeSyncLocker) AcquireLock(_ context.Context, _, _ string, ttl time.Duration) (bool, error) {
	f.gotTTL = ttl
	return f.acquired, f.err
}

func oidcUser(id, email, phone string) *model.User {
	return &model.User{ID: id, Email: email, Phone: phone, AuthProvider: model.AuthProviderOIDC, Status: "active"}
}

type syncEnv struct {
	svc   *DirectorySyncService
	users *pagedUserStore
	dir   *stubDirectoryLookup
	pub   *mockPublisher
	cache *mockCache
}

func setupDirectorySync(dir *stubDirectoryLookup, pages ...[]*model.User) *syncEnv {
	users := &pagedUserStore{mockUserStore: newMockUserStore(), pages: pages}
	for _, page := range pages {
		for _, u := range page {
			users.users[u.ID] = u
		}
	}
	pub := newMockPublisher()
	cache := newMockCache()
	svc := NewDirectorySyncService(dir, users, cache, pub, nil, func() string { return "token" })
	return &syncEnv{svc: svc, users: users, dir: dir, pub: pub, cache: cache}
}

func TestDirectorySyncSweepUpdatesChangedUsers(t *testing.T) {
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{
		ObjectID: "oid-new",
		Phone:    "+46 70 111 22 33",
		Manager:  &model.UserManager{DisplayName: "Boss"},
	}}
	env := setupDirectorySync(dir,
		[]*model.User{oidcUser("u1", "a@x.se", ""), {ID: "g1", Email: "g@x.se", AuthProvider: model.AuthProviderGuest}},
		[]*model.User{oidcUser("u2", "b@x.se", "+46 70 111 22 33")},
	)
	// u2's manager/oid still differ from the directory, so it changes too.
	_ = env.cache.SetUser(context.Background(), &model.User{ID: "u1"})

	env.svc.Sweep(context.Background(), time.Hour)

	if got := env.users.users["u1"]; got.Phone != "+46 70 111 22 33" || got.MSObjectID != "oid-new" || got.Manager == nil {
		t.Errorf("u1 not synced: %+v", got)
	}
	if updates := userUpdatedEvents(t, env.pub); len(updates) != 2 {
		t.Errorf("user.updated events = %d, want 2 (guest skipped)", len(updates))
	}
	if env.dir.gotEmail == "g@x.se" {
		t.Error("guest was looked up in the directory")
	}
}

func TestDirectorySyncSweepSkipsUnchangedAndMissing(t *testing.T) {
	manager := &model.UserManager{DisplayName: "Boss"}
	t.Run("unchanged user writes and publishes nothing", func(t *testing.T) {
		dir := &stubDirectoryLookup{profile: &DirectoryProfile{Phone: "+1", Manager: manager}}
		u := oidcUser("u1", "a@x.se", "+1")
		u.Manager = &model.UserManager{DisplayName: "Boss"}
		env := setupDirectorySync(dir, []*model.User{u})
		env.svc.Sweep(context.Background(), time.Hour)
		if got := userUpdatedEvents(t, env.pub); len(got) != 0 {
			t.Errorf("events = %d, want 0", len(got))
		}
	})
	t.Run("user missing from the directory keeps synced data", func(t *testing.T) {
		dir := &stubDirectoryLookup{} // nil profile
		u := oidcUser("u1", "a@x.se", "+46 70 000 00 00")
		env := setupDirectorySync(dir, []*model.User{u})
		env.svc.Sweep(context.Background(), time.Hour)
		if env.users.users["u1"].Phone != "+46 70 000 00 00" {
			t.Error("synced data wiped for a user outside the directory")
		}
		if got := userUpdatedEvents(t, env.pub); len(got) != 0 {
			t.Errorf("events = %d, want 0", len(got))
		}
	})
}

func TestDirectorySyncSweepAbortsWhenDirectoryDown(t *testing.T) {
	dir := &stubDirectoryLookup{err: errors.New("graph down")}
	users := make([]*model.User, 0, directorySyncMaxConsecutiveErrors+3)
	for i := range directorySyncMaxConsecutiveErrors + 3 {
		users = append(users, oidcUser(string(rune('a'+i)), "u@x.se", ""))
	}
	env := setupDirectorySync(dir, users)
	env.svc.Sweep(context.Background(), time.Hour)
	// Aborted at the consecutive-error cap instead of hammering every user.
	if got := userUpdatedEvents(t, env.pub); len(got) != 0 {
		t.Errorf("events = %d, want 0", len(got))
	}
}

func TestDirectorySyncSweepToleratesTransientFailures(t *testing.T) {
	// One user fails to persist; the sweep continues to the next.
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{Phone: "+2"}}
	env := setupDirectorySync(dir, []*model.User{oidcUser("u1", "a@x.se", ""), oidcUser("u2", "b@x.se", "")})
	env.users.updateErr = errors.New("dynamo write throttled")
	env.svc.Sweep(context.Background(), time.Hour)
	if got := userUpdatedEvents(t, env.pub); len(got) != 0 {
		t.Errorf("events = %d, want 0 (updates failed)", len(got))
	}
}

func TestDirectorySyncSweepListUsersError(t *testing.T) {
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{Phone: "+2"}}
	env := setupDirectorySync(dir, []*model.User{oidcUser("u1", "a@x.se", "")})
	env.users.listErr = errors.New("dynamo down")
	env.svc.Sweep(context.Background(), time.Hour)
	if got := userUpdatedEvents(t, env.pub); len(got) != 0 {
		t.Errorf("events = %d, want 0", len(got))
	}
}

func TestDirectorySyncElection(t *testing.T) {
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{Phone: "+2"}}
	t.Run("loser skips the sweep", func(t *testing.T) {
		env := setupDirectorySync(dir, []*model.User{oidcUser("u1", "a@x.se", "")})
		locker := &fakeSyncLocker{acquired: false}
		env.svc.locker = locker
		env.svc.Sweep(context.Background(), time.Hour)
		if got := userUpdatedEvents(t, env.pub); len(got) != 0 {
			t.Errorf("events = %d, want 0 (lock lost)", len(got))
		}
		if locker.gotTTL >= time.Hour {
			t.Errorf("lock TTL %v must stay under the interval", locker.gotTTL)
		}
	})
	t.Run("lock error skips the sweep", func(t *testing.T) {
		env := setupDirectorySync(dir, []*model.User{oidcUser("u1", "a@x.se", "")})
		env.svc.locker = &fakeSyncLocker{err: errors.New("redis down")}
		env.svc.Sweep(context.Background(), time.Hour)
		if got := userUpdatedEvents(t, env.pub); len(got) != 0 {
			t.Errorf("events = %d, want 0", len(got))
		}
	})
	t.Run("winner sweeps", func(t *testing.T) {
		env := setupDirectorySync(dir, []*model.User{oidcUser("u1", "a@x.se", "")})
		env.svc.locker = &fakeSyncLocker{acquired: true}
		env.svc.Sweep(context.Background(), time.Hour)
		if got := userUpdatedEvents(t, env.pub); len(got) != 1 {
			t.Errorf("events = %d, want 1", len(got))
		}
	})
}

func TestDirectorySyncRunLoop(t *testing.T) {
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{Phone: "+2"}}
	env := setupDirectorySync(dir, []*model.User{oidcUser("u1", "a@x.se", "")})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		// interval <= 0 falls back to the default; the immediate boot sweep
		// still runs before the first (never-reached) tick.
		env.svc.Run(ctx, 0)
		close(done)
	}()
	waitFor(t, func() bool {
		env.pub.mu.Lock()
		defer env.pub.mu.Unlock()
		return len(env.pub.published) >= 1
	})
	cancel()
	<-done

	// A tiny positive interval drives the ticker arm: the same (now
	// unchanged) user is re-swept on ticks until cancel.
	env2 := setupDirectorySync(dir, []*model.User{oidcUser("u2", "b@x.se", "")})
	var lockCount atomic.Int64
	env2.svc.locker = &lockCounter{n: &lockCount}
	ctx2, cancel2 := context.WithCancel(context.Background())
	done2 := make(chan struct{})
	go func() {
		env2.svc.Run(ctx2, 5*time.Millisecond)
		close(done2)
	}()
	waitFor(t, func() bool { return lockCount.Load() >= 2 }) // boot sweep + ≥1 tick
	cancel2()
	<-done2
}

// lockCounter counts election attempts (one per sweep) without granting the
// lock, so the ticker test never races the publisher.
type lockCounter struct{ n *atomic.Int64 }

func (l *lockCounter) AcquireLock(context.Context, string, string, time.Duration) (bool, error) {
	l.n.Add(1)
	return false, nil
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("condition not reached in time")
}
