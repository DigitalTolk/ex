package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// fakeRebuildStore is an in-memory LockStore (SET NX semantics, Redis stand-in)
// + StatusStore (JSON round-trip, DynamoDB stand-in) so the coordinator's
// election + status logic can be tested without Redis or DynamoDB.
type fakeRebuildStore struct {
	mu       sync.Mutex
	locks    map[string]string // key -> token
	statuses map[string][]byte // job -> json blob

	acquireErr  error
	getErr      error
	putErr      error
	lockHeldErr error
	putCalls    int
}

func newFakeStore() *fakeRebuildStore {
	return &fakeRebuildStore{locks: map[string]string{}, statuses: map[string][]byte{}}
}

func (f *fakeRebuildStore) AcquireLock(_ context.Context, key, token string, _ time.Duration) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.acquireErr != nil {
		return false, f.acquireErr
	}
	if _, held := f.locks[key]; held {
		return false, nil
	}
	f.locks[key] = token
	return true, nil
}

func (f *fakeRebuildStore) ReleaseLock(_ context.Context, key, token string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.locks[key] == token {
		delete(f.locks, key)
	}
	return nil
}

func (f *fakeRebuildStore) LockHeld(_ context.Context, key string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.lockHeldErr != nil {
		return false, f.lockHeldErr
	}
	_, held := f.locks[key]
	return held, nil
}

func (f *fakeRebuildStore) PutSearchStatus(_ context.Context, job string, val any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.putCalls++
	if f.putErr != nil {
		return f.putErr
	}
	data, err := json.Marshal(val)
	if err != nil {
		return err
	}
	f.statuses[job] = data
	return nil
}

func (f *fakeRebuildStore) GetSearchStatus(_ context.Context, job string, dest any) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return false, f.getErr
	}
	data, ok := f.statuses[job]
	if !ok {
		return false, nil
	}
	if err := json.Unmarshal(data, dest); err != nil {
		return false, err
	}
	return true, nil
}

// storedStatus reads back the persisted mapping-rebuild status for assertions.
func (f *fakeRebuildStore) storedStatus(t *testing.T) MappingRebuildStatus {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	var s MappingRebuildStatus
	if data, ok := f.statuses[searchJobMappingRebuild]; ok {
		if err := json.Unmarshal(data, &s); err != nil {
			t.Fatalf("unmarshal stored status: %v", err)
		}
	}
	return s
}

func fixedNow(v int64) func() int64 { return func() int64 { return v } }

func newTestRebuilder(store *fakeRebuildStore) *MappingRebuilder {
	var n int
	m := NewMappingRebuilder(&Client{}, &usersChannelsSpy{}, store, store, func() string {
		n++
		return fmt.Sprintf("tok-%d", n)
	})
	// Synchronous spawn so the goroutine body runs (and is covered) before Start
	// returns — no sleeps, no races.
	m.spawn = func(f func()) { f() }
	return m
}

// usersChannelsSpy is a no-op UsersChannelsSource; the recreate func is stubbed
// so it's never actually called against a cluster.
type usersChannelsSpy struct{}

func (usersChannelsSpy) ListUsers(context.Context) ([]*model.User, error)       { return nil, nil }
func (usersChannelsSpy) ListChannels(context.Context) ([]*model.Channel, error) { return nil, nil }

func TestNewMappingRebuilder_NilDeps(t *testing.T) {
	store := newFakeStore()
	tok := func() string { return "t" }
	if NewMappingRebuilder(nil, &usersChannelsSpy{}, store, store, tok) != nil {
		t.Error("nil client should yield nil rebuilder")
	}
	if NewMappingRebuilder(&Client{}, nil, store, store, tok) != nil {
		t.Error("nil src should yield nil rebuilder")
	}
	if NewMappingRebuilder(&Client{}, &usersChannelsSpy{}, nil, store, tok) != nil {
		t.Error("nil lock should yield nil rebuilder")
	}
	if NewMappingRebuilder(&Client{}, &usersChannelsSpy{}, store, nil, tok) != nil {
		t.Error("nil status store should yield nil rebuilder")
	}
	if NewMappingRebuilder(&Client{}, &usersChannelsSpy{}, store, store, nil) != nil {
		t.Error("nil newToken should yield nil rebuilder")
	}
	if NewMappingRebuilder(&Client{}, &usersChannelsSpy{}, store, store, tok) == nil {
		t.Error("all deps present should yield a rebuilder")
	}
}

