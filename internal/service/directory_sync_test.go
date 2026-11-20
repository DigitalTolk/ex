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

// Machine accounts are by definition absent from the upstream Microsoft 365
// directory, so the sweep must never judge them by it. Two incidental guards
// already skip them (a bot has no AuthProvider, and deactivation additionally
// requires an MSObjectID), but backfillAuthProvider classifies any
// password-less account as OIDC, so the explicit IsBot skip is what keeps this
// from becoming "every webhook bot is deactivated on the next sweep".
func TestDirectorySyncSweepSkipsBots(t *testing.T) {
	dir := &stubDirectoryLookup{} // nil profile: nobody is found in the directory
	bot := &model.User{ID: "bot-abc", DisplayName: "Deploy Bot", IsBot: true, Status: "active"}
	env := setupDirectorySync(dir, []*model.User{bot})

	env.svc.Sweep(context.Background(), time.Hour)

	if dir.gotEmail != "" {
		t.Errorf("directory was queried for bot account %q", dir.gotEmail)
	}
	if got := env.users.users["bot-abc"].Status; got != "active" {
		t.Errorf("bot status = %q, want it left active", got)
	}
}

// A name, department or job title changed in Entra reaches everyone without
// waiting for the owner's next login: the sweep writes it, reindexes the
// renamed user for search and broadcasts the new values.
func TestDirectorySyncSweepSyncsNameDepartmentAndTitle(t *testing.T) {
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{
		ObjectID:    "oid-1",
		DisplayName: "Alice Andersson",
		Phone:       "+1",
		Department:  "Engineering",
		JobTitle:    "Staff Engineer",
		Manager:     &model.UserManager{DisplayName: "Boss"},
	}}
	u := oidcUser("u1", "a@x.se", "+1")
	u.DisplayName, u.MSObjectID = "Alice Smith", "oid-1"
	u.Department, u.JobTitle = "Sales", "Engineer"
	u.Manager = &model.UserManager{DisplayName: "Boss"}
	env := setupDirectorySync(dir, []*model.User{u})
	idx := &stubUserIndexer{}
	env.svc.SetIndexer(idx)

	env.svc.Sweep(context.Background(), time.Hour)

	got := env.users.users["u1"]
	if got.DisplayName != "Alice Andersson" || got.Department != "Engineering" || got.JobTitle != "Staff Engineer" {
		t.Fatalf("not synced: name=%q department=%q title=%q", got.DisplayName, got.Department, got.JobTitle)
	}
	if len(idx.indexed) != 1 || idx.indexed[0] != "u1" {
		t.Errorf("indexed = %v, want the renamed user reindexed", idx.indexed)
	}
	updates := userUpdatedEvents(t, env.pub)
	if len(updates) != 1 {
		t.Fatalf("user.updated events = %d, want 1", len(updates))
	}
	ev := updates[0]
	if ev["displayName"] != "Alice Andersson" || ev["department"] != "Engineering" || ev["jobTitle"] != "Staff Engineer" {
		t.Errorf("event = %v, want the new name, department and title", ev)
	}
}

func TestDirectorySyncSweepEachDirectoryFieldCountsAsAChange(t *testing.T) {
	base := func() *model.User {
		u := oidcUser("u1", "a@x.se", "+1")
		u.DisplayName, u.MSObjectID, u.Department, u.JobTitle = "Alice", "oid-1", "Eng", "Dev"
		return u
	}
	profile := func() *DirectoryProfile {
		return &DirectoryProfile{ObjectID: "oid-1", DisplayName: "Alice", Phone: "+1", Department: "Eng", JobTitle: "Dev"}
	}
	for name, edit := range map[string]func(*DirectoryProfile){
		"unchanged":  func(*DirectoryProfile) {},
		"department": func(dp *DirectoryProfile) { dp.Department = "Ops" },
		"job title":  func(dp *DirectoryProfile) { dp.JobTitle = "Lead" },
		"name":       func(dp *DirectoryProfile) { dp.DisplayName = "Alicia" },
		// The directory reporting no name never blanks the stored one.
		"no name": func(dp *DirectoryProfile) { dp.DisplayName = "" },
	} {
		t.Run(name, func(t *testing.T) {
			dp := profile()
			edit(dp)
			env := setupDirectorySync(&stubDirectoryLookup{profile: dp}, []*model.User{base()})
			env.svc.Sweep(context.Background(), time.Hour)
			want := 1
			if name == "unchanged" || name == "no name" {
				want = 0
			}
			if got := len(userUpdatedEvents(t, env.pub)); got != want {
				t.Errorf("user.updated events = %d, want %d", got, want)
			}
			if env.users.users["u1"].DisplayName == "" {
				t.Error("stored name was blanked")
			}
		})
	}
}

