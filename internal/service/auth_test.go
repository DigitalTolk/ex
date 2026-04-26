package service

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"golang.org/x/crypto/bcrypt"
)

type authTestEnv struct {
	svc         *AuthService
	users       *mockUserStore
	tokens      *mockTokenStore
	invites     *mockInviteStore
	memberships *mockMembershipStore
	channels    *mockChannelStore
	jwt         *mockJWTProvider
	oidc        *mockOIDCProvider
	cache       *mockCache
}

func setupAuthService() *authTestEnv {
	users := newMockUserStore()
	tokens := newMockTokenStore()
	invites := newMockInviteStore()
	memberships := newMockMembershipStore()
	channels := newMockChannelStore()
	jwt := newMockJWTProvider()
	oidc := &mockOIDCProvider{
		authURL: "https://provider.example.com/authorize",
		userInfo: &OIDCUserInfo{
			Email:   "oidc@example.com",
			Name:    "OIDC User",
			Picture: "https://example.com/avatar.png",
		},
	}
	cache := newMockCache()

	svc := NewAuthService(users, tokens, invites, memberships, channels, jwt, oidc, cache)
	// Wire a real ChannelService so signup/invite flows trigger AutoJoinChannel
	// (system message + member.joined event), matching production behavior.
	chanSvc := NewChannelService(channels, memberships, users, newMockMessageStore(), cache, newMockBroker(), newMockPublisher())
	svc.SetChannelJoiner(chanSvc)

	return &authTestEnv{
		svc:         svc,
		users:       users,
		tokens:      tokens,
		invites:     invites,
		memberships: memberships,
		channels:    channels,
		jwt:         jwt,
		oidc:        oidc,
		cache:       cache,
	}
}

func TestHandleOIDCLogin(t *testing.T) {
	env := setupAuthService()

	authURL, state, err := env.svc.HandleOIDCLogin()
	if err != nil {
		t.Fatalf("HandleOIDCLogin: %v", err)
	}
	if authURL == "" {
		t.Error("expected non-empty authURL")
	}
	if state == "" {
		t.Error("expected non-empty state")
	}
}

func TestHandleOIDCLoginNoOIDC(t *testing.T) {
	env := setupAuthService()
	env.svc.oidc = nil

	_, _, err := env.svc.HandleOIDCLogin()
	if err == nil {
		t.Fatal("expected error when OIDC not configured")
	}
}

func TestHandleOIDCCallback_FirstUserGetsAdmin(t *testing.T) {
	env := setupAuthService()
	env.users.hasUsersVal = false // no existing users

	ctx := context.Background()
	accessToken, refreshToken, user, err := env.svc.HandleOIDCCallback(ctx, "auth-code", "state")
	if err != nil {
		t.Fatalf("HandleOIDCCallback: %v", err)
	}

	if accessToken == "" {
		t.Error("expected non-empty accessToken")
	}
	if refreshToken == "" {
		t.Error("expected non-empty refreshToken")
	}
	if user == nil {
		t.Fatal("expected non-nil user")
	}
	if user.SystemRole != model.SystemRoleAdmin {
		t.Errorf("first user SystemRole = %q, want %q", user.SystemRole, model.SystemRoleAdmin)
	}
	if user.Email != "oidc@example.com" {
		t.Errorf("user Email = %q, want %q", user.Email, "oidc@example.com")
	}
	if user.LastSeenAt == nil {
		t.Error("expected LastSeenAt to be set for first user")
	}
}

func TestHandleOIDCCallback_SecondUserGetsMember(t *testing.T) {
	env := setupAuthService()
	env.users.hasUsersVal = true // existing users

	ctx := context.Background()
	_, _, user, err := env.svc.HandleOIDCCallback(ctx, "auth-code", "state")
	if err != nil {
		t.Fatalf("HandleOIDCCallback: %v", err)
	}

	if user.SystemRole != model.SystemRoleMember {
		t.Errorf("second user SystemRole = %q, want %q", user.SystemRole, model.SystemRoleMember)
	}
}

func TestHandleOIDCCallback_ExistingUser(t *testing.T) {
	env := setupAuthService()

	// Pre-create the user in the store.
	existing := &model.User{
		ID:          "existing-user",
		Email:       "oidc@example.com",
		DisplayName: "Old Name",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}
	env.users.users[existing.ID] = existing
	env.users.emailIndex[existing.Email] = existing

	ctx := context.Background()
	_, _, user, err := env.svc.HandleOIDCCallback(ctx, "auth-code", "state")
	if err != nil {
		t.Fatalf("HandleOIDCCallback: %v", err)
	}

	// Profile should be updated from OIDC.
	if user.DisplayName != "OIDC User" {
		t.Errorf("DisplayName = %q, want %q", user.DisplayName, "OIDC User")
	}
}

