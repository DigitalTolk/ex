package service

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
)

// Regression: with the real ConversationService wired as the activator, every
// DM send re-read the conversation inside Activate although the send's access
// check had just loaded it. The loaded row is handed to the activator, so a
// send reads the conversation once — whether or not this send activates it.
func TestSend_ActivatorReusesTheLoadedConversation(t *testing.T) {
	for _, activated := range []bool{true, false} {
		svc, _, _, conversations, publisher := setupMessageService()
		conversations.conversations["dm-1"] = &model.Conversation{
			ID: "dm-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-1", "u-2"}, Activated: activated,
		}
		convSvc := NewConversationService(conversations, newMockUserStore(), nil, newMockBroker(), publisher)
		svc.SetActivator(convSvc)

		if _, err := svc.Send(context.Background(), "u-1", "dm-1", ParentConversation, "hello", ""); err != nil {
			t.Fatalf("Send: %v", err)
		}
		if conversations.getCalls.Load() != 1 {
			t.Fatalf("activated=%v: GetConversation calls = %d, want 1 per send", activated, conversations.getCalls.Load())
		}
		if !conversations.conversations["dm-1"].Activated {
			t.Fatalf("activated=%v: conversation not activated after a send", activated)
		}
		news := 0
		for _, p := range publisher.published {
			if p.event.Type == events.EventConversationNew {
				news++
			}
		}
		if want := map[bool]int{true: 0, false: 2}[activated]; news != want {
			t.Fatalf("activated=%v: conversation.new events = %d, want %d", activated, news, want)
		}
	}
}
