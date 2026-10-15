package main

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// pagedUsers serves users in pages of two.
type pagedUsers struct{ users []*model.User }

func (p pagedUsers) ListUsers(_ context.Context, _ int, lastKey string) ([]*model.User, string, error) {
	start := 0
	for i, u := range p.users {
		if u.ID == lastKey {
			start = i + 1
		}
	}
	end := min(start+2, len(p.users))
	next := ""
	if end < len(p.users) {
		next = p.users[end-1].ID
	}
	return p.users[start:end], next, nil
}

// shrinkSpy answers ShrinkAvatar from a table and records each call.
type shrinkSpy struct {
	changed map[string]bool
	fail    map[string]bool
	calls   []string
	dryRuns []bool
}

func (s *shrinkSpy) ShrinkAvatar(_ context.Context, userID string, dryRun bool) (bool, error) {
	s.calls = append(s.calls, userID)
	s.dryRuns = append(s.dryRuns, dryRun)
	if s.fail[userID] {
		return false, errors.New("boom")
	}
	return s.changed[userID], nil
}

func avatarUsers() pagedUsers {
	return pagedUsers{users: []*model.User{
		{ID: "big", AvatarKey: "avatars/big/1"},
		{ID: "none"},
		{ID: "fits", AvatarKey: "avatars/fits/1"},
		{ID: "big2", AvatarKey: "avatars/big2/1"},
		{ID: "broken", AvatarKey: "avatars/broken/1"},
	}}
}

func TestAvatarResize_WalksEveryPageAndSkipsUsersWithoutAnAvatar(t *testing.T) {
	spy := &shrinkSpy{changed: map[string]bool{"big": true, "big2": true}}
	if code := avatarResize(context.Background(), avatarUsers(), spy, false, true, "apply"); code != 0 {
		t.Fatalf("exit = %d, want 0", code)
	}
	if want := []string{"big", "fits", "big2", "broken"}; !slices.Equal(spy.calls, want) {
		t.Fatalf("calls = %v, want %v", spy.calls, want)
	}
	if slices.Contains(spy.dryRuns, true) {
		t.Fatal("an apply run asked for a dry run")
	}
}

func TestAvatarResize_DryRunIsPassedThrough(t *testing.T) {
	spy := &shrinkSpy{changed: map[string]bool{"big": true}}
	avatarResize(context.Background(), avatarUsers(), spy, true, false, "dry-run")
	if slices.Contains(spy.dryRuns, false) {
		t.Fatal("a dry run asked for a write")
	}
}

func TestAvatarResize_AFailedUserFailsTheRunButNotTheWalk(t *testing.T) {
	spy := &shrinkSpy{fail: map[string]bool{"fits": true}}
	if code := avatarResize(context.Background(), avatarUsers(), spy, false, false, "apply"); code != 1 {
		t.Fatalf("exit = %d, want 1", code)
	}
	if len(spy.calls) != 4 {
		t.Fatalf("calls = %v, want every user with an avatar", spy.calls)
	}
}
