package service

import (
	"testing"
)

// The FromDeps constructors are what production wiring (cmd/server) uses —
// every field must land on the matching service field, or a dependency
// silently vanishes from the delivery path.

func TestNewMessageServiceFromDeps_WiresEveryField(t *testing.T) {
	messages := newMockMessageStore()
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	publisher := newMockPublisher()
	broker := newMockBroker()
	channelSeq := &mockUnreadSeqStore{}
	convSeq := &mockUnreadSeqStore{}
	follows := newMockThreadFollowStore()
	userState := newMockUserStateStore()
	markdown := NewMarkdownRenderer()

	svc := NewMessageServiceFromDeps(MessageServiceDeps{
		Messages:        messages,
		Memberships:     memberships,
		Conversations:   conversations,
		Publisher:       publisher,
		Broker:          broker,
		ChannelSeq:      channelSeq,
		ConversationSeq: convSeq,
		ThreadFollows:   follows,
		UserState:       userState,
		Markdown:        markdown,
	})

	if svc.messages != MessageStore(messages) || svc.memberships != MembershipStore(memberships) {
		t.Fatal("core stores not wired")
	}
	if svc.conversations != ConversationStore(conversations) || svc.publisher != Publisher(publisher) || svc.broker != Broker(broker) {
		t.Fatal("conversations/publisher/broker not wired")
	}
	if svc.channelSeq != UnreadSeqStore(channelSeq) || svc.convSeq != UnreadSeqStore(convSeq) {
		t.Fatal("seq stores not wired")
	}
	if svc.threadFollows != ThreadFollowStore(follows) || svc.userState != UserStateStore(userState) {
		t.Fatal("thread follows / user state not wired")
	}
	if svc.markdown != markdown {
		t.Fatal("markdown renderer not wired")
	}
}

func TestNewNotificationServiceFromDeps_WiresEveryField(t *testing.T) {
	publisher := newMockPublisher()
	memberships := newMockMembershipStore()
	conversations := newMockConversationStore()
	channels := newMockChannelStore()
	users := newMockUserStore()
	messages := newMockMessageStore()
	follows := newMockThreadFollowStore()

	svc := NewNotificationServiceFromDeps(NotificationServiceDeps{
		Publisher:     publisher,
		Memberships:   memberships,
		Conversations: conversations,
		Channels:      channels,
		Users:         users,
		Messages:      messages,
		ThreadFollows: follows,
	})

	if svc.publisher != Publisher(publisher) || svc.members != MembershipStore(memberships) {
		t.Fatal("publisher/memberships not wired")
	}
	if svc.conv != ConversationStore(conversations) || svc.channels != ChannelStore(channels) {
		t.Fatal("conversations/channels not wired")
	}
	if svc.users != UserStore(users) || svc.messages != MessageStore(messages) {
		t.Fatal("users/messages not wired")
	}
	if svc.follows != ThreadFollowStore(follows) {
		t.Fatal("thread follows not wired")
	}
}
