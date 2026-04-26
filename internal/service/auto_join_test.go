package service

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// TestAutoJoinChannel_PostsSystemMessage verifies T12: signup/invite-accept
// auto-joins must publish a system "joined" message just like manual joins.
func TestAutoJoinChannel_PostsSystemMessage(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	pub := newMockPublisher()

	channels.channels["c1"] = &model.Channel{ID: "c1", Name: "general", Type: model.ChannelTypePublic, CreatedAt: time.Now()}
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice"}

	svc := NewChannelService(channels, memberships, users, messages, &mockCache{}, newMockBroker(), pub)

	if err := svc.AutoJoinChannel(context.Background(), "u1", "c1", model.ChannelRoleMember); err != nil {
		t.Fatalf("auto-join: %v", err)
	}

	// System message persisted
	var sysMsg *model.Message
	for _, m := range messages.messages {
		if m.System && m.ParentID == "c1" {
			sysMsg = m
		}
	}
	if sysMsg == nil {
		t.Fatal("expected a system join message to be persisted")
	}
	if sysMsg.AuthorID != "system" {
		t.Errorf("system message authorID=%q want %q", sysMsg.AuthorID, "system")
	}

	// message.new + members.changed events published
	var sawMsgNew, sawMembersChanged bool
	for _, p := range pub.published {
		if p.event.Type == events.EventMessageNew {
			sawMsgNew = true
		}
		if p.event.Type == events.EventMembersChanged {
			sawMembersChanged = true
		}
	}
	if !sawMsgNew {
		t.Error("expected message.new event for system join message")
	}
	if !sawMembersChanged {
		t.Error("expected members.changed event")
	}
}

// TestAutoJoinChannel_Idempotent verifies a no-op when the user is already
// a member — important because both ensureGeneralChannel and the invite
// accept flow may call AutoJoinChannel for the same channel.
func TestAutoJoinChannel_Idempotent(t *testing.T) {
	channels := newMockChannelStore()
	memberships := newMockMembershipStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	pub := newMockPublisher()

	channels.channels["c1"] = &model.Channel{ID: "c1", Name: "general", Type: model.ChannelTypePublic}
	users.users["u1"] = &model.User{ID: "u1", DisplayName: "Alice"}
	// Pre-existing membership.
	memberships.memberships["c1#u1"] = &model.ChannelMembership{ChannelID: "c1", UserID: "u1", Role: model.ChannelRoleMember, DisplayName: "Alice"}

	svc := NewChannelService(channels, memberships, users, messages, &mockCache{}, newMockBroker(), pub)
	if err := svc.AutoJoinChannel(context.Background(), "u1", "c1", model.ChannelRoleMember); err != nil {
		t.Fatalf("auto-join: %v", err)
	}

	for _, p := range pub.published {
		if p.event.Type == events.EventMembersChanged || p.event.Type == events.EventMessageNew {
			t.Errorf("idempotent auto-join should not republish events, got %v", p.event.Type)
		}
	}
}
