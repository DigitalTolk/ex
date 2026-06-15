//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// memberSeed builds the (channel, membership, userChannel) trio for seeding.
func memberSeed(channelID, userID string) (*model.Channel, *model.ChannelMembership, *model.UserChannel) {
	now := time.Now().Truncate(time.Millisecond)
	ch := makeChannel(channelID, "Mem "+channelID, "slug-"+channelID, model.ChannelTypePublic)
	member := &model.ChannelMembership{
		ChannelID:   channelID,
		UserID:      userID,
		Role:        model.ChannelRoleMember,
		DisplayName: "Member",
		JoinedAt:    now,
	}
	uc := &model.UserChannel{
		UserID:      userID,
		ChannelID:   channelID,
		ChannelName: "Mem " + channelID,
		ChannelType: model.ChannelTypePublic,
		Role:        model.ChannelRoleMember,
		JoinedAt:    now,
	}
	return ch, member, uc
}

func TestMembershipStore_AddChannelMember_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ch, member, uc := memberSeed("ch-me1", "u-me1")
	s := NewMembershipStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.AddChannelMember(ctx, ch, member, uc)
	if !errors.Is(err, errInjected) {
		t.Fatalf("AddChannelMember: want errInjected, got %v", err)
	}
}

func TestMembershipStore_RemoveChannelMember_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMembershipStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.RemoveChannelMember(ctx, "ch-me1", "u-me1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("RemoveChannelMember: want errInjected, got %v", err)
	}
}

func TestMembershipStore_GetChannelMembership_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMembershipStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	_, err := s.GetChannelMembership(ctx, "ch-me1", "u-me1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("GetChannelMembership: want errInjected, got %v", err)
	}
}

func TestMembershipStore_ListChannelMembers_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMembershipStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.ListChannelMembers(ctx, "ch-me1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListChannelMembers: want errInjected, got %v", err)
	}
}

func TestMembershipStore_ListUserChannels_QueryError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMembershipStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
	_, err := s.ListUserChannels(ctx, "u-me1")
	if !errors.Is(err, errInjected) {
		t.Fatalf("ListUserChannels: want errInjected, got %v", err)
	}
}

func TestMembershipStore_UpdateChannelRole_TransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMembershipStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.UpdateChannelRole(ctx, "ch-me1", "u-me1", model.ChannelRoleAdmin)
	if !errors.Is(err, errInjected) {
		t.Fatalf("UpdateChannelRole: want errInjected, got %v", err)
	}
}

func TestMembershipStore_SetUserChannelMute_UpdateItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ch, member, uc := memberSeed("ch-mute", "u-mute")
	if err := NewMembershipStore(db).AddChannelMember(ctx, ch, member, uc); err != nil {
		t.Fatalf("seed: %v", err)
	}
	s := NewMembershipStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	err := s.SetUserChannelMute(ctx, "ch-mute", "u-mute", true)
	if !errors.Is(err, errInjected) {
		t.Fatalf("SetUserChannelMute: want errInjected, got %v", err)
	}
}