func TestHandleOIDCCallback_NoOIDC(t *testing.T) {
	env := setupAuthService()
	env.svc.oidc = nil

	ctx := context.Background()
	_, _, _, err := env.svc.HandleOIDCCallback(ctx, "code", "state")
	if err == nil {
		t.Fatal("expected error when OIDC not configured")
	}
}

func TestRefreshAccessToken_Valid(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	// Create a user and a stored refresh token.
	user := &model.User{
		ID:          "user-rt",
		Email:       "rt@example.com",
		DisplayName: "RT User",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}
	env.users.users[user.ID] = user

	rawToken := "raw-refresh-token"
	hash := hashToken(rawToken)
	env.tokens.tokens[hash] = &model.RefreshToken{
		TokenHash: hash,
		UserID:    user.ID,
		ExpiresAt: time.Now().Add(720 * time.Hour),
		CreatedAt: time.Now(),
	}

	accessToken, err := env.svc.RefreshAccessToken(ctx, rawToken)
	if err != nil {
		t.Fatalf("RefreshAccessToken: %v", err)
	}
	if accessToken == "" {
		t.Error("expected non-empty accessToken")
	}
}

func TestRefreshAccessToken_Expired(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	rawToken := "expired-refresh"
	hash := hashToken(rawToken)
	env.tokens.tokens[hash] = &model.RefreshToken{
		TokenHash: hash,
		UserID:    "user-1",
		ExpiresAt: time.Now().Add(-1 * time.Hour), // expired
		CreatedAt: time.Now().Add(-25 * time.Hour),
	}

	_, err := env.svc.RefreshAccessToken(ctx, rawToken)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
}

func TestRefreshAccessToken_NotFound(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	_, err := env.svc.RefreshAccessToken(ctx, "nonexistent-token")
	if err == nil {
		t.Fatal("expected error for missing token")
	}
}

func TestLogout(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	rawToken := "logout-token"
	hash := hashToken(rawToken)
	env.tokens.tokens[hash] = &model.RefreshToken{
		TokenHash: hash,
		UserID:    "user-1",
		ExpiresAt: time.Now().Add(720 * time.Hour),
		CreatedAt: time.Now(),
	}

	err := env.svc.Logout(ctx, rawToken)
	if err != nil {
		t.Fatalf("Logout: %v", err)
	}

	// Token should be deleted.
	if _, ok := env.tokens.tokens[hash]; ok {
		t.Error("refresh token should have been deleted")
	}
}

func TestLogout_NonexistentToken(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	// Should not return an error for non-existent token.
	err := env.svc.Logout(ctx, "nonexistent")
	if err != nil {
		t.Fatalf("Logout with nonexistent token: %v", err)
	}
}

func TestGuestLogin_Valid(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	pw := "guest-password"
	hashed, _ := bcrypt.GenerateFromPassword([]byte(pw), bcrypt.MinCost)
	user := &model.User{
		ID:           "guest-1",
		Email:        "guest@example.com",
		DisplayName:  "Guest",
		SystemRole:   model.SystemRoleGuest,
		PasswordHash: string(hashed),
		Status:       "active",
	}
	env.users.users[user.ID] = user
	env.users.emailIndex[user.Email] = user

	accessToken, refreshToken, returnedUser, err := env.svc.GuestLogin(ctx, "guest@example.com", pw)
	if err != nil {
		t.Fatalf("GuestLogin: %v", err)
	}
	if accessToken == "" {
		t.Error("expected non-empty accessToken")
	}
	if refreshToken == "" {
		t.Error("expected non-empty refreshToken")
	}
	if returnedUser.ID != user.ID {
		t.Errorf("user ID = %q, want %q", returnedUser.ID, user.ID)
	}
}

func TestGuestLogin_NotGuest(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	hashed, _ := bcrypt.GenerateFromPassword([]byte("pw"), bcrypt.MinCost)
	user := &model.User{
		ID:           "member-1",
		Email:        "member@example.com",
		DisplayName:  "Member",
		SystemRole:   model.SystemRoleMember, // not guest
		PasswordHash: string(hashed),
		Status:       "active",
	}
	env.users.users[user.ID] = user
	env.users.emailIndex[user.Email] = user

	_, _, _, err := env.svc.GuestLogin(ctx, "member@example.com", "pw")
	if err == nil {
		t.Fatal("expected error for non-guest user")
	}
}

