package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"golang.org/x/crypto/bcrypt"
)

// seqJWT issues a distinct refresh token per call (the shared mock hands out
// one fixed value), so rotation chains and families can be modeled.
type seqJWT struct {
	mu sync.Mutex
	n  int
}

func (j *seqJWT) GenerateAccessToken(u *model.User) (string, error) {
	return "access-" + u.ID, nil
}

func (j *seqJWT) GenerateRefreshToken() (string, string, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.n++
	raw := fmt.Sprintf("refresh-raw-%d", j.n)
	return raw, hashToken(raw), nil
}

func (j *seqJWT) RefreshTTL() time.Duration { return 720 * time.Hour }

func setupSecurityAuth(t *testing.T) *authTestEnv {
	t.Helper()
	env := setupAuthService()
	env.svc.jwt = &seqJWT{}
	return env
}

// seedAdmin adds a system admin — the only role allowed to invite.
func seedAdmin(env *authTestEnv, id string) {
	addUser(env, &model.User{ID: id, Email: id + "@example.com", DisplayName: "Admin " + id, SystemRole: model.SystemRoleAdmin, AuthProvider: model.AuthProviderOIDC})
}

func addUser(env *authTestEnv, u *model.User) *model.User {
	if u.Status == "" {
		u.Status = "active"
	}
	env.users.users[u.ID] = u
	env.users.emailIndex[u.Email] = u
	return u
}

// ---------------------------------------------------------------- finding 5

