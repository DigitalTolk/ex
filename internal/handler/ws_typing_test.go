package handler

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
)

// stubPublisher records every Publish call so the test can assert on
// the topic + payload that the WSHandler emitted.
type stubPublisher struct {
	mu   sync.Mutex
	hits []struct {
		topic string
		evt   *events.Event
	}
	err error
}

func (s *stubPublisher) Publish(_ context.Context, topic string, evt *events.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hits = append(s.hits, struct {
		topic string
		evt   *events.Event
	}{topic: topic, evt: evt})
	return s.err
}

// buildHandlerWithChannel wires up a WSHandler whose channel service has
// one member ("u-1") in channel "ch-1". The conversation service is set
// up with one DM "c-1" between u-1 and u-2.
func buildHandlerWithChannel(t *testing.T) (*WSHandler, *stubPublisher) {
	t.Helper()
	channels := newDataChannelStore()
	memberships := newDataMembershipStore()
	convs := newDataConversationStore()
	users := newDataUserStoreForConv()

	if err := channels.CreateChannel(context.Background(), &model.Channel{
		ID: "ch-1", Name: "general", Slug: "general", Type: model.ChannelTypePublic,
	}); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if err := memberships.AddMember(context.Background(), &model.ChannelMembership{
		ChannelID: "ch-1", UserID: "u-1", Role: model.ChannelRoleMember,
	}, &model.UserChannel{UserID: "u-1", ChannelID: "ch-1", ChannelName: "general"}); err != nil {
		t.Fatalf("AddMember: %v", err)
	}

	convs.conversations["c-1"] = &model.Conversation{
		ID:             "c-1",
		Type:           model.ConversationTypeDM,
		ParticipantIDs: []string{"u-1", "u-2"},
	}

	chanSvc := service.NewChannelService(channels, memberships, users, nil, nil, nil, nil)
	convSvc := service.NewConversationService(convs, users, nil, nil, nil)

	pub := &stubPublisher{}
	h := &WSHandler{chanSvc: chanSvc, convSvc: convSvc}
	h.SetPublisher(pub)
	return h, pub
}

func decodeTyping(t *testing.T, evt *events.Event) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(evt.Data, &out); err != nil {
		t.Fatalf("decode typing payload: %v", err)
	}
	return out
}

func TestWSHandler_HandleInbound_TypingChannel(t *testing.T) {
	h, pub := buildHandlerWithChannel(t)
	raw, _ := json.Marshal(map[string]string{
		"type":       "typing",
		"parentID":   "ch-1",
		"parentType": "channel",
	})
	h.handleInbound(context.Background(), "u-1", raw)

	if len(pub.hits) != 1 {
		t.Fatalf("expected 1 publish; got %d", len(pub.hits))
	}
	hit := pub.hits[0]
	if hit.topic != pubsub.ChannelName("ch-1") {
		t.Errorf("topic = %q, want %q", hit.topic, pubsub.ChannelName("ch-1"))
	}
	if hit.evt.Type != events.EventTyping {
		t.Errorf("event type = %q, want %q", hit.evt.Type, events.EventTyping)
	}
	body := decodeTyping(t, hit.evt)
	if body["userID"] != "u-1" || body["parentID"] != "ch-1" || body["parentType"] != "channel" {
		t.Errorf("typing payload mismatch: %+v", body)
	}
}

func TestWSHandler_HandleInbound_TypingChannelInThread(t *testing.T) {
	// Typing inside a thread reply must publish to the same parent topic
	// as ordinary channel typing but carry parentMessageID so listening
	// clients can route the indicator into ThreadPanel rather than the
	// main MessageList.
	h, pub := buildHandlerWithChannel(t)
	raw, _ := json.Marshal(map[string]string{
		"type":            "typing",
		"parentID":        "ch-1",
		"parentType":      "channel",
		"parentMessageID": "m-thread-root",
	})
	h.handleInbound(context.Background(), "u-1", raw)

	if len(pub.hits) != 1 {
		t.Fatalf("expected 1 publish; got %d", len(pub.hits))
	}
	hit := pub.hits[0]
	if hit.topic != pubsub.ChannelName("ch-1") {
		t.Errorf("topic = %q, want %q", hit.topic, pubsub.ChannelName("ch-1"))
	}
	body := decodeTyping(t, hit.evt)
	if body["parentMessageID"] != "m-thread-root" {
		t.Errorf("parentMessageID not forwarded; got %+v", body)
	}
	if body["userID"] != "u-1" || body["parentID"] != "ch-1" || body["parentType"] != "channel" {
		t.Errorf("typing payload mismatch: %+v", body)
	}
}

func TestWSHandler_HandleInbound_TypingChannelOmitsParentMessageIDWhenAbsent(t *testing.T) {
	// Backwards compatibility: when no parentMessageID is supplied, the
	// emitted payload must not include the key at all (older clients use
	// strict shape parsers that may reject unknown blank fields).
	h, pub := buildHandlerWithChannel(t)
	raw, _ := json.Marshal(map[string]string{
		"type":       "typing",
		"parentID":   "ch-1",
		"parentType": "channel",
	})
	h.handleInbound(context.Background(), "u-1", raw)
	if len(pub.hits) != 1 {
		t.Fatalf("expected 1 publish; got %d", len(pub.hits))
	}
	body := decodeTyping(t, pub.hits[0].evt)
	if _, ok := body["parentMessageID"]; ok {
		t.Errorf("parentMessageID should be absent when caller did not set it; got %+v", body)
	}
}

