package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/alicebob/miniredis/v2"
)

// fakeAvatarSigner returns a deterministic URL so we can verify it ends up on
// the user struct after the cache round-trip.
type fakeAvatarSigner struct{}

func (fakeAvatarSigner) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	return "https://signed.example/" + key, nil
}

// countingAvatarSigner is a fakeAvatarSigner variant whose returned URL
// embeds a per-call counter, so two URLs for the same key are
// *different strings* — exactly how production presigned URLs behave
// (each carries a fresh signing timestamp). Tests use it to assert that
// the URL cache is what stabilises the final AvatarURL across calls.
type countingAvatarSigner struct{ calls int }

func (s *countingAvatarSigner) PresignedGetURL(_ context.Context, key string, _ time.Duration) (string, error) {
	s.calls++
	return fmt.Sprintf("https://signed.example/%s?sig=%d", key, s.calls), nil
}

func TestNewUserService(t *testing.T) {
	users := newMockUserStore()
	cache := newMockCache()
	svc := NewUserService(users, cache, nil, nil)
	if svc == nil {
		t.Fatal("expected non-nil UserService")
	}
}

func TestUserService_GetByID_CacheHit(t *testing.T) {
	users := newMockUserStore()
	cache := newMockCache()
	svc := NewUserService(users, cache, nil, nil)

	user := &model.User{
		ID:          "u1",
		Email:       "u1@example.com",
		DisplayName: "User One",
		SystemRole:  model.SystemRoleMember,
	}
	cache.users[user.ID] = user

	got, err := svc.GetByID(context.Background(), "u1")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.ID != user.ID {
		t.Errorf("ID = %q, want %q", got.ID, user.ID)
	}
}

func TestUserService_GetByID_CacheMiss(t *testing.T) {
	users := newMockUserStore()
	cache := newMockCache()
	svc := NewUserService(users, cache, nil, nil)

	user := &model.User{
		ID:          "u2",
		Email:       "u2@example.com",
		DisplayName: "User Two",
		SystemRole:  model.SystemRoleMember,
	}
	users.users[user.ID] = user

	got, err := svc.GetByID(context.Background(), "u2")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.ID != user.ID {
		t.Errorf("ID = %q, want %q", got.ID, user.ID)
	}

	// Should now be cached.
	if _, ok := cache.users["u2"]; !ok {
		t.Error("expected user to be cached after store fetch")
	}
}

func TestUserService_GetByID_NotFound(t *testing.T) {
	users := newMockUserStore()
	cache := newMockCache()
	svc := NewUserService(users, cache, nil, nil)

	_, err := svc.GetByID(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for non-existent user")
	}
}

func TestUserService_GetByID_BackfillsAuthProviderForLegacyUsers(t *testing.T) {
	// Users created before the AuthProvider field existed have it empty.
	// Without the backfill, the frontend's SSO lock would silently leave
	// their display name editable. This test pins the backfill rule:
	//   PasswordHash present  → guest (invite-acceptance flow)
	//   PasswordHash empty    → oidc  (everyone else)
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)
	ctx := context.Background()

	legacySSO := &model.User{
		ID:          "u-legacy-sso",
		Email:       "sso@example.com",
		DisplayName: "Legacy SSO",
		SystemRole:  model.SystemRoleMember,
		// No AuthProvider, no PasswordHash.
	}
	legacyGuest := &model.User{
		ID:           "u-legacy-guest",
		Email:        "guest@example.com",
		DisplayName:  "Legacy Guest",
		SystemRole:   model.SystemRoleGuest,
		PasswordHash: "$2a$bcrypt-fake",
	}
	users.users[legacySSO.ID] = legacySSO
	users.users[legacyGuest.ID] = legacyGuest

	got, err := svc.GetByID(ctx, legacySSO.ID)
	if err != nil {
		t.Fatalf("GetByID(sso): %v", err)
	}
	if got.AuthProvider != model.AuthProviderOIDC {
		t.Errorf("legacy SSO user backfill: AuthProvider = %q, want %q", got.AuthProvider, model.AuthProviderOIDC)
	}

	got, err = svc.GetByID(ctx, legacyGuest.ID)
	if err != nil {
		t.Fatalf("GetByID(guest): %v", err)
	}
	if got.AuthProvider != model.AuthProviderGuest {
		t.Errorf("legacy guest user backfill: AuthProvider = %q, want %q", got.AuthProvider, model.AuthProviderGuest)
	}
}

