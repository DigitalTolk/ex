package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// midMoveConverter moves a group's members into its channel the way the
// store does for a larger group — the channel and its first members in one
// transaction, the rest in further ones — and runs midway between them, when
// a message may land on the half-moved channel.
type midMoveConverter struct {
	*fakeConverter
	members  *mockMembershipStore
	channels *mockChannelStore
	midway   func()
}

func (c *midMoveConverter) ConvertGroupToChannel(ctx context.Context, ch *model.Channel, members []store.ConvertedMember, at time.Time) error {
	c.channels.channels[ch.ID] = ch
	c.members.memberships[ch.ID+"#"+members[0].Member.UserID] = members[0].Member
	c.midway()
	for _, m := range members[1:] {
		c.members.memberships[ch.ID+"#"+m.Member.UserID] = m.Member
	}
	return c.fakeConverter.ConvertGroupToChannel(ctx, ch, members, at)
}

// Converting a group into a channel moves the channel's audience generation
// on, so every instance alerts all of its members from the very next message —
// a member list cached while the move was still under way is never used again
// (it would otherwise stand for the cache's whole two-minute expiry).
func TestConvertGroupConversation_NewMembersAlertedImmediately(t *testing.T) {
	svc, conv, channels, users, _, _ := convertSetup(t)
	seedAllLevel(users, "u-a", "u-b", "u-c")
	members := svc.memberships.(*mockMembershipStore)
	gens := newMemGens()
	// Another instance's notifier, sharing the generations with the
	// converting instance.
	pub := newMockPublisher()
	notifier := NewNotificationService(pub, members, newMockConversationStore(), channels, users, newMockMessageStore())
	notifier.SetAudienceCache(NewAudienceCache(gens))
	svc.SetAudienceInvalidator(NewAudienceCache(gens))
	post := func(id string) map[string]bool {
		pub.mu.Lock()
		pub.published = nil
		pub.mu.Unlock()
		notifier.NotifyForMessage(context.Background(), &model.Message{ID: id, ParentID: "g-1", AuthorID: "sender", Body: "status"}, ParentChannel, nil)
		return alertedUsers(pub)
	}
	var midway map[string]bool
	svc.SetConversationConverter(&midMoveConverter{fakeConverter: conv, members: members, channels: channels, midway: func() {
		midway = post("m-mid")
	}}, nil)

	if _, err := svc.ConvertGroupConversation(context.Background(), "u-a", "g-1", "ops"); err != nil {
		t.Fatalf("convert: %v", err)
	}
	if !midway["u-a"] || midway["u-b"] {
		t.Fatalf("mid-move fan-out alerted %v, want only the first moved member", midway)
	}
	if got := post("m-after"); !got["u-a"] || !got["u-b"] || !got["u-c"] {
		t.Fatalf("after the conversion alerted %v — every member of the new channel must be alerted at once", got)
	}
}

// A conversion that reports a failure may still have moved some members:
// the audience moves on either way.
func TestConvertGroupConversation_FailedMoveStillInvalidates(t *testing.T) {
	svc, conv, _, _, _, _ := convertSetup(t)
	inv := &recordingInvalidator{}
	svc.SetAudienceInvalidator(inv)
	conv.convertErr = errors.New("throttled after the first transaction")
	if _, err := svc.ConvertGroupConversation(context.Background(), "u-a", "g-1", "ops"); err == nil {
		t.Fatal("store error not surfaced")
	}
	if got := inv.take(); len(got) != 1 || got[0] != "g-1" {
		t.Fatalf("invalidated %v, want [g-1]", got)
	}
}
