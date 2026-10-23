//go:build integration

package cache

import (
	"context"
	"testing"
)

// ChannelAudiencesChanged moves exactly the named channels' audience
// generations, under the keys the notifier reads, with a bounded TTL.
func TestChannelAudiencesChanged(t *testing.T) {
	c := newRealCache(t)
	ctx := context.Background()
	rdb := c.Client()
	a, b, other := ChannelAudienceKey("aud-a"), ChannelAudienceKey("aud-b"), ChannelAudienceKey("aud-other")
	if err := rdb.Del(ctx, a, b, other).Err(); err != nil {
		t.Fatalf("del: %v", err)
	}
	if err := rdb.Set(ctx, a, 7, 0).Err(); err != nil {
		t.Fatalf("seed: %v", err)
	}

	if err := c.ChannelAudiencesChanged(ctx, "aud-a", "aud-b"); err != nil {
		t.Fatalf("ChannelAudiencesChanged: %v", err)
	}
	if v, _ := rdb.Get(ctx, a).Int64(); v <= 7 {
		t.Fatalf("aud-a generation = %d, want moved past 7", v)
	}
	if v, _ := rdb.Get(ctx, b).Int64(); v <= 0 {
		t.Fatalf("aud-b generation = %d, want set", v)
	}
	if n := rdb.Exists(ctx, other).Val(); n != 0 {
		t.Fatal("an unnamed channel's generation moved")
	}
	for _, k := range []string{a, b} {
		if ttl := rdb.TTL(ctx, k).Val(); ttl <= 0 || ttl > AudienceGenTTL {
			t.Fatalf("%s TTL = %v, want within (0, %v]", k, ttl, AudienceGenTTL)
		}
	}
	if UserAudienceKey("u1") == ChannelAudienceKey("u1") {
		t.Fatal("user and channel generations share a key")
	}
	// Nothing to move is no round trip and no error.
	if err := c.ChannelAudiencesChanged(ctx); err != nil {
		t.Fatalf("empty: %v", err)
	}
}
