//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func strp(s string) *string { return &s }

// Regression: UpdateUser is a read-then-full-PutItem, so a writer holding a
// copy read before an admin deactivated the account wrote "active" straight
// back. A field-level patch touches only its own attributes.
func TestUserStore_PatchUserLeavesOtherFieldsAlone(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(db)
	u := makeUser("u-patch", "patch@test.com", "Patch")
	u.Status = "active"
	u.SystemRole = model.SystemRoleAdmin
	if err := s.CreateUser(ctx, u); err != nil {
		t.Fatalf("create: %v", err)
	}
	stale, err := s.GetUser(ctx, "u-patch") // a refresh reads the user…
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	// …an admin deactivates and demotes it…
	deactivated, member := "deactivated", model.SystemRoleMember
	if err := s.PatchUser(ctx, "u-patch", UserPatch{Status: &deactivated, SystemRole: &member, UpdatedAt: time.Now()}); err != nil {
		t.Fatalf("patch status: %v", err)
	}
	// …and the refresh records LastSeenAt from its stale copy.
	seen := time.Now().Truncate(time.Millisecond)
	stale.LastSeenAt = &seen
	if err := s.PatchUser(ctx, "u-patch", UserPatch{LastSeenAt: stale.LastSeenAt}); err != nil {
		t.Fatalf("patch last seen: %v", err)
	}
	got, _ := s.GetUser(ctx, "u-patch")
	if got.Status != "deactivated" || got.SystemRole != model.SystemRoleMember {
		t.Fatalf("stale writer undid the admin's change: status=%q role=%q", got.Status, got.SystemRole)
	}
	if got.LastSeenAt == nil || !got.LastSeenAt.Equal(seen) {
		t.Fatalf("lastSeenAt = %v, want %v", got.LastSeenAt, seen)
	}
}

func TestUserStore_PatchUserEveryField(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(db)
	u := makeUser("u-all", "all@test.com", "All")
	u.PasswordHash = "hash"
	u.AuthProvider = model.AuthProviderGuest
	u.TimeZone = "Europe/Stockholm"
	u.Phone = "+46 1"
	u.Manager = &model.UserManager{DisplayName: "Boss"}
	if err := s.CreateUser(ctx, u); err != nil {
		t.Fatalf("create: %v", err)
	}
	oidc := model.AuthProviderOIDC
	role := model.SystemRoleGuest
	now := time.Now().Truncate(time.Millisecond)
	err := s.PatchUser(ctx, "u-all", UserPatch{
		DisplayName:       strp("Renamed"),
		TimeZone:          strp("Asia/Tokyo"),
		SystemRole:        &role,
		Status:            strp("active"),
		AuthProvider:      &oidc,
		PasswordHash:      strp(""),
		LastSeenAt:        &now,
		MSObjectID:        strp("oid-1"),
		OIDCIssuer:        strp("https://issuer.example.com"),
		OIDCSubject:       strp("sub-1"),
		ExpectOIDCSubject: strp(""),
		DeactivatedBy:     strp(model.DeactivatedByAdmin),
		Directory:         &UserDirectoryFields{Phone: "+46 2", Manager: &model.UserManager{DisplayName: "New Boss"}},
		UpdatedAt:         now,
	})
	if err != nil {
		t.Fatalf("patch: %v", err)
	}
	got, _ := s.GetUser(ctx, "u-all")
	if got.DisplayName != "Renamed" || got.TimeZone != "Asia/Tokyo" || got.SystemRole != role ||
		got.AuthProvider != oidc || got.PasswordHash != "" || got.MSObjectID != "oid-1" ||
		got.OIDCIssuer != "https://issuer.example.com" || got.OIDCSubject != "sub-1" ||
		got.DeactivatedBy != model.DeactivatedByAdmin || got.Phone != "+46 2" ||
		got.Manager == nil || got.Manager.DisplayName != "New Boss" || !got.UpdatedAt.Equal(now) {
		t.Fatalf("patch not applied: %+v", got)
	}

	// Emptying optional attributes removes them; a nil manager removes it.
	err = s.PatchUser(ctx, "u-all", UserPatch{
		TimeZone: strp(""), MSObjectID: strp(""), DeactivatedBy: strp(""),
		Directory: &UserDirectoryFields{},
	})
	if err != nil {
		t.Fatalf("patch removals: %v", err)
	}
	got, _ = s.GetUser(ctx, "u-all")
	if got.TimeZone != "" || got.MSObjectID != "" || got.DeactivatedBy != "" || got.Phone != "" || got.Manager != nil {
		t.Fatalf("removals not applied: %+v", got)
	}
}

