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

	"github.com/DigitalTolk/ex/internal/email"
	"github.com/DigitalTolk/ex/internal/model"
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
}

// SetGuestLoginAnyRole allows password login for non-guest roles. Intended
// ONLY for local dev (GUEST_LOGIN_ANY_ROLE=true in the compose overlay):
// production users authenticate via OIDC and carry no password hash, so even
// misconfigured this cannot log an SSO account in — but keep it off anyway.
func (s *AuthService) SetGuestLoginAnyRole(v bool) { s.guestLoginAnyRole = v }

const (
	minGuestPasswordLen = 8
	maxGuestPasswordLen = 1024
	maxDisplayNameLen   = 80
	desktopAuthCodeTTL  = 2 * time.Minute
)

type DesktopAuthSession struct {
	AccessToken  string `json:"accessToken"`
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
	}
}

// SetChannelJoiner wires the ChannelService for auto-join behavior so signup
// and invite-accept flows publish member.joined events and system messages.
// Called from main wiring after ChannelService is constructed (avoids
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
	indexUser(ctx, s.indexer, u)
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

	// Employee-directory enrichment (phone + manager). Fail-open: a
	// directory outage must degrade to an un-enriched login, never block it.
	var dirProfile *DirectoryProfile
	if s.directory != nil {
		dp, derr := s.directory.LookupProfile(ctx, email, info.ObjectID)
		if derr != nil {
			slog.Warn("auth: directory profile lookup failed; continuing login without enrichment", "error", derr)
		} else {
			dirProfile = dp
		}
	}

	// Look up the user by email; create if not found.
	user, err = s.users.GetUserByEmail(ctx, email)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return "", "", nil, fmt.Errorf("auth: get user by email: %w", err)
		}

		// First user to log in becomes admin.
		role := model.SystemRoleMember
		hasUsers, err := s.users.HasUsers(ctx)
		if err != nil {
			return "", "", nil, fmt.Errorf("auth: check existing users: %w", err)
		}
		if !hasUsers {
			role = model.SystemRoleAdmin
		}

		now := time.Now()
		ns := model.DefaultNotificationSettingsForNewUser(info.Name)
		user = &model.User{
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
		}
		applyDirectoryProfile(user, dirProfile)
		if err := s.users.CreateUser(ctx, user); err != nil {
			if errors.Is(err, store.ErrAlreadyExists) {
				return "", "", nil, errors.New("auth: a user with this email already exists")
			}
			return "", "", nil, fmt.Errorf("auth: create user: %w", err)
		}
		s.indexUser(ctx, user)
	} else {
		// Update profile fields from the identity provider.
		now := time.Now()
		user.DisplayName = info.Name
		user.AvatarURL = info.Picture
		user.LastSeenAt = &now
		user.UpdatedAt = now
		if info.ObjectID != "" {
			user.MSObjectID = info.ObjectID
		}
		directoryChanged := dirProfile != nil &&
			(user.Phone != dirProfile.Phone || !user.Manager.Equal(dirProfile.Manager))
		applyDirectoryProfile(user, dirProfile)
		if err := s.users.UpdateUser(ctx, user); err != nil {
			return "", "", nil, fmt.Errorf("auth: update user: %w", err)
		}
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
	}

	// Ensure #general exists and the user is a member.
	s.ensureGeneralChannel(ctx, user)

	accessToken, refreshTokenRaw, err = s.issueTokens(ctx, user)
	if err != nil {
		return "", "", nil, err
	}
	return accessToken, refreshTokenRaw, user, nil
}

