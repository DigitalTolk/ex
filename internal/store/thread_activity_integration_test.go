//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/apperr"
	"github.com/DigitalTolk/ex/internal/model"
)

func followAt(userID, parentID, rootID string, following bool, at time.Time) *model.ThreadFollow {
	f := makeThreadFollow(userID, parentID, rootID)
	f.Following = following
	f.LastActivityAt = &at
	return f
}

func followedRoots(t *testing.T, s *ThreadFollowStoreImpl, userID string, limit int) []string {
	t.Helper()
	var roots []string
	for cursor := ""; ; {
		page, next, err := s.ListFollowedThreadsByActivity(context.Background(), userID, cursor, limit)
		if err != nil {
			t.Fatalf("ListFollowedThreadsByActivity: %v", err)
		}
		for _, f := range page {
			roots = append(roots, f.ThreadRootID)
		}
		if next == "" {
			return roots
		}
		cursor = next
	}
}

// A user's followed threads list latest reply first, a page at a time; an
// unfollowed thread, or one without a known reply time, is not listed.
func TestThreadFollowStore_ListFollowedThreadsByActivity(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(db)
	base := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	writes := []*model.ThreadFollow{
		followAt("u-act", "ch-1", "oldest", true, base),
		followAt("u-act", "ch-2", "newest", true, base.Add(time.Hour)),
		followAt("u-act", "ch-1", "middle", true, base.Add(time.Minute)),
		followAt("u-act", "ch-1", "unfollowed", false, base.Add(2*time.Hour)),
		followAt("u-other", "ch-1", "someone-else", true, base.Add(3*time.Hour)),
		makeThreadFollow("u-act", "ch-1", "no-time"),
	}
	if err := s.SetThreadFollowMany(ctx, writes[:3]); err != nil {
		t.Fatalf("SetThreadFollowMany: %v", err)
	}
	for _, f := range writes[3:] {
		if err := s.SetThreadFollow(ctx, f); err != nil {
			t.Fatalf("SetThreadFollow: %v", err)
		}
	}
	got := followedRoots(t, s, "u-act", 2)
	want := []string{"newest", "middle", "oldest"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("followed = %v, want %v", got, want)
	}

	// Unfollowing takes a thread off the list; following it again (only if
	// absent) does not bring an explicit unfollow back.
	if err := s.SetThreadFollow(ctx, followAt("u-act", "ch-1", "middle", false, base.Add(time.Minute))); err != nil {
		t.Fatalf("unfollow: %v", err)
	}
	if err := s.SetThreadFollowIfAbsent(ctx, followAt("u-act", "ch-1", "middle", true, base.Add(4*time.Hour))); err != nil {
		t.Fatalf("SetThreadFollowIfAbsent: %v", err)
	}
	if got := followedRoots(t, s, "u-act", 10); len(got) != 2 || got[0] != "newest" || got[1] != "oldest" {
		t.Fatalf("after unfollow = %v, want [newest oldest]", got)
	}

	// A cursor this store didn't hand out is refused.
	for _, bad := range []string{"short", "2026-10-01T09:00:00.000000000Z#nohash", "2026-10-01T09:00:00.000000000Z#ch-1#", "2026-10-01T09:00:00.000000000Z-ch-1#r"} {
		if _, _, err := s.ListFollowedThreadsByActivity(ctx, "u-act", bad, 2); !errors.Is(err, apperr.ErrValidation) {
			t.Errorf("cursor %q: err = %v, want a validation error", bad, err)
		}
	}
}

// A reply moves a followed thread up: only a followed row, only forward.
func TestThreadFollowStore_TouchThreadActivity(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(db)
	base := time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)
	for _, f := range []*model.ThreadFollow{
		followAt("u-a", "ch-1", "root-1", true, base),
		followAt("u-a", "ch-1", "root-2", true, base.Add(time.Minute)),
		followAt("u-b", "ch-1", "root-1", false, base),
		makeThreadFollow("u-c", "ch-1", "root-1"),
	} {
		if err := s.SetThreadFollow(ctx, f); err != nil {
			t.Fatalf("SetThreadFollow: %v", err)
		}
	}
	reply := base.Add(time.Hour)
	if err := s.TouchThreadActivity(ctx, []string{"u-a", "u-b", "u-c", "u-missing"}, "ch-1", "root-1", reply); err != nil {
		t.Fatalf("TouchThreadActivity: %v", err)
	}
	if got := followedRoots(t, s, "u-a", 10); len(got) != 2 || got[0] != "root-1" {
		t.Fatalf("u-a = %v, want root-1 first after its reply", got)
	}
	f, err := s.GetThreadFollow(ctx, "u-a", "ch-1", "root-1")
	if err != nil || f.LastActivityAt == nil || !f.LastActivityAt.Equal(reply) {
		t.Fatalf("u-a row = %+v (err %v), want the reply time", f, err)
	}
	// The unfollowed row stays off the list; the row without a time joins it
	// (it is followed); no row is created for someone without one.
	if got := followedRoots(t, s, "u-b", 10); len(got) != 0 {
		t.Fatalf("u-b = %v, want nothing", got)
	}
	if got := followedRoots(t, s, "u-c", 10); len(got) != 1 {
		t.Fatalf("u-c = %v, want root-1", got)
	}
	if _, err := s.GetThreadFollow(ctx, "u-missing", "ch-1", "root-1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("u-missing row err = %v, want none created", err)
	}
	// A late, older touch never moves a thread back down.
	if err := s.TouchThreadActivity(ctx, []string{"u-a"}, "ch-1", "root-1", base); err != nil {
		t.Fatalf("TouchThreadActivity: %v", err)
	}
	if f, _ := s.GetThreadFollow(ctx, "u-a", "ch-1", "root-1"); !f.LastActivityAt.Equal(reply) {
		t.Fatalf("u-a row = %+v, want it kept at the newer reply", f)
	}
}

func TestThreadFollowStore_GetUserThreadFollows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(db)
	if err := s.SetThreadFollow(ctx, makeThreadFollow("u-g", "ch-1", "root-1")); err != nil {
		t.Fatalf("SetThreadFollow: %v", err)
	}
	got, err := s.GetUserThreadFollows(ctx, "u-g", []model.ThreadRef{{ParentID: "ch-1", ThreadRootID: "root-1"}, {ParentID: "ch-1", ThreadRootID: "none"}})
	if err != nil || len(got) != 1 || got[0].ThreadRootID != "root-1" {
		t.Fatalf("follows = %+v (err %v), want root-1 only", got, err)
	}
}

func TestThreadFollowStore_ActivityErrors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	if _, _, err := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failQuery = true })).ListFollowedThreadsByActivity(ctx, "u", "", 5); !errors.Is(err, errInjected) {
		t.Errorf("list: err = %v, want errInjected", err)
	}
	_, _, err := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.transformQuery = corruptQuery })).ListFollowedThreadsByActivity(ctx, "u", "", 5)
	assertUnmarshalErr(t, err, "list followed threads")
	if _, err := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true })).GetUserThreadFollows(ctx, "u", []model.ThreadRef{{ParentID: "p", ThreadRootID: "r"}}); !errors.Is(err, errInjected) {
		t.Errorf("get many: err = %v, want errInjected", err)
	}
	if err := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true })).TouchThreadActivity(ctx, []string{"u"}, "p", "r", time.Now()); !errors.Is(err, errInjected) {
		t.Errorf("touch: err = %v, want errInjected", err)
	}
}