// indexedUsers records what the index was given, not just whom.
type indexedUsers struct{ got []model.User }

func (i *indexedUsers) IndexUser(_ context.Context, u *model.User) error {
	i.got = append(i.got, *u)
	return nil
}
func (i *indexedUsers) DeleteUser(context.Context, string) error { return nil }

// Regression: the sweep reindexed the copy from its page read, so an
// account the status sweep deactivated meanwhile showed in search as active.
func TestDirectorySyncSweepIndexesTheStoredUserNotThePageCopy(t *testing.T) {
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{ObjectID: "oid-1", DisplayName: "Alicia", Phone: "+1"}}
	page := oidcUser("u1", "a@x.se", "+1")
	page.DisplayName, page.MSObjectID, page.Status = "Alice", "oid-1", "active"
	env := setupDirectorySync(dir, []*model.User{page})
	stored := *page
	stored.Status = "deactivated"
	env.users.users["u1"] = &stored
	idx := &indexedUsers{}
	env.svc.SetIndexer(idx)

	env.svc.Sweep(context.Background(), time.Hour)

	if len(idx.got) != 1 || idx.got[0].Status != "deactivated" || idx.got[0].DisplayName != "Alicia" {
		t.Fatalf("indexed %+v, want the stored (deactivated) account under its new name", idx.got)
	}
}

// A re-read that fails leaves the index alone rather than writing the stale
// page copy.
func TestDirectorySyncSweepSkipsIndexingWhenTheReReadFails(t *testing.T) {
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{ObjectID: "oid-1", DisplayName: "Alicia", Phone: "+1"}}
	page := oidcUser("u1", "a@x.se", "+1")
	page.DisplayName, page.MSObjectID = "Alice", "oid-1"
	env := setupDirectorySync(dir, []*model.User{page})
	env.users.getUserErr = errors.New("dynamo down")
	idx := &indexedUsers{}
	env.svc.SetIndexer(idx)

	env.svc.Sweep(context.Background(), time.Hour)

	if len(idx.got) != 0 {
		t.Fatalf("indexed %+v after a failed re-read", idx.got)
	}
	if len(userUpdatedEvents(t, env.pub)) != 1 {
		t.Fatal("the change itself must still be broadcast")
	}
}

// Regression: with no directory name, the sweep still wrote back the name
// from its page read, undoing a rename a login made meanwhile.
func TestDirectorySyncSweepWithoutADirectoryNameKeepsAConcurrentRename(t *testing.T) {
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{ObjectID: "oid-1", Phone: "+1", Department: "Ops"}}
	page := oidcUser("u1", "a@x.se", "+1")
	page.DisplayName, page.MSObjectID = "Old Name", "oid-1"
	env := setupDirectorySync(dir, []*model.User{page})
	stored := *page
	stored.DisplayName = "New Name"
	env.users.users["u1"] = &stored

	env.svc.Sweep(context.Background(), time.Hour)

	if got := env.users.users["u1"]; got.DisplayName != "New Name" || got.Department != "Ops" {
		t.Fatalf("stored name=%q department=%q, want the login's rename kept and the department synced", got.DisplayName, got.Department)
	}
	if ev := userUpdatedEvents(t, env.pub); len(ev) != 1 || ev[0]["displayName"] != "New Name" {
		t.Fatalf("user.updated = %v, want one event carrying the stored name", ev)
	}
}
