package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// Account deactivation and password reset disconnect the account's paired
// runners (a runner is a machine credential of the same account).

var errRevokeFake = errors.New("revoke fake failure")

type rtFakeRevoker struct {
	revoked []string
	err     error
}

func (r *rtFakeRevoker) RevokeAllForUser(_ context.Context, userID string) error {
	r.revoked = append(r.revoked, userID)
	return r.err
}

func TestUserService_Deactivate_DisconnectsRunners(t *testing.T) {
	users := newMockUserStore()
	svc := NewUserService(users, nil, nil, &mockPublisher{})
	revoker := &rtFakeRevoker{}
	svc.SetRunnerRevoker(revoker)
	users.users["u-r"] = &model.User{ID: "u-r", SystemRole: model.SystemRoleGuest, AuthProvider: model.AuthProviderGuest, Status: "active"}

	if _, err := svc.SetStatus(context.Background(), "u-r", false); err != nil {
		t.Fatalf("reactivate no-op: %v", err)
	}
	if len(revoker.revoked) != 0 {
		t.Fatal("reactivation must not touch runners")
	}
	if _, err := svc.SetStatus(context.Background(), "u-r", true); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if len(revoker.revoked) != 1 || revoker.revoked[0] != "u-r" {
		t.Fatalf("revoked = %v", revoker.revoked)
	}
}

func TestResetPassword_DisconnectsRunnersEvenIfThatFails(t *testing.T) {
	for _, revokeErr := range []error{nil, errRevokeFake} {
		env := setupPasswordReset(t)
		revoker := &rtFakeRevoker{err: revokeErr}
		env.svc.SetRunnerRevoker(revoker)
		env.resets.tickets[hashToken("tok")] = "u-guest"
		if err := env.svc.ResetPassword(context.Background(), "tok", "long-enough-password"); err != nil {
			t.Fatalf("ResetPassword (revoke err %v) = %v", revokeErr, err)
		}
		if len(revoker.revoked) != 1 || revoker.revoked[0] != "u-guest" {
			t.Fatalf("revoked = %v", revoker.revoked)
		}
	}
}