func TestUserService_GetByID_DoesNotOverwriteExistingAuthProvider(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)
	ctx := context.Background()

	user := &model.User{
		ID:           "u-explicit-guest",
		Email:        "g@example.com",
		DisplayName:  "Guest",
		SystemRole:   model.SystemRoleGuest,
		AuthProvider: model.AuthProviderGuest,
		// Even with no password the explicit AuthProvider must win.
	}
	users.users[user.ID] = user

	got, err := svc.GetByID(ctx, user.ID)
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.AuthProvider != model.AuthProviderGuest {
		t.Errorf("explicit AuthProvider was overwritten: %q", got.AuthProvider)
	}
}

func TestUserService_GetByID_NilCache(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	user := &model.User{
		ID:          "u3",
		Email:       "u3@example.com",
		DisplayName: "User Three",
		SystemRole:  model.SystemRoleMember,
	}
	users.users[user.ID] = user

	got, err := svc.GetByID(context.Background(), "u3")
	if err != nil {
		t.Fatalf("GetByID: %v", err)
	}
	if got.ID != "u3" {
		t.Errorf("ID = %q, want %q", got.ID, "u3")
	}
}

func TestUserService_GetByEmail(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	user := &model.User{
		ID:          "u4",
		Email:       "u4@example.com",
		DisplayName: "User Four",
		SystemRole:  model.SystemRoleMember,
	}
	users.users[user.ID] = user
	users.emailIndex[user.Email] = user

	got, err := svc.GetByEmail(context.Background(), "u4@example.com")
	if err != nil {
		t.Fatalf("GetByEmail: %v", err)
	}
	if got.ID != user.ID {
		t.Errorf("ID = %q, want %q", got.ID, user.ID)
	}
}

func TestUserService_GetByEmail_NotFound(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	_, err := svc.GetByEmail(context.Background(), "noone@example.com")
	if err == nil {
		t.Fatal("expected error for non-existent email")
	}
}

