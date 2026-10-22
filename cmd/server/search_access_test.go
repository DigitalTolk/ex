package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

type fakeSearchMemberships struct {
	calls int
	chans map[string][]*model.UserChannel
	err   error
}

func (f *fakeSearchMemberships) ListUserChannels(_ context.Context, userID string) ([]*model.UserChannel, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return append([]*model.UserChannel(nil), f.chans[userID]...), nil
}

type fakeSearchConversations struct {
	calls int
	convs map[string][]*model.UserConversation
	err   error
}

func (f *fakeSearchConversations) ListUserConversations(_ context.Context, userID string) ([]*model.UserConversation, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
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

// A lookup that fails — a slow search the client gave up on cancels it — is
// an error, and is not remembered: an empty set would hide every result for
// the cache's lifetime, and channel search would read it as "no scoping".
func TestSearchAccess_FailedLookupIsAnErrorNotCached(t *testing.T) {
	for _, fail := range []string{"channels", "conversations"} {
		t.Run(fail, func(t *testing.T) {
			memberships := &fakeSearchMemberships{chans: map[string][]*model.UserChannel{"u1": {{ChannelID: "ch-1"}}}}
			conversations := &fakeSearchConversations{convs: map[string][]*model.UserConversation{"u1": {{ConversationID: "dm-1"}}}}
			if fail == "channels" {
				memberships.err = context.Canceled
			} else {
				conversations.err = context.Canceled
			}
			access := newSearchAccess(memberships, conversations)
			if ids, err := access.AllowedParentIDs(context.Background(), "u1"); !errors.Is(err, context.Canceled) || ids != nil {
				t.Fatalf("AllowedParentIDs = %v, %v; want the lookup's error", ids, err)
			}
			memberships.err, conversations.err = nil, nil
			ids, err := access.AllowedParentIDs(context.Background(), "u1")
			if err != nil || !reflect.DeepEqual(ids, []string{"ch-1", "dm-1"}) {
				t.Fatalf("after recovery = %v, %v; want a fresh lookup", ids, err)
			}
		})
	}
}

// Someone with no channels or conversations gets an empty set, never nil
// (nil means unscoped to channel search).
func TestSearchAccess_NoMembershipsIsEmptyNotNil(t *testing.T) {
	access := newSearchAccess(&fakeSearchMemberships{}, &fakeSearchConversations{})
	ids, err := access.AllowedParentIDs(context.Background(), "u1")
	if err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("AllowedParentIDs = %#v, %v; want an empty, non-nil set", ids, err)
	}
}
