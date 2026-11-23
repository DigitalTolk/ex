package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// --- SendNoIndex ------------------------------------------------------------

func TestSendNoIndexFlagsMessageForSearchExclusion(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["chan-1#u1"] = &model.ChannelMembership{ChannelID: "chan-1", UserID: "u1"}

	msg, err := svc.SendNoIndex(context.Background(), "u1", "chan-1", ParentChannel, "join link", "")
	if err != nil {
		t.Fatalf("SendNoIndex: %v", err)
	}
	if !msg.NoIndex {
		t.Error("SendNoIndex must persist NoIndex=true (search exclusion)")
	}

	plain, err := svc.Send(context.Background(), "u1", "chan-1", ParentChannel, "hello", "")
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if plain.NoIndex {
		t.Error("Send must not flag messages NoIndex")
	}
}

// --- UserService.SetStatusFromDirectory --------------------------------------

func setupDirectoryStatusUser(t *testing.T, provider model.AuthProvider, status string) (*UserService, *mockUserStore, *mockPublisher) {
	t.Helper()
	users := newMockUserStore()
	pub := newMockPublisher()
	svc := NewUserService(users, newMockCache(), nil, pub)
	svc.SetTokenStore(newMockTokenStore())
	u := &model.User{ID: "u1", Email: "a@x.se", AuthProvider: provider, Status: status}
	users.users[u.ID] = u
	users.emailIndex[u.Email] = u
	return svc, users, pub
}

func TestSetStatusFromDirectoryDeactivatesSSOUser(t *testing.T) {
	svc, users, pub := setupDirectoryStatusUser(t, model.AuthProviderOIDC, "active")

	if err := svc.SetStatusFromDirectory(context.Background(), "u1", true); err != nil {
		t.Fatalf("SetStatusFromDirectory: %v", err)
	}
	if users.users["u1"].Status != "deactivated" {
		t.Errorf("status = %q, want deactivated", users.users["u1"].Status)
	}
	var sawLogout, sawUpdated bool
	for _, p := range pub.published {
		switch p.event.Type {
		case "auth.force_logout":
			sawLogout = true
		case "user.updated":
			sawUpdated = true
		}
	}
	if !sawLogout || !sawUpdated {
		t.Errorf("events: forceLogout=%v userUpdated=%v, want both (a deactivated account must not keep a session)", sawLogout, sawUpdated)
	}
}

func TestSetStatusFromDirectoryReactivates(t *testing.T) {
	svc, users, _ := setupDirectoryStatusUser(t, model.AuthProviderOIDC, "deactivated")
	if err := svc.SetStatusFromDirectory(context.Background(), "u1", false); err != nil {
		t.Fatalf("SetStatusFromDirectory: %v", err)
	}
	if users.users["u1"].Status != "active" {
		t.Errorf("status = %q, want active", users.users["u1"].Status)
	}
}

func TestSetStatusFromDirectoryNoOpWhenStatusMatches(t *testing.T) {
	svc, _, pub := setupDirectoryStatusUser(t, model.AuthProviderOIDC, "active")
	if err := svc.SetStatusFromDirectory(context.Background(), "u1", false); err != nil {
		t.Fatalf("SetStatusFromDirectory: %v", err)
	}
	if len(pub.published) != 0 {
		t.Errorf("published %d events on a no-op status set", len(pub.published))
	}
}

func TestSetStatusFromDirectoryRejectsGuests(t *testing.T) {
	svc, _, _ := setupDirectoryStatusUser(t, model.AuthProviderGuest, "active")
	if err := svc.SetStatusFromDirectory(context.Background(), "u1", true); err == nil || !strings.Contains(err.Error(), "SSO accounts") {
		t.Fatalf("err = %v, want SSO-only guard", err)
	}
}

func TestSetStatusFromDirectoryGetError(t *testing.T) {
	svc, users, _ := setupDirectoryStatusUser(t, model.AuthProviderOIDC, "active")
	users.getUserErr = errors.New("dynamo down")
	if err := svc.SetStatusFromDirectory(context.Background(), "u1", true); err == nil {
		t.Fatal("expected error when the user can't be loaded")
	}
}

// --- DirectorySyncService status sweep ---------------------------------------

// fakeAccountLister is a programmable DirectoryAccountLister.
type fakeAccountLister struct {
	accounts map[string]bool
	err      error
}

