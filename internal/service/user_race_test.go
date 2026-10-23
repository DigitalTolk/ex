package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// ---------------------------------------------------------------- finding 3

// staleReadStore hands out COPIES of the stored user (as a real store does)
// and runs afterRead once the copy is taken — the window in which another
// request changes the row.
type staleReadStore struct {
	*mockUserStore
	afterRead func()
}

func (s *staleReadStore) GetUser(ctx context.Context, id string) (*model.User, error) {
	u, err := s.mockUserStore.GetUser(ctx, id)
	if err != nil {
		return nil, err
	}
	cp := *u
	if s.afterRead != nil {
		hook := s.afterRead
		s.afterRead = nil
		hook()
	}
	return &cp, nil
}

// Regression: RefreshAccessToken wrote its whole (stale) copy of the user
// back to record LastSeenAt, undoing a deactivation that landed meanwhile.
func TestRefreshDoesNotUndoAConcurrentDeactivation(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	u := addUser(env, &model.User{ID: "u-race", Email: "race@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	_, rt, _ := env.svc.issueTokens(ctx, u)
	st := &staleReadStore{mockUserStore: env.users, afterRead: func() {
		env.users.users["u-race"].Status = "deactivated"
	}}
	env.svc.users = st
	_, _, _ = env.svc.RefreshAccessToken(ctx, rt)
	if got := env.users.users["u-race"].Status; got != "deactivated" {
		t.Fatalf("status = %q, the refresh resurrected a deactivated account", got)
	}
}

// Regression: the time-zone heartbeat did the same to a demotion.
func TestTimeZonePatchDoesNotUndoAConcurrentDemotion(t *testing.T) {
	users := newMockUserStore()
	users.users["u-tz"] = &model.User{ID: "u-tz", SystemRole: model.SystemRoleAdmin, Status: "active", TimeZone: "UTC"}
	st := &staleReadStore{mockUserStore: users, afterRead: func() {
		users.users["u-tz"].SystemRole = model.SystemRoleMember
	}}
	svc := NewUserService(st, nil, nil, nil)
	if _, err := svc.PatchTimeZoneIfChanged(context.Background(), "u-tz", "Europe/Stockholm"); err != nil {
		t.Fatalf("PatchTimeZoneIfChanged: %v", err)
	}
	got := users.users["u-tz"]
	if got.SystemRole != model.SystemRoleMember || got.TimeZone != "Europe/Stockholm" {
		t.Fatalf("user = role %q tz %q, want member/Europe/Stockholm", got.SystemRole, got.TimeZone)
	}
}

// Regression: a role change wrote back a status it read before a
// deactivation.
func TestRoleChangeDoesNotUndoAConcurrentDeactivation(t *testing.T) {
	users := newMockUserStore()
	users.users["u-role"] = &model.User{ID: "u-role", SystemRole: model.SystemRoleMember, Status: "active", AuthProvider: model.AuthProviderOIDC}
	st := &staleReadStore{mockUserStore: users, afterRead: func() {
		users.users["u-role"].Status = "deactivated"
	}}
	svc := NewUserService(st, nil, nil, nil)
	if _, err := svc.UpdateRole(context.Background(), "admin", "u-role", model.SystemRoleAdmin); err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	got := users.users["u-role"]
	if got.Status != "deactivated" || got.SystemRole != model.SystemRoleAdmin {
		t.Fatalf("user = status %q role %q, want deactivated/admin", got.Status, got.SystemRole)
	}
}

// Regression: a password reset wrote back its whole copy of the account —
// undoing a deactivation that landed between its read and its write — and
// pushed that stale copy into the cache the auth middleware reads.
func TestPasswordResetDoesNotUndoAConcurrentDeactivation(t *testing.T) {
	env := setupPasswordReset(t)
	env.resets.tickets[hashToken("tok")] = "u-guest"
	st := &staleReadStore{mockUserStore: env.users, afterRead: func() {
		env.users.users["u-guest"].Status = "deactivated"
	}}
	env.svc.users = st
	if err := env.svc.ResetPassword(context.Background(), "tok", "brand-new-password"); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if got := env.users.users["u-guest"].Status; got != "deactivated" {
		t.Fatalf("status = %q, the reset resurrected a deactivated account", got)
	}
	if cached, ok := env.cache.users["u-guest"]; ok && cached.Status != "deactivated" {
		t.Fatalf("the cache holds a stale %q copy of a deactivated account", cached.Status)
	}
}
