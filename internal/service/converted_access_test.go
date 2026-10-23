package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// A group DM that became private channel "grp-9" (same ID). "kept" is still a
// member of the channel; "removed" was in the group but has since been removed
// from the channel — their old participant entry must grant nothing.
func convertedGroupFixtures() (*model.Conversation, *model.Channel) {
	conv := &model.Conversation{
		ID: "grp-9", Type: model.ConversationTypeGroup, Name: "War room",
		ParticipantIDs:       []string{"kept", "removed"},
		ConvertedToChannelID: "grp-9",
	}
	ch := &model.Channel{ID: "grp-9", Slug: "war-room", Type: model.ChannelTypePrivate}
	return conv, ch
}

func convertedMessageLinkService() *MessageLinkService {
	conv, ch := convertedGroupFixtures()
	return NewMessageLinkService(
		"https://ex.test",
		fakeMLChannels{bySlug: map[string]*model.Channel{ch.Slug: ch}, byID: map[string]*model.Channel{ch.ID: ch}},
		fakeMLMemberships{members: map[string]bool{"grp-9#kept": true}},
		fakeMLConversations{byID: map[string]*model.Conversation{conv.ID: conv}},
		fakeMLMessages{byKey: map[string]*model.Message{
			"grp-9#m1": {ID: "m1", ParentID: "grp-9", AuthorID: "kept", Body: "incident notes", CreatedAt: time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)},
		}},
		fakeMLUsers{byID: map[string]*model.User{}},
		fakeMLAttachments{byID: map[string]*model.Attachment{}},
	)
}

// Regression: a link to the OLD conversation id unfurled the message for
// anyone still listed as a participant of the converted group — including
// people removed from the private channel it became.
func TestMessageLink_Preview_ConvertedConversationUsesChannelMembership(t *testing.T) {
	svc := convertedMessageLinkService()
	const link = "https://ex.test/conversation/grp-9#msg-m1"

	if p, ok := svc.Preview(context.Background(), "removed", link); !ok || p != nil {
		t.Fatalf("removed member: preview = %+v ok=%v, want an internal link with NO preview", p, ok)
	}
	p, ok := svc.Preview(context.Background(), "kept", link)
	if !ok || p == nil {
		t.Fatalf("channel member: preview = %+v ok=%v, want the message", p, ok)
	}
	if p.Body != "incident notes" || p.ChannelLabel != "~war-room" {
		t.Fatalf("preview = %+v, want the body labelled with the channel", p)
	}
}

// The converted channel being unreadable (lookup failure) never falls back
// to the stale participant list.
func TestMessageLink_Preview_ConvertedConversationChannelMissing(t *testing.T) {
	conv, _ := convertedGroupFixtures()
	svc := NewMessageLinkService("https://ex.test",
		fakeMLChannels{},
		fakeMLMemberships{members: map[string]bool{"grp-9#kept": true}},
		fakeMLConversations{byID: map[string]*model.Conversation{conv.ID: conv}},
		fakeMLMessages{byKey: map[string]*model.Message{"grp-9#m1": {ID: "m1", ParentID: "grp-9", Body: "x"}}},
		fakeMLUsers{}, fakeMLAttachments{})
	if p, ok := svc.Preview(context.Background(), "kept", "https://ex.test/conversation/grp-9#msg-m1"); !ok || p != nil {
		t.Fatalf("preview = %+v ok=%v, want no preview when the channel can't be read", p, ok)
	}
}

func setupConvertedConversationService(t *testing.T) (*ConversationService, *mockMembershipStore) {
	t.Helper()
	svc, convs, _, _, _ := setupConversationService()
	conv, _ := convertedGroupFixtures()
	convs.conversations[conv.ID] = conv
	memberships := newMockMembershipStore()
	memberships.memberships["grp-9#kept"] = &model.ChannelMembership{ChannelID: "grp-9", UserID: "kept", Role: model.ChannelRoleMember}
	svc.SetChannelMemberships(memberships)
	return svc, memberships
}

// Regression: GetByID and IsParticipant read the frozen participant list of a
// converted group, so a user removed from the private channel still passed.
func TestConversationService_ConvertedGroupRoutesThroughChannelMembership(t *testing.T) {
	ctx := context.Background()
	svc, memberships := setupConvertedConversationService(t)

	if _, err := svc.GetByID(ctx, "removed", "grp-9"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("GetByID(removed) err = %v, want ErrForbidden", err)
	}
	if svc.IsParticipant(ctx, "removed", "grp-9") {
		t.Fatal("IsParticipant(removed) = true, want false")
	}
	if conv, err := svc.GetByID(ctx, "kept", "grp-9"); err != nil || conv.ID != "grp-9" {
		t.Fatalf("GetByID(kept) = %+v, %v; want the conversation", conv, err)
	}
	if !svc.IsParticipant(ctx, "kept", "grp-9") {
		t.Fatal("IsParticipant(kept) = false, want true")
	}

	// A membership read that fails is an error, never a grant.
	memberships.getErr = errors.New("throttled")
	if _, err := svc.GetByID(ctx, "kept", "grp-9"); err == nil || errors.Is(err, ErrForbidden) {
		t.Fatalf("GetByID on a store failure: err = %v, want a non-verdict error", err)
	}
	if svc.IsParticipant(ctx, "kept", "grp-9") {
		t.Fatal("IsParticipant on a store failure = true, want false")
	}
}

// Without the channel membership reader wired, a converted group grants
// nobody (fail closed) rather than trusting the stale participant list.
func TestConversationService_ConvertedGroupFailsClosedWithoutMemberships(t *testing.T) {
	svc, convs, _, _, _ := setupConversationService()
	conv, _ := convertedGroupFixtures()
	convs.conversations[conv.ID] = conv
	if _, err := svc.GetByID(context.Background(), "kept", "grp-9"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("err = %v, want ErrForbidden", err)
	}
	if svc.IsParticipant(context.Background(), "kept", "grp-9") {
		t.Fatal("IsParticipant = true, want false")
	}
}
