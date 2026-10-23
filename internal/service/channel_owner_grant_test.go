package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// Regression: AddMember let a channel ADMIN invite someone straight in as
// OWNER, although UpdateMemberRole refuses an admin that promotion. Granting
// owner takes an owner or a system admin; an admin's owner grant lands as admin.
func TestChannelService_AddMember_OwnerGrantNeedsOwnerOrSystemAdmin(t *testing.T) {
	cases := []struct {
		name     string
		actor    string
		role     model.ChannelRole // actor's channel role (0 = not a member)
		sysAdmin bool
		want     model.ChannelRole
	}{
		{name: "admin is clamped to admin", actor: "admin-1", role: model.ChannelRoleAdmin, want: model.ChannelRoleAdmin},
		{name: "owner may grant owner", actor: "owner-1", role: model.ChannelRoleOwner, want: model.ChannelRoleOwner},
		{name: "system admin may grant owner", actor: "sys-1", role: model.ChannelRoleMember, sysAdmin: true, want: model.ChannelRoleOwner},
		{name: "member is clamped to member", actor: "member-1", role: model.ChannelRoleMember, want: model.ChannelRoleMember},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			svc, channels, memberships, users, _, _ := setupChannelServiceWithUsers()
			channels.channels["ch-own"] = &model.Channel{ID: "ch-own", Name: "own", Type: model.ChannelTypePublic}
			memberships.memberships["ch-own#"+tc.actor] = &model.ChannelMembership{ChannelID: "ch-own", UserID: tc.actor, Role: tc.role}
			sysRole := model.SystemRoleMember
			if tc.sysAdmin {
				sysRole = model.SystemRoleAdmin
			}
			users.users[tc.actor] = &model.User{ID: tc.actor, SystemRole: sysRole}

			if err := svc.AddMember(context.Background(), tc.actor, "ch-own", "newcomer", model.ChannelRoleOwner); err != nil {
				t.Fatalf("AddMember: %v", err)
			}
			got := memberships.memberships["ch-own#newcomer"]
			if got == nil || got.Role != tc.want {
				t.Fatalf("newcomer role = %+v, want %s", got, tc.want)
			}
		})
	}
}
