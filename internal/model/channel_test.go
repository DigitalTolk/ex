package model

import "testing"

func TestParseChannelRole(t *testing.T) {
	tests := []struct {
		input string
		want  ChannelRole
	}{
		{"owner", ChannelRoleOwner},
		{"admin", ChannelRoleAdmin},
		{"member", ChannelRoleMember},
		{"", ChannelRoleMember},
		{"unknown", ChannelRoleMember},
		{"OWNER", ChannelRoleMember}, // case-sensitive, falls through to default
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := ParseChannelRole(tt.input)
			if got != tt.want {
				t.Errorf("ParseChannelRole(%q) = %d, want %d", tt.input, got, tt.want)
			}
		})
	}
}

func TestChannelRoleString(t *testing.T) {
	tests := []struct {
		role ChannelRole
		want string
	}{
		{ChannelRoleMember, "member"},
		{ChannelRoleAdmin, "admin"},
		{ChannelRoleOwner, "owner"},
		{ChannelRole(0), "unknown"},
		{ChannelRole(99), "unknown"},
	}

	for _, tt := range tests {
		t.Run(tt.want, func(t *testing.T) {
			got := tt.role.String()
			if got != tt.want {
				t.Errorf("ChannelRole(%d).String() = %q, want %q", tt.role, got, tt.want)
			}
		})
	}
}
