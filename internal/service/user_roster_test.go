package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// The mention roster every client loads, the directory and the status sweep
// share one copy of the account list: the first read fills it, the rest come
// from the cache until a profile write drops it.
func TestUserService_ListAll_SharesOneRosterRead(t *testing.T) {
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "Ann", AvatarKey: "avatars/a/x"}
	users.users["bot"] = &model.User{ID: "bot", DisplayName: "Deploy Bot", IsBot: true}
	svc := NewUserService(users, newMockCache(), fakeAvatarSigner{}, nil)
	ctx := context.Background()

	for range 2 {
		got, err := svc.ListAll(ctx)
		if err != nil {
			t.Fatalf("ListAll: %v", err)
		}
		// The cached copy keeps the avatar key, so avatars still sign.
		if len(got) != 1 || got[0].ID != "a" || got[0].AvatarURL == "" {
			t.Fatalf("roster = %+v, want Ann with a signed avatar", got)
		}
	}
	if users.listCalls != 1 {
		t.Fatalf("user partition read %d times, want 1", users.listCalls)
	}

	if _, err := svc.UpdateRole(ctx, "admin-1", "a", model.SystemRoleAdmin); err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	got, err := svc.ListAll(ctx)
	if err != nil || len(got) != 1 || got[0].SystemRole != model.SystemRoleAdmin {
		t.Fatalf("roster after a role change = %+v (err %v), want the new role", got, err)
	}
	if users.listCalls != 2 {
		t.Fatalf("user partition read %d times, want a re-read after the write", users.listCalls)
	}
}

// Without a cache (or with it down) the roster is read from the store each
// time, and a store failure surfaces.
func TestUserService_ListAll_Uncached(t *testing.T) {
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a"}
	down := newMockCache()
	down.getErr, down.setErr = errors.New("redis down"), errors.New("redis down")
	for _, c := range []Cache{nil, down} {
		svc := NewUserService(users, c, nil, nil)
		if got, err := svc.ListAll(context.Background()); err != nil || len(got) != 1 {
			t.Fatalf("ListAll = %+v (err %v), want the store's roster", got, err)
		}
	}
	users.listErr = errors.New("list boom")
	if _, err := NewUserService(users, newMockCache(), nil, nil).ListAll(context.Background()); !errors.Is(err, users.listErr) {
		t.Fatalf("err = %v, want the store error", err)
	}
}

// The status sweep reads the shared roster too: every instance sweeps each
// minute, and none of them re-reads the user partition while the copy holds.
// Clearing a status drops the copy, so the next sweep sees it gone.
func TestUserService_ClearExpiredStatuses_ReadsTheSharedRoster(t *testing.T) {
	users := newMockUserStore()
	past := time.Now().Add(-time.Minute)
	users.users["a"] = &model.User{ID: "a", UserStatus: &model.UserStatus{Text: "lunch", ClearAt: &past}}
	users.users["b"] = &model.User{ID: "b"}
	svc := NewUserService(users, newMockCache(), nil, nil)
	ctx := context.Background()
	if _, err := svc.ListAll(ctx); err != nil {
		t.Fatalf("ListAll: %v", err)
	}

	cleared, err := svc.ClearExpiredStatuses(ctx, time.Now())
	if err != nil || cleared != 1 {
		t.Fatalf("cleared = %d (err %v), want 1", cleared, err)
	}
	if users.listCalls != 1 {
		t.Fatalf("user partition read %d times, want the shared copy", users.listCalls)
	}
	if cleared, err := svc.ClearExpiredStatuses(ctx, time.Now()); err != nil || cleared != 0 {
		t.Fatalf("second sweep cleared %d (err %v), want nothing left", cleared, err)
	}
}