func TestMappingRebuilder_StartRunsAndRecordsStatus(t *testing.T) {
	store := newFakeStore()
	m := newTestRebuilder(store)
	m.recreate = func(context.Context, IndexRebuilder, UsersChannelsSource) (int, int, error) {
		return 7, 3, nil
	}

	started, err := m.Start(context.Background(), fixedNow(1000))
	if err != nil {
		t.Fatalf("Start error: %v", err)
	}
	if !started {
		t.Fatal("expected Start to win the lock")
	}
	got := store.storedStatus(t)
	if got.Running || got.Users != 7 || got.Channels != 3 || got.StartedAt != 1000 || got.CompletedAt != 1000 || got.LastError != "" {
		t.Fatalf("terminal status wrong: %+v", got)
	}
	// Lock released on completion, so a fresh Start can win again.
	if held, _ := store.LockHeld(context.Background(), mappingRebuildLockKey); held {
		t.Error("lock should be released after the run completes")
	}
}

func TestMappingRebuilder_StartRecordsError(t *testing.T) {
	store := newFakeStore()
	m := newTestRebuilder(store)
	m.recreate = func(context.Context, IndexRebuilder, UsersChannelsSource) (int, int, error) {
		return 0, 0, errors.New("boom")
	}
	if _, err := m.Start(context.Background(), fixedNow(5)); err != nil {
		t.Fatalf("Start error: %v", err)
	}
	got := store.storedStatus(t)
	if got.LastError != "boom" || got.Running {
		t.Fatalf("expected recorded error, got %+v", got)
	}
}

func TestMappingRebuilder_StartConflictWhenLocked(t *testing.T) {
	store := newFakeStore()
	m := newTestRebuilder(store)
	// Pre-hold the lock — a second instance is already running.
	store.locks[mappingRebuildLockKey] = "someone-else"

	started, err := m.Start(context.Background(), fixedNow(1))
	if err != nil {
		t.Fatalf("Start error: %v", err)
	}
	if started {
		t.Fatal("expected Start to decline when the lock is held")
	}
}

func TestMappingRebuilder_StartAcquireError(t *testing.T) {
	store := newFakeStore()
	store.acquireErr = errors.New("redis down")
	m := newTestRebuilder(store)

	started, err := m.Start(context.Background(), fixedNow(1))
	if started || err == nil {
		t.Fatalf("expected (false, err), got (%v, %v)", started, err)
	}
}

func TestMappingRebuilder_StatusMissIsZero(t *testing.T) {
	m := newTestRebuilder(newFakeStore())
	st, err := m.Status(context.Background())
	if err != nil {
		t.Fatalf("Status error: %v", err)
	}
	if st != (MappingRebuildStatus{}) {
		t.Fatalf("never-run status should be zero, got %+v", st)
	}
}

func TestMappingRebuilder_StatusGetError(t *testing.T) {
	store := newFakeStore()
	store.getErr = errors.New("redis get failed")
	m := newTestRebuilder(store)
	if _, err := m.Status(context.Background()); err == nil {
		t.Fatal("expected Status to surface a non-miss Get error")
	}
}

func TestMappingRebuilder_StatusRunningWithLockHeld(t *testing.T) {
	store := newFakeStore()
	m := newTestRebuilder(store)
	store.locks[mappingRebuildLockKey] = "tok"
	_ = store.PutSearchStatus(context.Background(), searchJobMappingRebuild, MappingRebuildStatus{Running: true, StartedAt: 10})

	st, err := m.Status(context.Background())
	if err != nil {
		t.Fatalf("Status error: %v", err)
	}
	if !st.Running {
		t.Fatal("a running rebuild whose lock is still held must report running")
	}
}

func TestMappingRebuilder_StatusReconcilesCrashedRun(t *testing.T) {
	store := newFakeStore()
	m := newTestRebuilder(store)
	// Status says running, but NO lock is held → the runner crashed.
	_ = store.PutSearchStatus(context.Background(), searchJobMappingRebuild, MappingRebuildStatus{Running: true, StartedAt: 10})

	st, err := m.Status(context.Background())
	if err != nil {
		t.Fatalf("Status error: %v", err)
	}
	if st.Running {
		t.Fatal("a running status with no lock must reconcile to not-running")
	}
	if st.LastError == "" {
		t.Fatal("crashed reconcile should annotate lastError")
	}
}