// Regression: replaying a rotated token whose successor chain is live is
// detected — but only the presented token was deleted, so the chain's live
// head (possibly the attacker's) kept working. The whole family goes.
func TestRefreshReplayRevokesTheWholeFamily(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	u := addUser(env, &model.User{ID: "u-fam", Email: "fam@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	_, rt1, err := env.svc.issueTokens(ctx, u)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	_, rt2, err := env.svc.RefreshAccessToken(ctx, rt1)
	if err != nil {
		t.Fatalf("refresh rt1: %v", err)
	}
	_, rt3, err := env.svc.RefreshAccessToken(ctx, rt2)
	if err != nil {
		t.Fatalf("refresh rt2: %v", err)
	}
	// rt1 is replayed after its successor rt2 was used: two parties hold the
	// session.
	if _, _, err := env.svc.RefreshAccessToken(ctx, rt1); err == nil {
		t.Fatal("replay of rt1 must be refused")
	}
	if _, _, err := env.svc.RefreshAccessToken(ctx, rt3); err == nil {
		t.Fatal("the live head of a replayed family must be revoked too")
	}
}

// Regression: logout deleted only the current row; the rotated predecessor
// (kept for the lost-response grace) then found its successor gone, counted
// it as "never used" and minted a fresh session.
func TestLogoutRevokesTheWholeFamily(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	u := addUser(env, &model.User{ID: "u-out", Email: "out@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	_, rt1, _ := env.svc.issueTokens(ctx, u)
	_, rt2, err := env.svc.RefreshAccessToken(ctx, rt1)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if err := env.svc.Logout(ctx, rt2); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, _, err := env.svc.RefreshAccessToken(ctx, rt1); err == nil {
		t.Fatal("a rotated predecessor must not resurrect a logged-out session")
	}
}

// Another login of the same user is another family and survives.
func TestLogoutLeavesOtherSessionsAlone(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	u := addUser(env, &model.User{ID: "u-two", Email: "two@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	_, laptop, _ := env.svc.issueTokens(ctx, u)
	_, phone, _ := env.svc.issueTokens(ctx, u)
	if err := env.svc.Logout(ctx, laptop); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if _, _, err := env.svc.RefreshAccessToken(ctx, phone); err != nil {
		t.Fatalf("the other device's session must survive: %v", err)
	}
}

// ---------------------------------------------------------------- finding 2

// Regression: refresh never looked at the account status, so a deactivated
// account kept minting access tokens from a surviving refresh token.
func TestRefreshRefusesADeactivatedAccount(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	u := addUser(env, &model.User{ID: "u-off", Email: "off@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	_, rt, _ := env.svc.issueTokens(ctx, u)
	u.Status = "deactivated"
	if _, _, err := env.svc.RefreshAccessToken(ctx, rt); err == nil {
		t.Fatal("refresh of a deactivated account must be refused")
	}
}

// Regression: an SSO login into a deactivated account updated the profile
// and handed out fresh tokens.
func TestOIDCLoginRefusesADeactivatedAccount(t *testing.T) {
	env := setupSecurityAuth(t)
	addUser(env, &model.User{ID: "u-sso-off", Email: "oidc@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC, Status: "deactivated"})
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err == nil {
		t.Fatal("SSO login of a deactivated account must be refused")
	}
	if len(env.tokens.tokens) != 0 {
		t.Fatalf("no refresh token may be stored for a refused login, got %d", len(env.tokens.tokens))
	}
}

// Regression: only guests could be deactivated, so an SSO account could not
// be revoked at all short of the 12-hourly directory sweep.
func TestAdminCanDeactivateAnSSOAccount(t *testing.T) {
	users := newMockUserStore()
	tokens := newMockTokenStore()
	svc := NewUserService(users, nil, nil, &mockPublisher{})
	svc.SetTokenStore(tokens)
	users.users["u-sso"] = &model.User{ID: "u-sso", Email: "sso@example.com", Status: "active", AuthProvider: model.AuthProviderOIDC, SystemRole: model.SystemRoleMember}
	tokens.tokens["h"] = &model.RefreshToken{TokenHash: "h", UserID: "u-sso"}
	got, err := svc.SetStatus(context.Background(), "u-sso", true)
	if err != nil {
		t.Fatalf("deactivate SSO account: %v", err)
	}
	if got.Status != "deactivated" || users.users["u-sso"].Status != "deactivated" {
		t.Fatalf("status = %q, want deactivated", users.users["u-sso"].Status)
	}
	if len(tokens.tokens) != 0 {
		t.Fatal("deactivation must revoke the account's refresh tokens")
	}
	if _, err := svc.SetStatus(context.Background(), "u-sso", false); err != nil || users.users["u-sso"].Status != "active" {
		t.Fatalf("reactivate SSO account: err=%v status=%q", err, users.users["u-sso"].Status)
	}
}

// Regression: deactivation ignored a failed token revocation and reported
// success — leaving live credentials behind for an account the admin
// believes is locked out.
func TestDeactivationFailsLoudlyWhenRevocationFails(t *testing.T) {
	users := newMockUserStore()
	tokens := newMockTokenStore()
	tokens.deleteErr = errors.New("throttled")
	svc := NewUserService(users, nil, nil, &mockPublisher{})
	svc.SetTokenStore(tokens)
	users.users["g-1"] = &model.User{ID: "g-1", Email: "g@example.com", Status: "active", AuthProvider: model.AuthProviderGuest, SystemRole: model.SystemRoleGuest}
	if _, err := svc.SetStatus(context.Background(), "g-1", true); err == nil {
		t.Fatal("a failed refresh-token revocation must fail the deactivation")
	}
	runners := &rtFakeRevoker{err: errors.New("runner store down")}
	tokens.deleteErr = nil
	svc.SetRunnerRevoker(runners)
	if _, err := svc.SetStatus(context.Background(), "g-1", true); err == nil {
		t.Fatal("a failed runner revocation must fail the deactivation")
	}
}

// ---------------------------------------------------------------- finding 1

// Regression: any authenticated user — a guest included — could invite any
// address, and the invite token came back to them.
func TestCreateInviteIsAdminOnly(t *testing.T) {
	env := setupSecurityAuth(t)
	for _, role := range []model.SystemRole{model.SystemRoleGuest, model.SystemRoleMember} {
		addUser(env, &model.User{ID: "inv-" + string(role), Email: string(role) + "@example.com", SystemRole: role})
		if _, err := env.svc.CreateInvite(context.Background(), "inv-"+string(role), "new.employee@example.com", nil); err == nil {
			t.Fatalf("a %s must not be able to create invites", role)
		}
	}
	addUser(env, &model.User{ID: "inv-admin", Email: "admin@example.com", SystemRole: model.SystemRoleAdmin})
	if _, err := env.svc.CreateInvite(context.Background(), "inv-admin", "new.employee@example.com", nil); err != nil {
		t.Fatalf("an admin invites: %v", err)
	}
}

// Regression (pre-account takeover): someone who accepted an invite for an
// employee's not-yet-registered address set their own password; when the
// employee later signed in through SSO, the account kept that password and
// the claimer's sessions. An SSO login converts the account and evicts them.
func TestOIDCLoginEvictsWhoeverClaimedTheAddressWithAPassword(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	runners := &rtFakeRevoker{}
	env.svc.SetRunnerRevoker(runners)
	env.invites.invites["tok"] = &model.Invite{Token: "tok", Email: "oidc@example.com", InviterID: "admin", ExpiresAt: time.Now().Add(time.Hour)}
	_, claimerRefresh, claimed, err := env.svc.AcceptInvite(ctx, "tok", "Not The Employee", "attacker-password")
	if err != nil {
		t.Fatalf("accept invite: %v", err)
	}

	_, _, user, err := env.svc.HandleOIDCCallback(ctx, "code", "state", "nonce")
	if err != nil {
		t.Fatalf("employee SSO login: %v", err)
	}
	if user.ID != claimed.ID {
		t.Fatalf("SSO login landed on a different account")
	}
	stored := env.users.users[claimed.ID]
	if stored.AuthProvider != model.AuthProviderOIDC || stored.PasswordHash != "" {
		t.Fatalf("account still password-managed: provider=%q hash=%q", stored.AuthProvider, stored.PasswordHash)
	}
	if _, _, err := env.svc.RefreshAccessToken(ctx, claimerRefresh); err == nil {
		t.Fatal("the claimer's session must be revoked")
	}
	if _, _, _, err := env.svc.GuestLogin(ctx, "oidc@example.com", "attacker-password"); err == nil {
		t.Fatal("the claimer's password must no longer work")
	}
	if len(runners.revoked) != 1 || runners.revoked[0] != claimed.ID {
		t.Fatalf("the claimer's runners must be disconnected, got %v", runners.revoked)
	}
}

// ---------------------------------------------------------------- finding 4

func TestOIDCLoginBindsTheIdentityAndRefusesAnother(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	u := addUser(env, &model.User{ID: "u-bind", Email: "oidc@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	if _, _, _, err := env.svc.HandleOIDCCallback(ctx, "code", "state", "nonce"); err != nil {
		t.Fatalf("first login: %v", err)
	}
	if u.OIDCIssuer != "https://idp.example.com" || u.OIDCSubject != "sub-oidc" {
		t.Fatalf("identity not bound: %q/%q", u.OIDCIssuer, u.OIDCSubject)
	}
	// Same address, another identity (a recycled or re-pointed mailbox).
	env.oidc.userInfo.Subject = "sub-someone-else"
	if _, _, _, err := env.svc.HandleOIDCCallback(ctx, "code", "state", "nonce"); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("other subject = %v, want ErrIdentityMismatch", err)
	}
	env.oidc.userInfo.Subject = "sub-oidc"
	env.oidc.userInfo.Issuer = "https://other-idp.example.com"
	if _, _, _, err := env.svc.HandleOIDCCallback(ctx, "code", "state", "nonce"); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("other issuer = %v, want ErrIdentityMismatch", err)
	}
	if u.OIDCSubject != "sub-oidc" || u.OIDCIssuer != "https://idp.example.com" {
		t.Fatalf("a refused login rebound the account: %q/%q", u.OIDCIssuer, u.OIDCSubject)
	}
}

// A re-keyed `sub` (new app registration, new issuer URL) with the SAME
// pinned directory object id is still the same person: the account re-binds.
func TestOIDCLoginRebindsOnAMatchingObjectID(t *testing.T) {
	env := setupSecurityAuth(t)
	u := addUser(env, &model.User{ID: "u-rekey", Email: "oidc@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC,
		MSObjectID: "oid-1", OIDCIssuer: "https://old-issuer.example.com", OIDCSubject: "old-sub"})
	env.oidc.userInfo.ObjectID = "oid-1"
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err != nil {
		t.Fatalf("login with the pinned oid: %v", err)
	}
	if u.OIDCSubject != "sub-oidc" || u.OIDCIssuer != "https://idp.example.com" {
		t.Fatalf("identity not re-bound: %q/%q", u.OIDCIssuer, u.OIDCSubject)
	}
}

func TestOIDCLoginRefusesATokenWithoutSubject(t *testing.T) {
	env := setupSecurityAuth(t)
	env.oidc.userInfo.Subject = ""
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("no subject = %v, want ErrIdentityMismatch", err)
	}
}

func TestOIDCLoginEmailVerifiedClaim(t *testing.T) {
	no, yes := false, true
	env := setupSecurityAuth(t)
	env.oidc.userInfo.EmailVerified = &no
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); !errors.Is(err, ErrEmailUnverified) {
		t.Fatalf("email_verified=false = %v, want ErrEmailUnverified", err)
	}
	env.oidc.userInfo.EmailVerified = &yes
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err != nil {
		t.Fatalf("email_verified=true: %v", err)
	}
}

func TestOIDCLoginAllowedEmailDomains(t *testing.T) {
	env := setupSecurityAuth(t)
	env.svc.SetAllowedEmailDomains([]string{" Corp.Example ", ""})
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); !errors.Is(err, ErrEmailDomainNotAllowed) {
		t.Fatalf("outside domain = %v, want ErrEmailDomainNotAllowed", err)
	}
	if len(env.users.users) != 0 {
		t.Fatal("no account may be created for a refused domain")
	}
	env.oidc.userInfo.Email = "dev@corp.example"
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err != nil {
		t.Fatalf("allowed domain: %v", err)
	}
	env.svc.SetAllowedEmailDomains(nil)
	env.oidc.userInfo.Email = "oidc@example.com"
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err != nil {
		t.Fatalf("no allowlist: %v", err)
	}
}

// Two logins racing to bind different identities: the loser's
// compare-and-swap fails and the login is refused.
func TestOIDCLoginLosesAConcurrentBind(t *testing.T) {
	env := setupSecurityAuth(t)
	addUser(env, &model.User{ID: "u-cas", Email: "oidc@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	st := &staleEmailStore{mockUserStore: env.users, afterRead: func() {
		env.users.users["u-cas"].OIDCSubject = "sub-winner"
	}}
	env.svc.users = st
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("lost bind = %v, want ErrIdentityMismatch", err)
	}
}

// staleEmailStore copies on GetUserByEmail and runs afterRead in the window.
type staleEmailStore struct {
	*mockUserStore
	afterRead func()
}

func (s *staleEmailStore) GetUserByEmail(ctx context.Context, email string) (*model.User, error) {
	u, err := s.mockUserStore.GetUserByEmail(ctx, email)
	if err != nil {
		return nil, err
	}
	cp := *u
	s.afterRead()
	return &cp, nil
}

func TestOIDCLoginPatchFailure(t *testing.T) {
	env := setupSecurityAuth(t)
	addUser(env, &model.User{ID: "u-pf", Email: "oidc@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	env.users.updateErr = errors.New("dynamo down")
	_, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce")
	if err == nil || errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("patch failure = %v, want a plain update error", err)
	}
}

// The first verified oid pins an account that has none yet.
func TestOIDCLoginPinsTheTokenObjectID(t *testing.T) {
	env := setupSecurityAuth(t)
	u := addUser(env, &model.User{ID: "u-pin", Email: "oidc@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	env.oidc.userInfo.ObjectID = "oid-token"
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if u.MSObjectID != "oid-token" {
		t.Fatalf("MSObjectID = %q, want the token's oid pinned", u.MSObjectID)
	}
}

// The directory's object id fills an empty pin when the token has none.
func TestOIDCLoginPinsTheDirectoryObjectID(t *testing.T) {
	env := setupSecurityAuth(t)
	u := addUser(env, &model.User{ID: "u-dir", Email: "oidc@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	env.svc.SetDirectory(&stubDirectoryLookup{profile: &DirectoryProfile{Phone: "+46 1", ObjectID: "oid-dir"}})
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if u.MSObjectID != "oid-dir" || u.Phone != "+46 1" {
		t.Fatalf("user = oid %q phone %q, want the directory's", u.MSObjectID, u.Phone)
	}
}

// Converting a password account must not hand out an SSO session while the
// password holder's sessions survive: any failure in the eviction fails the
// login, and the next login retries it.
func TestOIDCConversionFailuresFailTheLogin(t *testing.T) {
	seedGuest := func(env *authTestEnv) *model.User {
		return addUser(env, &model.User{ID: "u-claimed", Email: "oidc@example.com", SystemRole: model.SystemRoleGuest, AuthProvider: model.AuthProviderGuest, PasswordHash: "hash"})
	}
	t.Run("session revocation", func(t *testing.T) {
		env := setupSecurityAuth(t)
		u := seedGuest(env)
		env.tokens.deleteAllErr = errors.New("throttled")
		if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err == nil {
			t.Fatal("a failed session revocation must fail the login")
		}
		if u.AuthProvider != model.AuthProviderGuest || u.PasswordHash != "" {
			t.Fatalf("provider=%q hash=%q: the password must be gone and the conversion left to retry", u.AuthProvider, u.PasswordHash)
		}
		env.tokens.deleteAllErr = nil
		if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err != nil || u.AuthProvider != model.AuthProviderOIDC {
			t.Fatalf("retry: err=%v provider=%q", err, u.AuthProvider)
		}
	})
	t.Run("runner revocation", func(t *testing.T) {
		env := setupSecurityAuth(t)
		seedGuest(env)
		env.svc.SetRunnerRevoker(&rtFakeRevoker{err: errors.New("runner store down")})
		if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err == nil {
			t.Fatal("a failed runner revocation must fail the login")
		}
	})
	t.Run("clearing the password", func(t *testing.T) {
		env := setupSecurityAuth(t)
		seedGuest(env)
		env.users.updateErr = errors.New("dynamo down")
		if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err == nil {
			t.Fatal("a failed password wipe must fail the login")
		}
	})
}

// ---------------------------------------------------------------- finding 2: session lifetime

func TestRefreshRefusesASessionPastItsMaximumAge(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	env.svc.SetSessionMaxAge(time.Hour)
	addUser(env, &model.User{ID: "u-old", Email: "old@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	loggedIn := time.Now().Add(-2 * time.Hour)
	raw := "old-session"
	env.tokens.tokens[hashToken(raw)] = &model.RefreshToken{TokenHash: hashToken(raw), UserID: "u-old", FamilyID: "fam-old",
		AuthTime: &loggedIn, CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}
	env.tokens.tokens["sibling"] = &model.RefreshToken{TokenHash: "sibling", UserID: "u-old", FamilyID: "fam-old", ExpiresAt: time.Now().Add(time.Hour)}
	if _, _, err := env.svc.RefreshAccessToken(ctx, raw); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("old session = %v, want ErrSessionInvalid", err)
	}
	if len(env.tokens.tokens) != 0 {
		t.Fatalf("the expired session's family must be revoked, %d tokens left", len(env.tokens.tokens))
	}
}

// Rotation carries the login time; the successor never outlives the
// session's absolute bound.
func TestRefreshCarriesTheLoginTimeAndCapsExpiry(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	env.svc.SetSessionMaxAge(48 * time.Hour)
	u := addUser(env, &model.User{ID: "u-cap", Email: "cap@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	_, rt1, _ := env.svc.issueTokens(ctx, u)
	first := env.tokens.tokens[hashToken(rt1)]
	if !first.ExpiresAt.Equal(first.AuthTime.Add(48 * time.Hour)) {
		t.Fatalf("login token expiry %v, want capped at login+48h", first.ExpiresAt)
	}
	_, rt2, err := env.svc.RefreshAccessToken(ctx, rt1)
	if err != nil {
		t.Fatalf("refresh: %v", err)
	}
	second := env.tokens.tokens[hashToken(rt2)]
	if second.FamilyID != first.FamilyID || !second.AuthTime.Equal(*first.AuthTime) {
		t.Fatalf("successor family/auth time = %q/%v, want %q/%v", second.FamilyID, second.AuthTime, first.FamilyID, first.AuthTime)
	}
	if !second.ExpiresAt.Equal(first.AuthTime.Add(48 * time.Hour)) {
		t.Fatalf("successor expiry %v, want capped at login+48h", second.ExpiresAt)
	}

	// A bound longer than the TTL leaves the TTL in charge.
	env.svc.SetSessionMaxAge(10000 * time.Hour)
	_, rt3, _ := env.svc.issueTokens(ctx, u)
	third := env.tokens.tokens[hashToken(rt3)]
	if !third.ExpiresAt.Equal(third.AuthTime.Add(720 * time.Hour)) {
		t.Fatalf("expiry %v, want login+TTL", third.ExpiresAt)
	}
}

// A token minted before families existed is its family's root: its
// successors carry its hash, a replay revokes them, and its creation time
// stands in for the login time.
func TestRefreshOfALegacyToken(t *testing.T) {
	env := setupSecurityAuth(t)
	ctx := context.Background()
	addUser(env, &model.User{ID: "u-legacy", Email: "legacy@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC})
	created := time.Now().Add(-time.Hour)
	raw := "legacy-raw"
	root := hashToken(raw)
	env.tokens.tokens[root] = &model.RefreshToken{TokenHash: root, UserID: "u-legacy", CreatedAt: created, ExpiresAt: time.Now().Add(time.Hour)}
	_, rt2, err := env.svc.RefreshAccessToken(ctx, raw)
	if err != nil {
		t.Fatalf("refresh legacy: %v", err)
	}
	succ := env.tokens.tokens[hashToken(rt2)]
	if succ.FamilyID != root || !succ.AuthTime.Equal(created) {
		t.Fatalf("successor = family %q auth %v, want %q/%v", succ.FamilyID, succ.AuthTime, root, created)
	}
	_, _, _ = env.svc.RefreshAccessToken(ctx, rt2) // successor used
	if _, _, err := env.svc.RefreshAccessToken(ctx, raw); !errors.Is(err, ErrSessionInvalid) {
		t.Fatalf("legacy replay = %v, want ErrSessionInvalid", err)
	}
	if len(env.tokens.tokens) != 0 {
		t.Fatalf("legacy family not revoked: %d tokens left", len(env.tokens.tokens))
	}
}

func TestGuestLoginRefusesADeactivatedAccount(t *testing.T) {
	env := setupSecurityAuth(t)
	hashed, _ := bcrypt.GenerateFromPassword([]byte("guest-password"), bcrypt.MinCost)
	addUser(env, &model.User{ID: "g-off", Email: "off@example.com", SystemRole: model.SystemRoleGuest, AuthProvider: model.AuthProviderGuest, PasswordHash: string(hashed), Status: "deactivated"})
	if _, _, _, err := env.svc.GuestLogin(context.Background(), "off@example.com", "guest-password"); !errors.Is(err, ErrAccountDeactivated) {
		t.Fatalf("deactivated guest login = %v, want ErrAccountDeactivated", err)
	}
}
