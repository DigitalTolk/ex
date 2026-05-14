package handler

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// MemberIDs strips ChannelMembership rows down to user IDs and skips
// empty/nil entries so XADD never sees an empty key.
func TestMembershipMemberLister_StripsToUserIDs(t *testing.T) {
	list := func(_ context.Context, channelID string) ([]*model.ChannelMembership, error) {
		if channelID != "c1" {
			t.Fatalf("unexpected channelID: %q", channelID)
		}
		return []*model.ChannelMembership{
			{ChannelID: "c1", UserID: "u1"},
			{ChannelID: "c1", UserID: "u2"},
			{ChannelID: "c1", UserID: ""}, // empty UserID — must be skipped
			nil,                            // nil row — must be skipped
			{ChannelID: "c1", UserID: "u3"},
		}, nil
	}
	lister := NewMembershipMemberLister(list)
	got, err := lister.MemberIDs(context.Background(), "c1")
	if err != nil {
		t.Fatalf("MemberIDs: %v", err)
	}
	if len(got) != 3 || got[0] != "u1" || got[1] != "u2" || got[2] != "u3" {
		t.Errorf("MemberIDs = %v, want [u1 u2 u3]", got)
	}
}

// Backing-store errors must propagate so the publisher can log
// them — silent failure would mask a broken DynamoDB dependency.
func TestMembershipMemberLister_PropagatesError(t *testing.T) {
	boom := errors.New("dynamo down")
	list := func(_ context.Context, _ string) ([]*model.ChannelMembership, error) {
		return nil, boom
	}
	lister := NewMembershipMemberLister(list)
	if _, err := lister.MemberIDs(context.Background(), "c1"); !errors.Is(err, boom) {
		t.Errorf("err = %v, want %v", err, boom)
	}
}

// nil receiver / nil function are safe no-ops so wiring code can
// stay straight-line without a guard at every call site.
func TestMembershipMemberLister_NilSafe(t *testing.T) {
	var nilLister *MembershipMemberLister
	if got, err := nilLister.MemberIDs(context.Background(), "c1"); err != nil || got != nil {
		t.Errorf("nil receiver = %v err=%v, want nil/nil", got, err)
	}
	lister := NewMembershipMemberLister(nil)
	if got, err := lister.MemberIDs(context.Background(), "c1"); err != nil || got != nil {
		t.Errorf("nil func = %v err=%v, want nil/nil", got, err)
	}
}

// Conversation → ParticipantIDs with empty entries skipped.
func TestConversationParticipantLister_StripsAndSkipsEmpty(t *testing.T) {
	get := func(_ context.Context, _ string) (*model.Conversation, error) {
		return &model.Conversation{ID: "conv1", ParticipantIDs: []string{"u1", "", "u2", "u3"}}, nil
	}
	lister := NewConversationParticipantLister(get)
	got, err := lister.ParticipantIDs(context.Background(), "conv1")
	if err != nil {
		t.Fatalf("ParticipantIDs: %v", err)
	}
	if len(got) != 3 || got[0] != "u1" || got[1] != "u2" || got[2] != "u3" {
		t.Errorf("ParticipantIDs = %v, want [u1 u2 u3]", got)
	}
}

// Missing conversation (deleted between publish and resolve) returns
// nil — no error — so the publish still goes through live.
func TestConversationParticipantLister_HandlesMissingConv(t *testing.T) {
	get := func(_ context.Context, _ string) (*model.Conversation, error) { return nil, nil }
	lister := NewConversationParticipantLister(get)
	got, err := lister.ParticipantIDs(context.Background(), "missing")
	if err != nil {
		t.Errorf("missing conv should not error, got %v", err)
	}
	if got != nil {
		t.Errorf("missing conv = %v, want nil", got)
	}
}

func TestConversationParticipantLister_PropagatesError(t *testing.T) {
	boom := errors.New("get failed")
	get := func(_ context.Context, _ string) (*model.Conversation, error) { return nil, boom }
	lister := NewConversationParticipantLister(get)
	if _, err := lister.ParticipantIDs(context.Background(), "c"); !errors.Is(err, boom) {
		t.Errorf("err = %v, want %v", err, boom)
	}
}

func TestConversationParticipantLister_NilSafe(t *testing.T) {
	var nilLister *ConversationParticipantLister
	if got, err := nilLister.ParticipantIDs(context.Background(), "c"); err != nil || got != nil {
		t.Errorf("nil receiver = %v err=%v, want nil/nil", got, err)
	}
	l := NewConversationParticipantLister(nil)
	if got, err := l.ParticipantIDs(context.Background(), "c"); err != nil || got != nil {
		t.Errorf("nil func = %v err=%v, want nil/nil", got, err)
	}
}
