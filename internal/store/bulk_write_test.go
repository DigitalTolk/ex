//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

func TestDeriveGroupConversationID_OrderIndependent(t *testing.T) {
	a := DeriveGroupConversationID([]string{"u3", "u1", "u2"})
	b := DeriveGroupConversationID([]string{"u1", "u2", "u3"})
	if a != b || a != DeriveID("group:u1:u2:u3") {
		t.Fatalf("group ids differ: %s %s", a, b)
	}
	in := []string{"b", "a"}
	DeriveGroupConversationID(in)
	if in[0] != "b" {
		t.Fatal("input slice must not be reordered")
	}
}

// AddMessageSeq advances the counter by n in one write; AddChannelLastRead
// moves a member's watermark by the same amount so their unread is unchanged.
func TestChannelStore_AddMessageSeqAndLastRead(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewChannelStore(db)
	ms := NewMembershipStore(db)
	ch := makeChannel("ch-bulk", "bulk", "bulk", model.ChannelTypePublic)
	if err := cs.CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	if err := ms.AddChannelMember(ctx, ch, &model.ChannelMembership{ChannelID: ch.ID, UserID: "u1"}, &model.UserChannel{UserID: "u1", ChannelID: ch.ID, LastReadSeq: 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := cs.IncrementMessageSeq(ctx, ch.ID); err != nil { // 1 unread
		t.Fatal(err)
	}
	if got, err := cs.AddMessageSeq(ctx, ch.ID, 5); err != nil || got != 6 {
		t.Fatalf("AddMessageSeq = %d, %v; want 6", got, err)
	}
	if err := ms.AddChannelLastRead(ctx, ch.ID, "u1", 5); err != nil {
		t.Fatal(err)
	}
	ucs, err := ms.ListUserChannels(ctx, "u1")
	if err != nil || len(ucs) != 1 || ucs[0].LastReadSeq != 5 {
		t.Fatalf("user channels = %+v, %v", ucs, err)
	}
	if err := ms.AddChannelLastRead(ctx, ch.ID, "ghost", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-member: want ErrNotFound, got %v", err)
	}
	if _, err := cs.AddMessageSeq(ctx, "ghost", 2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing channel: want ErrNotFound, got %v", err)
	}
}

// A posted message stamps the channel's lastMessageAt (the sidebar's "Recent
// activity" sort); a bulk import adds to the counter without touching it.
func TestChannelStore_IncrementMessageSeqStampsLastMessageAt(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewChannelStore(db)
	ch := makeChannel("ch-recent", "recent", "recent", model.ChannelTypePublic)
	if err := cs.CreateChannel(ctx, ch); err != nil {
		t.Fatal(err)
	}
	if _, err := cs.AddMessageSeq(ctx, ch.ID, 3); err != nil {
		t.Fatal(err)
	}
	got, err := cs.GetChannel(ctx, ch.ID)
	if err != nil || got.LastMessageAt != nil {
		t.Fatalf("after import: lastMessageAt = %v, %v; want unset", got.LastMessageAt, err)
	}
	before := time.Now().Add(-time.Second)
	if _, err := cs.IncrementMessageSeq(ctx, ch.ID); err != nil {
		t.Fatal(err)
	}
	got, err = cs.GetChannel(ctx, ch.ID)
	if err != nil || got.LastMessageAt == nil || got.LastMessageAt.Before(before) || got.MessageSeq != 4 {
		t.Fatalf("after post: channel = %+v, %v; want lastMessageAt stamped and seq 4", got, err)
	}
	if got.LastMessageAt.Nanosecond() != 0 {
		t.Fatalf("lastMessageAt = %v; want whole seconds", got.LastMessageAt)
	}
}

func TestConversationStore_AddMessageSeqAndLastRead(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewConversationStore(db)
	conv := &model.Conversation{ID: "conv-bulk", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u1", "u2"}}
	members := []*model.UserConversation{{UserID: "u1", ConversationID: conv.ID}, {UserID: "u2", ConversationID: conv.ID}}
	if err := cs.CreateConversation(ctx, conv, members); err != nil {
		t.Fatal(err)
	}
	if got, err := cs.AddMessageSeq(ctx, conv.ID, 4); err != nil || got != 4 {
		t.Fatalf("AddMessageSeq = %d, %v", got, err)
	}
	if got, err := cs.IncrementMessageSeq(ctx, conv.ID); err != nil || got != 5 {
		t.Fatalf("IncrementMessageSeq = %d, %v", got, err)
	}
	if err := cs.AddConversationLastRead(ctx, conv.ID, "u2", 4); err != nil {
		t.Fatal(err)
	}
	ucs, err := cs.ListUserConversations(ctx, "u2")
	if err != nil || len(ucs) != 1 || ucs[0].LastReadSeq != 4 {
		t.Fatalf("user conversations = %+v, %v", ucs, err)
	}
	if err := cs.AddConversationLastRead(ctx, conv.ID, "ghost", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-participant: want ErrNotFound, got %v", err)
	}
	if _, err := cs.AddMessageSeq(ctx, "ghost", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing conversation: want ErrNotFound, got %v", err)
	}
	f := NewConversationStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if _, err := f.AddMessageSeq(ctx, conv.ID, 1); !errors.Is(err, errInjected) {
		t.Fatalf("want errInjected, got %v", err)
	}
}

func TestMessageStore_SetReplyMetadata(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(db)
	root := &model.Message{ID: "root", ParentID: "ch", AuthorID: "u1", Body: "r", CreatedAt: time.Now()}
	if err := s.CreateMessage(ctx, root); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Truncate(time.Millisecond).UTC()
	if err := s.SetReplyMetadata(ctx, "ch", "root", 7, at, []string{"u3", "u2"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetMessage(ctx, "ch", "root")
	if err != nil || got.ReplyCount != 7 || got.LastReplyAt == nil || !got.LastReplyAt.Equal(at) || len(got.RecentReplyAuthorIDs) != 2 {
		t.Fatalf("root = %+v, %v", got, err)
	}
	if err := s.SetReplyMetadata(ctx, "ch", "ghost", 1, at, nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing root: want ErrNotFound, got %v", err)
	}
	f := NewMessageStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if err := f.SetReplyMetadata(ctx, "ch", "root", 1, at, nil); !errors.Is(err, errInjected) {
		t.Fatalf("want errInjected, got %v", err)
	}
}
