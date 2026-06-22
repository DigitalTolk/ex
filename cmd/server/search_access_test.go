package main

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

type fakeSearchMemberships struct {
	calls int
	chans map[string][]*model.UserChannel
}

func (f *fakeSearchMemberships) ListUserChannels(_ context.Context, userID string) ([]*model.UserChannel, error) {
	f.calls++
	return append([]*model.UserChannel(nil), f.chans[userID]...), nil
}

type fakeSearchConversations struct {
	calls int
	convs map[string][]*model.UserConversation
}

func (f *fakeSearchConversations) ListUserConversations(_ context.Context, userID string) ([]*model.UserConversation, error) {
	f.calls++
	return append([]*model.UserConversation(nil), f.convs[userID]...), nil
}

func TestSearchAccess_CachesMembershipForSearchBurst(t *testing.T) {
	memberships := &fakeSearchMemberships{chans: map[string][]*model.UserChannel{
		"u1": {
			{ChannelID: "ch-1"},
			{ChannelID: "ch-2"},
		},
	}}
	conversations := &fakeSearchConversations{convs: map[string][]*model.UserConversation{
		"u1": {{ConversationID: "dm-1"}},
	}}
	access := newSearchAccess(memberships, conversations)

	first, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil {
		t.Fatalf("AllowedParentIDs first: %v", err)
	}
	if !reflect.DeepEqual(first, []string{"ch-1", "ch-2", "dm-1"}) {
		t.Fatalf("first ids = %v", first)
	}

	memberships.chans["u1"] = []*model.UserChannel{{ChannelID: "ch-2"}}
	conversations.convs["u1"] = nil
	second, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil {
		t.Fatalf("AllowedParentIDs second: %v", err)
	}
	if !reflect.DeepEqual(second, first) {
		t.Fatalf("second ids = %v, want cached %v", second, first)
	}
	if memberships.calls != 1 || conversations.calls != 1 {
		t.Fatalf("calls = memberships:%d conversations:%d, want 1 each", memberships.calls, conversations.calls)
	}
}

func TestSearchAccess_RefreshesMembershipAfterCacheExpiry(t *testing.T) {
	now := time.Date(2026, 5, 4, 12, 0, 0, 0, time.UTC)
	memberships := &fakeSearchMemberships{chans: map[string][]*model.UserChannel{
		"u1": {{ChannelID: "ch-1"}},
	}}
	access := newSearchAccess(memberships, nil)
	access.now = func() time.Time { return now }

	first, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil {
		t.Fatalf("AllowedParentIDs first: %v", err)
	}
	memberships.chans["u1"] = []*model.UserChannel{{ChannelID: "ch-2"}}
	now = now.Add(allowedParentIDsTTL + time.Millisecond)

	second, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil {
		t.Fatalf("AllowedParentIDs second: %v", err)
	}
	if reflect.DeepEqual(second, first) || !reflect.DeepEqual(second, []string{"ch-2"}) {
		t.Fatalf("second ids = %v, want refreshed [ch-2]", second)
	}
	if memberships.calls != 2 {
		t.Fatalf("membership calls = %d, want 2", memberships.calls)
	}
}

func TestSearchAccess_EmptyUserDoesNotQueryStores(t *testing.T) {
	memberships := &fakeSearchMemberships{}
	conversations := &fakeSearchConversations{}
	access := newSearchAccess(memberships, conversations)

	ids, err := access.AllowedParentIDs(context.Background(), "")
	if err != nil {
		t.Fatalf("AllowedParentIDs: %v", err)
	}
	if ids != nil {
		t.Fatalf("ids = %v, want nil", ids)
	}
	if memberships.calls != 0 || conversations.calls != 0 {
		t.Fatalf("stores were queried for empty user")
	}
}
