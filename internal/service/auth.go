package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/limits"

	"github.com/DigitalTolk/ex/internal/email"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/crypto/bcrypt"
)

// generalChannelID is a deterministic ULID derived from the name "general"
// so it's consistent across all instances without coordination.
var generalChannelID = store.DeriveID("channel:general")

// randRead is a seam over crypto/rand.Read so tests can exercise the
// (otherwise unreachable) CSPRNG-failure branches.
var randRead = rand.Read

// ChannelJoiner is the subset of ChannelService that auth flows use to
// auto-join users to channels (e.g. #general on signup, channels listed on
// an invite). Defined as an interface so AuthService stays testable without
// pulling in the full ChannelService.
type ChannelJoiner interface {
	AutoJoinChannel(ctx context.Context, userID, channelID string, role model.ChannelRole) error
}

// AuthService handles authentication, token management, and invitations.
type AuthService struct {
	users        UserStore
	tokens       TokenStore
	invites      InviteStore
	memberships  MembershipStore
	channelStore ChannelStore
	joiner       ChannelJoiner // optional: when set, channel joins post system messages
	jwt          JWTProvider
	oidc         OIDCProvider // may be nil when OIDC is not configured
	cache        Cache
	indexer      UserIndexer
	// directory, when set, enriches OIDC logins with employee-directory
	// attributes (phone + manager). Lookups are fail-open: an outage
	// degrades to an un-enriched login.
	directory DirectoryLookup
	// publisher broadcasts user.updated when a login-time directory sync
	// changes an existing profile, so open clients refresh it live.
	publisher Publisher
	// resets stores single-use password-reset tickets (guest accounts only).
	// Nil when unwired — see password_reset.go.
	resets PasswordResetStore
	// runners, when set, disconnects the account's ex-runners on password
	// reset, alongside the refresh tokens.
	runners RunnerRevoker
	// mailer delivers transactional email (invites, password resets). Nil
	// when SMTP is unconfigured: links are still minted and returned to the
	// caller, they just aren't delivered.
	mailer email.Sender
	// baseURL is the public origin used to build links inside emails.
	baseURL string
	// guestLoginAnyRole lifts GuestLogin's role gate (dev stacks only, where
	// OIDC isn't configured and password login is the only path). Off by
	// default; see SetGuestLoginAnyRole.
	guestLoginAnyRole bool
	// sessionMaxAge bounds a session's absolute lifetime: no refresh is
	// honored once this long has passed since the user authenticated,
	// however often the session rotated. Zero disables the bound.
	sessionMaxAge time.Duration
	// allowedEmailDomains, when non-empty, restricts SSO sign-in (account
	// creation included) to these lower-cased email domains.
	allowedEmailDomains map[string]bool
	// background runs work that must not hold up the caller's response
	// (the self-service password-reset mail). safe.Go in production; tests
	// substitute a recorder.
	background func(func())
}

// SetBackgroundRunner replaces how detached work (the self-service reset
// mail) is started — safe.Go by default. A caller that must observe that
// work synchronously (tests, a CLI) passes a runner that calls fn inline.
func (s *AuthService) SetBackgroundRunner(run func(fn func())) { s.background = run }

// SetSessionMaxAge sets the absolute session lifetime (SESSION_MAX_AGE).
func (s *AuthService) SetSessionMaxAge(d time.Duration) { s.sessionMaxAge = d }

// SetAllowedEmailDomains restricts SSO sign-in to the given email domains
// (OIDC_ALLOWED_EMAIL_DOMAINS). Empty allows every domain the IdP vouches
// for.
func (s *AuthService) SetAllowedEmailDomains(domains []string) {
	s.allowedEmailDomains = nil
	for _, d := range domains {
		if d = strings.ToLower(strings.TrimSpace(d)); d != "" {
			if s.allowedEmailDomains == nil {
				s.allowedEmailDomains = map[string]bool{}
			}
			s.allowedEmailDomains[d] = true
		}
	}
}

