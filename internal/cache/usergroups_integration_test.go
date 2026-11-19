//go:build integration

package cache

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

func downClient() *redis.Client {
	return redis.NewClient(&redis.Options{Addr: "127.0.0.1:1", DialTimeout: 50 * time.Millisecond, MaxRetries: -1})
}

func testGroup(id string, version int64, members ...string) *model.UserGroupDetail {
	return &model.UserGroupDetail{
		UserGroup: model.UserGroup{ID: id, Handle: "h-" + id, MemberCount: len(members)},
		MemberIDs: members,
		Version:   version,
	}
}

func TestUserGroupCopies_StoreReadForget(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()
	copies := NewUserGroupCopies(c.Client(), time.Hour)

	if got, err := copies.Get(ctx, nil); err != nil || len(got) != 0 {
		t.Fatalf("Get(nil) = %v, %v", got, err)
	}
	if err := copies.Put(ctx, testGroup("g1", 3, "u1", "u2")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	got, err := copies.Get(ctx, []string{"g1", "g-missing"})
	if err != nil || len(got) != 1 {
		t.Fatalf("Get = %v, %v", got, err)
	}
	if g := got["g1"]; g.Version != 3 || !slices.Equal(g.MemberIDs, []string{"u1", "u2"}) || g.Handle != "h-g1" {
		t.Fatalf("copy = %+v", g)
	}
	if ttl := plain.PTTL(ctx, userGroupCopyKey("g1")).Val(); ttl <= 0 || ttl > time.Hour {
		t.Fatalf("TTL = %v, want within an hour", ttl)
	}

	if err := copies.Forget(ctx, "g1"); err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if got, _ := copies.Get(ctx, []string{"g1"}); len(got) != 0 {
		t.Fatalf("Get after Forget = %v", got)
	}
}

func TestUserGroupCopies_UnreadableEntriesReadThrough(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()
	copies := NewUserGroupCopies(c.Client(), time.Hour)
	plain.Set(ctx, userGroupCopyKey("bad"), "{not json", time.Hour)
	plain.Set(ctx, userGroupCopyKey("empty"), `{"v":1}`, time.Hour)
	if got, err := copies.Get(ctx, []string{"bad", "empty"}); err != nil || len(got) != 0 {
		t.Fatalf("Get = %v, %v; want both left to the store", got, err)
	}
	// A corrupt entry is overwritten by the next copy.
	if err := copies.Put(ctx, testGroup("bad", 1, "u1")); err != nil {
		t.Fatal(err)
	}
	if got, _ := copies.Get(ctx, []string{"bad"}); got["bad"] == nil {
		t.Fatal("a corrupt copy blocked the next one")
	}
}

func TestUserGroupCopies_Errors(t *testing.T) {
	ctx := context.Background()
	down := NewUserGroupCopies(downClient(), time.Hour)
	if _, err := down.Get(ctx, []string{"g"}); err == nil {
		t.Error("Get: want the connection error")
	}
	if err := down.Put(ctx, testGroup("g", 1)); err == nil {
		t.Error("Put: want the connection error")
	}
	if err := down.Forget(ctx, "g"); err == nil {
		t.Error("Forget: want the connection error")
	}
}
