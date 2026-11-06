//go:build integration

package cache

import (
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

// failingHook fails the command named fail on its nth call (1-based), in a
// plain call or inside a pipeline.
type failingHook struct {
	fail string
	nth  int
	seen int
}

func (h *failingHook) DialHook(next redis.DialHook) redis.DialHook {
	return func(ctx context.Context, network, addr string) (net.Conn, error) { return next(ctx, network, addr) }
}

func (h *failingHook) hit(cmds ...redis.Cmder) bool {
	for _, c := range cmds {
		if strings.EqualFold(c.Name(), h.fail) {
			h.seen++
			if h.seen == h.nth {
				return true
			}
		}
	}
	return false
}

func (h *failingHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		if h.hit(cmd) {
			return errors.New("injected " + h.fail + " failure")
		}
		return next(ctx, cmd)
	}
}

func (h *failingHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		if h.hit(cmds...) {
			return errors.New("injected " + h.fail + " failure")
		}
		return next(ctx, cmds)
	}
}

func hookedClient(t *testing.T, hook redis.Hook) *redis.Client {
	t.Helper()
	c, _ := setupRealTestCache(t)
	rdb := redis.NewClient(&redis.Options{Addr: c.Client().Options().Addr})
	rdb.AddHook(hook)
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb
}

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
	if ttl := plain.PTTL(ctx, userGroupKey("g1")).Val(); ttl <= 0 || ttl > time.Hour {
		t.Fatalf("TTL = %v, want within an hour", ttl)
	}

	if err := copies.Forget(ctx, "g1"); err != nil {
		t.Fatalf("Forget: %v", err)
	}
	if got, _ := copies.Get(ctx, []string{"g1"}); len(got) != 0 {
		t.Fatalf("Get after Forget = %v", got)
	}
}

// Two writers finishing out of order: the older version never overwrites the
// newer one.
func TestUserGroupCopies_OnlyMoveForward(t *testing.T) {
	c, _ := setupRealTestCache(t)
	ctx := context.Background()
	copies := NewUserGroupCopies(c.Client(), time.Hour)
	if err := copies.Put(ctx, testGroup("g1", 5, "new")); err != nil {
		t.Fatal(err)
	}
	for _, v := range []int64{4, 5} {
		if err := copies.Put(ctx, testGroup("g1", v, "old")); err != nil {
			t.Fatal(err)
		}
	}
	if got, _ := copies.Get(ctx, []string{"g1"}); !slices.Equal(got["g1"].MemberIDs, []string{"new"}) {
		t.Fatalf("copy = %v, want version 5 kept", got["g1"].MemberIDs)
	}
	if err := copies.Put(ctx, testGroup("g1", 6, "newer")); err != nil {
		t.Fatal(err)
	}
	if got, _ := copies.Get(ctx, []string{"g1"}); got["g1"].Version != 6 {
		t.Fatalf("version = %d, want 6", got["g1"].Version)
	}
}

func TestUserGroupCopies_UnreadableEntriesReadThrough(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()
	copies := NewUserGroupCopies(c.Client(), time.Hour)
	plain.Set(ctx, userGroupKey("bad"), "{not json", time.Hour)
	plain.Set(ctx, userGroupKey("empty"), `{"v":1}`, time.Hour)
	if got, err := copies.Get(ctx, []string{"bad", "empty"}); err != nil || len(got) != 0 {
		t.Fatalf("Get = %v, %v; want both left to the store", got, err)
	}
	// A corrupt entry is overwritten by the next write.
	if err := copies.Put(ctx, testGroup("bad", 1, "u1")); err != nil {
		t.Fatal(err)
	}
	if got, _ := copies.Get(ctx, []string{"bad"}); got["bad"] == nil {
		t.Fatal("a corrupt copy blocked the next write")
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

func TestEntraUserIndex_ReplaceLookupAdd(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()
	idx := NewEntraUserIndex(c.Client())

	if got, complete, err := idx.Lookup(ctx, []string{"o1"}); err != nil || complete || len(got) != 0 {
		t.Fatalf("Lookup on no index = %v, %v, %v", got, complete, err)
	}
	// A sign-in before any rebuild doesn't make the index complete.
	if err := idx.Add(ctx, "o9", "u9"); err != nil {
		t.Fatal(err)
	}
	if got, complete, _ := idx.Lookup(ctx, []string{"o9"}); complete || got["o9"] != "u9" {
		t.Fatalf("Lookup after Add = %v, complete %v", got, complete)
	}

	big := map[string]string{}
	for i := range 1200 {
		big[fmt.Sprintf("o%d", i)] = fmt.Sprintf("u%d", i)
	}
	if err := idx.Replace(ctx, big, time.Hour); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	got, complete, err := idx.Lookup(ctx, []string{"o1", "o1199", "o9", "nobody"})
	if err != nil || !complete || got["o1"] != "u1" || got["o1199"] != "u1199" || len(got) != 3 {
		t.Fatalf("Lookup = %v, complete %v, %v", got, complete, err)
	}
	if ttl := plain.PTTL(ctx, entraIndexKey).Val(); ttl <= 0 || ttl > time.Hour {
		t.Fatalf("TTL = %v", ttl)
	}
	if keys := plain.Keys(ctx, entraIndexKey+":next:*").Val(); len(keys) != 0 {
		t.Fatalf("temporary keys left behind: %v", keys)
	}

	// An empty rebuild is still a complete index.
	if err := idx.Replace(ctx, map[string]string{}, time.Hour); err != nil {
		t.Fatal(err)
	}
	if got, complete, _ := idx.Lookup(ctx, []string{"o1"}); !complete || len(got) != 0 {
		t.Fatalf("after an empty rebuild = %v, complete %v", got, complete)
	}
}

func TestEntraUserIndex_Errors(t *testing.T) {
	ctx := context.Background()
	down := NewEntraUserIndex(downClient())
	if _, _, err := down.Lookup(ctx, []string{"o"}); err == nil {
		t.Error("Lookup: want the connection error")
	}
	if err := down.Add(ctx, "o", "u"); err == nil {
		t.Error("Add: want the connection error")
	}

	big := map[string]string{}
	for i := range 600 {
		big[fmt.Sprintf("o%d", i)] = "u"
	}
	// The first batch (written inside the loop), the last batch, and the swap.
	for name, hook := range map[string]*failingHook{
		"batch": {fail: "hset", nth: 1},
		"last":  {fail: "hset", nth: 2},
		"swap":  {fail: "rename", nth: 1},
	} {
		idx := NewEntraUserIndex(hookedClient(t, hook))
		if err := idx.Replace(ctx, big, time.Hour); err == nil {
			t.Errorf("%s: Replace = nil, want the injected failure", name)
		}
	}
}
