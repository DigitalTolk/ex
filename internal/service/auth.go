package service

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/crypto/bcrypt"
)

// generalChannelID is a deterministic ULID derived from the name "general"
// so it's consistent across all instances without coordination.
var generalChannelID = store.DeriveID("channel:general")

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
}

const (
	minGuestPasswordLen = 8
	maxGuestPasswordLen = 1024
	maxDisplayNameLen   = 80
)

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

func (s *AuthService) indexUser(ctx context.Context, u *model.User) {
	indexUser(ctx, s.indexer, u)
}

// HandleOIDCLogin generates a random state string and returns the OIDC
// provider's authorization URL. The caller is responsible for storing the
// state in an HTTP-only cookie.
func (s *AuthService) HandleOIDCLogin() (authURL, state string, err error) {
	if s.oidc == nil {
		return "", "", errors.New("auth: OIDC is not configured")
	}

	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("auth: generate state: %w", err)
	}
	state = hex.EncodeToString(b)
	authURL = s.oidc.AuthURL(state)
	return authURL, state, nil
}

// HandleOIDCCallback exchanges the authorization code for tokens,
// upserts the user (creating with SystemRoleMember if new), generates
// an access/refresh token pair, and stores the refresh token.
func (s *AuthService) HandleOIDCCallback(ctx context.Context, code, state string) (accessToken, refreshTokenRaw string, user *model.User, err error) {
	if s.oidc == nil {
		return "", "", nil, errors.New("auth: OIDC is not configured")
	}

	info, err := s.oidc.Exchange(ctx, code)
	if err != nil {
		return "", "", nil, fmt.Errorf("auth: oidc exchange: %w", err)
	}

	// Look up the user by email; create if not found.
	user, err = s.users.GetUserByEmail(ctx, info.Email)
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
		user = &model.User{
			ID:           store.NewID(),
			Email:        info.Email,
			DisplayName:  info.Name,
			AvatarURL:    info.Picture,
			SystemRole:   role,
			AuthProvider: model.AuthProviderOIDC,
			Status:       "active",
			LastSeenAt:   &now,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
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
		if err := s.users.UpdateUser(ctx, user); err != nil {
			return "", "", nil, fmt.Errorf("auth: update user: %w", err)
		}
		s.indexUser(ctx, user)
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
func (s *AuthService) RefreshAccessToken(ctx context.Context, refreshTokenRaw string) (string, error) {
	hash := hashToken(refreshTokenRaw)

	rt, err := s.tokens.GetRefreshToken(ctx, hash)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", errors.New("auth: refresh token not found")
		}
		return "", fmt.Errorf("auth: get refresh token: %w", err)
	}

	if time.Now().After(rt.ExpiresAt) {
		// Clean up expired token.
		_ = s.tokens.DeleteRefreshToken(ctx, hash)
		return "", errors.New("auth: refresh token expired")
	}

	user, err := s.users.GetUser(ctx, rt.UserID)
	if err != nil {
		return "", fmt.Errorf("auth: get user: %w", err)
	}

	now := time.Now()
	user.LastSeenAt = &now
	_ = s.users.UpdateUser(ctx, user)

	accessToken, err := s.jwt.GenerateAccessToken(user)
	if err != nil {
		return "", fmt.Errorf("auth: generate access token: %w", err)
	}
	return accessToken, nil
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
func (s *AuthService) CreateInvite(ctx context.Context, inviterID, email string, channelIDs []string) (*model.Invite, error) {
	email, err := normalizeEmailAddress(email)
	if err != nil {
		return nil, err
	}
	channelIDs, err = s.authorizedInviteChannelIDs(ctx, inviterID, channelIDs)
	if err != nil {
		return nil, err
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return nil, fmt.Errorf("auth: generate invite token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(b)

	now := time.Now()
	inv := &model.Invite{
		Token:      token,
		Email:      email,
		InviterID:  inviterID,
		ChannelIDs: channelIDs,
		ExpiresAt:  now.Add(72 * time.Hour),
		CreatedAt:  now,
	}
	if err := s.invites.CreateInvite(ctx, inv); err != nil {
		return nil, fmt.Errorf("auth: store invite: %w", err)
	}
	return inv, nil
}

// AcceptInvite validates the invite token, creates a guest user, adds the user
// to the specified channels, generates tokens, and deletes the invite.
func (s *AuthService) AcceptInvite(ctx context.Context, token, displayName, password string) (accessToken, refreshTokenRaw string, user *model.User, err error) {
	displayName = strings.TrimSpace(displayName)
	if displayName == "" || utf8.RuneCountInString(displayName) > maxDisplayNameLen {
		return "", "", nil, fmt.Errorf("auth: display name must be 1-%d characters", maxDisplayNameLen)
	}
	if utf8.RuneCountInString(password) < minGuestPasswordLen || len(password) > maxGuestPasswordLen {
		return "", "", nil, fmt.Errorf("auth: password must be at least %d characters", minGuestPasswordLen)
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

	hashed, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", "", nil, fmt.Errorf("auth: hash password: %w", err)
	}

	now := time.Now()
	user = &model.User{
		ID:           store.NewID(),
		Email:        inv.Email,
		DisplayName:  displayName,
		SystemRole:   model.SystemRoleGuest,
		AuthProvider: model.AuthProviderGuest,
		PasswordHash: string(hashed),
		Status:       "active",
		CreatedAt:    now,
		UpdatedAt:    now,
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

// GuestLogin authenticates a guest user via email and password (bcrypt).
func (s *AuthService) GuestLogin(ctx context.Context, email, password string) (accessToken, refreshTokenRaw string, user *model.User, err error) {
	email, err = normalizeEmailAddress(email)
	if err != nil {
		return "", "", nil, errors.New("auth: invalid credentials")
	}
	user, err = s.users.GetUserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return "", "", nil, errors.New("auth: invalid credentials")
		}
		return "", "", nil, fmt.Errorf("auth: get user by email: %w", err)
	}

	if user.SystemRole != model.SystemRoleGuest {
		return "", "", nil, errors.New("auth: not a guest account")
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
