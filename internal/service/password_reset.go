package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"time"
	"unicode/utf8"

	"github.com/DigitalTolk/ex/internal/email"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/crypto/bcrypt"
)

// Password reset applies to GUEST accounts only — accounts that hold a local
// bcrypt password because they came in through an invite. SSO (OIDC) users
// have no password here at all: their credential lives in the identity
// provider, and handing out a reset link for one would either be a no-op or,
// worse, mint a local password that shadows the IdP. Every entry point below
// therefore checks supportsPasswordReset, and the check keys on AuthProvider
// rather than SystemRole: an SSO user demoted to the guest ROLE is still
// IdP-managed and must stay SSO-only.

const (
	// passwordResetTTL bounds how long a reset link stays live. Long enough
	// for an admin to relay it and for a guest to act on an email, short
	// enough that a link left in an inbox is not a standing key to the
	// account. Must stay well under the invite expiry — this is a recovery
	// path, not an onboarding one.
	passwordResetTTL = time.Hour
	// passwordResetTokenBytes is the raw entropy behind a reset token. 32
	// bytes (256 bits) makes guessing irrelevant next to the TTL.
	passwordResetTokenBytes = 32
	// passwordResetCooldown is the per-address floor between self-service
	// reset mails, so the endpoint can't be used to flood someone's inbox.
	passwordResetCooldown = 5 * time.Minute
	// passwordResetWorkTimeout bounds the detached lookup + mint + send.
	passwordResetWorkTimeout = 30 * time.Second
)

var (
	// ErrPasswordResetUnsupported reports an account that cannot hold a local
	// password (an SSO/OIDC user). Surfaced to admins as a 409 so the UI can
	// explain WHY rather than silently doing nothing.
	ErrPasswordResetUnsupported = errors.New("auth: password reset is only available for guest accounts; SSO users sign in through the identity provider")
	// ErrPasswordResetInvalid reports an unknown, expired, or already-used
	// reset token. Deliberately indistinguishable between those cases.
	ErrPasswordResetInvalid = errors.New("auth: this password reset link is invalid or has expired")
	// ErrPasswordResetUnavailable reports that reset tickets have no backing
	// store wired (no Redis), so the feature is off in this deployment.
	ErrPasswordResetUnavailable = errors.New("auth: password reset is not available")
)

// PasswordResetStore persists single-use reset tickets keyed by the token's
// hash. Backed by Redis (cache.RedisCache) in production.
type PasswordResetStore interface {
	MintPasswordResetTicket(ctx context.Context, tokenHash, userID string, ttl time.Duration) error
	ConsumePasswordResetTicket(ctx context.Context, tokenHash string) (string, error)
}

// PasswordResetTicket is a freshly minted reset link. The URL is returned to
// an admin caller so the reset still works when mail is unconfigured or the
// relay is down — EmailSent tells the UI which of those two stories to tell.
type PasswordResetTicket struct {
	URL       string    `json:"resetURL"`
	ExpiresAt time.Time `json:"expiresAt"`
	EmailSent bool      `json:"emailSent"`
}

// SetPasswordResetStore wires the single-use reset-ticket store. Optional:
// without it, password reset reports ErrPasswordResetUnavailable instead of
// failing at the Redis call.
func (s *AuthService) SetPasswordResetStore(st PasswordResetStore) { s.resets = st }

// SetRunnerRevoker wires ex-runner revocation into password reset. Optional.
func (s *AuthService) SetRunnerRevoker(r RunnerRevoker) { s.runners = r }

// SetMailer wires transactional email and the public base URL used to build
// links inside it. Optional: with no mailer, invites and resets still mint
// their links (the admin copies them by hand) — they just aren't delivered.
func (s *AuthService) SetMailer(m email.Sender, baseURL string) {
	s.mailer = m
	s.baseURL = baseURL
}

// supportsPasswordReset reports whether the account holds a local password.
// backfillAuthProvider covers rows written before AuthProvider existed, so a
// legacy guest is not mistaken for an SSO user (and vice versa).
func supportsPasswordReset(user *model.User) bool {
	if user == nil {
		return false
	}
	backfillAuthProvider(user)
	return user.AuthProvider == model.AuthProviderGuest
}