// Errors the auth flows surface to their (often unauthenticated) callers.
// Each carries a fixed message; handlers map them to fixed responses and
// never echo an internal error's text.
var (
	ErrInvalidCredentials = errors.New("auth: invalid credentials")
	// ErrSessionInvalid covers an unknown, expired, replayed or revoked
	// refresh token, and a session past its absolute lifetime.
	ErrSessionInvalid = errors.New("auth: session is no longer valid")
	// ErrAccountDeactivated refuses every sign-in path for a deactivated
	// account.
	ErrAccountDeactivated = errors.New("auth: this account is deactivated")
	// ErrIdentityMismatch refuses an SSO login whose verified identity
	// (issuer + subject, or the directory object id) differs from the one
	// the account is bound to.
	ErrIdentityMismatch = errors.New("auth: this sign-in does not match the account's identity")
	// ErrEmailUnverified refuses an SSO login whose provider explicitly
	// says the email address is not verified.
	ErrEmailUnverified = errors.New("auth: the identity provider has not verified this email address")
	// ErrEmailDomainNotAllowed refuses an SSO login outside
	// OIDC_ALLOWED_EMAIL_DOMAINS.
	ErrEmailDomainNotAllowed = errors.New("auth: this email domain may not sign in")
	// ErrInviteForbidden refuses an invite from anyone but a system admin.
	ErrInviteForbidden = fmt.Errorf("auth: only admins can invite: %w", ErrForbidden)
	// ErrInviteInvalid covers an unknown or expired invite.
	ErrInviteInvalid = errors.New("auth: this invite is invalid or has expired")
	// ErrInvalidDisplayName / ErrInvalidPassword are the invite form's
	// validation failures.
	ErrInvalidDisplayName = fmt.Errorf("auth: display name must be 1-%d characters", maxDisplayNameLen)
	ErrInvalidPassword    = fmt.Errorf("auth: password must be at least %d characters", minGuestPasswordLen)
	// ErrAccountExists refuses an invite for an address that already has an
	// account.
	ErrAccountExists = errors.New("auth: an account with this email already exists")
	// ErrDesktopAuthInvalid refuses a desktop sign-in code that is missing,
	// unknown, expired or already redeemed.
	ErrDesktopAuthInvalid = errors.New("auth: desktop auth code expired or invalid")
)

// SetGuestLoginAnyRole allows password login for non-guest roles. Intended
// ONLY for local dev (GUEST_LOGIN_ANY_ROLE=true in the compose overlay):
// production users authenticate via OIDC and carry no password hash, so even
// misconfigured this cannot log an SSO account in — but keep it off anyway.
func (s *AuthService) SetGuestLoginAnyRole(v bool) { s.guestLoginAnyRole = v }

const (
	minGuestPasswordLen = 8
	maxGuestPasswordLen = 1024
	maxDisplayNameLen   = limits.MaxDisplayNameChars
	desktopAuthCodeTTL  = 2 * time.Minute
)

// DesktopAuthSession is what a one-time desktop code redeems for: the
// refresh token /auth/desktop/complete sets as the first-party cookie. The
// access token is never carried — the app obtains one by refreshing.
type DesktopAuthSession struct {
	RefreshToken string `json:"refreshToken"`
}

// NewAuthService creates an AuthService with the given dependencies.
func NewAuthService(
	users UserStore,
	tokens TokenStore,
	invites InviteStore,
	memberships MembershipStore,
	channelStore ChannelStore,
	jwt JWTProvider,
	oidc OIDCProvider,
	cache Cache,
) *AuthService {
	return &AuthService{
		users:        users,
		tokens:       tokens,
		invites:      invites,
		memberships:  memberships,
		channelStore: channelStore,
		jwt:          jwt,
		oidc:         oidc,
		cache:        cache,
		background:   safe.Go,
	}
}

// SetChannelJoiner wires the ChannelService for auto-join behavior so signup
// and invite-accept flows publish member.joined events and system messages.
// Called from the app wiring (internal/app) after ChannelService is constructed (avoids
// constructor cycle).
func (s *AuthService) SetChannelJoiner(j ChannelJoiner) { s.joiner = j }

func (s *AuthService) SetIndexer(i UserIndexer) { s.indexer = i }

// SetDirectory wires the employee-directory lookup (Microsoft Graph) used to
// enrich OIDC logins with phone + manager. Optional; nil disables enrichment.
func (s *AuthService) SetDirectory(d DirectoryLookup) { s.directory = d }

// SetPublisher wires the event publisher used to broadcast user.updated when
// a directory sync changes a profile. Optional.
func (s *AuthService) SetPublisher(p Publisher) { s.publisher = p }

func (s *AuthService) indexUser(ctx context.Context, u *model.User) {
	IndexUser(ctx, s.indexer, u)
}

// HandleOIDCLogin generates a random state string and returns the OIDC
// provider's authorization URL. The caller is responsible for storing the
// state in an HTTP-only cookie.
func (s *AuthService) HandleOIDCLogin() (authURL, state, nonce string, err error) {
	if s.oidc == nil {
		return "", "", "", errors.New("auth: OIDC is not configured")
	}

	b := make([]byte, 32)
	if _, err := randRead(b); err != nil {
		return "", "", "", fmt.Errorf("auth: generate state: %w", err)
	}
	state = hex.EncodeToString(b[:16])
	// A nonce is bound into the auth request and verified against the returned
	// ID token's nonce claim, preventing ID-token replay/injection.
	nonce = hex.EncodeToString(b[16:])
	authURL = s.oidc.AuthURL(state, nonce)
	return authURL, state, nonce, nil
}

