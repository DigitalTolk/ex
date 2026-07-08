package handler

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

func TestTypingGate_CachesVerdicts(t *testing.T) {
	gate := newTypingGate()

	// A keystroke burst costs ONE lookup; the cached verdict answers the rest.
	lookups := 0
	for range 5 {
		if !gate.check("c#ch-1", func() bool { lookups++; return true }) {
			t.Fatal("member verdict lost")
		}
	}
	if lookups != 1 {
		t.Fatalf("lookups = %d, want 1 for a burst", lookups)
	}

	// Negative verdicts cache too — a stranger's spam burst is one read.
	denials := 0
	for range 3 {
		if gate.check("c#ch-secret", func() bool { denials++; return false }) {
			t.Fatal("non-member verdict lost")
		}
	}
	if denials != 1 {
		t.Fatalf("denials = %d, want 1", denials)
	}

	// Expired entries re-check, so a membership change lands within the TTL.
	orig := typingMembershipTTL
	typingMembershipTTL = -time.Nanosecond
	defer func() { typingMembershipTTL = orig }()
	rechecks := 0
	gate.check("c#ch-2", func() bool { rechecks++; return true })
	gate.check("c#ch-2", func() bool { rechecks++; return false })
	if rechecks != 2 {
		t.Fatalf("rechecks = %d, want 2 after expiry", rechecks)
	}
}

// countingMembershipStore counts GetMembership reads so the flow test can
// assert a typing burst hits DynamoDB once, not once per frame.
type countingMembershipStore struct {
	*dataMembershipStore
	getCalls int
}

func (s *countingMembershipStore) GetMembership(ctx context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	s.getCalls++
	return s.dataMembershipStore.GetMembership(ctx, channelID, userID)
}

func TestWSHandler_TypingBurst_OneMembershipRead(t *testing.T) {
	channels := newDataChannelStore()
	memberships := &countingMembershipStore{dataMembershipStore: newDataMembershipStore()}
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
	chanSvc := service.NewChannelService(channels, memberships, users, nil, nil, nil, nil)
	pub := &stubPublisher{}
	h := &WSHandler{chanSvc: chanSvc}
	h.SetPublisher(pub)

	gate := newTypingGate() // one gate per connection, shared across frames
	raw, _ := json.Marshal(map[string]string{"type": "typing", "parentID": "ch-1", "parentType": "channel"})
	for range 4 {
		h.handleInbound(context.Background(), "u-1", raw, gate)
	}
	if len(pub.hits) != 4 {
		t.Fatalf("published typing events = %d, want 4", len(pub.hits))
	}
	if memberships.getCalls != 1 {
		t.Fatalf("membership reads = %d, want 1 for the whole burst", memberships.getCalls)
	}
}