func TestUserService_Update(t *testing.T) {
	users := newMockUserStore()
	cache := newMockCache()
	svc := NewUserService(users, cache, nil, nil)

	user := &model.User{
		ID:          "u5",
		Email:       "u5@example.com",
		DisplayName: "Old Name",
		SystemRole:  model.SystemRoleMember,
	}
	users.users[user.ID] = user
	users.emailIndex[user.Email] = user

	newName := "New Name"
	newKey := "avatars/u5/some-id"
	updated, err := svc.Update(context.Background(), "u5", &newName, &newKey, nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.DisplayName != newName {
		t.Errorf("DisplayName = %q, want %q", updated.DisplayName, newName)
	}
	if updated.AvatarKey != newKey {
		t.Errorf("AvatarKey = %q, want %q", updated.AvatarKey, newKey)
	}
}

func TestUserService_Update_OIDCUserCannotChangeDisplayName(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	user := &model.User{
		ID:           "u-sso",
		Email:        "sso@example.com",
		DisplayName:  "Upstream Name",
		SystemRole:   model.SystemRoleMember,
		AuthProvider: model.AuthProviderOIDC,
	}
	users.users[user.ID] = user
	users.emailIndex[user.Email] = user

	newName := "Local Override"
	if _, err := svc.Update(context.Background(), "u-sso", &newName, nil, nil); err == nil {
		t.Fatal("expected error when OIDC user tries to rename themselves")
	}
	if user.DisplayName != "Upstream Name" {
		t.Errorf("DisplayName changed despite SSO lock: %q", user.DisplayName)
	}
}

func TestUserService_Update_OIDCUserSameDisplayNameAllowed(t *testing.T) {
	// Sending the unchanged displayName should be a no-op and must not
	// trigger the SSO guard — otherwise PATCHing other fields with the
	// existing name in the payload would fail.
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	user := &model.User{
		ID:           "u-sso2",
		Email:        "sso2@example.com",
		DisplayName:  "Upstream Name",
		AvatarKey:    "avatars/u-sso2/old",
		SystemRole:   model.SystemRoleMember,
		AuthProvider: model.AuthProviderOIDC,
	}
	users.users[user.ID] = user
	users.emailIndex[user.Email] = user

	same := "Upstream Name"
	newKey := "avatars/u-sso2/new"
	if _, err := svc.Update(context.Background(), "u-sso2", &same, &newKey, nil); err != nil {
		t.Fatalf("Update with unchanged name should succeed: %v", err)
	}
	if user.AvatarKey != newKey {
		t.Errorf("AvatarKey not updated: %q", user.AvatarKey)
	}
}

func TestUserService_Update_NotFound(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	name := "X"
	_, err := svc.Update(context.Background(), "nonexistent", &name, nil, nil)
	if err == nil {
		t.Fatal("expected error for non-existent user")
	}
}

func TestUserService_Update_PartialFields(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	user := &model.User{
		ID:          "u6",
		Email:       "u6@example.com",
		DisplayName: "Original",
		AvatarKey:   "avatars/u6/old",
		SystemRole:  model.SystemRoleMember,
	}
	users.users[user.ID] = user
	users.emailIndex[user.Email] = user

	// Only update display name.
	newName := "Updated"
	updated, err := svc.Update(context.Background(), "u6", &newName, nil, nil)
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.DisplayName != "Updated" {
		t.Errorf("DisplayName = %q, want %q", updated.DisplayName, "Updated")
	}
	if updated.AvatarKey != "avatars/u6/old" {
		t.Errorf("AvatarKey should remain unchanged, got %q", updated.AvatarKey)
	}
}

func TestUserService_GetBatch(t *testing.T) {
	users := newMockUserStore()
	cache := newMockCache()
	svc := NewUserService(users, cache, nil, nil)

	users.users["b1"] = &model.User{ID: "b1", DisplayName: "Alice"}
	users.users["b2"] = &model.User{ID: "b2", DisplayName: "Bob"}

	got, err := svc.GetBatch(context.Background(), []string{"b1", "b2", "missing"})
	if err != nil {
		t.Fatalf("GetBatch: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 users, got %d", len(got))
	}
}

func TestUserService_GetBatch_Empty(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	got, err := svc.GetBatch(context.Background(), []string{})
	if err != nil {
		t.Fatalf("GetBatch: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("expected 0 users, got %d", len(got))
	}
}

func TestUserService_List(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	_, _, err := svc.List(context.Background(), 50, "")
	if err != nil {
		t.Fatalf("List: %v", err)
	}
}

func TestUserService_Search(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	users.users["s1"] = &model.User{ID: "s1", Email: "alice@example.com", DisplayName: "Alice Smith"}
	users.users["s2"] = &model.User{ID: "s2", Email: "bob@example.com", DisplayName: "Bob Jones"}
	users.users["s3"] = &model.User{ID: "s3", Email: "charlie@example.com", DisplayName: "Charlie Smith"}

	// Search by display name.
	results, err := svc.Search(context.Background(), "smith", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 2 {
		t.Errorf("expected 2 results for 'smith', got %d", len(results))
	}

	// Search by email.
	results, err = svc.Search(context.Background(), "bob@", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result for 'bob@', got %d", len(results))
	}

	// Search with limit.
	results, err = svc.Search(context.Background(), "example", 1)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result with limit=1, got %d", len(results))
	}

	// Search with no matches.
	results, err = svc.Search(context.Background(), "zzz", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 0 {
		t.Errorf("expected 0 results for 'zzz', got %d", len(results))
	}
}

func TestUserService_UpdateRole(t *testing.T) {
	users := newMockUserStore()
	cache := newMockCache()
	svc := NewUserService(users, cache, nil, nil)

	user := &model.User{
		ID:          "role-u",
		Email:       "role@example.com",
		DisplayName: "Role User",
		SystemRole:  model.SystemRoleMember,
	}
	users.users[user.ID] = user
	users.emailIndex[user.Email] = user

	updated, err := svc.UpdateRole(context.Background(), "actor", "role-u", model.SystemRoleAdmin)
	if err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if updated.SystemRole != model.SystemRoleAdmin {
		t.Errorf("SystemRole = %q, want %q", updated.SystemRole, model.SystemRoleAdmin)
	}
	if users.users["role-u"].SystemRole != model.SystemRoleAdmin {
		t.Error("expected role to persist in store")
	}
}

func TestUserService_UpdateRole_GuestCannotBePromoted(t *testing.T) {
	// Member and admin are SSO-only. An account that came in via the
	// invite-acceptance flow (AuthProvider=guest) must not be promoted
	// without going through SSO first.
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	guest := &model.User{
		ID:           "u-guest",
		Email:        "g@example.com",
		DisplayName:  "Guest",
		SystemRole:   model.SystemRoleGuest,
		AuthProvider: model.AuthProviderGuest,
		PasswordHash: "$2a$bcrypt-fake",
	}
	users.users[guest.ID] = guest

	if _, err := svc.UpdateRole(context.Background(), "admin", guest.ID, model.SystemRoleMember); err == nil {
		t.Fatal("expected guest→member promotion to fail")
	}
	if _, err := svc.UpdateRole(context.Background(), "admin", guest.ID, model.SystemRoleAdmin); err == nil {
		t.Fatal("expected guest→admin promotion to fail")
	}
	if guest.SystemRole != model.SystemRoleGuest {
		t.Errorf("guest's role was changed despite the guard: %q", guest.SystemRole)
	}
}

func TestUserService_UpdateRole_DemotionToGuestAllowed(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	member := &model.User{
		ID:           "u-mem",
		Email:        "m@example.com",
		DisplayName:  "Member",
		SystemRole:   model.SystemRoleMember,
		AuthProvider: model.AuthProviderOIDC,
	}
	users.users[member.ID] = member

	updated, err := svc.UpdateRole(context.Background(), "admin", member.ID, model.SystemRoleGuest)
	if err != nil {
		t.Fatalf("member→guest demotion should succeed: %v", err)
	}
	if updated.SystemRole != model.SystemRoleGuest {
		t.Errorf("SystemRole = %q, want guest", updated.SystemRole)
	}
}

func TestUserService_UpdateRole_NotFound(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	_, err := svc.UpdateRole(context.Background(), "actor", "missing", model.SystemRoleAdmin)
	if err == nil {
		t.Fatal("expected error for non-existent user")
	}
}

func TestUserService_SetStatus_DeactivateAndReactivateGuest(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	guest := &model.User{
		ID:           "u-guest-x",
		Email:        "x@example.com",
		DisplayName:  "Guest X",
		SystemRole:   model.SystemRoleGuest,
		AuthProvider: model.AuthProviderGuest,
		PasswordHash: "$2a$bcrypt",
		Status:       "active",
	}
	users.users[guest.ID] = guest

	out, err := svc.SetStatus(context.Background(), guest.ID, true)
	if err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if out.Status != "deactivated" {
		t.Errorf("Status = %q, want deactivated", out.Status)
	}

	out, err = svc.SetStatus(context.Background(), guest.ID, false)
	if err != nil {
		t.Fatalf("reactivate: %v", err)
	}
	if out.Status != "active" {
		t.Errorf("Status = %q, want active", out.Status)
	}
}

func TestUserService_SetStatus_RejectsNonGuest(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	member := &model.User{
		ID:           "u-mem-y",
		AuthProvider: model.AuthProviderOIDC,
		Status:       "active",
	}
	users.users[member.ID] = member

	if _, err := svc.SetStatus(context.Background(), member.ID, true); err == nil {
		t.Fatal("expected SSO/member to be rejected")
	}
}

func TestUserService_SetStatus_NotFound(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)
	if _, err := svc.SetStatus(context.Background(), "missing", true); err == nil {
		t.Fatal("expected not-found error")
	}
}

// Deactivating a guest must wipe every refresh token they hold so the
// session truly ends — otherwise the user could refresh into a new
// access token until the refresh expires naturally.
func TestUserService_SetStatus_Deactivate_InvalidatesRefreshTokens(t *testing.T) {
	users := newMockUserStore()
	tokens := newMockTokenStore()
	pub := &mockPublisher{}
	svc := NewUserService(users, nil, nil, pub)
	svc.SetTokenStore(tokens)

	guest := &model.User{
		ID: "u-guest-tok", Email: "g@x.com", SystemRole: model.SystemRoleGuest,
		AuthProvider: model.AuthProviderGuest, Status: "active",
	}
	users.users[guest.ID] = guest

	tokens.tokens["h1"] = &model.RefreshToken{TokenHash: "h1", UserID: guest.ID}
	tokens.tokens["h2"] = &model.RefreshToken{TokenHash: "h2", UserID: guest.ID}
	tokens.tokens["other"] = &model.RefreshToken{TokenHash: "other", UserID: "someone-else"}

	if _, err := svc.SetStatus(context.Background(), guest.ID, true); err != nil {
		t.Fatalf("deactivate: %v", err)
	}

	if _, ok := tokens.tokens["h1"]; ok {
		t.Error("guest refresh token h1 should be wiped")
	}
	if _, ok := tokens.tokens["h2"]; ok {
		t.Error("guest refresh token h2 should be wiped")
	}
	if _, ok := tokens.tokens["other"]; !ok {
		t.Error("unrelated user's refresh token must not be touched")
	}

	// A force-logout event should be published to the user's personal
	// channel so any open browser tab disconnects right now.
	var sawForceLogout bool
	for _, p := range pub.published {
		if p.event.Type == "auth.force_logout" {
			sawForceLogout = true
			break
		}
	}
	if !sawForceLogout {
		t.Error("expected auth.force_logout to be published on deactivate")
	}
}

func TestUserService_SetStatus_Reactivate_DoesNotPublishForceLogout(t *testing.T) {
	users := newMockUserStore()
	tokens := newMockTokenStore()
	pub := &mockPublisher{}
	svc := NewUserService(users, nil, nil, pub)
	svc.SetTokenStore(tokens)

	guest := &model.User{
		ID: "u-react", SystemRole: model.SystemRoleGuest,
		AuthProvider: model.AuthProviderGuest, Status: "deactivated",
	}
	users.users[guest.ID] = guest
	tokens.tokens["k"] = &model.RefreshToken{TokenHash: "k", UserID: guest.ID}

	if _, err := svc.SetStatus(context.Background(), guest.ID, false); err != nil {
		t.Fatalf("reactivate: %v", err)
	}

	if _, ok := tokens.tokens["k"]; !ok {
		t.Error("reactivation must not invalidate tokens")
	}
	for _, p := range pub.published {
		if p.event.Type == "auth.force_logout" {
			t.Error("force_logout must not be published on reactivation")
		}
	}
}

func TestUserService_Search_CaseInsensitive(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, nil)

	users.users["ci1"] = &model.User{ID: "ci1", Email: "UPPER@EXAMPLE.COM", DisplayName: "Upper Case"}

	results, err := svc.Search(context.Background(), "upper", 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}
}

// TestUserService_AvatarPersistsAcrossCacheRoundTrip is a regression test for
// the bug where avatars vanished on hard refresh. The public model.User hides
// AvatarKey from JSON, but the Redis cache marshals to JSON — so naive
// caching would strip the key, leaving resolveAvatar with nothing to sign.
// This test uses the real RedisCache (backed by miniredis) plus a real-shaped
// avatar signer to prove the full GetMe → cache hit → resolved-URL flow.
func TestUserService_AvatarPersistsAcrossCacheRoundTrip(t *testing.T) {
	mr := miniredis.RunT(t)
	c, err := cache.NewRedisCache("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}

	users := newMockUserStore()
	users.users["u1"] = &model.User{
		ID:          "u1",
		Email:       "u1@x.com",
		DisplayName: "U1",
		AvatarKey:   "avatars/u1/abc",
		SystemRole:  model.SystemRoleMember,
	}

	svc := NewUserService(users, c, fakeAvatarSigner{}, nil)

	// First call: cache miss → loads from store → caches → resolves URL.
	first, err := svc.GetByID(context.Background(), "u1")
	if err != nil {
		t.Fatalf("first GetByID: %v", err)
	}
	if first.AvatarURL != "https://signed.example/avatars/u1/abc" {
		t.Fatalf("first AvatarURL = %q, want signed URL", first.AvatarURL)
	}

	// Second call: cache hit. Without the AvatarKey-preserving cache record,
	// resolveAvatar would have nothing to sign and AvatarURL would be empty.
	second, err := svc.GetByID(context.Background(), "u1")
	if err != nil {
		t.Fatalf("second GetByID: %v", err)
	}
	if second.AvatarKey != "avatars/u1/abc" {
		t.Errorf("AvatarKey lost across cache round-trip: got %q", second.AvatarKey)
	}
	if second.AvatarURL != "https://signed.example/avatars/u1/abc" {
		t.Errorf("AvatarURL not regenerated on cache hit: got %q", second.AvatarURL)
	}
}

// TestUserService_UpdateAvatarKey_RegeneratesURLAfterRefresh simulates the
// post-upload flow: PATCH /users/me with new avatarKey → cache invalidated →
// next GetByID hits store, caches, regenerates URL. Hard refresh should
// continue to show the avatar.
func TestUserService_UpdateAvatarKey_RegeneratesURLAfterRefresh(t *testing.T) {
	mr := miniredis.RunT(t)
	c, err := cache.NewRedisCache("redis://" + mr.Addr())
	if err != nil {
		t.Fatalf("NewRedisCache: %v", err)
	}

	users := newMockUserStore()
	users.users["u1"] = &model.User{
		ID: "u1", Email: "u1@x.com", DisplayName: "U1", SystemRole: model.SystemRoleMember,
	}

	svc := NewUserService(users, c, fakeAvatarSigner{}, nil)

	// Upload sets the new key.
	newKey := "avatars/u1/new-upload"
	if _, err := svc.Update(context.Background(), "u1", nil, &newKey, nil); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// Simulate hard refresh: cache was invalidated by Update; first GetByID
	// reloads from store. Subsequent calls hit cache.
	for i := 0; i < 3; i++ {
		got, err := svc.GetByID(context.Background(), "u1")
		if err != nil {
			t.Fatalf("GetByID #%d: %v", i, err)
		}
		if got.AvatarKey != newKey {
			t.Errorf("call %d: AvatarKey = %q, want %q", i, got.AvatarKey, newKey)
		}
		if got.AvatarURL != "https://signed.example/"+newKey {
			t.Errorf("call %d: AvatarURL = %q, want signed URL with new key", i, got.AvatarURL)
		}
	}
}

// TestUserService_AvatarURL_StableAcrossLookups is the regression test
// for the "avatars reload too often" bug. Production presigned URLs
// embed a fresh signing timestamp on every sign — so without per-key
// URL caching the same avatar would render with a different URL on
// each request, blowing the browser cache. Using countingAvatarSigner
// (which embeds a call counter in the URL) we verify the resolved
// AvatarURL is byte-identical across two consecutive lookups within
// the cache window, and that the underlying signer was called only
// once.
func TestUserService_AvatarURL_StableAcrossLookups(t *testing.T) {
	users := newMockUserStore()
	users.users["u1"] = &model.User{
		ID: "u1", Email: "u1@x.com", DisplayName: "U1",
		AvatarKey: "avatars/u1/abc", SystemRole: model.SystemRoleMember,
	}
	signer := &countingAvatarSigner{}
	// nil cache: take the no-cache path so resolveAvatar is hit on
	// every call. This isolates the URL cache as the only thing that
	// could be holding the URL stable.
	svc := NewUserService(users, nil, signer, nil)

	first, err := svc.GetByID(context.Background(), "u1")
	if err != nil {
		t.Fatalf("first GetByID: %v", err)
	}
	second, err := svc.GetByID(context.Background(), "u1")
	if err != nil {
		t.Fatalf("second GetByID: %v", err)
	}

	if first.AvatarURL == "" {
		t.Fatal("expected an AvatarURL on the first lookup")
	}
	if first.AvatarURL != second.AvatarURL {
		t.Errorf("AvatarURL changed across consecutive lookups (browser would re-download):\n  first:  %q\n  second: %q", first.AvatarURL, second.AvatarURL)
	}
	if signer.calls != 1 {
		t.Errorf("PresignedGetURL called %d times across two lookups; expected 1 (cached)", signer.calls)
	}
}