// HandleOIDCCallback exchanges the authorization code for tokens,
// upserts the user (creating with SystemRoleMember if new), generates
// an access/refresh token pair, and stores the refresh token.
//
// The account is bound to the provider's verified identity, not just the
// email claim: the first login records issuer + subject, and a later login
// presenting a different identity for the same address is refused (as is
// one whose directory object id contradicts the pinned one). A guest
// (password) account at the address is converted to SSO — its password is
// cleared and every session and runner it had is revoked — so whoever
// claimed an employee's address through an invite loses it the moment the
// employee signs in.
func (s *AuthService) HandleOIDCCallback(ctx context.Context, code, state, nonce string) (accessToken, refreshTokenRaw string, user *model.User, err error) {
	if s.oidc == nil {
		return "", "", nil, errors.New("auth: OIDC is not configured")
	}

	info, err := s.oidc.Exchange(ctx, code, nonce)
	if err != nil {
		return "", "", nil, fmt.Errorf("auth: oidc exchange: %w", err)
	}
	email, err := normalizeEmailAddress(info.Email)
	if err != nil {
		return "", "", nil, err
	}
	if info.Subject == "" {
		return "", "", nil, fmt.Errorf("auth: id token carries no subject: %w", ErrIdentityMismatch)
	}
	if info.EmailVerified != nil && !*info.EmailVerified {
		return "", "", nil, ErrEmailUnverified
	}
	if !s.emailDomainAllowed(email) {
		return "", "", nil, ErrEmailDomainNotAllowed
	}

	// Look up the user by email; create if not found.
	user, err = s.users.GetUserByEmail(ctx, email)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return "", "", nil, fmt.Errorf("auth: get user by email: %w", err)
		}
		user, err = s.createOIDCUser(ctx, email, info)
		if err != nil {
			return "", "", nil, err
		}
	} else if err := s.refreshOIDCUser(ctx, user, info); err != nil {
		return "", "", nil, err
	}

	// Ensure #general exists and the user is a member.
	s.ensureGeneralChannel(ctx, user)

	accessToken, refreshTokenRaw, err = s.issueTokens(ctx, user)
	if err != nil {
		return "", "", nil, err
	}
	return accessToken, refreshTokenRaw, user, nil
}

// lookupDirectory enriches an SSO login with employee-directory attributes
// (phone + manager). Fail-open: a directory outage must degrade to an
// un-enriched login, never block it.
func (s *AuthService) lookupDirectory(ctx context.Context, email, objectID string) *DirectoryProfile {
	if s.directory == nil {
		return nil
	}
	dp, err := s.directory.LookupProfile(ctx, email, objectID)
	if err != nil {
		slog.WarnContext(ctx, "auth: directory profile lookup failed; continuing login without enrichment", "error", err)
		return nil
	}
	return dp
}

func (s *AuthService) createOIDCUser(ctx context.Context, email string, info *OIDCUserInfo) (*model.User, error) {
	// First user to log in becomes admin.
	role := model.SystemRoleMember
	hasUsers, err := s.users.HasUsers(ctx)
	if err != nil {
		return nil, fmt.Errorf("auth: check existing users: %w", err)
	}
	if !hasUsers {
		role = model.SystemRoleAdmin
	}

	now := time.Now()
	ns := model.DefaultNotificationSettingsForNewUser(info.Name)
	user := &model.User{
		ID:                   store.NewID(),
		Email:                email,
		DisplayName:          info.Name,
		AvatarURL:            info.Picture,
		SystemRole:           role,
		AuthProvider:         model.AuthProviderOIDC,
		NotificationSettings: &ns,
		Status:               "active",
		LastSeenAt:           &now,
		CreatedAt:            now,
		UpdatedAt:            now,
		MSObjectID:           info.ObjectID,
		OIDCIssuer:           info.Issuer,
		OIDCSubject:          info.Subject,
	}
	applyDirectoryProfile(user, s.lookupDirectory(ctx, email, info.ObjectID))
	if err := s.users.CreateUser(ctx, user); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return nil, ErrAccountExists
		}
		return nil, fmt.Errorf("auth: create user: %w", err)
	}
	s.indexUser(ctx, user)
	return user, nil
}