// A first sign-in creates an account the @-mention roster must list at once,
// and a later sign-in refreshes IdP-owned fields (name, picture, phone): both
// drop the shared roster, so it isn't stale for its whole lifetime.
func TestAuthService_SignInDropsTheSharedRoster(t *testing.T) {
	env := setupAuthService()
	env.users.hasUsersVal = true
	ctx := context.Background()
	roster := NewUserService(env.users, env.cache, nil, nil)
	if _, err := roster.ListAll(ctx); err != nil {
		t.Fatalf("ListAll: %v", err)
	}

	if _, _, _, err := env.svc.HandleOIDCCallback(ctx, "auth-code", "state", "nonce"); err != nil {
		t.Fatalf("first sign-in: %v", err)
	}
	got, err := roster.ListAll(ctx)
	if err != nil || len(got) != 1 || got[0].Email != "oidc@example.com" {
		t.Fatalf("roster after the first sign-in = %+v (err %v), want the new account", got, err)
	}

	env.oidc.userInfo.Name = "Renamed In The IdP"
	if _, _, _, err := env.svc.HandleOIDCCallback(ctx, "auth-code", "state", "nonce"); err != nil {
		t.Fatalf("second sign-in: %v", err)
	}
	got, err = roster.ListAll(ctx)
	if err != nil || len(got) != 1 || got[0].DisplayName != "Renamed In The IdP" {
		t.Fatalf("roster after a sign-in refresh = %+v (err %v), want the IdP's new name", got, err)
	}
}

// Which accounts are deactivated is answered from the shared roster: a member
// list of a 400-member channel used to batch-read 400 user rows on every open.
// IDs the roster doesn't hold (bots, unknown IDs) are still read from the
// store, and a deactivation drops the roster so it shows at once.
func TestUserService_DeactivatedAmong_ReadsTheRoster(t *testing.T) {
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", Status: "active"}
	users.users["d"] = &model.User{ID: "d", Status: "deactivated"}
	users.users["bot"] = &model.User{ID: "bot", IsBot: true, Status: "deactivated"}
	svc := NewUserService(users, newMockCache(), nil, nil)
	ctx := context.Background()

	got, err := svc.DeactivatedAmong(ctx, []string{"a", "d"})
	if err != nil || len(got) != 1 || !got["d"] {
		t.Fatalf("deactivated = %v (err %v), want only d", got, err)
	}
	if len(users.deactivatedReads) != 0 {
		t.Fatalf("store reads = %v, want none for roster accounts", users.deactivatedReads)
	}

	got, err = svc.DeactivatedAmong(ctx, []string{"a", "bot", "ghost"})
	if err != nil || len(got) != 1 || !got["bot"] {
		t.Fatalf("deactivated = %v (err %v), want the bot from the store", got, err)
	}
	if len(users.deactivatedReads) != 1 || len(users.deactivatedReads[0]) != 2 {
		t.Fatalf("store reads = %v, want one read of the two IDs the roster lacks", users.deactivatedReads)
	}

	if _, err := svc.SetStatus(ctx, "a", true); err != nil {
		t.Fatalf("SetStatus: %v", err)
	}
	if got, err := svc.DeactivatedAmong(ctx, []string{"a"}); err != nil || !got["a"] {
		t.Fatalf("deactivated after deactivating a = %v (err %v), want a", got, err)
	}
	if users.listCalls != 2 {
		t.Fatalf("user partition read %d times, want 2 (once, then after the deactivation)", users.listCalls)
	}
}

// A roster or store failure surfaces, so callers keep their "list everyone"
// fallback.
func TestUserService_DeactivatedAmong_Errors(t *testing.T) {
	users := newMockUserStore()
	users.listErr = errors.New("list boom")
	if _, err := NewUserService(users, nil, nil, nil).DeactivatedAmong(context.Background(), []string{"a"}); !errors.Is(err, users.listErr) {
		t.Fatalf("err = %v, want the roster error", err)
	}
	users = newMockUserStore()
	users.deactivatedErr = errors.New("status boom")
	if _, err := NewUserService(users, nil, nil, nil).DeactivatedAmong(context.Background(), []string{"ghost"}); !errors.Is(err, users.deactivatedErr) {
		t.Fatalf("err = %v, want the store error", err)
	}
	if got, err := NewUserService(newMockUserStore(), nil, nil, nil).DeactivatedAmong(context.Background(), nil); err != nil || len(got) != 0 {
		t.Fatalf("no IDs = %v (err %v), want empty", got, err)
	}
}