func (f *fakeAccountLister) ListAccounts(context.Context) (map[string]bool, error) {
	return f.accounts, f.err
}

type fakeStatusSetter struct {
	calls map[string]bool // userID -> deactivated
	err   error
}

func (f *fakeStatusSetter) SetStatusFromDirectory(_ context.Context, targetID string, deactivated bool) error {
	if f.err != nil {
		return f.err
	}
	if f.calls == nil {
		f.calls = map[string]bool{}
	}
	f.calls[targetID] = deactivated
	return nil
}

func statusSweepEnv(accounts map[string]bool, users ...*model.User) (*DirectorySyncService, *fakeStatusSetter, *fakeAccountLister, *pagedUserStore) {
	store := &pagedUserStore{mockUserStore: newMockUserStore(), pages: [][]*model.User{users}}
	for _, u := range users {
		store.users[u.ID] = u
	}
	setter := &fakeStatusSetter{}
	lister := &fakeAccountLister{accounts: accounts}
	svc := NewDirectorySyncService(&stubDirectoryLookup{}, store, newMockCache(), newMockPublisher(), nil, func() string { return "t" })
	svc.SetStatusSync(lister, setter)
	return svc, setter, lister, store
}

func ssoUser(id, oid, status string) *model.User {
	u := oidcUser(id, id+"@x.se", "")
	u.MSObjectID, u.Status = oid, status
	return u
}

// An account disabled in Entra can't sign in, but the directory still lists
// it: the profile lookup answers 200, so the old 404-only check never
// deactivated it, and it stayed an active colleague in Ex.
func TestDirectoryStatusDeactivatesUserDisabledUpstream(t *testing.T) {
	svc, setter, _, _ := statusSweepEnv(
		map[string]bool{"oid-on": true, "oid-off": false},
		ssoUser("u-on", "oid-on", "active"),
		ssoUser("u-off", "oid-off", "active"),
	)

	svc.SweepStatus(context.Background(), time.Hour)

	if deactivated, ok := setter.calls["u-off"]; !ok || !deactivated {
		t.Errorf("calls = %v, want u-off deactivated", setter.calls)
	}
	if _, ok := setter.calls["u-on"]; ok {
		t.Error("u-on must not be touched")
	}
}

func TestDirectoryStatusDeactivatesUserDeletedUpstream(t *testing.T) {
	svc, setter, _, _ := statusSweepEnv(
		map[string]bool{"oid-alive": true},
		ssoUser("u-alive", "oid-alive", "active"),
		ssoUser("u-gone", "oid-gone", "active"),
	)

	svc.SweepStatus(context.Background(), time.Hour)

	if deactivated, ok := setter.calls["u-gone"]; !ok || !deactivated {
		t.Errorf("calls = %v, want u-gone deactivated", setter.calls)
	}
	if _, ok := setter.calls["u-alive"]; ok {
		t.Error("u-alive must not be touched")
	}
}

func TestDirectoryStatusJudgesOnlyAccountsWithAnObjectID(t *testing.T) {
	// No stored object id: the account can't be matched to the directory
	// with certainty (email may != UPN), so it is never locked out. Guests,
	// bots and already deactivated accounts are left alone too.
	guest := &model.User{ID: "u-guest", AuthProvider: model.AuthProviderGuest, Status: "active", MSObjectID: "oid-guest"}
	bot := &model.User{ID: "u-bot", IsBot: true, AuthProvider: model.AuthProviderOIDC, Status: "active", MSObjectID: "oid-bot"}
	svc, setter, _, _ := statusSweepEnv(
		map[string]bool{"oid-someone": true},
		ssoUser("u-nooid", "", "active"),
		ssoUser("u-already", "oid-already", "deactivated"),
		guest, bot,
	)
	svc.SweepStatus(context.Background(), time.Hour)
	if len(setter.calls) != 0 {
		t.Errorf("calls = %v, want none", setter.calls)
	}
}

func TestDirectoryStatusReactivatesUserWhoCanSignInAgain(t *testing.T) {
	back := ssoUser("u-back", "oid-back", "deactivated")
	back.DeactivatedBy = model.DeactivatedByDirectory
	svc, setter, _, _ := statusSweepEnv(map[string]bool{"oid-back": true}, back)

	svc.SweepStatus(context.Background(), time.Hour)

	if deactivated, ok := setter.calls["u-back"]; !ok || deactivated {
		t.Errorf("calls = %v, want u-back reactivated", setter.calls)
	}
}

