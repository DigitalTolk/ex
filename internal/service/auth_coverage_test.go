package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"golang.org/x/crypto/bcrypt"
)

// GUEST_LOGIN_ANY_ROLE (dev stacks): the role gate lifts, the password check
// still stands.
func TestAuthCov_GuestLoginAnyRole(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	hashed, _ := bcrypt.GenerateFromPassword([]byte("pw-123"), bcrypt.MinCost)
	member := &model.User{
		ID:           "member-9",
		Email:        "member9@example.com",
		DisplayName:  "Member Nine",
		SystemRole:   model.SystemRoleMember,
		PasswordHash: string(hashed),
		Status:       "active",
	}
	env.users.users[member.ID] = member
	env.users.emailIndex[member.Email] = member

	// Gate down (default): a non-guest account is indistinguishable from a
	// wrong password.
	if _, _, _, err := env.svc.GuestLogin(ctx, member.Email, "pw-123"); err == nil {
		t.Fatal("member login with gate down: want error")
	}

	// Gate lifted: same account logs in — but only with the right password.
	env.svc.SetGuestLoginAnyRole(true)
	access, _, u, err := env.svc.GuestLogin(ctx, member.Email, "pw-123")
	if err != nil {
		t.Fatalf("member login with gate lifted: %v", err)
	}
	if access == "" || u.ID != member.ID {
		t.Fatalf("lifted login result: token=%q user=%+v", access, u)
	}
	if _, _, _, err := env.svc.GuestLogin(ctx, member.Email, "wrong"); err == nil {
		t.Fatal("lifted gate must not skip the password check")
	}
}