// RefreshAccessToken validates the raw refresh token, looks it up in the
// store, checks expiry, loads the associated user, and returns a new
// access token.
func (s *AuthService) RefreshAccessToken(ctx context.Context, refreshTokenRaw string) (accessToken, newRefreshRaw string, err error) {
	hash := hashToken(refreshTokenRaw)

	rt, err := s.tokens.GetRefreshToken(ctx, hash)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", "", errors.New("auth: refresh token not found")
		}
		return "", "", fmt.Errorf("auth: get refresh token: %w", err)
	}

	if time.Now().After(rt.ExpiresAt) {
		// Clean up expired token.
		_ = s.tokens.DeleteRefreshToken(ctx, hash)
		return "", "", errors.New("auth: refresh token expired")
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
	//     Reject and revoke the presented token.
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
			slog.Warn("auth: rotated refresh token replayed after its successor was used — revoking", "userID", rt.UserID)
			_ = s.tokens.DeleteRefreshToken(ctx, hash)
			return "", "", errors.New("auth: refresh token already used")
		}
		if rt.SupersededBy != "" {
			// The orphaned successor is unreachable by anyone; remove it so
			// this token's next successor is the single live continuation.
			_ = s.tokens.DeleteRefreshToken(ctx, rt.SupersededBy)
		}
		// INFO (not WARN): this is the expected recovery for a lost rotation
		// response; its frequency is a useful proxy for client network health.
		slog.Info("auth: refresh token reused after lost rotation response — reissuing", "userID", rt.UserID)
	}

	user, err := s.users.GetUser(ctx, rt.UserID)
	if err != nil {
		return "", "", fmt.Errorf("auth: get user: %w", err)
	}

	now := time.Now()
	user.LastSeenAt = &now
	_ = s.users.UpdateUser(ctx, user)

	accessToken, err = s.jwt.GenerateAccessToken(user)
	if err != nil {
		return "", "", fmt.Errorf("auth: generate access token: %w", err)
	}

	// Rotate the refresh token: issue a fresh successor and stamp the
	// presented token as rotated. The old token is kept (not deleted) so a
	// lost response can be retried under the successor-unused rule above; it
	// still ages out at its original expiry, and any use after its successor
	// chain went live is rejected as replay.
	newRefreshRaw, newHash, err := s.jwt.GenerateRefreshToken()
	if err != nil {
		return "", "", fmt.Errorf("auth: generate refresh token: %w", err)
	}
	if err := s.tokens.StoreRefreshToken(ctx, &model.RefreshToken{
		TokenHash: newHash,
		UserID:    user.ID,
		ExpiresAt: now.Add(s.jwt.RefreshTTL()),
		CreatedAt: now,
	}); err != nil {
		return "", "", fmt.Errorf("auth: store refresh token: %w", err)
	}
	if err := s.tokens.MarkRefreshTokenRotated(ctx, hash, now, newHash); err != nil {
		// The stamp failed — the presented token would stay reusable with NO
		// successor linkage, i.e. unlimited replay. Fall back to hard
		// deletion (the pre-grace behavior) rather than weaken rotation.
		slog.Warn("auth: mark refresh token rotated failed; deleting instead", "error", err)
		_ = s.tokens.DeleteRefreshToken(ctx, hash)
	}

	return accessToken, newRefreshRaw, nil
}

func (s *AuthService) CreateDesktopAuthSession(ctx context.Context, accessToken, refreshToken string) (string, error) {
	if s.cache == nil {
		return "", errors.New("auth: desktop auth cache is not configured")
	}

	b := make([]byte, 32)
	if _, err := randRead(b); err != nil {
		return "", fmt.Errorf("auth: generate desktop auth code: %w", err)
	}
	code := base64.RawURLEncoding.EncodeToString(b)
	session := DesktopAuthSession{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}
	if err := s.cache.Set(ctx, desktopAuthCodeKey(code), session, desktopAuthCodeTTL); err != nil {
		return "", fmt.Errorf("auth: store desktop auth session: %w", err)
	}
	return code, nil
}

