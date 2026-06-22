package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

func TestHandleOIDCLogin_RandError(t *testing.T) {
	env := setupAuthService()
	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	defer func() { randRead = orig }()
	if _, _, _, err := env.svc.HandleOIDCLogin(); err == nil {
		t.Fatal("expected rand error from HandleOIDCLogin")
	}
}

func TestHandleOIDCCallback_BadEmailFromProvider(t *testing.T) {
	env := setupAuthService()
	env.oidc.userInfo.Email = "not-an-email"
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err == nil {
		t.Fatal("expected normalize-email error")
	}
}

func TestHandleOIDCCallback_CreateUserAlreadyExists(t *testing.T) {
	env := setupAuthService()
	// New user (not in email index) but CreateUser races to ErrAlreadyExists.
	env.users.createErr = store.ErrAlreadyExists
	if _, _, _, err := env.svc.HandleOIDCCallback(context.Background(), "code", "state", "nonce"); err == nil {
		t.Fatal("expected already-exists error")
	}
}

func TestCreateDesktopAuthSession_RandError(t *testing.T) {
	env := setupAuthService()
	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	defer func() { randRead = orig }()
	if _, err := env.svc.CreateDesktopAuthSession(context.Background(), "a", "r"); err == nil {
		t.Fatal("expected rand error")
	}
}

func TestCreateInvite_RandError(t *testing.T) {
	env := setupAuthService()
	orig := randRead
	randRead = func([]byte) (int, error) { return 0, errors.New("no entropy") }
	defer func() { randRead = orig }()
	if _, err := env.svc.CreateInvite(context.Background(), "inviter", "guest@example.com", nil); err == nil {
		t.Fatal("expected rand error")
	}
}

func TestAcceptInvite_BcryptError(t *testing.T) {
	env := setupAuthService()
	env.invites.invites["tok"] = &model.Invite{
		Token:     "tok",
		Email:     "guest@example.com",
		InviterID: "inviter",
		ExpiresAt: time.Now().Add(time.Hour),
	}
	// A password longer than 72 bytes but within maxGuestPasswordLen passes
	// validation and trips bcrypt's password-too-long error.
	longPw := strings.Repeat("a", 100)
	if _, _, _, err := env.svc.AcceptInvite(context.Background(), "tok", "Guest", longPw); err == nil {
		t.Fatal("expected bcrypt password-too-long error")
	}
}

func TestAcceptInvite_CreateUserAlreadyExists(t *testing.T) {
	env := setupAuthService()
	env.invites.invites["tok"] = &model.Invite{
		Token:     "tok",
		Email:     "guest@example.com",
		InviterID: "inviter",
		ExpiresAt: time.Now().Add(time.Hour),
	}
	env.users.createErr = store.ErrAlreadyExists
	if _, _, _, err := env.svc.AcceptInvite(context.Background(), "tok", "Guest", "password123"); err == nil {
		t.Fatal("expected already-exists error")
	}
}

func TestGuestLogin_BadEmail(t *testing.T) {
	env := setupAuthService()
	if _, _, _, err := env.svc.GuestLogin(context.Background(), "not-an-email", "password123"); err == nil {
		t.Fatal("expected invalid-credentials for bad email")
	}
}