// refreshOIDCUser checks an existing account against the login's identity,
// converts a password account to SSO, and writes the IdP-owned profile
// fields with a field-level patch (a full put could resurrect a concurrent
// deactivation or demotion).
func (s *AuthService) refreshOIDCUser(ctx context.Context, user *model.User, info *OIDCUserInfo) error {
	if user.Status == "deactivated" {
		return ErrAccountDeactivated
	}
	if user.MSObjectID != "" && info.ObjectID != "" && user.MSObjectID != info.ObjectID {
		slog.WarnContext(ctx, "auth: SSO login refused — directory object id differs from the account's", "userID", user.ID)
		return ErrIdentityMismatch
	}
	boundTo := user.OIDCSubject
	if boundTo != "" && (boundTo != info.Subject || user.OIDCIssuer != info.Issuer) {
		// The pinned directory object id is the one stable cross-check: a
		// changed app registration or issuer URL re-keys `sub` for everyone,
		// and the same verified `oid` proves it is still the same person.
		if user.MSObjectID == "" || info.ObjectID != user.MSObjectID {
			slog.WarnContext(ctx, "auth: SSO login refused — identity differs from the one bound to the account", "userID", user.ID)
			return ErrIdentityMismatch
		}
		slog.WarnContext(ctx, "auth: SSO identity re-bound on a matching directory object id", "userID", user.ID)
	}

	now := time.Now()
	patch := store.UserPatch{
		DisplayName:       &info.Name,
		LastSeenAt:        &now,
		UpdatedAt:         now,
		OIDCIssuer:        &info.Issuer,
		OIDCSubject:       &info.Subject,
		ExpectOIDCSubject: &boundTo,
	}
	if user.MSObjectID == "" && info.ObjectID != "" {
		patch.MSObjectID = &info.ObjectID
	}
	dirProfile := s.lookupDirectory(ctx, user.Email, info.ObjectID)
	directoryChanged := dirProfile != nil &&
		(user.Phone != dirProfile.Phone || !user.Manager.Equal(dirProfile.Manager))
	if dirProfile != nil {
		patch.Directory = &store.UserDirectoryFields{Phone: dirProfile.Phone, Manager: dirProfile.Manager}
		if user.MSObjectID == "" && patch.MSObjectID == nil && dirProfile.ObjectID != "" {
			patch.MSObjectID = &dirProfile.ObjectID
		}
	}
	backfillAuthProvider(user)
	if user.AuthProvider != model.AuthProviderOIDC {
		if err := s.evictPasswordHolder(ctx, user); err != nil {
			return err
		}
		oidc := model.AuthProviderOIDC
		patch.AuthProvider = &oidc
	}
	if err := s.users.PatchUser(ctx, user.ID, patch); err != nil {
		if errors.Is(err, store.ErrIdentityBound) {
			slog.WarnContext(ctx, "auth: SSO login refused — account was bound to another identity concurrently", "userID", user.ID)
			return ErrIdentityMismatch
		}
		return fmt.Errorf("auth: update user: %w", err)
	}
	user.DisplayName = info.Name
	user.AvatarURL = info.Picture
	user.LastSeenAt = &now
	user.UpdatedAt = now
	user.OIDCIssuer, user.OIDCSubject = info.Issuer, info.Subject
	if patch.MSObjectID != nil {
		user.MSObjectID = *patch.MSObjectID
	}
	if dirProfile != nil {
		user.Phone, user.Manager = dirProfile.Phone, dirProfile.Manager
	}
	user.AuthProvider = model.AuthProviderOIDC
	if s.cache != nil {
		// Drop the cached profile so the refreshed fields are visible
		// immediately (UserService reads cache-first).
		_ = s.cache.Delete(ctx, "user:"+user.ID)
	}
	s.indexUser(ctx, user)
	if directoryChanged {
		// Broadcast the change so peers with this profile open (hover
		// card, directory) refresh without a reload.
		publishUserDirectoryUpdated(ctx, s.publisher, user)
	}
	return nil
}

// evictPasswordHolder is the first half of converting a password account to
// SSO: the password is cleared (no new password login from here on), then
// whoever held it — an invite claimer, in the takeover case — loses every
// session and paired runner. Only after that does the caller flip the
// provider to OIDC, so a failure here fails the login and the next SSO
// login retries the whole eviction: handing the employee a session while the
// claimer's survive would bless the takeover.
func (s *AuthService) evictPasswordHolder(ctx context.Context, user *model.User) error {
	slog.WarnContext(ctx, "auth: password account converting to SSO on its first SSO login — revoking its existing sessions and runners", "userID", user.ID)
	noPassword := ""
	if err := s.users.PatchUser(ctx, user.ID, store.UserPatch{PasswordHash: &noPassword}); err != nil {
		return fmt.Errorf("auth: clear password on SSO conversion: %w", err)
	}
	user.PasswordHash = ""
	if err := s.tokens.DeleteAllRefreshTokensForUser(ctx, user.ID); err != nil {
		slog.ErrorContext(ctx, "auth: SSO conversion could not revoke the account's sessions", "userID", user.ID, "error", err)
		return fmt.Errorf("auth: revoke sessions on SSO conversion: %w", err)
	}
	if s.runners != nil {
		if err := s.runners.RevokeAllForUser(ctx, user.ID); err != nil {
			slog.ErrorContext(ctx, "auth: SSO conversion could not disconnect the account's runners", "userID", user.ID, "error", err)
			return fmt.Errorf("auth: revoke runners on SSO conversion: %w", err)
		}
	}
	return nil
}

func (s *AuthService) emailDomainAllowed(email string) bool {
	if len(s.allowedEmailDomains) == 0 {
		return true
	}
	return s.allowedEmailDomains[email[strings.LastIndex(email, "@")+1:]]
}