func (s *AuthService) ConsumeDesktopAuthSession(ctx context.Context, code string) (*DesktopAuthSession, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil, errors.New("auth: missing desktop auth code")
	}
	if s.cache == nil {
		return nil, errors.New("auth: desktop auth cache is not configured")
	}

	var session DesktopAuthSession
	key := desktopAuthCodeKey(code)
	if err := s.cache.Get(ctx, key, &session); err != nil {
		return nil, errors.New("auth: desktop auth code expired or invalid")
	}
	_ = s.cache.Delete(ctx, key)
	if session.AccessToken == "" || session.RefreshToken == "" {
		return nil, errors.New("auth: desktop auth session is invalid")
	}
	return &session, nil
}

// Logout deletes the refresh token identified by the raw value.
func (s *AuthService) Logout(ctx context.Context, refreshTokenRaw string) error {
	hash := hashToken(refreshTokenRaw)
	if err := s.tokens.DeleteRefreshToken(ctx, hash); err != nil && !errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("auth: delete refresh token: %w", err)
	}
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
	s.deliver(ctx, email.InviteMessage(addr, s.inviterName(ctx, inviterID), s.baseURL+"/invite/"+token), "invite", inviterID)
	return inv, nil
}

// inviterName resolves the inviter's display name for the invitation email.
// Best-effort: a lookup failure just yields a nameless invitation rather than
// blocking it.
func (s *AuthService) inviterName(ctx context.Context, inviterID string) string {
	if s.mailer == nil {
		return ""
	}
	user, err := s.users.GetUser(ctx, inviterID)
	if err != nil {
		return ""
	}
	return user.DisplayName
}

// AcceptInvite validates the invite token, creates a guest user, adds the user
// to the specified channels, generates tokens, and deletes the invite.
func (s *AuthService) AcceptInvite(ctx context.Context, token, displayName, password string) (accessToken, refreshTokenRaw string, user *model.User, err error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" || utf8.RuneCountInString(displayName) > maxDisplayNameLen {
		return "", "", nil, fmt.Errorf("auth: display name must be 1-%d characters", maxDisplayNameLen)
	}
	if err := validateGuestPassword(password); err != nil {
		return "", "", nil, err
	}
	inv, err := s.invites.GetInvite(ctx, token)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", "", nil, errors.New("auth: invite not found")
		}
		return "", "", nil, fmt.Errorf("auth: get invite: %w", err)
	}

	if time.Now().After(inv.ExpiresAt) {
		_ = s.invites.DeleteInvite(ctx, token)
		return "", "", nil, errors.New("auth: invite expired")
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
			return "", "", nil, errors.New("auth: a user with this email already exists")
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
		return "", "", nil, errors.New("auth: invalid credentials")
	}
	user, err = s.users.GetUserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Run a bcrypt comparison against a dummy hash so a non-existent
			// account takes the same wall time as a real one — otherwise the
			// early return leaks account existence via a timing side-channel.
			_ = bcrypt.CompareHashAndPassword(dummyBcryptHash, []byte(password))
			return "", "", nil, errors.New("auth: invalid credentials")
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
		return "", "", nil, errors.New("auth: invalid credentials")
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return "", "", nil, errors.New("auth: invalid credentials")
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
		return "", errors.New("auth: invalid email address")
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email {
		return "", errors.New("auth: invalid email address")
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
				return nil, errors.New("auth: inviter cannot invite to a channel they are not a member of")
			}
			return nil, fmt.Errorf("auth: check invite channel membership: %w", err)
		}
		cleaned = append(cleaned, chID)
	}
	return cleaned, nil
}

// applyDirectoryProfile stamps synced directory attributes onto the user.
// A nil profile (directory disabled, user not in the directory, or the lookup
// failed) leaves the stored attributes untouched — a transient miss must not
// wipe previously synced data.
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

	rt := &model.RefreshToken{
		TokenHash: refreshHash,
		UserID:    user.ID,
		ExpiresAt: time.Now().Add(s.jwt.RefreshTTL()),
		CreatedAt: time.Now(),
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
