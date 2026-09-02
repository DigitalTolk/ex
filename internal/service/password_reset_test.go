package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/email"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
	"golang.org/x/crypto/bcrypt"
)

// --- Mock PasswordResetStore ---

type mockResetStore struct {
	mu         sync.Mutex
	tickets    map[string]string // tokenHash -> userID
	ttls       map[string]time.Duration
	mintErr    error
	consumeErr error
}

func newMockResetStore() *mockResetStore {
	return &mockResetStore{tickets: map[string]string{}, ttls: map[string]time.Duration{}}
}

func (m *mockResetStore) MintPasswordResetTicket(_ context.Context, tokenHash, userID string, ttl time.Duration) error {
	if m.mintErr != nil {
		return m.mintErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.tickets[tokenHash] = userID
	m.ttls[tokenHash] = ttl
	return nil
}

func (m *mockResetStore) ConsumePasswordResetTicket(_ context.Context, tokenHash string) (string, error) {
	if m.consumeErr != nil {
		return "", m.consumeErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	userID, ok := m.tickets[tokenHash]
	if !ok {
		return "", nil
	}
	// Single-use, exactly like the Redis GETDEL it stands in for.
	delete(m.tickets, tokenHash)
	return userID, nil
}

// --- Mock email.Sender ---

type mockMailer struct {
	mu   sync.Mutex
	sent []email.Message
	err  error
}

func (m *mockMailer) Send(_ context.Context, msg email.Message) error {
	if m.err != nil {
		return m.err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sent = append(m.sent, msg)
	return nil
}

func (m *mockMailer) last() email.Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.sent) == 0 {
		return email.Message{}
	}
	return m.sent[len(m.sent)-1]
}

type resetTestEnv struct {
	*authTestEnv
	resets *mockResetStore
	mailer *mockMailer
}

// setupPasswordReset wires an AuthService with reset tickets and a mailer, plus
// one guest and one SSO user to act on.
func setupPasswordReset(t *testing.T) *resetTestEnv {
	t.Helper()
	env := setupAuthService()
	resets := newMockResetStore()
	mailer := &mockMailer{}
	env.svc.SetPasswordResetStore(resets)
	env.svc.SetMailer(mailer, "https://ex.example.com")

	guest := &model.User{
		ID: "u-guest", Email: "guest@example.com", DisplayName: "Guest User",
		SystemRole: model.SystemRoleGuest, AuthProvider: model.AuthProviderGuest,
		PasswordHash: "old-hash", Status: "active",
	}
	sso := &model.User{
		ID: "u-sso", Email: "sso@example.com", DisplayName: "SSO User",
		SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC,
		Status: "active",
	}
	env.users.users[guest.ID] = guest
	env.users.emailIndex[guest.Email] = guest
	env.users.users[sso.ID] = sso
	env.users.emailIndex[sso.Email] = sso

	return &resetTestEnv{authTestEnv: env, resets: resets, mailer: mailer}
}

// tokenFromURL extracts the raw reset token out of a minted link.
func tokenFromURL(t *testing.T, url string) string {
	t.Helper()
	const prefix = "https://ex.example.com/reset-password/"
	if !strings.HasPrefix(url, prefix) {
		t.Fatalf("reset URL = %q, want %q prefix", url, prefix)
	}
	return strings.TrimPrefix(url, prefix)
}

// An admin reset mints a usable link and emails it to the guest.
func TestCreatePasswordResetForUser_GuestSucceeds(t *testing.T) {
	env := setupPasswordReset(t)

	ticket, err := env.svc.CreatePasswordResetForUser(context.Background(), "u-guest")
	if err != nil {
		t.Fatalf("CreatePasswordResetForUser = %v", err)
	}
	if !ticket.EmailSent {
		t.Error("EmailSent = false, want true when the mailer accepts the message")
	}
	if ticket.ExpiresAt.Before(time.Now()) {
		t.Errorf("ExpiresAt = %v, want a future time", ticket.ExpiresAt)
	}
	token := tokenFromURL(t, ticket.URL)
	if len(token) < 40 {
		t.Errorf("token %q is too short to be 32 bytes of entropy", token)
	}
	// The ticket is stored under the token's HASH, never the token itself —
	// a Redis dump must not yield usable reset links.
	if _, raw := env.resets.tickets[token]; raw {
		t.Error("reset ticket stored under the raw token; must be stored hashed")
	}
	if got := env.resets.tickets[hashToken(token)]; got != "u-guest" {
		t.Errorf("stored ticket = %q, want u-guest", got)
	}
	if got := env.resets.ttls[hashToken(token)]; got != passwordResetTTL {
		t.Errorf("ticket TTL = %v, want %v", got, passwordResetTTL)
	}

	msg := env.mailer.last()
	if msg.To != "guest@example.com" {
		t.Errorf("email To = %q, want guest@example.com", msg.To)
	}
	if !strings.Contains(msg.Text, ticket.URL) {
		t.Errorf("email body does not carry the reset link: %q", msg.Text)
	}
	if !strings.Contains(msg.Text, "administrator") {
		t.Errorf("admin-initiated email should say so: %q", msg.Text)
	}
}

// The load-bearing guard: an SSO account can never be reset, because its
// credential lives in the identity provider.
func TestCreatePasswordResetForUser_SSORejected(t *testing.T) {
	env := setupPasswordReset(t)

	_, err := env.svc.CreatePasswordResetForUser(context.Background(), "u-sso")
	if !errors.Is(err, ErrPasswordResetUnsupported) {
		t.Fatalf("err = %v, want ErrPasswordResetUnsupported", err)
	}
	if len(env.resets.tickets) != 0 {
		t.Error("a ticket was minted for an SSO account")
	}
	if len(env.mailer.sent) != 0 {
		t.Error("an email was sent for an SSO account")
	}
}

// An SSO user DEMOTED to the guest role is still IdP-managed: the guard keys
// on AuthProvider, not SystemRole.
func TestCreatePasswordResetForUser_SSODemotedToGuestRoleStillRejected(t *testing.T) {
	env := setupPasswordReset(t)
	env.users.users["u-sso"].SystemRole = model.SystemRoleGuest

	_, err := env.svc.CreatePasswordResetForUser(context.Background(), "u-sso")
	if !errors.Is(err, ErrPasswordResetUnsupported) {
		t.Fatalf("err = %v, want ErrPasswordResetUnsupported", err)
	}
}

// Rows written before AuthProvider existed are classified by whether they
// carry a password, so a legacy guest is still resettable and a legacy SSO
// user still is not.
func TestSupportsPasswordReset_LegacyRows(t *testing.T) {
	cases := []struct {
		name string
		user *model.User
		want bool
	}{
		{"nil user", nil, false},
		{"legacy row with a password is a guest", &model.User{ID: "a", PasswordHash: "x"}, true},
		{"legacy row without a password is SSO", &model.User{ID: "b"}, false},
		{"explicit guest", &model.User{ID: "c", AuthProvider: model.AuthProviderGuest}, true},
		{"explicit oidc", &model.User{ID: "d", AuthProvider: model.AuthProviderOIDC}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := supportsPasswordReset(tc.user); got != tc.want {
				t.Errorf("supportsPasswordReset = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestCreatePasswordResetForUser_Errors(t *testing.T) {
	t.Run("no reset store wired", func(t *testing.T) {
		env := setupAuthService()
		_, err := env.svc.CreatePasswordResetForUser(context.Background(), "u-guest")
		if !errors.Is(err, ErrPasswordResetUnavailable) {
			t.Fatalf("err = %v, want ErrPasswordResetUnavailable", err)
		}
	})

	t.Run("unknown user", func(t *testing.T) {
		env := setupPasswordReset(t)
		_, err := env.svc.CreatePasswordResetForUser(context.Background(), "nobody")
		if !errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want store.ErrNotFound", err)
		}
	})

	t.Run("store failure", func(t *testing.T) {
		env := setupPasswordReset(t)
		env.users.getUserErr = errors.New("dynamo down")
		_, err := env.svc.CreatePasswordResetForUser(context.Background(), "u-guest")
		if err == nil || errors.Is(err, store.ErrNotFound) {
			t.Fatalf("err = %v, want a wrapped store failure", err)
		}
	})

	t.Run("ticket store failure", func(t *testing.T) {
		env := setupPasswordReset(t)
		env.resets.mintErr = errors.New("redis down")
		_, err := env.svc.CreatePasswordResetForUser(context.Background(), "u-guest")
		if err == nil {
			t.Fatal("expected the mint failure to surface")
		}
	})

	t.Run("entropy failure", func(t *testing.T) {
		env := setupPasswordReset(t)
		restore := randRead
		randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
		defer func() { randRead = restore }()

		_, err := env.svc.CreatePasswordResetForUser(context.Background(), "u-guest")
		if err == nil {
			t.Fatal("expected the CSPRNG failure to surface")
		}
	})
}

// A minted link still works when mail is down — the admin relays it by hand.
// EmailSent is what tells them which of those two happened.
func TestCreatePasswordReset_MailFailureStillReturnsLink(t *testing.T) {
	env := setupPasswordReset(t)
	env.mailer.err = errors.New("relay refused")

	ticket, err := env.svc.CreatePasswordResetForUser(context.Background(), "u-guest")
	if err != nil {
		t.Fatalf("a mail failure must not fail the reset: %v", err)
	}
	if ticket.EmailSent {
		t.Error("EmailSent = true after the mailer failed")
	}
	if ticket.URL == "" {
		t.Error("no link returned; the admin has no way to relay the reset")
	}
}

func TestCreatePasswordReset_NoMailerConfigured(t *testing.T) {
	env := setupPasswordReset(t)
	env.svc.SetMailer(nil, "https://ex.example.com")

	ticket, err := env.svc.CreatePasswordResetForUser(context.Background(), "u-guest")
	if err != nil {
		t.Fatalf("CreatePasswordResetForUser = %v", err)
	}
	if ticket.EmailSent {
		t.Error("EmailSent = true with no mailer wired")
	}
	if ticket.URL == "" {
		t.Error("no link returned with no mailer wired")
	}
}

// --- Self-service request ---

func TestRequestPasswordReset_GuestGetsLink(t *testing.T) {
	env := setupPasswordReset(t)

	if err := env.svc.RequestPasswordReset(context.Background(), "  Guest@Example.com "); err != nil {
		t.Fatalf("RequestPasswordReset = %v", err)
	}
	if len(env.resets.tickets) != 1 {
		t.Fatalf("tickets minted = %d, want 1", len(env.resets.tickets))
	}
	msg := env.mailer.last()
	if msg.To != "guest@example.com" {
		t.Errorf("email To = %q, want guest@example.com", msg.To)
	}
	// Self-service wording, not the admin variant.
	if strings.Contains(msg.Text, "administrator") {
		t.Errorf("self-service email should not claim an admin started it: %q", msg.Text)
	}
}

// No caller may learn whether an address exists, whether it is a guest, or
// whether mail went out: every one of these answers success and does nothing.
func TestRequestPasswordReset_NeverEnumerates(t *testing.T) {
	cases := []struct {
		name  string
		email string
		setup func(*resetTestEnv)
	}{
		{"unknown address", "nobody@example.com", nil},
		{"SSO address", "sso@example.com", nil},
		{"malformed address", "not-an-email", nil},
		{"empty address", "", nil},
		{"store failure", "guest@example.com", func(e *resetTestEnv) {
			e.users.getEmailErr = errors.New("dynamo down")
		}},
		{"ticket store failure", "guest@example.com", func(e *resetTestEnv) {
			e.resets.mintErr = errors.New("redis down")
		}},
		{"mail failure", "guest@example.com", func(e *resetTestEnv) {
			e.mailer.err = errors.New("relay refused")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := setupPasswordReset(t)
			if tc.setup != nil {
				tc.setup(env)
			}
			if err := env.svc.RequestPasswordReset(context.Background(), tc.email); err != nil {
				t.Fatalf("RequestPasswordReset leaked an error: %v", err)
			}
		})
	}
}

func TestRequestPasswordReset_NoStoreWired(t *testing.T) {
	env := setupAuthService()
	if err := env.svc.RequestPasswordReset(context.Background(), "guest@example.com"); !errors.Is(err, ErrPasswordResetUnavailable) {
		t.Fatalf("err = %v, want ErrPasswordResetUnavailable", err)
	}
}

// --- Redemption ---

// The whole flow: mint a link, redeem it, and the new password is the one that
// works from then on.
func TestResetPassword_EndToEnd(t *testing.T) {
	env := setupPasswordReset(t)
	ctx := context.Background()
	// A live session that must not survive the reset.
	env.tokens.tokens["hash-1"] = &model.RefreshToken{TokenHash: "hash-1", UserID: "u-guest"}

	ticket, err := env.svc.CreatePasswordResetForUser(ctx, "u-guest")
	if err != nil {
		t.Fatalf("CreatePasswordResetForUser = %v", err)
	}
	token := tokenFromURL(t, ticket.URL)

	if err := env.svc.ResetPassword(ctx, token, "brand-new-password"); err != nil {
		t.Fatalf("ResetPassword = %v", err)
	}

	stored := env.users.users["u-guest"]
	if err := bcrypt.CompareHashAndPassword([]byte(stored.PasswordHash), []byte("brand-new-password")); err != nil {
		t.Errorf("the new password does not verify against the stored hash: %v", err)
	}
	if len(env.tokens.tokens) != 0 {
		t.Error("existing refresh tokens survived a password reset")
	}
	if _, cached := env.cache.users["u-guest"]; !cached {
		t.Error("the cached user was not refreshed with the new hash")
	}

	// Single-use: the same link cannot be redeemed twice.
	if err := env.svc.ResetPassword(ctx, token, "another-password"); !errors.Is(err, ErrPasswordResetInvalid) {
		t.Fatalf("second redemption err = %v, want ErrPasswordResetInvalid", err)
	}
}

// A guest who reset their password can sign in with it immediately.
func TestResetPassword_ThenGuestLoginSucceeds(t *testing.T) {
	env := setupPasswordReset(t)
	ctx := context.Background()

	ticket, err := env.svc.CreatePasswordResetForUser(ctx, "u-guest")
	if err != nil {
		t.Fatalf("CreatePasswordResetForUser = %v", err)
	}
	if err := env.svc.ResetPassword(ctx, tokenFromURL(t, ticket.URL), "brand-new-password"); err != nil {
		t.Fatalf("ResetPassword = %v", err)
	}

	if _, _, _, err := env.svc.GuestLogin(ctx, "guest@example.com", "brand-new-password"); err != nil {
		t.Fatalf("GuestLogin with the new password = %v", err)
	}
	if _, _, _, err := env.svc.GuestLogin(ctx, "guest@example.com", "old-password"); err == nil {
		t.Fatal("the old password still works after a reset")
	}
}

func TestResetPassword_Errors(t *testing.T) {
	t.Run("no reset store wired", func(t *testing.T) {
		env := setupAuthService()
		if err := env.svc.ResetPassword(context.Background(), "tok", "long-enough-password"); !errors.Is(err, ErrPasswordResetUnavailable) {
			t.Fatalf("err = %v, want ErrPasswordResetUnavailable", err)
		}
	})

	t.Run("password too short", func(t *testing.T) {
		env := setupPasswordReset(t)
		if err := env.svc.ResetPassword(context.Background(), "tok", "short"); err == nil {
			t.Fatal("expected a length error")
		}
	})

	t.Run("unknown token", func(t *testing.T) {
		env := setupPasswordReset(t)
		if err := env.svc.ResetPassword(context.Background(), "nope", "long-enough-password"); !errors.Is(err, ErrPasswordResetInvalid) {
			t.Fatal("expected ErrPasswordResetInvalid for an unknown token")
		}
	})

	t.Run("ticket store failure", func(t *testing.T) {
		env := setupPasswordReset(t)
		env.resets.consumeErr = errors.New("redis down")
		if err := env.svc.ResetPassword(context.Background(), "tok", "long-enough-password"); err == nil {
			t.Fatal("expected the consume failure to surface")
		}
	})

	t.Run("account vanished between mint and redemption", func(t *testing.T) {
		env := setupPasswordReset(t)
		env.resets.tickets[hashToken("tok")] = "ghost-user"
		if err := env.svc.ResetPassword(context.Background(), "tok", "long-enough-password"); err == nil {
			t.Fatal("expected the missing account to surface")
		}
	})

	t.Run("account converted to SSO between mint and redemption", func(t *testing.T) {
		env := setupPasswordReset(t)
		ctx := context.Background()
		ticket, err := env.svc.CreatePasswordResetForUser(ctx, "u-guest")
		if err != nil {
			t.Fatalf("CreatePasswordResetForUser = %v", err)
		}
		env.users.users["u-guest"].AuthProvider = model.AuthProviderOIDC

		if err := env.svc.ResetPassword(ctx, tokenFromURL(t, ticket.URL), "long-enough-password"); !errors.Is(err, ErrPasswordResetUnsupported) {
			t.Fatalf("err = %v, want ErrPasswordResetUnsupported — a stale ticket must never write a local password onto an SSO account", err)
		}
	})

	t.Run("bcrypt rejects an over-long password", func(t *testing.T) {
		env := setupPasswordReset(t)
		env.resets.tickets[hashToken("tok")] = "u-guest"
		// Within maxGuestPasswordLen but past bcrypt's 72-byte input limit.
		if err := env.svc.ResetPassword(context.Background(), "tok", strings.Repeat("a", 100)); err == nil {
			t.Fatal("expected the bcrypt failure to surface")
		}
	})

	t.Run("user store write failure", func(t *testing.T) {
		env := setupPasswordReset(t)
		env.resets.tickets[hashToken("tok")] = "u-guest"
		env.users.updateErr = errors.New("dynamo down")
		if err := env.svc.ResetPassword(context.Background(), "tok", "long-enough-password"); err == nil {
			t.Fatal("expected the update failure to surface")
		}
	})
}

// A cache or revocation hiccup is logged, not fatal: the user already chose a
// new password and must not be told it failed.
func TestResetPassword_DegradedDependenciesStillSucceed(t *testing.T) {
	env := setupPasswordReset(t)
	env.resets.tickets[hashToken("tok")] = "u-guest"
	env.cache.setErr = errors.New("redis down")
	env.tokens.deleteErr = errors.New("dynamo down")

	if err := env.svc.ResetPassword(context.Background(), "tok", "long-enough-password"); err != nil {
		t.Fatalf("ResetPassword = %v", err)
	}
	stored := env.users.users["u-guest"]
	if err := bcrypt.CompareHashAndPassword([]byte(stored.PasswordHash), []byte("long-enough-password")); err != nil {
		t.Errorf("the password was not actually changed: %v", err)
	}
}

func TestValidateGuestPassword(t *testing.T) {
	cases := []struct {
		name     string
		password string
		wantErr  bool
	}{
		{"too short", "short", true},
		{"empty", "", true},
		{"at the minimum", "12345678", false},
		{"over the maximum", strings.Repeat("a", maxGuestPasswordLen+1), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateGuestPassword(tc.password)
			if (err != nil) != tc.wantErr {
				t.Errorf("validateGuestPassword(%d chars) = %v, wantErr %v", len(tc.password), err, tc.wantErr)
			}
		})
	}
}
