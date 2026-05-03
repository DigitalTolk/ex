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
		Email:      "invitee@example.com",
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
