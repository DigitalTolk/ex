//go:build integration

package store

import (
	"context"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// These tests drive each manual LastEvaluatedKey drain loop through a second
// iteration via faultClient.pageQueryOnce, covering the >1MB pagination-
// continuation branch a small DynamoDB Local table never produces on its own.

func TestMembershipStore_List_PaginatesAllPages(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	seed := NewMembershipStore(db)
	if err := seed.AddChannelMember(ctx,
		&model.Channel{ID: "ch-pg", Name: "pg", Type: model.ChannelTypePublic},
		&model.ChannelMembership{ChannelID: "ch-pg", UserID: "u-pg"},
		&model.UserChannel{ChannelID: "ch-pg", UserID: "u-pg"},
	); err != nil {
		t.Fatalf("seed AddChannelMember: %v", err)
	}
	s := NewMembershipStore(withFault(db, func(f *faultClient) { f.pageQueryOnce = true }))

	members, err := s.ListMembers(ctx, "ch-pg")
	if err != nil || len(members) != 1 {
		t.Fatalf("ListChannelMembers paged = %v, %v; want 1 member", len(members), err)
	}
	chans, err := s.ListUserChannels(ctx, "u-pg")
	if err != nil || len(chans) != 1 {
		t.Fatalf("ListUserChannels paged = %v, %v; want 1 channel", len(chans), err)
	}
}

func TestConversationStore_ListUserConversations_PaginatesAllPages(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	cs := NewConversationStore(db)
	if err := cs.CreateConversation(ctx,
		&model.Conversation{ID: "conv-pg", Type: model.ConversationTypeDM},
		[]*model.UserConversation{{ConversationID: "conv-pg", UserID: "u-pgc"}},
	); err != nil {
		t.Fatalf("seed Create: %v", err)
	}
	s := NewConversationStore(withFault(db, func(f *faultClient) { f.pageQueryOnce = true }))

	convs, err := s.ListUserConversations(ctx, "u-pgc")
	if err != nil || len(convs) != 1 {
		t.Fatalf("ListUserConversations paged = %v, %v; want 1 conversation", len(convs), err)
	}
}

func TestThreadFollowStore_List_PaginatesAllPages(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	tf := NewThreadFollowStore(db)
	if err := tf.SetThreadFollow(ctx, makeThreadFollow("u-pgt", "ch-pgt", "root-pgt")); err != nil {
		t.Fatalf("seed Set: %v", err)
	}
	s := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.pageQueryOnce = true }))

	byThread, err := s.ListThreadFollows(ctx, "ch-pgt", "root-pgt")
	if err != nil || len(byThread) != 1 {
		t.Fatalf("ListThread paged = %v, %v; want 1 follow", len(byThread), err)
	}
	byUser, err := s.ListUserThreadFollows(ctx, "u-pgt")
	if err != nil || len(byUser) != 1 {
		t.Fatalf("ListUser paged = %v, %v; want 1 follow", len(byUser), err)
	}
}

func TestUserStateStore_List_PaginatesAllPages(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	us := NewUserStateStore(db)
	if err := us.SetUserState(ctx, makeUserState("u-pgs", model.UserStateThreadNotification, "root-pgs")); err != nil {
		t.Fatalf("seed Set: %v", err)
	}
	s := NewUserStateStore(withFault(db, func(f *faultClient) { f.pageQueryOnce = true }))

	items, err := s.ListUserState(ctx, "u-pgs")
	if err != nil || len(items) != 1 {
		t.Fatalf("UserState.List paged = %v, %v; want 1 item", len(items), err)
	}
}