func TestMappingRebuilder_StatusKeepsExistingErrorOnReconcile(t *testing.T) {
	store := newFakeStore()
	m := newTestRebuilder(store)
	_ = store.PutSearchStatus(context.Background(), searchJobMappingRebuild, MappingRebuildStatus{Running: true, LastError: "prior"})
	st, _ := m.Status(context.Background())
	if st.LastError != "prior" {
		t.Fatalf("reconcile should not clobber an existing error, got %q", st.LastError)
	}
}

func TestMappingRebuilder_StatusLockHeldErrorLeavesRunning(t *testing.T) {
	store := newFakeStore()
	m := newTestRebuilder(store)
	store.lockHeldErr = errors.New("exists failed")
	_ = store.PutSearchStatus(context.Background(), searchJobMappingRebuild, MappingRebuildStatus{Running: true})
	st, _ := m.Status(context.Background())
	if !st.Running {
		t.Fatal("a LockHeld error must not flip a running status (fail safe: keep showing running)")
	}
}

// versionFunc builds a versionOf stub from a per-index (version, present, err)
// table so StartIfStale's staleness check runs without a live cluster.
func versionFunc(table map[string]struct {
	version int
	present bool
	err     error
}) func(context.Context, string) (int, bool, error) {
	return func(_ context.Context, name string) (int, bool, error) {
		e := table[name]
		return e.version, e.present, e.err
	}
}

// staleRebuilder wires a rebuilder whose recreate records that it ran, so tests
// can assert whether StartIfStale actually kicked a rebuild off.
func staleRebuilder(t *testing.T, store *fakeRebuildStore, versionOf func(context.Context, string) (int, bool, error)) (*MappingRebuilder, *bool) {
	t.Helper()
	m := newTestRebuilder(store)
	m.versionOf = versionOf
	ran := false
	m.recreate = func(context.Context, IndexRebuilder, UsersChannelsSource) (int, int, error) {
		ran = true
		return 4, 2, nil
	}
	return m, &ran
}

func TestMappingRebuilder_StartIfStale_UpToDateSkips(t *testing.T) {
	// Both indices stamped at the desired version → nothing to do.
	m, ran := staleRebuilder(t, newFakeStore(), versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers:    {version: usersChannelsSchemaVersion, present: true},
		IndexChannels: {version: usersChannelsSchemaVersion, present: true},
	}))
	started, err := m.StartIfStale(context.Background(), fixedNow(1))
	if err != nil {
		t.Fatalf("StartIfStale error: %v", err)
	}
	if started {
		t.Fatal("an up-to-date cluster must not start a rebuild")
	}
	if *ran {
		t.Fatal("recreate must not run when the cluster is current")
	}
}

func TestMappingRebuilder_StartIfStale_MissingStampRebuilds(t *testing.T) {
	// A freshly-created / pre-versioning index carries no stamp → stale.
	m, ran := staleRebuilder(t, newFakeStore(), versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers:    {present: false},
		IndexChannels: {version: usersChannelsSchemaVersion, present: true},
	}))
	started, err := m.StartIfStale(context.Background(), fixedNow(1))
	if err != nil || !started {
		t.Fatalf("expected an unstamped index to trigger a rebuild, got (%v, %v)", started, err)
	}
	if !*ran {
		t.Fatal("recreate should have run for the stale cluster")
	}
}

func TestMappingRebuilder_StartIfStale_OlderVersionRebuilds(t *testing.T) {
	// Live generation behind the binary's → stale.
	m, ran := staleRebuilder(t, newFakeStore(), versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers:    {version: usersChannelsSchemaVersion - 1, present: true},
		IndexChannels: {version: usersChannelsSchemaVersion, present: true},
	}))
	started, err := m.StartIfStale(context.Background(), fixedNow(1))
	if err != nil || !started {
		t.Fatalf("expected an older index to trigger a rebuild, got (%v, %v)", started, err)
	}
	if !*ran {
		t.Fatal("recreate should have run for the older-generation cluster")
	}
}

func TestMappingRebuilder_StartIfStale_NewerVersionSkips(t *testing.T) {
	// Ping-pong guard: an older binary seeing a NEWER live index does nothing.
	m, ran := staleRebuilder(t, newFakeStore(), versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers:    {version: usersChannelsSchemaVersion + 5, present: true},
		IndexChannels: {version: usersChannelsSchemaVersion + 5, present: true},
	}))
	started, err := m.StartIfStale(context.Background(), fixedNow(1))
	if err != nil {
		t.Fatalf("StartIfStale error: %v", err)
	}
	if started || *ran {
		t.Fatal("a newer live index must be treated as fresh (no downgrade rebuild)")
	}
}

