package cache

import (
	"context"
	"math/rand/v2"
	"time"

	"github.com/redis/go-redis/v9"
)

// Notification audience generations. The notifier caches each channel's
// audience (members, mutes, per-channel preferences) and each user's account
// notification settings in-process, and uses an entry only while its Redis
// generation still matches (internal/service AudienceCache). Every writer of
// an audience moves the generation right after its write commits, so every
// instance reloads on its very next fan-out: the services through the
// AudienceCache, the history importer — which must not go through the
// services — through RedisCache.ChannelAudiencesChanged. Both share these
// keys and BumpAudienceGenerations, so they can never drift apart.

// AudienceGenTTL keeps generation keys from outliving their channel or user
// forever. An expired key is re-seeded with a fresh random value, which reads
// as a change — one extra reload, never a stale hit.
const AudienceGenTTL = 30 * 24 * time.Hour

// ChannelAudienceKey is the generation key of a channel's audience.
func ChannelAudienceKey(channelID string) string { return "audgen:ch:" + channelID }

// UserAudienceKey is the generation key of a user's account settings.
func UserAudienceKey(userID string) string { return "audgen:u:" + userID }

// BumpAudienceGenerations moves every key to a new value, by a random step,
// so a key lost to a Redis restart or eviction (and re-seeded at random)
// never comes back with a value an old cache entry still carries.
func BumpAudienceGenerations(ctx context.Context, rdb redis.UniversalClient, keys ...string) error {
	pipe := rdb.Pipeline()
	for _, k := range keys {
		pipe.IncrBy(ctx, k, rand.Int64N(1<<31)+1)
		pipe.Expire(ctx, k, AudienceGenTTL)
	}
	_, err := pipe.Exec(ctx)
	return err
}

// ChannelAudiencesChanged moves the audience generations of these channels,
// for a membership write made outside the services (the history importer).
func (c *RedisCache) ChannelAudiencesChanged(ctx context.Context, channelIDs ...string) error {
	keys := make([]string, len(channelIDs))
	for i, id := range channelIDs {
		keys[i] = ChannelAudienceKey(id)
	}
	return BumpAudienceGenerations(ctx, c.client, keys...)
}