// RefreshAccessToken validates the raw refresh token, looks it up in the
// store, checks expiry and the session's absolute lifetime, loads the
// associated user (refusing a deactivated one), and returns a new access
// token plus the rotated refresh token.
func (s *AuthService) RefreshAccessToken(ctx context.Context, refreshTokenRaw string) (accessToken, newRefreshRaw string, err error) {
	hash := hashToken(refreshTokenRaw)

	rt, err := s.tokens.GetRefreshToken(ctx, hash)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", "", fmt.Errorf("auth: refresh token not found: %w", ErrSessionInvalid)
		}
		return "", "", fmt.Errorf("auth: get refresh token: %w", err)
	}

	now := time.Now()
	if now.After(rt.ExpiresAt) {
		// Clean up expired token.
		_ = s.tokens.DeleteRefreshToken(ctx, hash)
		return "", "", fmt.Errorf("auth: refresh token expired: %w", ErrSessionInvalid)
	}
	authTime := sessionAuthTime(rt)
	if s.sessionMaxAge > 0 && now.Sub(authTime) > s.sessionMaxAge {
		s.revokeFamily(ctx, rt)
		return "", "", fmt.Errorf("auth: session past its maximum age: %w", ErrSessionInvalid)
	}

	// Reuse of an already-rotated token. The successor's raw value rode
	// exactly one HTTP response; on mobile-grade networks that response is
	// regularly lost (radio drop, app backgrounded mid-request, client
	// timeout) — the client then retries with the only token it ever held.
	// Distinguish the two possible worlds by the successor's own state:
	//   - successor NEVER used → the response carrying it was provably lost
	//     (its raw value was destroyed with the response; nobody can ever
	//     present it). Honor the retry: revoke the orphan and rotate afresh.
	//   - successor (chain) alive → two parties hold live tokens: replay.
	//     Reject and revoke the WHOLE family — the live head may be the
	//     attacker's.
	// This is what keeps "re-login multiple times a day on desktop/iOS while
	// the SSO session is still valid" from happening without giving up
	// rotation's replay protection.
	if rt.RotatedAt != nil {
		successorUsed := false
		if rt.SupersededBy != "" {
			successor, err := s.tokens.GetRefreshToken(ctx, rt.SupersededBy)
			switch {
			case err == nil:
				successorUsed = successor.RotatedAt != nil
			case errors.Is(err, store.ErrNotFound):
				// Successor already revoked or expired — treat as unused;
				// the legit holder of THIS token is the only party left.
			default:
				return "", "", fmt.Errorf("auth: get successor token: %w", err)
			}
		}
		if successorUsed {
			slog.WarnContext(ctx, "auth: rotated refresh token replayed after its successor was used — revoking the session", "userID", rt.UserID)
			s.revokeFamily(ctx, rt)
			return "", "", fmt.Errorf("auth: refresh token already used: %w", ErrSessionInvalid)
		}
		if rt.SupersededBy != "" {
			// The orphaned successor is unreachable by anyone; remove it so
			// this token's next successor is the single live continuation.
			_ = s.tokens.DeleteRefreshToken(ctx, rt.SupersededBy)
		}
		// INFO (not WARN): this is the expected recovery for a lost rotation
		// response; its frequency is a useful proxy for client network health.
		slog.InfoContext(ctx, "auth: refresh token reused after lost rotation response — reissuing", "userID", rt.UserID)
	}

	user, err := s.users.GetUser(ctx, rt.UserID)
	if err != nil {
		return "", "", fmt.Errorf("auth: get user: %w", err)
	}
	if user.Status == "deactivated" {
		s.revokeFamily(ctx, rt)
		return "", "", ErrAccountDeactivated
	}

	// Field-level: a full put of this (possibly stale) copy could undo a
	// deactivation or demotion that landed since the read above.
	_ = s.users.PatchUser(ctx, user.ID, store.UserPatch{LastSeenAt: &now})
	user.LastSeenAt = &now

	accessToken, err = s.jwt.GenerateAccessToken(user)
	if err != nil {
		return "", "", fmt.Errorf("auth: generate access token: %w", err)
	}

	// Rotate the refresh token: issue a fresh successor in the same family
	// (same login time) and stamp the presented token as rotated. The old
	// token is kept (not deleted) so a lost response can be retried under
	// the successor-unused rule above; it still ages out at its original
	// expiry, and any use after its successor chain went live is rejected as
	// replay.
	newRefreshRaw, newHash, err := s.jwt.GenerateRefreshToken()
	if err != nil {
		return "", "", fmt.Errorf("auth: generate refresh token: %w", err)
	}
	if err := s.tokens.StoreRefreshToken(ctx, &model.RefreshToken{
		TokenHash: newHash,
		UserID:    user.ID,
		ExpiresAt: s.refreshExpiry(now, authTime),
		CreatedAt: now,
		FamilyID:  sessionFamily(rt),
		AuthTime:  &authTime,
	}); err != nil {
		return "", "", fmt.Errorf("auth: store refresh token: %w", err)
	}
	if err := s.tokens.MarkRefreshTokenRotated(ctx, hash, now, newHash); err != nil {
		// The stamp failed — the presented token would stay reusable with NO
		// successor linkage, i.e. unlimited replay. Fall back to hard
		// deletion (the pre-grace behavior) rather than weaken rotation.
		slog.WarnContext(ctx, "auth: mark refresh token rotated failed; deleting instead", "error", err)
		_ = s.tokens.DeleteRefreshToken(ctx, hash)
	}

	return accessToken, newRefreshRaw, nil
}