func TestUserStore_PatchUserSubjectCompareAndSwap(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(db)
	if err := s.CreateUser(ctx, makeUser("u-cas", "cas@test.com", "Cas")); err != nil {
		t.Fatalf("create: %v", err)
	}
	// First bind wins…
	if err := s.PatchUser(ctx, "u-cas", UserPatch{OIDCSubject: strp("sub-a"), ExpectOIDCSubject: strp("")}); err != nil {
		t.Fatalf("first bind: %v", err)
	}
	// …a racing bind of another identity loses.
	if err := s.PatchUser(ctx, "u-cas", UserPatch{OIDCSubject: strp("sub-b"), ExpectOIDCSubject: strp("")}); !errors.Is(err, ErrIdentityBound) {
		t.Fatalf("second bind = %v, want ErrIdentityBound", err)
	}
	// A swap from the current value succeeds.
	if err := s.PatchUser(ctx, "u-cas", UserPatch{OIDCSubject: strp("sub-b"), ExpectOIDCSubject: strp("sub-a")}); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	if err := s.PatchUser(ctx, "u-cas", UserPatch{OIDCSubject: strp("sub-c"), ExpectOIDCSubject: strp("sub-a")}); !errors.Is(err, ErrIdentityBound) {
		t.Fatalf("stale rebind = %v, want ErrIdentityBound", err)
	}
	got, _ := s.GetUser(ctx, "u-cas")
	if got.OIDCSubject != "sub-b" {
		t.Fatalf("subject = %q, want sub-b", got.OIDCSubject)
	}
}

func TestUserStore_PatchUserMissingAndEmpty(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewUserStore(db)
	if err := s.PatchUser(ctx, "u-ghost", UserPatch{Status: strp("active")}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing user = %v, want ErrNotFound", err)
	}
	// An empty patch writes nothing — not even to a missing row.
	if err := s.PatchUser(ctx, "u-ghost", UserPatch{}); err != nil {
		t.Fatalf("empty patch = %v, want nil", err)
	}
	fs := NewUserStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if err := fs.PatchUser(ctx, "u-ghost", UserPatch{Status: strp("active")}); !errors.Is(err, errInjected) {
		t.Fatalf("update fault = %v, want errInjected", err)
	}
}

// Regression: reuse detection and logout deleted only the presented token,
// leaving the rest of the session's rotation chain alive.
func TestTokenStore_DeleteRefreshTokenFamily(t *testing.T) {
	db := setupDynamoDB(t)
	ts := NewTokenStore(db)
	ctx := context.Background()
	mk := func(hash, user, family string) {
		rt := makeRefreshToken(hash, user)
		rt.FamilyID = family
		if err := ts.StoreRefreshToken(ctx, rt); err != nil {
			t.Fatalf("store %s: %v", hash, err)
		}
	}
	mk("fam-a1", "u-fam", "family-a")
	mk("fam-a2", "u-fam", "family-a")
	mk("fam-b1", "u-fam", "family-b")
	mk("fam-other", "u-other", "family-a")

	if err := ts.DeleteRefreshTokenFamily(ctx, "u-fam", "family-a"); err != nil {
		t.Fatalf("delete family: %v", err)
	}
	for _, gone := range []string{"fam-a1", "fam-a2"} {
		if _, err := ts.GetRefreshToken(ctx, gone); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s survived its family's revocation: %v", gone, err)
		}
	}
	for _, kept := range []string{"fam-b1", "fam-other"} {
		if _, err := ts.GetRefreshToken(ctx, kept); err != nil {
			t.Errorf("%s (another session) was revoked: %v", kept, err)
		}
	}

	fq := NewTokenStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	if err := fq.DeleteRefreshTokenFamily(ctx, "u-fam", "family-b"); !errors.Is(err, errInjected) {
		t.Fatalf("query fault = %v, want errInjected", err)
	}
	fb := NewTokenStore(withFault(db, func(f *faultClient) { f.failBatchWriteItem = true }))
	if err := fb.DeleteRefreshTokenFamily(ctx, "u-fam", "family-b"); !errors.Is(err, errInjected) {
		t.Fatalf("batch fault = %v, want errInjected", err)
	}
}
