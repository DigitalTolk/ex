package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

type recordingGroupRemover struct {
	removed []string
	err     error
}

func (r *recordingGroupRemover) RemoveUserFromAllGroups(_ context.Context, userID string) error {
	r.removed = append(r.removed, userID)
	return r.err
}

func roleFixture() (*UserService, *mockUserStore, *recordingGroupRemover) {
	users := newMockUserStore()
	svc := NewUserService(users, newMockCache(), nil, nil)
	remover := &recordingGroupRemover{}
	svc.SetUserGroups(remover)
	users.users["u-1"] = &model.User{ID: "u-1", Email: "u1@example.com", SystemRole: model.SystemRoleMember, AuthProvider: model.AuthProviderOIDC}
	return svc, users, remover
}

func TestUserService_DemotionToGuestLeavesEveryUserGroup(t *testing.T) {
	svc, users, remover := roleFixture()
	if _, err := svc.UpdateRole(context.Background(), "actor", "u-1", model.SystemRoleGuest); err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if len(remover.removed) != 1 || remover.removed[0] != "u-1" {
		t.Fatalf("removed from groups = %v, want u-1", remover.removed)
	}
	if users.users["u-1"].SystemRole != model.SystemRoleGuest {
		t.Fatal("role not stored")
	}
}

func TestUserService_OtherRoleChangesKeepUserGroups(t *testing.T) {
	svc, _, remover := roleFixture()
	if _, err := svc.UpdateRole(context.Background(), "actor", "u-1", model.SystemRoleAdmin); err != nil {
		t.Fatalf("UpdateRole: %v", err)
	}
	if len(remover.removed) != 0 {
		t.Fatalf("a promotion left groups: %v", remover.removed)
	}
}

func TestUserService_FailedGroupCleanupKeepsTheRole(t *testing.T) {
	svc, users, remover := roleFixture()
	remover.err = errors.New("dynamo down")
	if _, err := svc.UpdateRole(context.Background(), "actor", "u-1", model.SystemRoleGuest); err == nil {
		t.Fatal("UpdateRole succeeded although the user is still in their groups")
	}
	if users.users["u-1"].SystemRole != model.SystemRoleMember {
		t.Fatal("the role changed although the group cleanup failed")
	}
}

func TestUserService_WiredNamesUserGroupMembership(t *testing.T) {
	err := (&UserService{}).Wired()
	if err == nil || !strings.Contains(err.Error(), "user-group membership") {
		t.Fatalf("Wired = %v, want it to name the user-group cleanup", err)
	}
}

func TestSettingsService_UserGroupManagers(t *testing.T) {
	svc := NewSettingsService(&fakeSettingsStore{})
	for _, v := range []model.UserGroupManagers{"", model.UserGroupManagersAdmins, model.UserGroupManagersMembers} {
		got, err := svc.Update(context.Background(), &model.WorkspaceSettings{UserGroupManagers: v})
		if err != nil || got.UserGroupManagers != v {
			t.Errorf("Update(%q) = %+v, %v", v, got, err)
		}
	}
	if _, err := svc.Update(context.Background(), &model.WorkspaceSettings{UserGroupManagers: "everyone"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("Update(everyone) = %v, want a validation error", err)
	}
}

func TestIncomingWebhookService_TranslatesSlackUserGroups(t *testing.T) {
	svc := NewIncomingWebhookService(nil, fakeWebhookChannels{}, nil, nil, "")
	cases := map[string]string{
		"<!subteam^S0123|@oncall> db down": "@oncall db down",
		"<!subteam^S0123|sre> look":        "@sre look",
		"<!subteam^S0123> unlabelled":      "<!subteam^S0123> unlabelled",
	}
	for in, want := range cases {
		if got := svc.TranslateMarkup(context.Background(), in); got != want {
			t.Errorf("TranslateMarkup(%q) = %q, want %q", in, got, want)
		}
	}
}