// sessionFamily is the login session a refresh token belongs to. A token
// minted before families existed is the root of its own family: its hash is
// the family ID its successors carry.
func sessionFamily(rt *model.RefreshToken) string {
	if rt.FamilyID != "" {
		return rt.FamilyID
	}
	return rt.TokenHash
}

// sessionAuthTime is when the session's user authenticated. A pre-family
// token has no record of it; its own creation is the closest bound.
func sessionAuthTime(rt *model.RefreshToken) time.Time {
	if rt.AuthTime != nil {
		return *rt.AuthTime
	}
	return rt.CreatedAt
}

// refreshExpiry is a new refresh token's expiry: the usual TTL, capped by
// the session's absolute lifetime.
func (s *AuthService) refreshExpiry(now, authTime time.Time) time.Time {
	exp := now.Add(s.jwt.RefreshTTL())
	if s.sessionMaxAge > 0 {
		if limit := authTime.Add(s.sessionMaxAge); limit.Before(exp) {
			return limit
		}
	}
	return exp
}

// revokeFamily deletes every token of rt's login session: the family's rows,
// the legacy family root (whose hash is the family ID) and rt itself. A
// failure is logged at ERROR — the caller is already refusing the session,
// and a surviving family member is a live credential.
func (s *AuthService) revokeFamily(ctx context.Context, rt *model.RefreshToken) {
	family := sessionFamily(rt)
	if err := s.tokens.DeleteRefreshTokenFamily(ctx, rt.UserID, family); err != nil {
		slog.ErrorContext(ctx, "auth: revoking a refresh-token family failed", "userID", rt.UserID, "error", err)
	}
	for _, hash := range []string{family, rt.TokenHash} {
		if err := s.tokens.DeleteRefreshToken(ctx, hash); err != nil {
			slog.ErrorContext(ctx, "auth: revoking a refresh token failed", "userID", rt.UserID, "error", err)
		}
	}
}

// CreateDesktopAuthSession parks a refresh token behind a one-time code for
// a native/desktop shell to redeem at /auth/desktop/complete.
func (s *AuthService) CreateDesktopAuthSession(ctx context.Context, refreshToken string) (string, error) {
	if s.cache == nil {
		return "", errors.New("auth: desktop auth cache is not configured")
	}

	b := make([]byte, 32)
	if _, err := randRead(b); err != nil {
		return "", fmt.Errorf("auth: generate desktop auth code: %w", err)
	}
	code := base64.RawURLEncoding.EncodeToString(b)
	session := DesktopAuthSession{RefreshToken: refreshToken}
	if err := s.cache.Set(ctx, desktopAuthCodeKey(code), session, desktopAuthCodeTTL); err != nil {
		return "", fmt.Errorf("auth: store desktop auth session: %w", err)
	}
	return code, nil
}

func (s *AuthService) ConsumeDesktopAuthSession(ctx context.Context, code string) (*DesktopAuthSession, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil, ErrDesktopAuthInvalid
	}
	if s.cache == nil {
		return nil, errors.New("auth: desktop auth cache is not configured")
	}

	var session DesktopAuthSession
	key := desktopAuthCodeKey(code)
	if err := s.cache.Get(ctx, key, &session); err != nil {
		return nil, ErrDesktopAuthInvalid
	}
	_ = s.cache.Delete(ctx, key)
	if session.RefreshToken == "" {
		return nil, ErrDesktopAuthInvalid
	}
	return &session, nil
}

// Logout ends the session the raw refresh token belongs to: every token of
// its family goes, so a rotated predecessor (kept for the lost-response
// grace) can't mint a new session afterwards. Other devices' sessions are
// other families and stay.
func (s *AuthService) Logout(ctx context.Context, refreshTokenRaw string) error {
	rt, err := s.tokens.GetRefreshToken(ctx, hashToken(refreshTokenRaw))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		return fmt.Errorf("auth: get refresh token: %w", err)
	}
	s.revokeFamily(ctx, rt)
	return nil
}