func TestWSHandler_HandleInbound_TypingConversation(t *testing.T) {
	h, pub := buildHandlerWithChannel(t)
	raw, _ := json.Marshal(map[string]string{
		"type":       "typing",
		"parentID":   "c-1",
		"parentType": "conversation",
	})
	h.handleInbound(context.Background(), "u-2", raw)

	if len(pub.hits) != 1 {
		t.Fatalf("expected 1 publish; got %d", len(pub.hits))
	}
	if pub.hits[0].topic != pubsub.ConversationName("c-1") {
		t.Errorf("conversation typing should publish to conversation topic")
	}
}

func TestWSHandler_HandleInbound_TypingNonMemberDropped(t *testing.T) {
	h, pub := buildHandlerWithChannel(t)
	raw, _ := json.Marshal(map[string]string{
		"type":       "typing",
		"parentID":   "ch-1",
		"parentType": "channel",
	})
	h.handleInbound(context.Background(), "u-stranger", raw)
	if len(pub.hits) != 0 {
		t.Errorf("non-member typing must not be published; got %d", len(pub.hits))
	}
}

func TestWSHandler_HandleInbound_TypingNonParticipantDropped(t *testing.T) {
	h, pub := buildHandlerWithChannel(t)
	raw, _ := json.Marshal(map[string]string{
		"type":       "typing",
		"parentID":   "c-1",
		"parentType": "conversation",
	})
	h.handleInbound(context.Background(), "u-stranger", raw)
	if len(pub.hits) != 0 {
		t.Errorf("non-participant typing must not be published; got %d", len(pub.hits))
	}
}

func TestWSHandler_HandleInbound_UnknownTypeIgnored(t *testing.T) {
	h, pub := buildHandlerWithChannel(t)
	raw, _ := json.Marshal(map[string]string{"type": "definitely-not-a-thing"})
	h.handleInbound(context.Background(), "u-1", raw)
	if len(pub.hits) != 0 {
		t.Errorf("unknown frame types must be silently dropped; got %d publishes", len(pub.hits))
	}
}

func TestWSHandler_HandleInbound_TimeZoneUpdatePatchesUser(t *testing.T) {
	users := newDataUserStoreForConv()
	users.users["u-1"] = &model.User{
		ID:          "u-1",
		Email:       "u1@example.com",
		DisplayName: "User 1",
		SystemRole:  model.SystemRoleMember,
		Status:      "active",
		TimeZone:    "UTC",
	}
	h := &WSHandler{}
	h.SetUserService(service.NewUserService(users, nil, nil, nil))

	raw, _ := json.Marshal(map[string]string{
		"type":     "timezone.update",
		"timeZone": "Europe/Stockholm",
	})
	h.handleInbound(context.Background(), "u-1", raw)

	if users.users["u-1"].TimeZone != "Europe/Stockholm" {
		t.Fatalf("timezone = %q, want Europe/Stockholm", users.users["u-1"].TimeZone)
	}
}

func TestWSHandler_HandleInbound_MalformedJSONIgnored(t *testing.T) {
	h, pub := buildHandlerWithChannel(t)
	h.handleInbound(context.Background(), "u-1", []byte("{not json"))
	if len(pub.hits) != 0 {
		t.Errorf("malformed frame must not crash or publish; got %d", len(pub.hits))
	}
}

func TestWSHandler_HandleInbound_NoPublisherWired_NoOp(t *testing.T) {
	// Without a publisher, the inbound handler should be a no-op (no panic).
	h, _ := buildHandlerWithChannel(t)
	h.publisher = nil
	raw, _ := json.Marshal(map[string]string{
		"type":       "typing",
		"parentID":   "ch-1",
		"parentType": "channel",
	})
	h.handleInbound(context.Background(), "u-1", raw)
}

func TestWSHandler_HandleInbound_TypingMissingParentIDIgnored(t *testing.T) {
	h, pub := buildHandlerWithChannel(t)
	raw, _ := json.Marshal(map[string]string{"type": "typing", "parentType": "channel"})
	h.handleInbound(context.Background(), "u-1", raw)
	if len(pub.hits) != 0 {
		t.Errorf("blank parentID must short-circuit; got %d", len(pub.hits))
	}
}

func TestWSHandler_HandleInbound_TypingUnknownParentTypeIgnored(t *testing.T) {
	h, pub := buildHandlerWithChannel(t)
	raw, _ := json.Marshal(map[string]string{
		"type":       "typing",
		"parentID":   "ch-1",
		"parentType": "thread", // not a recognised parent kind
	})
	h.handleInbound(context.Background(), "u-1", raw)
	if len(pub.hits) != 0 {
		t.Errorf("unknown parentType must short-circuit; got %d", len(pub.hits))
	}
}
