//go:build integration

package cache

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Batch primitives added for the APM perf work: GetUsers/SetUsers (user cache
// in one MGET / one pipeline) and the generic GetManyJSON/SetManyJSON pair
// backing StableMediaURLs. Real-Redis suites: round trips, miss/corrupt
// semantics, empty inputs and the injected-failure arms.

func TestGetUsersSetUsers_RealRedis(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	// Empty input short-circuits without a round trip.
	if got, err := c.GetUsers(ctx, nil); err != nil || len(got) != 0 {
		t.Fatalf("GetUsers(nil) = %v (err=%v), want empty success", got, err)
	}
	if err := c.SetUsers(ctx, nil); err != nil {
		t.Fatalf("SetUsers(nil): %v", err)
	}

	u1 := &model.User{ID: "u-mget-1", Email: "a@x.io", DisplayName: "A", AvatarKey: "avatars/a.png"}
	u2 := &model.User{ID: "u-mget-2", Email: "b@x.io", DisplayName: "B"}
	if err := c.SetUsers(ctx, []*model.User{u1, u2}); err != nil {
		t.Fatalf("SetUsers: %v", err)
	}

	// One MGET: hits resolve (AvatarKey survives the cache record round trip),
	// the missing ID is simply absent, and a corrupt entry degrades to a miss.
	if err := plain.Set(ctx, userKeyPrefix+"u-corrupt", "not json", time.Minute).Err(); err != nil {
		t.Fatalf("seed corrupt: %v", err)
	}
	got, err := c.GetUsers(ctx, []string{u1.ID, "u-mget-missing", u2.ID, "u-corrupt"})
	if err != nil {
		t.Fatalf("GetUsers: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d users, want 2 (miss + corrupt absent)", len(got))
	}
	if got[u1.ID] == nil || got[u1.ID].AvatarKey != "avatars/a.png" || got[u2.ID] == nil {
		t.Fatalf("resolved = %+v, want both users with avatar key intact", got)
	}

	// The pipelined write applied the user-cache TTL (not persistent keys).
	ttl, err := plain.TTL(ctx, userKeyPrefix+u1.ID).Result()
	if err != nil || ttl <= 0 {
		t.Fatalf("TTL after SetUsers = %v (err=%v), want a positive TTL", ttl, err)
	}
}

func TestGetUsersSetUsers_Failures_RealRedis(t *testing.T) {
	if _, err := cacheFailingOn(t, "mget").GetUsers(context.Background(), []string{"u-1"}); !errors.Is(err, errInjected) {
		t.Fatalf("GetUsers mget failure = %v, want errInjected", err)
	}
	u := &model.User{ID: "u-setfail", Email: "x@x.io", DisplayName: "X"}
	if err := cacheFailingOn(t, "set").SetUsers(context.Background(), []*model.User{u}); !errors.Is(err, errInjected) {
		t.Fatalf("SetUsers pipeline failure = %v, want errInjected", err)
	}
}

func TestGetManyJSONSetManyJSON_RealRedis(t *testing.T) {
	c, plain := setupRealTestCache(t)
	ctx := context.Background()

	// Empty input short-circuits.
	if got, err := c.GetManyJSON(ctx, nil); err != nil || got != nil {
		t.Fatalf("GetManyJSON(nil) = %v (err=%v), want nil success", got, err)
	}
	if err := c.SetManyJSON(ctx, nil, nil, time.Minute); err != nil {
		t.Fatalf("SetManyJSON(nil): %v", err)
	}

	type rec struct {
		Token string `json:"token"`
	}
	keys := []string{"media:test:k1", "media:test:k2"}
	if err := c.SetManyJSON(ctx, keys, []any{rec{Token: "t1"}, rec{Token: "t2"}}, time.Minute); err != nil {
		t.Fatalf("SetManyJSON: %v", err)
	}

	// Key-aligned result: hits carry the JSON, the miss slot is nil.
	got, err := c.GetManyJSON(ctx, []string{keys[0], "media:test:missing", keys[1]})
	if err != nil {
		t.Fatalf("GetManyJSON: %v", err)
	}
	if len(got) != 3 || got[1] != nil {
		t.Fatalf("alignment = %q, want [hit nil hit]", got)
	}
	if string(got[0]) != `{"token":"t1"}` || string(got[2]) != `{"token":"t2"}` {
		t.Fatalf("payloads = %q", got)
	}

	// The shared TTL was applied to every key in the pipeline.
	for _, k := range keys {
		if ttl, err := plain.TTL(ctx, k).Result(); err != nil || ttl <= 0 {
			t.Fatalf("TTL(%s) = %v (err=%v), want positive", k, ttl, err)
		}
	}
}

func TestGetManyJSONSetManyJSON_Failures_RealRedis(t *testing.T) {
	ctx := context.Background()
	if _, err := cacheFailingOn(t, "mget").GetManyJSON(ctx, []string{"k"}); !errors.Is(err, errInjected) {
		t.Fatalf("GetManyJSON mget failure = %v, want errInjected", err)
	}
	if err := cacheFailingOn(t, "set").SetManyJSON(ctx, []string{"k"}, []any{"v"}, time.Minute); !errors.Is(err, errInjected) {
		t.Fatalf("SetManyJSON pipeline failure = %v, want errInjected", err)
	}
	// An unmarshalable value fails BEFORE any write is queued.
	c, _ := setupRealTestCache(t)
	if err := c.SetManyJSON(ctx, []string{"k"}, []any{func() {}}, time.Minute); err == nil {
		t.Fatal("SetManyJSON(func) = nil error, want marshal failure")
	}
}

// SetUsers marshals concrete user records, which cannot fail — that path uses
// the mustJSON idiom, whose panic arm is pinned here directly.
func TestCacheMustJSONPanicsOnImpossibleFailure(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic from an unmarshalable value")
		}
	}()
	_ = mustJSON(json.Marshal(make(chan int)))
}