// CreatePasswordResetForUser mints a reset link for a guest account on an
// admin's behalf and emails it to the guest. The link is also returned so the
// admin can relay it directly — the reset must not depend on mail being up.
//
// Callers are responsible for enforcing admin-only access.
func (s *AuthService) CreatePasswordResetForUser(ctx context.Context, targetUserID string) (*PasswordResetTicket, error) {
	if s.resets == nil {
		return nil, ErrPasswordResetUnavailable
	}
	user, err := s.users.GetUser(ctx, targetUserID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
		return nil, fmt.Errorf("auth: get user for password reset: %w", err)
	}
	if !supportsPasswordReset(user) {
		return nil, ErrPasswordResetUnsupported
	}
	return s.mintPasswordReset(ctx, user, true)
}

// RequestPasswordReset is the self-service "I forgot my password" entry point.
// It reports success for ANY input: a caller must not be able to learn whether
// an address is registered, whether it is a guest, or whether mail went out.
// Only the reset-store being unwired is surfaced, and that is a deployment
// fact, not a per-account one.
//
// Everything per-account runs detached, after the response: a guest address
// used to answer only once its mail had been sent — a timing oracle that told
// guest accounts apart from everything else.
func (s *AuthService) RequestPasswordReset(ctx context.Context, rawEmail string) error {
	if s.resets == nil {
		return ErrPasswordResetUnavailable
	}
	addr, err := normalizeEmailAddress(rawEmail)
	if err != nil {
		return nil
	}
	detached := context.WithoutCancel(ctx)
	s.background(func() {
		ctx, cancel := context.WithTimeout(detached, passwordResetWorkTimeout)
		defer cancel()
		s.processPasswordResetRequest(ctx, addr)
	})
	return nil
}

// processPasswordResetRequest is the detached half of RequestPasswordReset:
// cooldown, lookup, guest check, mint and send. Nothing here reaches the
// caller; failures are logged.
func (s *AuthService) processPasswordResetRequest(ctx context.Context, addr string) {
	if !s.passwordResetCooldownFree(ctx, addr) {
		return
	}
	user, err := s.users.GetUserByEmail(ctx, addr)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			slog.ErrorContext(ctx, "password reset lookup failed", "error", err)
		}
		return
	}
	if !supportsPasswordReset(user) {
		// An SSO account. Nothing to reset, and saying so would confirm the
		// address exists.
		return
	}
	if _, err := s.mintPasswordReset(ctx, user, false); err != nil {
		slog.ErrorContext(ctx, "password reset mint failed", "userID", user.ID, "error", err)
	}
}

// passwordResetCooldownFree claims the address's cooldown slot: true for the
// first request in passwordResetCooldown, false for the rest. Keyed by the
// address's hash (no plaintext addresses in Redis) and taken for every
// address, registered or not, so it reveals nothing either. Without a cache
// — or when it is down — requests are not throttled: the per-IP route limit
// still applies, and a reset must not hinge on Redis.
func (s *AuthService) passwordResetCooldownFree(ctx context.Context, addr string) bool {
	if s.cache == nil {
		return true
	}
	key := "pwreset:cooldown:" + hashToken(addr)
	var seen bool
	if err := s.cache.Get(ctx, key, &seen); err == nil {
		return false
	}
	if err := s.cache.Set(ctx, key, true, passwordResetCooldown); err != nil {
		slog.WarnContext(ctx, "password reset cooldown not recorded", "error", err)
	}
	return true
}

