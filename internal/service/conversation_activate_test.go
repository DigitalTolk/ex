package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// TestCreateGroup_DoesNotPublishConversationNew verifies T6: new groups must
// not propagate to clients until the first message is sent.
func TestCreateGroup_DoesNotPublishConversationNew(t *testing.T) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "A"}
	users.users["b"] = &model.User{ID: "b", DisplayName: "B"}
	pub := newMockPublisher()
	svc := NewConversationService(convs, users, &mockCache{}, newMockBroker(), pub)

	if _, err := svc.CreateGroup(context.Background(), "a", []string{"b"}, ""); err != nil {
		t.Fatalf("create: %v", err)
	}
	for _, p := range pub.published {
		if p.event.Type == events.EventConversationNew {
			t.Fatalf("CreateGroup must not publish conversation.new; got %v", p.event.Type)
		}
	}
}

// TestGetOrCreateDM_DoesNotPublishConversationNew verifies T6 for DMs.
func TestGetOrCreateDM_DoesNotPublishConversationNew(t *testing.T) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "A"}
	users.users["b"] = &model.User{ID: "b", DisplayName: "B"}
	pub := newMockPublisher()
	svc := NewConversationService(convs, users, &mockCache{}, newMockBroker(), pub)

	if _, err := svc.GetOrCreateDM(context.Background(), "a", "b"); err != nil {
		t.Fatalf("dm: %v", err)
	}
	for _, p := range pub.published {
		if p.event.Type == events.EventConversationNew {
			t.Fatalf("GetOrCreateDM must not publish conversation.new; got %v", p.event.Type)
		}
	}
}

// TestActivate_PublishesConversationNew verifies that activation publishes
// the deferred event to all participants.
func TestActivate_PublishesConversationNew(t *testing.T) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "A"}
	users.users["b"] = &model.User{ID: "b", DisplayName: "B"}
	users.users["c"] = &model.User{ID: "c", DisplayName: "C"}
	pub := newMockPublisher()
	svc := NewConversationService(convs, users, &mockCache{}, newMockBroker(), pub)

	conv, err := svc.CreateGroup(context.Background(), "a", []string{"b", "c"}, "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	pub.published = nil // discard create-time events

	if err := svc.Activate(context.Background(), conv.ID); err != nil {
		t.Fatalf("activate: %v", err)
	}

	convNewCount := 0
	for _, p := range pub.published {
		if p.event.Type == events.EventConversationNew {
			convNewCount++
		}
	}
	if convNewCount != 3 {
		t.Errorf("expected 3 conversation.new events (one per participant), got %d", convNewCount)
	}

	// Idempotent: second activate should NOT republish.
	pub.published = nil
	if err := svc.Activate(context.Background(), conv.ID); err != nil {
		t.Fatalf("activate idempotent: %v", err)
	}
	for _, p := range pub.published {
		if p.event.Type == events.EventConversationNew {
			t.Fatal("Activate must be idempotent — no second publish")
		}
	}
}

// TestListUserConversations_HidesInactivatedFromNonCreator verifies that the
// activated filter hides newly-created groups from non-creator participants
// until activation.
func TestListUserConversations_HidesInactivatedFromNonCreator(t *testing.T) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "A"}
	users.users["b"] = &model.User{ID: "b", DisplayName: "B"}
	pub := newMockPublisher()
	svc := NewConversationService(convs, users, &mockCache{}, newMockBroker(), pub)

	conv, err := svc.CreateGroup(context.Background(), "a", []string{"b"}, "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// Creator A sees it.
	listA, err := svc.ListUserConversations(context.Background(), "a")
	if err != nil {
		t.Fatalf("list a: %v", err)
	}
	if len(listA) != 1 {
		t.Errorf("creator should see 1 conversation, got %d", len(listA))
	}

	// Non-creator B does NOT see it before activation.
	listB, err := svc.ListUserConversations(context.Background(), "b")
	if err != nil {
		t.Fatalf("list b: %v", err)
	}
	if len(listB) != 0 {
		t.Errorf("non-creator should not see inactivated convo, got %d", len(listB))
	}

	// After activation, B sees it.
	if err := svc.Activate(context.Background(), conv.ID); err != nil {
		t.Fatalf("activate: %v", err)
	}
	listB2, err := svc.ListUserConversations(context.Background(), "b")
	if err != nil {
		t.Fatalf("list b after activate: %v", err)
	}
	if len(listB2) != 1 {
		t.Errorf("non-creator should see activated convo, got %d", len(listB2))
	}
}

// TestMessageService_SendActivatesConversation verifies that the first message
// in a conversation triggers activation.
func TestMessageService_SendActivatesConversation(t *testing.T) {
	convs := newMockConversationStore()
	users := newMockUserStore()
	users.users["a"] = &model.User{ID: "a", DisplayName: "A"}
	users.users["b"] = &model.User{ID: "b", DisplayName: "B"}
	pub := newMockPublisher()
	convSvc := NewConversationService(convs, users, &mockCache{}, newMockBroker(), pub)
	conv, err := convSvc.CreateGroup(context.Background(), "a", []string{"b"}, "")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	messageStore := newMockMessageStore()
	memberStore := newMockMembershipStore()
	msgSvc := NewMessageService(messageStore, memberStore, convs, pub, newMockBroker())
	msgSvc.SetActivator(convSvc)

	pub.published = nil
	if _, err := msgSvc.Send(context.Background(), "a", conv.ID, ParentConversation, "hello", ""); err != nil {
		t.Fatalf("send: %v", err)
	}

	// Verify conversation.new was published as part of activation.
	convNewCount := 0
	for _, p := range pub.published {
		if p.event.Type == events.EventConversationNew {
			convNewCount++
		}
	}
	if convNewCount == 0 {
		t.Error("first message did not trigger conversation activation event")
	}
}