func TestDirectoryStatusLeavesAdminDeactivationAlone(t *testing.T) {
	held := ssoUser("u-held", "oid-held", "deactivated")
	held.DeactivatedBy = model.DeactivatedByAdmin
	svc, setter, _, _ := statusSweepEnv(map[string]bool{"oid-held": true}, held)

	svc.SweepStatus(context.Background(), time.Hour)

	if len(setter.calls) != 0 {
		t.Errorf("calls = %v, want none: the directory never undoes an admin's deactivation", setter.calls)
	}
}

func TestDirectoryStatusReactivateErrorContinues(t *testing.T) {
	back := ssoUser("u-back", "oid-back", "deactivated")
	svc, setter, _, _ := statusSweepEnv(map[string]bool{"oid-back": true, "oid-off": false}, back, ssoUser("u-off", "oid-off", "active"))
	setter.err = errors.New("store down")
	svc.SweepStatus(context.Background(), time.Hour) // logged, the sweep goes on
}

func TestDirectoryStatusDeactivationCircuitBreaker(t *testing.T) {
	// Every account disabled at once — the misconfiguration signature. With
	// 8 checked users the cap is max(3, 0) = 3, so 8 candidates must trip
	// the breaker and deactivate NOBODY.
	accounts := map[string]bool{"oid-unrelated": true}
	users := make([]*model.User, 0, 8)
	for i := range 8 {
		oid := fmt.Sprintf("oid-%d", i)
		accounts[oid] = false
		users = append(users, ssoUser(fmt.Sprintf("u%d", i), oid, "active"))
	}
	svc, setter, _, _ := statusSweepEnv(accounts, users...)
	svc.SweepStatus(context.Background(), time.Hour)
	if len(setter.calls) != 0 {
		t.Errorf("calls = %v, want none — breaker must stop a mass deactivation", setter.calls)
	}
}

func TestDirectoryStatusDeactivateErrorContinues(t *testing.T) {
	svc, setter, _, _ := statusSweepEnv(map[string]bool{"oid-off": false}, ssoUser("u-off", "oid-off", "active"))
	setter.err = errors.New("store down")
	svc.SweepStatus(context.Background(), time.Hour) // logged, not fatal
}

func TestDirectoryStatusSkipsSweepWithoutAListing(t *testing.T) {
	t.Run("listing error", func(t *testing.T) {
		svc, setter, lister, _ := statusSweepEnv(nil, ssoUser("u1", "oid-1", "active"))
		lister.err = errors.New("graph down")
		svc.SweepStatus(context.Background(), time.Hour)
		if len(setter.calls) != 0 {
			t.Errorf("calls = %v, want none when the directory can't be read", setter.calls)
		}
	})
	t.Run("empty listing", func(t *testing.T) {
		// Nobody listed reads as "everyone left" — never grounds to act.
		svc, setter, _, _ := statusSweepEnv(map[string]bool{}, ssoUser("u1", "oid-1", "active"))
		svc.SweepStatus(context.Background(), time.Hour)
		if len(setter.calls) != 0 {
			t.Errorf("calls = %v, want none for an empty listing", setter.calls)
		}
	})
	t.Run("user listing error", func(t *testing.T) {
		svc, setter, _, users := statusSweepEnv(map[string]bool{"oid-off": false}, ssoUser("u-off", "oid-off", "active"))
		users.listErr = errors.New("dynamo down")
		svc.SweepStatus(context.Background(), time.Hour)
		if len(setter.calls) != 0 {
			t.Errorf("calls = %v, want none", setter.calls)
		}
	})
}

func TestDirectoryStatusPagesThroughUsers(t *testing.T) {
	store := &pagedUserStore{mockUserStore: newMockUserStore(), pages: [][]*model.User{
		{ssoUser("u1", "oid-1", "active")},
		{ssoUser("u2", "oid-2", "active")},
	}}
	setter := &fakeStatusSetter{}
	svc := NewDirectorySyncService(&stubDirectoryLookup{}, store, newMockCache(), newMockPublisher(), nil, func() string { return "t" })
	svc.SetStatusSync(&fakeAccountLister{accounts: map[string]bool{"oid-1": true, "oid-2": false}}, setter)

	svc.SweepStatus(context.Background(), time.Hour)

	if deactivated, ok := setter.calls["u2"]; !ok || !deactivated || len(setter.calls) != 1 {
		t.Errorf("calls = %v, want only u2 (second page) deactivated", setter.calls)
	}
}