// ResetPassword redeems a reset token and sets a new password. The token is
// single-use (GETDEL in the store), and every existing session is revoked:
// a reset means the old credential is no longer trusted, so sessions opened
// with it must not survive.
func (s *AuthService) ResetPassword(ctx context.Context, token, password string) error {
	if s.resets == nil {
		return ErrPasswordResetUnavailable
	}
	if err := validateGuestPassword(password); err != nil {
		return err
	}
	userID, err := s.resets.ConsumePasswordResetTicket(ctx, hashToken(token))
	if err != nil {
		return fmt.Errorf("auth: consume password reset: %w", err)
	}
	if userID == "" {
		return ErrPasswordResetInvalid
	}
	user, err := s.users.GetUser(ctx, userID)
	if errors.Is(err, store.ErrNotFound) {
		// The ticket outlived its account (deleted between mint and use).
		return ErrPasswordResetInvalid
	}
	if err != nil {
		return fmt.Errorf("auth: get user for password reset: %w", err)
	}
	// Re-checked at redemption, not just at minting: the account could have
	// been converted between the two, and a stale ticket must never write a
	// local password onto an SSO account.
	if !supportsPasswordReset(user) {
		return ErrPasswordResetUnsupported
	}

	hashed, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("auth: hash password: %w", err)
	}
	// Field-level: writing back the whole copy read above could undo a
	// deactivation (or demotion) that landed in between.
	hash := string(hashed)
	if err := s.users.PatchUser(ctx, user.ID, store.UserPatch{PasswordHash: &hash, UpdatedAt: time.Now()}); err != nil {
		return fmt.Errorf("auth: update password: %w", err)
	}
	// Evict the cached copy so nothing serves the superseded hash. (Not a
	// refresh with this copy: it may already be stale, and the auth
	// middleware reads status and role from the cache.)
	if err := s.cache.Delete(ctx, "user:"+user.ID); err != nil {
		slog.WarnContext(ctx, "password reset: cache eviction failed", "userID", user.ID, "error", err)
	}
	// Best-effort, and loudly logged: a surviving refresh token after a
	// password reset is a real security gap, but it must not fail a reset the
	// user already completed.
	if err := s.tokens.DeleteAllRefreshTokensForUser(ctx, user.ID); err != nil {
		slog.ErrorContext(ctx, "password reset: revoking existing sessions failed", "userID", user.ID, "error", err)
	}
	// Same reasoning for paired ex-runners: whoever held the old password
	// may have paired a machine to run agents as this account.
	if s.runners != nil {
		if err := s.runners.RevokeAllForUser(ctx, user.ID); err != nil {
			slog.ErrorContext(ctx, "password reset: disconnecting runners failed", "userID", user.ID, "error", err)
		}
	}
	return nil
}

// mintPasswordReset generates the token, stores its hash, and emails the link.
func (s *AuthService) mintPasswordReset(ctx context.Context, user *model.User, byAdmin bool) (*PasswordResetTicket, error) {
	b := make([]byte, passwordResetTokenBytes)
	if _, err := randRead(b); err != nil {
		return nil, fmt.Errorf("auth: generate password reset token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	if err := s.resets.MintPasswordResetTicket(ctx, hashToken(token), user.ID, passwordResetTTL); err != nil {
		return nil, fmt.Errorf("auth: store password reset: %w", err)
	}
	ticket := &PasswordResetTicket{
		URL:       s.baseURL + "/reset-password/" + token,
		ExpiresAt: time.Now().Add(passwordResetTTL),
	}
	ticket.EmailSent = s.deliver(ctx, email.PasswordResetMessage(
		user.Email, ticket.URL, int(passwordResetTTL/time.Hour), byAdmin,
	), "password reset", user.ID)
	return ticket, nil
}

// deliver sends one transactional message, reporting whether it actually went
// out. A failure is logged at ERROR: for the self-service flow the email IS
// the only delivery path, so a silent failure would look to the user like a
// reset that simply never arrived.
func (s *AuthService) deliver(ctx context.Context, msg email.Message, kind, userID string) bool {
	if s.mailer == nil {
		return false
	}
	if err := s.mailer.Send(ctx, msg); err != nil {
		slog.ErrorContext(ctx, "transactional email failed", "kind", kind, "userID", userID, "error", err)
		return false
	}
	return true
}

// validateGuestPassword enforces the local-password rules shared by invite
// acceptance and password reset.
func validateGuestPassword(password string) error {
	if utf8.RuneCountInString(password) < minGuestPasswordLen || len(password) > maxGuestPasswordLen {
		return ErrInvalidPassword
	}
	return nil
}