// CreateInvite generates an invitation token, stores the invite with a 72-hour
// expiry, and returns the invite model.
// The invite link is emailed to the invitee when SMTP is configured, and is
// also returned so the inviter can copy it directly — the invite must not
// depend on mail being up.
//
// The parameter is inviteeEmail, not email: this file imports the email
// package, and a parameter named email would shadow it.
func (s *AuthService) CreateInvite(ctx context.Context, inviterID, inviteeEmail string, channelIDs []string) (*model.Invite, error) {
	// Invites mint password accounts, so only system admins issue them —
	// checked against the STORED role (the router's role gate reads the same
	// thing; this keeps the service safe on its own).
	inviter, err := s.users.GetUser(ctx, inviterID)
	if err != nil {
		return nil, fmt.Errorf("auth: get inviter: %w", err)
	}
	if inviter.SystemRole != model.SystemRoleAdmin {
		return nil, ErrInviteForbidden
	}
	addr, err := normalizeEmailAddress(inviteeEmail)
	if err != nil {
		return nil, err
	}
	channelIDs, err = s.authorizedInviteChannelIDs(ctx, inviterID, channelIDs)
	if err != nil {
		return nil, err
	}
	b := make([]byte, 24)
	if _, err := randRead(b); err != nil {
		return nil, fmt.Errorf("auth: generate invite token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(b)

	now := time.Now()
	inv := &model.Invite{
		Token:      token,
		Email:      addr,
		InviterID:  inviterID,
		ChannelIDs: channelIDs,
		ExpiresAt:  now.Add(72 * time.Hour),
		CreatedAt:  now,
	}
	if err := s.invites.CreateInvite(ctx, inv); err != nil {
		return nil, fmt.Errorf("auth: store invite: %w", err)
	}
	s.deliver(ctx, email.InviteMessage(addr, inviter.DisplayName, s.baseURL+"/invite/"+token), "invite", inviterID)
	return inv, nil
}

// AcceptInvite validates the invite token, creates a guest user, adds the user
// to the specified channels, generates tokens, and deletes the invite.
func (s *AuthService) AcceptInvite(ctx context.Context, token, displayName, password string) (accessToken, refreshTokenRaw string, user *model.User, err error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" || utf8.RuneCountInString(displayName) > maxDisplayNameLen {
		return "", "", nil, ErrInvalidDisplayName
	}
	if err := validateGuestPassword(password); err != nil {
		return "", "", nil, err
	}
	inv, err := s.invites.GetInvite(ctx, token)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", "", nil, ErrInviteInvalid
		}
		return "", "", nil, fmt.Errorf("auth: get invite: %w", err)
	}

	if time.Now().After(inv.ExpiresAt) {
		_ = s.invites.DeleteInvite(ctx, token)
		return "", "", nil, ErrInviteInvalid
	}
	email, err := normalizeEmailAddress(inv.Email)
	if err != nil {
		return "", "", nil, err
	}

	hashed, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", "", nil, fmt.Errorf("auth: hash password: %w", err)
	}

	now := time.Now()
	ns := model.DefaultNotificationSettingsForNewUser(displayName)
	user = &model.User{
		ID:                   store.NewID(),
		Email:                email,
		DisplayName:          displayName,
		SystemRole:           model.SystemRoleGuest,
		AuthProvider:         model.AuthProviderGuest,
		PasswordHash:         string(hashed),
		NotificationSettings: &ns,
		Status:               "active",
		CreatedAt:            now,
		UpdatedAt:            now,
	}
	if err := s.users.CreateUser(ctx, user); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			return "", "", nil, ErrAccountExists
		}
		return "", "", nil, fmt.Errorf("auth: create guest user: %w", err)
	}
	s.indexUser(ctx, user)

	// Add the guest to the channels listed on the invite. AutoJoinChannel
	// publishes member.joined + a system message and is idempotent.
	if s.joiner != nil {
		for _, chID := range inv.ChannelIDs {
			if err := s.joiner.AutoJoinChannel(ctx, user.ID, chID, model.ChannelRoleMember); err != nil {
				return "", "", nil, fmt.Errorf("auth: add to channel %s: %w", chID, err)
			}
		}
	}

	// Ensure invited guest can access #general.
	s.ensureGeneralChannel(ctx, user)

	accessToken, refreshTokenRaw, err = s.issueTokens(ctx, user)
	if err != nil {
		return "", "", nil, err
	}

	// Clean up the invite.
	_ = s.invites.DeleteInvite(ctx, token)

	return accessToken, refreshTokenRaw, user, nil
}

// dummyBcryptHash is a precomputed bcrypt hash used only to spend the same
// CPU time as a real password check when an account doesn't exist, closing the
// user-enumeration timing side-channel in GuestLogin. The password it hashes is
// irrelevant — it never matches a user-supplied one.
var dummyBcryptHash = []byte("$2a$10$3txrxENsY7NdXGi1zr/4ze99AUZIY36/D5qVX1bFyzncrepNRmbLy")

