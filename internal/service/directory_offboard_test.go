package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
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

// --- DirectorySyncService offboarding ----------------------------------------

// funcDirectoryLookup routes lookups per call for mixed-population sweeps.
type funcDirectoryLookup func(ctx context.Context, email, objectID string) (*DirectoryProfile, error)

func (f funcDirectoryLookup) LookupProfile(ctx context.Context, email, objectID string) (*DirectoryProfile, error) {
	return f(ctx, email, objectID)
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

func offboardSweepEnv(lookup DirectoryLookup, users ...*model.User) (*DirectorySyncService, *fakeStatusSetter) {
	store := &pagedUserStore{mockUserStore: newMockUserStore(), pages: [][]*model.User{users}}
	for _, u := range users {
		store.users[u.ID] = u
	}
	setter := &fakeStatusSetter{}
	svc := NewDirectorySyncService(lookup, store, newMockCache(), newMockPublisher(), nil, func() string { return "t" })
	svc.SetStatusSetter(setter)
	return svc, setter
}

// presentExcept answers "in the directory" for every user except the given ids.
func presentExcept(gone ...string) funcDirectoryLookup {
	return func(_ context.Context, _, objectID string) (*DirectoryProfile, error) {
		for _, g := range gone {
			if objectID == g {
				return nil, nil
			}
		}
		return &DirectoryProfile{ObjectID: objectID, Phone: ""}, nil
	}
}

func TestDirectorySyncDeactivatesUserDeletedUpstream(t *testing.T) {
	alive := oidcUser("u-alive", "a@x.se", "")
	alive.MSObjectID = "oid-alive"
	gone := oidcUser("u-gone", "b@x.se", "")
	gone.MSObjectID = "oid-gone"
	svc, setter := offboardSweepEnv(presentExcept("oid-gone"), alive, gone)

	svc.Sweep(context.Background(), time.Hour)

	if deactivated, ok := setter.calls["u-gone"]; !ok || !deactivated {
		t.Errorf("calls = %v, want u-gone deactivated", setter.calls)
	}
	if _, ok := setter.calls["u-alive"]; ok {
		t.Error("u-alive must not be touched")
	}
}

func TestDirectorySyncNeverDeactivatesOnEmailKeyedMiss(t *testing.T) {
	// No stored object id → the 404 may just mean email != UPN; locking the
	// user out on that evidence is forbidden.
	noOid := oidcUser("u-nooid", "c@x.se", "")
	svc, setter := offboardSweepEnv(
		funcDirectoryLookup(func(context.Context, string, string) (*DirectoryProfile, error) { return nil, nil }),
		noOid,
	)
	svc.Sweep(context.Background(), time.Hour)
	if len(setter.calls) != 0 {
		t.Errorf("calls = %v, want none for an email-keyed miss", setter.calls)
	}
}

func TestDirectorySyncReactivatesUserBackInDirectory(t *testing.T) {
	back := oidcUser("u-back", "d@x.se", "")
	back.MSObjectID = "oid-back"
	back.Status = "deactivated"
	svc, setter := offboardSweepEnv(presentExcept(), back)

	svc.Sweep(context.Background(), time.Hour)

	if deactivated, ok := setter.calls["u-back"]; !ok || deactivated {
		t.Errorf("calls = %v, want u-back reactivated", setter.calls)
	}
}

func TestDirectorySyncReactivateErrorContinues(t *testing.T) {
	back := oidcUser("u-back", "d@x.se", "")
	back.MSObjectID = "oid-back"
	back.Status = "deactivated"
	svc, setter := offboardSweepEnv(presentExcept(), back)
	setter.err = errors.New("store down")
	svc.Sweep(context.Background(), time.Hour) // must not panic/abort
}

func TestDirectorySyncDeactivationCircuitBreaker(t *testing.T) {
	// Everyone 404s by object id — the misconfiguration signature. With
	// 8 scanned users the cap is max(3, 0) = 3, so 8 candidates must trip
	// the breaker and deactivate NOBODY.
	users := make([]*model.User, 0, 8)
	for i := range 8 {
		u := oidcUser(fmt.Sprintf("u%d", i), fmt.Sprintf("u%d@x.se", i), "")
		u.MSObjectID = fmt.Sprintf("oid-%d", i)
		users = append(users, u)
	}
	svc, setter := offboardSweepEnv(
		funcDirectoryLookup(func(context.Context, string, string) (*DirectoryProfile, error) { return nil, nil }),
		users...,
	)
	svc.Sweep(context.Background(), time.Hour)
	if len(setter.calls) != 0 {
		t.Errorf("calls = %v, want none — breaker must stop a mass deactivation", setter.calls)
	}
}

func TestDirectorySyncDeactivateErrorContinues(t *testing.T) {
	gone := oidcUser("u-gone", "b@x.se", "")
	gone.MSObjectID = "oid-gone"
	svc, setter := offboardSweepEnv(presentExcept("oid-gone"), gone)
	setter.err = errors.New("store down")
	svc.Sweep(context.Background(), time.Hour) // logged, not fatal
}