func TestDirectoryStatusElection(t *testing.T) {
	t.Run("loser skips the sweep", func(t *testing.T) {
		svc, setter, _, _ := statusSweepEnv(map[string]bool{"oid-off": false}, ssoUser("u-off", "oid-off", "active"))
		locker := &fakeSyncLocker{acquired: false}
		svc.locker = locker
		svc.SweepStatus(context.Background(), time.Hour)
		if len(setter.calls) != 0 {
			t.Errorf("calls = %v, want none (lock lost)", setter.calls)
		}
		if locker.gotTTL >= time.Hour {
			t.Errorf("lock TTL %v must stay under the interval", locker.gotTTL)
		}
	})
	t.Run("lock error skips the sweep", func(t *testing.T) {
		svc, setter, _, _ := statusSweepEnv(map[string]bool{"oid-off": false}, ssoUser("u-off", "oid-off", "active"))
		svc.locker = &fakeSyncLocker{err: errors.New("redis down")}
		svc.SweepStatus(context.Background(), time.Hour)
		if len(setter.calls) != 0 {
			t.Errorf("calls = %v, want none", setter.calls)
		}
	})
	t.Run("winner sweeps", func(t *testing.T) {
		svc, setter, _, _ := statusSweepEnv(map[string]bool{"oid-off": false}, ssoUser("u-off", "oid-off", "active"))
		svc.locker = &fakeSyncLocker{acquired: true}
		svc.SweepStatus(context.Background(), time.Hour)
		if !setter.calls["u-off"] {
			t.Errorf("calls = %v, want u-off deactivated", setter.calls)
		}
	})
}

func TestDirectoryStatusRunLoop(t *testing.T) {
	// interval <= 0 falls back to the default; the immediate boot sweep
	// still runs before the first (never-reached) tick.
	svc, _, _, _ := statusSweepEnv(map[string]bool{"oid-1": true}, ssoUser("u1", "oid-1", "active"))
	var lockCount atomic.Int64
	svc.locker = &lockCounter{n: &lockCount}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		svc.RunStatus(ctx, 0)
		close(done)
	}()
	waitFor(t, func() bool { return lockCount.Load() >= 1 })
	cancel()
	<-done

	// A tiny positive interval drives the ticker arm, and a panicking sweep
	// is confined to itself: the loop keeps checking.
	var attempts atomic.Int64
	svc.locker = &panickyLocker{n: &attempts}
	ctx2, cancel2 := context.WithCancel(context.Background())
	done2 := make(chan struct{})
	go func() {
		svc.RunStatus(ctx2, 5*time.Millisecond)
		close(done2)
	}()
	waitFor(t, func() bool { return attempts.Load() >= 2 }) // panicked boot sweep, then a tick
	cancel2()
	<-done2
}

// The profile sweep writes from the copy its page read returned. Writing
// that whole copy back would undo a status change made in the meantime —
// the status sweep, running alongside, deactivating this very account.
func TestDirectorySyncProfileWriteKeepsAConcurrentDeactivation(t *testing.T) {
	stale := oidcUser("u1", "a@x.se", "")
	store := &pagedUserStore{mockUserStore: newMockUserStore(), pages: [][]*model.User{{stale}}}
	current := *stale
	current.Status, current.DeactivatedBy = "deactivated", model.DeactivatedByDirectory
	store.users["u1"] = &current
	dir := &stubDirectoryLookup{profile: &DirectoryProfile{ObjectID: "oid-1", Phone: "+46 70 111 22 33"}}
	svc := NewDirectorySyncService(dir, store, newMockCache(), newMockPublisher(), nil, func() string { return "t" })

	svc.Sweep(context.Background(), time.Hour)

	got := store.users["u1"]
	if got.Status != "deactivated" || got.DeactivatedBy != model.DeactivatedByDirectory {
		t.Errorf("status = %q (by %q), want the deactivation kept", got.Status, got.DeactivatedBy)
	}
	if got.Phone != "+46 70 111 22 33" || got.MSObjectID != "oid-1" {
		t.Errorf("profile not synced: %+v", got)
	}
}
