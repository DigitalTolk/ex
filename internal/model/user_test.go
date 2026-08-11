package model

import "testing"

func TestUserManagerEqual(t *testing.T) {
	a := &UserManager{DisplayName: "Boss", Email: "boss@example.com", UserID: "u1"}
	cases := []struct {
		name string
		m, o *UserManager
		want bool
	}{
		{"both nil", nil, nil, true},
		{"nil vs set", nil, a, false},
		{"set vs nil", a, nil, false},
		{"equal values", a, &UserManager{DisplayName: "Boss", Email: "boss@example.com", UserID: "u1"}, true},
		{"different values", a, &UserManager{DisplayName: "Other"}, false},
	}
	for _, tc := range cases {
		if got := tc.m.Equal(tc.o); got != tc.want {
			t.Errorf("%s: Equal = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestUserIsBot(t *testing.T) {
	// Callers use this instead of hardcoding the AuthProvider string.
	if !(&User{AuthProvider: AuthProviderBot}).IsBot() {
		t.Error("a bot account must report IsBot")
	}
	if (&User{AuthProvider: AuthProviderOIDC}).IsBot() {
		t.Error("an SSO user is not a bot")
	}
	var nilUser *User
	if nilUser.IsBot() {
		t.Error("a nil user must not report as a bot")
	}
}
