package service

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

func seedChannel(channels *mockChannelStore, id string, archived bool) {
	channels.channels[id] = &model.Channel{ID: id, Name: "general", Archived: archived}
}

func seedOwner(memberships *mockMembershipStore, channelID, userID string) {
	memberships.memberships[channelID+"#"+userID] = &model.ChannelMembership{
		ChannelID: channelID, UserID: userID, Role: model.ChannelRoleOwner,
	}
}

func TestChannel_GetVisibleByID_GetError(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	channels.getErr = errors.New("boom")
	if _, err := svc.GetVisibleByID(context.Background(), "u1", "ch1"); err == nil {
		t.Fatal("expected get error")
	}
}

func TestChannel_GetVisibleByID_Forbidden(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	seedChannel(channels, "ch1", false)
	if _, err := svc.GetVisibleByID(context.Background(), "u1", "ch1"); err == nil {
		t.Fatal("expected forbidden for non-member")
	}
}

func TestChannel_GetVisibleByID_Archived(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	seedChannel(channels, "ch1", true)
	if _, err := svc.GetVisibleByID(context.Background(), "u1", "ch1"); err == nil {
		t.Fatal("expected forbidden for archived channel")
	}
}

func TestChannel_GetVisibleBySlug_SlugError(t *testing.T) {
	svc, channels, _, _, _ := setupChannelService()
	channels.slugErr = errors.New("boom")
	if _, err := svc.GetVisibleBySlug(context.Background(), "u1", "general"); err == nil {
		t.Fatal("expected slug lookup error")
	}
}

func TestChannel_Update_NotMember(t *testing.T) {
	svc, _, _, _, _ := setupChannelService()
	name := "new"
	if _, err := svc.Update(context.Background(), "u1", "ch1", &name, nil); err == nil {
		t.Fatal("expected permission error")
	}
}

func TestChannel_Update_GetError(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	seedOwner(memberships, "ch1", "u1")
	channels.getErr = errors.New("boom")
	name := "new"
	if _, err := svc.Update(context.Background(), "u1", "ch1", &name, nil); err == nil {
		t.Fatal("expected get error")
	}
}

func TestChannel_Update_UpdateError(t *testing.T) {
	svc, channels, memberships, _, _ := setupChannelService()
	seedOwner(memberships, "ch1", "u1")
	seedChannel(channels, "ch1", false)
	channels.updateErr = errors.New("boom")
	name := "newname"
	if _, err := svc.Update(context.Background(), "u1", "ch1", &name, nil); err == nil {
		t.Fatal("expected update error")
	}
}

func TestChannel_SetMute_GetMembershipError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.getErr = errors.New("boom")
	if err := svc.SetMute(context.Background(), "u1", "ch1", true); err == nil {
		t.Fatal("expected get membership error")
	}
}

func TestChannel_SetMute_SetMuteError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}
	memberships.setMuteErr = errors.New("boom")
	if err := svc.SetMute(context.Background(), "u1", "ch1", true); err == nil {
		t.Fatal("expected set-mute error")
	}
}

func TestChannel_postSystemMessage_CreateErrorSwallowed(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "U"}
	messages := newMockMessageStore()
	messages.createErr = errors.New("boom")
	svc := NewChannelService(channels, memberships, users, messages, newMockCache(), newMockBroker(), newMockPublisher())
	channels.channels["c1"] = &model.Channel{ID: "c1", Type: model.ChannelTypePublic}
	// The system-message write fails, but AutoJoinChannel still succeeds.
	if err := svc.AutoJoinChannel(context.Background(), "u1", "c1", model.ChannelRoleMember); err != nil {
		t.Fatalf("AutoJoinChannel should succeed despite system-message error: %v", err)
	}
}

func TestChannel_postSystemMessage_NilStoreNoOp(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "U"}
	// nil message store → postSystemMessage short-circuits.
	svc := NewChannelService(channels, memberships, users, nil, newMockCache(), newMockBroker(), newMockPublisher())
	channels.channels["c1"] = &model.Channel{ID: "c1", Type: model.ChannelTypePublic}
	if err := svc.AutoJoinChannel(context.Background(), "u1", "c1", model.ChannelRoleMember); err != nil {
		t.Fatalf("AutoJoinChannel with nil message store: %v", err)
	}
}

func TestChannel_SetFavorite_StoreError(t *testing.T) {
	// Membership check passes, but no user-side channel row exists, so the
	// store SetFavorite returns ErrNotFound.
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}
	if err := svc.SetFavorite(context.Background(), "u1", "ch1", true); err == nil {
		t.Fatal("expected store set-favorite error")
	}
}

func TestChannel_ListMembers_PermissionDenied(t *testing.T) {
	// No membership for the actor → checkPermission rejects before listing.
	svc, _, _, _, _ := setupChannelService()
	if _, err := svc.ListMembers(context.Background(), "stranger", "ch1"); err == nil {
		t.Fatal("expected permission error for non-member")
	}
}

func TestChannel_ListMembers_ListError(t *testing.T) {
	svc, _, memberships, _, _ := setupChannelService()
	memberships.memberships["ch1#u1"] = &model.ChannelMembership{ChannelID: "ch1", UserID: "u1", Role: model.ChannelRoleMember}
	memberships.listMembersErr = errors.New("boom")
	if _, err := svc.ListMembers(context.Background(), "u1", "ch1"); err == nil {
		t.Fatal("expected list-members error")
	}
}
