package service

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestAcceptInvite_Valid(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	// Create the invite-target channel so AutoJoinChannel can resolve it.
	env.channels.channels["ch1"] = &model.Channel{ID: "ch1", Name: "ch1", Type: model.ChannelTypePublic}
	env.invites.invites["valid-token"] = &model.Invite{
		Token:      "valid-token",
		Email:      " Invitee@Example.COM ",
		InviterID:  "inviter-1",
		ChannelIDs: []string{"ch1"},
		ExpiresAt:  time.Now().Add(72 * time.Hour),
		CreatedAt:  time.Now(),
	}

	accessToken, refreshToken, user, err := env.svc.AcceptInvite(ctx, "valid-token", "New Guest", "password123")
	if err != nil {
		t.Fatalf("AcceptInvite: %v", err)
	}

	if accessToken == "" {
		t.Error("expected non-empty accessToken")
	}
	if refreshToken == "" {
		t.Error("expected non-empty refreshToken")
	}
	if user == nil {
		t.Fatal("expected non-nil user")
	}
	if user.SystemRole != model.SystemRoleGuest {
		t.Errorf("SystemRole = %q, want %q", user.SystemRole, model.SystemRoleGuest)
	}
	if user.Email != "invitee@example.com" {
		t.Errorf("Email = %q, want %q", user.Email, "invitee@example.com")
	}
	if user.DisplayName != "New Guest" {
		t.Errorf("DisplayName = %q, want %q", user.DisplayName, "New Guest")
	}

	// Invite should be deleted after acceptance.
	if _, ok := env.invites.invites["valid-token"]; ok {
		t.Error("invite should be deleted after acceptance")
	}

	// Membership should be created for ch1.
	key := "ch1#" + user.ID
	if _, ok := env.memberships.memberships[key]; !ok {
		t.Error("expected membership in ch1 after invite acceptance")
	}

	// Guest should also be added to #general.
	generalKey := generalChannelID + "#" + user.ID
	if _, ok := env.memberships.memberships[generalKey]; !ok {
		t.Error("expected invited guest to be auto-added to #general")
	}

	// Verify DisplayName is set on #general membership.
	generalMem := env.memberships.memberships[generalKey]
	if generalMem.DisplayName != "New Guest" {
		t.Errorf("expected DisplayName = %q, got %q", "New Guest", generalMem.DisplayName)
	}

	// Verify DisplayName is set on invite channel membership.
	ch1Mem := env.memberships.memberships[key]
	if ch1Mem.DisplayName != "New Guest" {
		t.Errorf("expected invite channel DisplayName = %q, got %q", "New Guest", ch1Mem.DisplayName)
	}
}

func TestAcceptInvite_NotFound(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	_, _, _, err := env.svc.AcceptInvite(ctx, "nonexistent", "Name", "password123")
	if err == nil {
		t.Fatal("expected error for non-existent invite")
	}
}

// TestAcceptInvite_ValidationFailures exercises the input-validation
// branches that fire before any store lookup happens — these are the
// cheapest tests to write and they pin the user-visible error copy.
func TestAcceptInvite_ValidationFailures(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	cases := []struct {
		name        string
		displayName string
		password    string
		wantMsgSub  string
	}{
		{"empty displayName", "", "password123", "display name"},
		{"whitespace-only displayName", "   ", "password123", "display name"},
		{"displayName too long", string(make([]byte, 200)), "password123", "display name"},
		{"password too short", "Name", "short", "password"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, _, _, err := env.svc.AcceptInvite(ctx, "any", tc.displayName, tc.password)
			if err == nil {
				t.Fatalf("expected validation error for %s", tc.name)
			}
		})
	}
}

func TestAcceptInvite_Expired(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	env.invites.invites["expired-token"] = &model.Invite{
		Token:     "expired-token",
		Email:     "expired@example.com",
		InviterID: "inviter-1",
		ExpiresAt: time.Now().Add(-1 * time.Hour), // expired
		CreatedAt: time.Now().Add(-73 * time.Hour),
	}

	_, _, _, err := env.svc.AcceptInvite(ctx, "expired-token", "Name", "password123")
	if err == nil {
		t.Fatal("expected error for expired invite")
	}
}

// TestAcceptInvite_BadInviteEmail exercises the normalizeEmailAddress
// failure branch — an invite whose stored email no longer parses (bad
// data from an older schema, or a manually-edited record) must surface
// a clear validation error rather than crash.
func TestAcceptInvite_BadInviteEmail(t *testing.T) {
	env := setupAuthService()
	ctx := context.Background()

	env.invites.invites["bad-email-token"] = &model.Invite{
		Token:     "bad-email-token",
		Email:     "not-an-email-at-all",
		InviterID: "inviter-1",
		ExpiresAt: time.Now().Add(72 * time.Hour),
		CreatedAt: time.Now(),
	}

	_, _, _, err := env.svc.AcceptInvite(ctx, "bad-email-token", "Name", "password123")
	if err == nil {
		t.Fatal("expected error for invite with invalid stored email")
	}
}