// GuestLogin authenticates a guest user via email and password (bcrypt).
func (s *AuthService) GuestLogin(ctx context.Context, email, password string) (accessToken, refreshTokenRaw string, user *model.User, err error) {
	email, err = normalizeEmailAddress(email)
	if err != nil {
		return "", "", nil, ErrInvalidCredentials
	}
	user, err = s.users.GetUserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Run a bcrypt comparison against a dummy hash so a non-existent
			// account takes the same wall time as a real one — otherwise the
			// early return leaks account existence via a timing side-channel.
			_ = bcrypt.CompareHashAndPassword(dummyBcryptHash, []byte(password))
			return "", "", nil, ErrInvalidCredentials
		}
		return "", "", nil, fmt.Errorf("auth: get user by email: %w", err)
	}

	if user.SystemRole != model.SystemRoleGuest && !s.guestLoginAnyRole {
		// A real (e.g. SSO) account exists at this email. Spend the same dummy
		// bcrypt the not-found path does and return the SAME generic message, so
		// an unauthenticated caller can't enumerate non-guest accounts by timing
		// OR by error text. GUEST_LOGIN_ANY_ROLE (dev stacks only — no OIDC
		// locally) lifts the role gate; the password check below still stands,
		// and SSO users carry no password hash, so they remain unloginable here.
		_ = bcrypt.CompareHashAndPassword(dummyBcryptHash, []byte(password))
		return "", "", nil, ErrInvalidCredentials
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return "", "", nil, ErrInvalidCredentials
	}
	// Checked only after the password: the generic answer above must not
	// reveal that a deactivated account exists at this address.
	if user.Status == "deactivated" {
		return "", "", nil, ErrAccountDeactivated
	}

	accessToken, refreshTokenRaw, err = s.issueTokens(ctx, user)
	if err != nil {
		return "", "", nil, err
	}
	return accessToken, refreshTokenRaw, user, nil
}

func normalizeEmailAddress(email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || len(email) > 254 {
		return "", apperr.Invalid("auth: invalid email address")
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email {
		return "", apperr.Invalid("auth: invalid email address")
	}
	return email, nil
}

func (s *AuthService) authorizedInviteChannelIDs(ctx context.Context, inviterID string, channelIDs []string) ([]string, error) {
	cleaned := make([]string, 0, len(channelIDs))
	seen := make(map[string]bool, len(channelIDs))
	for _, raw := range channelIDs {
		chID := strings.TrimSpace(raw)
		if chID == "" || seen[chID] {
			continue
		}
		seen[chID] = true
		if _, err := s.memberships.GetMembership(ctx, chID, inviterID); err != nil {
			if errors.Is(err, store.ErrNotFound) {
				return nil, apperr.Forbidden("auth: inviter cannot invite to a channel they are not a member of")
			}
			return nil, fmt.Errorf("auth: check invite channel membership: %w", err)
		}
		cleaned = append(cleaned, chID)
	}
	return cleaned, nil
}

// applyDirectoryProfile stamps synced directory attributes onto a new user.
// A nil profile (directory disabled, user not in the directory, or the lookup
// failed) leaves the attributes untouched.
func applyDirectoryProfile(user *model.User, dp *DirectoryProfile) {
	if dp == nil {
		return
	}
	user.Phone = dp.Phone
	user.Manager = dp.Manager
	if dp.ObjectID != "" {
		user.MSObjectID = dp.ObjectID
	}
}

// ensureGeneralChannel creates the #general channel if it doesn't exist and adds
// the user as a member. Errors are logged but not propagated — login should not
// fail because of channel setup.
func (s *AuthService) ensureGeneralChannel(ctx context.Context, user *model.User) {
	now := time.Now()

	// Try to create #general. If it already exists, that's fine.
	ch := &model.Channel{
		ID:          generalChannelID,
		Name:        "general",
		Slug:        "general",
		Description: "Company-wide announcements and work-based matters",
		Type:        model.ChannelTypePublic,
		CreatedBy:   user.ID,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	_ = s.channelStore.CreateChannel(ctx, ch) // ignore AlreadyExists

	role := model.ChannelRoleMember
	if user.SystemRole == model.SystemRoleAdmin {
		role = model.ChannelRoleOwner
	}
	if s.joiner != nil {
		_ = s.joiner.AutoJoinChannel(ctx, user.ID, generalChannelID, role)
	}
}

// issueTokens generates an access/refresh token pair and persists the refresh token.
func (s *AuthService) issueTokens(ctx context.Context, user *model.User) (accessToken, refreshTokenRaw string, err error) {
	accessToken, err = s.jwt.GenerateAccessToken(user)
	if err != nil {
		return "", "", fmt.Errorf("auth: generate access token: %w", err)
	}

	refreshTokenRaw, refreshHash, err := s.jwt.GenerateRefreshToken()
	if err != nil {
		return "", "", fmt.Errorf("auth: generate refresh token: %w", err)
	}

	// A login starts a new session: a fresh family, authenticated now.
	now := time.Now()
	rt := &model.RefreshToken{
		TokenHash: refreshHash,
		UserID:    user.ID,
		ExpiresAt: s.refreshExpiry(now, now),
		CreatedAt: now,
		FamilyID:  store.NewID(),
		AuthTime:  &now,
	}
	if err := s.tokens.StoreRefreshToken(ctx, rt); err != nil {
		return "", "", fmt.Errorf("auth: store refresh token: %w", err)
	}

	return accessToken, refreshTokenRaw, nil
}

// hashToken computes the SHA-256 hash of a raw token and returns it
// as a base64url-encoded string (matching JWTManager.GenerateRefreshToken).
func hashToken(raw string) string {
	h := sha256.Sum256([]byte(raw))
	return base64.RawURLEncoding.EncodeToString(h[:])
}

func desktopAuthCodeKey(code string) string {
	return "desktop_auth:" + code
}