func TestGuestLogin_WrongPassword(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	hashed, _ := bcrypt.GenerateFromPassword([]byte("correct"), bcrypt.MinCost)
	user := &model.User{
		ID:           "guest-2",
		Email:        "guest2@example.com",
		DisplayName:  "Guest 2",
		SystemRole:   model.SystemRoleGuest,
		PasswordHash: string(hashed),
		Status:       "active",
	}
	env.users.users[user.ID] = user
	env.users.emailIndex[user.Email] = user

	_, _, _, err := env.svc.GuestLogin(ctx, "guest2@example.com", "wrong")
	if err == nil {
		t.Fatal("expected error for wrong password")
	}
}

func TestGuestLogin_UserNotFound(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	_, _, _, err := env.svc.GuestLogin(ctx, "nouser@example.com", "pw")
	if err == nil {
		t.Fatal("expected error for non-existent user")
	}
}

func TestEnsureGeneralChannel_CreatesChannelAndMembership(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	user := &model.User{
		ID:          "user-gen",
		Email:       "gen@example.com",
		DisplayName: "Gen User",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}

	env.svc.ensureGeneralChannel(ctx, user)

	// Check channel was created.
	ch, ok := env.channels.channels[generalChannelID]
	if !ok {
		t.Fatal("expected general channel to be created")
	}
	if ch.Name != "general" {
		t.Errorf("channel name = %q, want %q", ch.Name, "general")
	}
	if ch.Type != model.ChannelTypePublic {
		t.Errorf("channel type = %q, want %q", ch.Type, model.ChannelTypePublic)
	}

	// Check membership.
	key := generalChannelID + "#" + user.ID
	mem, ok := env.memberships.memberships[key]
	if !ok {
		t.Fatal("expected membership to be created")
	}
	if mem.Role != model.ChannelRoleMember {
		t.Errorf("membership role = %d, want %d", mem.Role, model.ChannelRoleMember)
	}
}

func TestEnsureGeneralChannel_AdminGetsOwnerRole(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	user := &model.User{
		ID:          "admin-gen",
		Email:       "admin@example.com",
		DisplayName: "Admin User",
		SystemRole:  model.SystemRoleAdmin,
		Status:      "active",
	}

	env.svc.ensureGeneralChannel(ctx, user)

	key := generalChannelID + "#" + user.ID
	mem, ok := env.memberships.memberships[key]
	if !ok {
		t.Fatal("expected membership to be created")
	}
	if mem.Role != model.ChannelRoleOwner {
		t.Errorf("admin membership role = %d, want %d (owner)", mem.Role, model.ChannelRoleOwner)
	}
}

func TestEnsureGeneralChannel_Idempotent(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	user := &model.User{
		ID:          "user-idem",
		Email:       "idem@example.com",
		DisplayName: "Idem User",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
	}

	// Call twice -- should not panic or error.
	env.svc.ensureGeneralChannel(ctx, user)
	env.svc.ensureGeneralChannel(ctx, user)
}

func TestHashToken(t *testing.T) {
	// Verify deterministic.
	h1 := hashToken("test-raw")
	h2 := hashToken("test-raw")
	if h1 != h2 {
		t.Error("hashToken should be deterministic")
	}

	// Different inputs produce different hashes.
	h3 := hashToken("other-raw")
	if h1 == h3 {
		t.Error("different inputs should produce different hashes")
	}

	if h1 == "" {
		t.Error("hash should not be empty")
	}
}

func TestCreateInvite(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	inv, err := env.svc.CreateInvite(ctx, "inviter-1", "invitee@example.com", []string{"ch1", "ch2"})
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if inv.Token == "" {
		t.Error("expected non-empty invite token")
	}
	if inv.Email != "invitee@example.com" {
		t.Errorf("Email = %q, want %q", inv.Email, "invitee@example.com")
	}
	if inv.InviterID != "inviter-1" {
		t.Errorf("InviterID = %q, want %q", inv.InviterID, "inviter-1")
	}
	if len(inv.ChannelIDs) != 2 {
		t.Errorf("ChannelIDs len = %d, want 2", len(inv.ChannelIDs))
	}
}

func TestIssueTokens(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	user := &model.User{
		ID:          "user-issue",
		Email:       "issue@example.com",
		DisplayName: "Issue User",
		SystemRole:  model.SystemRoleMember,
	}

	accessToken, refreshRaw, err := env.svc.issueTokens(ctx, user)
	if err != nil {
		t.Fatalf("issueTokens: %v", err)
	}
	if accessToken == "" {
		t.Error("expected non-empty accessToken")
	}
	if refreshRaw == "" {
		t.Error("expected non-empty refreshRaw")
	}

	// Verify refresh token was stored.
	if len(env.tokens.tokens) == 0 {
		t.Error("expected refresh token to be stored")
	}
}
