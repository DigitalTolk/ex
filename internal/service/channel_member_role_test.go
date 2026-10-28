package service

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
)

// memberRoleFixture: a channel owned by "owner", with "bob" as a plain member
// and "sa", a system admin who was invited in as a plain member too.
func memberRoleFixture() (*ChannelService, *mockMembershipStore, *mockPublisher) {
	svc, channels, memberships, users, _, publisher := setupChannelServiceWithUsers()
	channels.channels["ch-r"] = &model.Channel{ID: "ch-r", Name: "ops", Slug: "ops", Type: model.ChannelTypePrivate}
	users.users["sa"] = &model.User{ID: "sa", DisplayName: "Sys Admin", SystemRole: model.SystemRoleAdmin}
	for id, role := range map[string]model.ChannelRole{"owner": model.ChannelRoleOwner, "bob": model.ChannelRoleMember, "sa": model.ChannelRoleMember} {
		memberships.memberships["ch-r#"+id] = &model.ChannelMembership{ChannelID: "ch-r", UserID: id, Role: role}
	}
	return svc, memberships, publisher
}

func TestChannelService_UpdateMemberRole_SystemAdminHandsTheChannelToANewOwner(t *testing.T) {
	svc, memberships, publisher := memberRoleFixture()
	ctx := context.Background()

	if err := svc.UpdateMemberRole(ctx, "sa", "ch-r", "bob", model.ChannelRoleOwner); err != nil {
		t.Fatalf("make bob owner: %v", err)
	}
	if err := svc.UpdateMemberRole(ctx, "sa", "ch-r", "owner", model.ChannelRoleMember); err != nil {
		t.Fatalf("demote the old owner: %v", err)
	}
	if got := memberships.memberships["ch-r#bob"].Role; got != model.ChannelRoleOwner {
		t.Errorf("bob = %s, want owner", got)
	}
	if got := memberships.memberships["ch-r#owner"].Role; got != model.ChannelRoleMember {
		t.Errorf("old owner = %s, want member", got)
	}

	// Each change reaches every member, naming who changed and to what.
	publisher.mu.Lock()
	defer publisher.mu.Unlock()
	var changes []map[string]any
	for _, p := range publisher.published {
		if p.event.Type != events.EventMembersChanged {
			continue
		}
		if p.channel != pubsub.ChannelName("ch-r") {
			t.Errorf("members.changed went to %q", p.channel)
		}
		var payload map[string]any
		if err := json.Unmarshal(p.event.Data, &payload); err != nil {
			t.Fatal(err)
		}
		changes = append(changes, payload)
	}
	if len(changes) != 2 {
		t.Fatalf("members.changed events = %d, want 2", len(changes))
	}
	if changes[0]["userID"] != "bob" || changes[0]["role"] != "owner" || changes[0]["action"] != events.MemberActionRoleChanged {
		t.Errorf("first change = %v", changes[0])
	}
	if changes[1]["userID"] != "owner" || changes[1]["role"] != "member" {
		t.Errorf("second change = %v", changes[1])
	}
}

func TestChannelService_UpdateMemberRole_FailedWriteAnnouncesNothing(t *testing.T) {
	svc, memberships, publisher := memberRoleFixture()
	memberships.updateRoleErr = errors.New("dynamo down")
	if err := svc.UpdateMemberRole(context.Background(), "sa", "ch-r", "bob", model.ChannelRoleAdmin); err == nil {
		t.Fatal("a failed write must fail the call")
	}
	if len(publishedTo(publisher, events.EventMembersChanged)) != 0 {
		t.Fatal("a role that was never written must not be announced")
	}
}

func TestChannelService_Update_SystemAdminMemberRenamesAndDescribes(t *testing.T) {
	svc, _, _ := memberRoleFixture()
	name, desc := "ops-team", "On call"
	ch, err := svc.Update(context.Background(), "sa", "ch-r", &name, &desc)
	if err != nil {
		t.Fatalf("Update by a system admin: %v", err)
	}
	if ch.Name != name || ch.Slug != "ops-team" || ch.Description != desc {
		t.Fatalf("channel = %+v", ch)
	}
	if _, err := svc.Update(context.Background(), "bob", "ch-r", &name, nil); err == nil {
		t.Fatal("a plain member must not rename the channel")
	}
}
