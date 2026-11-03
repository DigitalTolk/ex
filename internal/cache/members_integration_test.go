//go:build integration

package cache

import (
	"context"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

func memberRow(channelID, userID string, role model.ChannelRole) *model.ChannelMembership {
	return &model.ChannelMembership{ChannelID: channelID, UserID: userID, Role: role, JoinedAt: time.Now().UTC().Truncate(time.Second)}
}

// A member's row is served while the channel's generation holds and never
// after it moves; a row for someone else isn't invented.
func TestMemberLists_MemberFollowsTheGeneration(t *testing.T) {
	rdb := newRealCache(t).Client()
	ctx := context.Background()
	m := NewMemberLists(rdb, time.Minute)

	row, gen, err := m.Member(ctx, "ch-m", "u1")
	if err != nil || row != nil || gen != "" {
		t.Fatalf("empty copy = %v gen %q (err %v), want nothing at the empty generation", row, gen, err)
	}
	if err := m.PutMember(ctx, "ch-m", gen, memberRow("ch-m", "u1", model.ChannelRoleAdmin)); err != nil {
		t.Fatalf("PutMember: %v", err)
	}
	row, _, err = m.Member(ctx, "ch-m", "u1")
	if err != nil || row == nil || row.Role != model.ChannelRoleAdmin {
		t.Fatalf("cached row = %+v (err %v), want u1 as admin", row, err)
	}
	if other, _, err := m.Member(ctx, "ch-m", "u2"); err != nil || other != nil {
		t.Fatalf("u2 = %+v (err %v), want no row", other, err)
	}
	// A partly filled copy can't say who all the members are.
	if _, _, complete, err := m.Members(ctx, "ch-m"); err != nil || complete {
		t.Fatalf("complete = %v (err %v), want an incomplete copy", complete, err)
	}

	if err := BumpAudienceGenerations(ctx, rdb, ChannelAudienceKey("ch-m")); err != nil {
		t.Fatal(err)
	}
	row, newGen, err := m.Member(ctx, "ch-m", "u1")
	if err != nil || row != nil || newGen == gen {
		t.Fatalf("after the move = %+v gen %q (err %v), want no row at a new generation", row, newGen, err)
	}
	// A fill at the new generation starts the hash over.
	if err := m.PutMember(ctx, "ch-m", newGen, memberRow("ch-m", "u2", model.ChannelRoleMember)); err != nil {
		t.Fatal(err)
	}
	if row, _, _ := m.Member(ctx, "ch-m", "u1"); row != nil {
		t.Fatalf("u1 from the old generation = %+v, want gone", row)
	}
	if row, _, _ := m.Member(ctx, "ch-m", "u2"); row == nil {
		t.Fatal("u2 not cached at the new generation")
	}
	if ttl := rdb.PTTL(ctx, membersKey("ch-m")).Val(); ttl <= 0 || ttl > time.Minute {
		t.Fatalf("TTL = %v, want within a minute", ttl)
	}
}

// A complete list is served whole while its generation holds.
func TestMemberLists_MembersFollowTheGeneration(t *testing.T) {
	rdb := newRealCache(t).Client()
	ctx := context.Background()
	m := NewMemberLists(rdb, time.Minute)
	if err := BumpAudienceGenerations(ctx, rdb, ChannelAudienceKey("ch-l")); err != nil {
		t.Fatal(err)
	}

	_, gen, complete, err := m.Members(ctx, "ch-l")
	if err != nil || complete || gen == "" {
		t.Fatalf("empty copy complete=%v gen %q (err %v)", complete, gen, err)
	}
	if err := m.PutMembers(ctx, "ch-l", gen, []*model.ChannelMembership{memberRow("ch-l", "u1", model.ChannelRoleOwner), memberRow("ch-l", "u2", model.ChannelRoleMember)}); err != nil {
		t.Fatalf("PutMembers: %v", err)
	}
	rows, _, complete, err := m.Members(ctx, "ch-l")
	if err != nil || !complete || len(rows) != 2 {
		t.Fatalf("members = %v complete=%v (err %v), want both", rows, complete, err)
	}
	if row, _, err := m.Member(ctx, "ch-l", "u1"); err != nil || row == nil || row.Role != model.ChannelRoleOwner {
		t.Fatalf("u1 from the list = %+v (err %v)", row, err)
	}

	// A channel with nobody in it is a complete, empty list.
	if err := m.PutMembers(ctx, "ch-empty", "", nil); err != nil {
		t.Fatal(err)
	}
	if rows, _, complete, err := m.Members(ctx, "ch-empty"); err != nil || !complete || len(rows) != 0 {
		t.Fatalf("empty channel = %v complete=%v (err %v)", rows, complete, err)
	}

	if err := BumpAudienceGenerations(ctx, rdb, ChannelAudienceKey("ch-l")); err != nil {
		t.Fatal(err)
	}
	if _, _, complete, err := m.Members(ctx, "ch-l"); err != nil || complete {
		t.Fatalf("after the move complete=%v (err %v), want a miss", complete, err)
	}
}

// A corrupt row surfaces instead of serving garbage, and Redis being down
// is reported (callers then read the store).
func TestMemberLists_Errors(t *testing.T) {
	rdb := newRealCache(t).Client()
	ctx := context.Background()
	m := NewMemberLists(rdb, time.Minute)
	if err := m.PutMembers(ctx, "ch-bad", "", nil); err != nil {
		t.Fatal(err)
	}
	rdb.HSet(ctx, membersKey("ch-bad"), "u1", "{not json")
	if _, _, err := m.Member(ctx, "ch-bad", "u1"); err == nil {
		t.Fatal("Member: want a decode error")
	}
	if _, _, _, err := m.Members(ctx, "ch-bad"); err == nil {
		t.Fatal("Members: want a decode error")
	}

	down := NewMemberLists(redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 50 * time.Millisecond, MaxRetries: -1}), time.Minute)
	if _, _, err := down.Member(ctx, "ch", "u1"); err == nil {
		t.Fatal("Member: want the connection error")
	}
	if _, _, _, err := down.Members(ctx, "ch"); err == nil {
		t.Fatal("Members: want the connection error")
	}
	if err := down.PutMember(ctx, "ch", "", memberRow("ch", "u1", model.ChannelRoleMember)); err == nil {
		t.Fatal("PutMember: want the connection error")
	}
	if err := down.PutMembers(ctx, "ch", "", nil); err == nil {
		t.Fatal("PutMembers: want the connection error")
	}
}