func TestMappingRebuilder_StartIfStale_ChannelsStaleOnly(t *testing.T) {
	// Users current, channels behind → still stale (covers the second index).
	m, ran := staleRebuilder(t, newFakeStore(), versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers:    {version: usersChannelsSchemaVersion, present: true},
		IndexChannels: {present: false},
	}))
	started, err := m.StartIfStale(context.Background(), fixedNow(1))
	if err != nil || !started || !*ran {
		t.Fatalf("a stale channels index alone must trigger a rebuild, got (%v, %v, ran=%v)", started, err, *ran)
	}
}

func TestMappingRebuilder_StartIfStale_ReadErrorSurfaced(t *testing.T) {
	// A mapping read failure aborts the check — never masquerade as "current".
	m, ran := staleRebuilder(t, newFakeStore(), versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers: {err: errors.New("opensearch down")},
	}))
	started, err := m.StartIfStale(context.Background(), fixedNow(1))
	if started || err == nil {
		t.Fatalf("expected (false, err) on a read failure, got (%v, %v)", started, err)
	}
	if *ran {
		t.Fatal("recreate must not run when staleness can't be determined")
	}
}

func TestMappingRebuilder_StartIfStale_LockHeldNoDouble(t *testing.T) {
	// Stale, but another instance already owns the rebuild lock → decline.
	store := newFakeStore()
	store.locks[mappingRebuildLockKey] = "someone-else"
	m, ran := staleRebuilder(t, store, versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers: {present: false},
	}))
	started, err := m.StartIfStale(context.Background(), fixedNow(1))
	if err != nil {
		t.Fatalf("StartIfStale error: %v", err)
	}
	if started || *ran {
		t.Fatal("a held lock must prevent a second concurrent rebuild")
	}
}

func TestMappingRebuilder_StartIfStale_AcquireErrorSurfaced(t *testing.T) {
	// Stale, but the lock acquisition itself errors → propagate.
	store := newFakeStore()
	store.acquireErr = errors.New("redis down")
	m, _ := staleRebuilder(t, store, versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers: {present: false},
	}))
	started, err := m.StartIfStale(context.Background(), fixedNow(1))
	if started || err == nil {
		t.Fatalf("expected the lock error to surface, got (%v, %v)", started, err)
	}
}

func TestMappingRebuilder_SchemaVersions_ReportsCurrentAndExpected(t *testing.T) {
	m := newTestRebuilder(newFakeStore())
	m.versionOf = versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers:    {version: usersChannelsSchemaVersion, present: true},
		IndexChannels: {present: false}, // unstamped → nil current, stale
	})
	got, err := m.SchemaVersions(context.Background())
	if err != nil {
		t.Fatalf("SchemaVersions error: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 entries, got %d", len(got))
	}
	users := got[0]
	if users.Index != IndexUsers || users.Current == nil || *users.Current != usersChannelsSchemaVersion ||
		users.Expected != usersChannelsSchemaVersion || users.Stale {
		t.Errorf("users entry wrong: %+v (current=%v)", users, users.Current)
	}
	channels := got[1]
	if channels.Index != IndexChannels || channels.Current != nil || !channels.Stale {
		t.Errorf("unstamped channels entry should have nil current + stale, got %+v", channels)
	}
}

func TestMappingRebuilder_SchemaVersions_SurfacesReadError(t *testing.T) {
	m := newTestRebuilder(newFakeStore())
	m.versionOf = versionFunc(map[string]struct {
		version int
		present bool
		err     error
	}{
		IndexUsers: {err: errors.New("opensearch down")},
	})
	if _, err := m.SchemaVersions(context.Background()); err == nil {
		t.Fatal("expected a read error to surface")
	}
}

// TestMappingRebuilder_DefaultSpawnRunsGoroutine exercises the real `go f()`
// spawn wired by NewMappingRebuilder (the test helper overrides it), proving the
// detached path completes.
func TestMappingRebuilder_DefaultSpawnRunsGoroutine(t *testing.T) {
	store := newFakeStore()
	m := NewMappingRebuilder(&Client{}, &usersChannelsSpy{}, store, store, func() string { return "tok" })
	done := make(chan struct{})
	m.recreate = func(context.Context, IndexRebuilder, UsersChannelsSource) (int, int, error) {
		close(done)
		return 1, 1, nil
	}
	started, err := m.Start(context.Background(), fixedNow(1))
	if !started || err != nil {
		t.Fatalf("expected Start to succeed, got (%v, %v)", started, err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("detached goroutine never ran the rebuild")
	}
}
