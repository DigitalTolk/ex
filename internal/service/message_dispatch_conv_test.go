package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// A DM send loads its conversation once, for the access check, and hands that
// same row to the agent dispatcher: the 1:1-DM auto-invoke decides from it
// instead of reading the conversation a second time.
func TestSendHandsTheLoadedConversationToTheAgentDispatcher(t *testing.T) {
	svc, _, _, conversations, _ := setupMessageService()
	dm := &model.Conversation{ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-alice", "u-bot"}, Activated: true}
	conversations.conversations["dm-1"] = dm
	dispatcher := msgagCovNewDispatcher()
	svc.SetAgentDispatcher(dispatcher)

	if _, err := svc.Send(context.Background(), "u-alice", "dm-1", ParentConversation, "hi", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	msgagCovWait(t, dispatcher.done)

	calls := dispatcher.snapshot()
	if len(calls) != 1 || calls[0].conv != dm {
		t.Fatalf("dispatched conversation = %+v, want the row the send loaded", calls)
	}
	if conversations.getCalls.Load() != 1 {
		t.Errorf("conversation reads = %d, want 1", conversations.getCalls.Load())
	}
}

// A channel post has no conversation to hand on.
func TestSendDispatchesChannelPostsWithoutAConversation(t *testing.T) {
	svc, _, memberships, _, _ := setupMessageService()
	memberships.memberships["ch-1#u-alice"] = &model.ChannelMembership{ChannelID: "ch-1", UserID: "u-alice", Role: model.ChannelRoleMember}
	dispatcher := msgagCovNewDispatcher()
	svc.SetAgentDispatcher(dispatcher)

	if _, err := svc.Send(context.Background(), "u-alice", "ch-1", ParentChannel, "hi", ""); err != nil {
		t.Fatalf("Send: %v", err)
	}
	msgagCovWait(t, dispatcher.done)

	if calls := dispatcher.snapshot(); len(calls) != 1 || calls[0].conv != nil {
		t.Fatalf("dispatched = %+v, want one call with no conversation", calls)
	}
}
