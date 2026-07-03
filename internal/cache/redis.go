package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

// ErrCacheMiss is returned when a key is not found in the cache.
var ErrCacheMiss = errors.New("cache miss")

const userKeyPrefix = "user:"
const userCacheTTL = 15 * time.Minute
const presenceKeyPrefix = "presence:online:"

// notifAckKeyPrefix / notifAckTTL back the desktop-delivery acknowledgement
// marker. When a client receives a `notification.new` it acks over its
// WebSocket; the backend records the ack here so the deferred mobile-push
// fallback can tell "the desktop actually delivered this" from "presence merely
// claimed the user was online". The TTL only needs to outlive the deferred-push
// window plus slack, so it MUST stay above service.ackFallbackDelay (30s) —
// otherwise a recorded ack could expire before the deferred-push timer reads it
// and the push would fire despite a healthy desktop. 60s clears the 30s delay
// with margin. Cross-instance by construction (Redis), so the ack and the
// deferred push can land on different backend instances. See CLAUDE.md
// (Notifications).
const notifAckKeyPrefix = "notifack:"
const notifAckTTL = 60 * time.Second

// presenceTTL is the backstop expiry for a user's "online" marker. The WS
// keep-alive refreshes it every wsKeepAliveInterval (15s), so it must stay
// comfortably above that to avoid a live user flapping offline between
// refreshes. It is also the *latest* a dead connection can keep a user looking
// online if the graceful OnDisconnect cleanup never runs (e.g. Redis hiccup) —
// so it is deliberately tight (40s, was 90s) to bound the window in which a
// dead desktop socket would suppress the mobile-push fallback. Primary
// dead-socket detection is the protocol ping/pong in the WS keep-alive loop;
// this TTL is the secondary safety net. See CLAUDE.md (Notifications).
const presenceTTL = 40 * time.Second
const emojiFreqKeyPrefix = "emoji:freq:"

// emojiFreqTTL ages out a user's emoji-usage history so a long-dormant
// account doesn't keep stale favourites forever; every use refreshes it.
const emojiFreqTTL = 90 * 24 * time.Hour

// RedisCache wraps a Redis client to provide typed caching operations.
type RedisCache struct {
	client *redis.Client
}

// NewRedisCache parses the given Redis URL, creates a client, and verifies
// connectivity with a PING.
func NewRedisCache(redisURL string) (*RedisCache, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, fmt.Errorf("parse redis url: %w", err)
	}

	client := redis.NewClient(opts)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := client.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("redis ping: %w", err)
	}

	return &RedisCache{client: client}, nil
}

// Get retrieves a value from Redis by key and JSON-unmarshals it into dest.
// Returns ErrCacheMiss if the key does not exist.
func (c *RedisCache) Get(ctx context.Context, key string, dest interface{}) error {
	val, err := c.client.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return ErrCacheMiss
	}
	if err != nil {
		return fmt.Errorf("cache get %q: %w", key, err)
	}
	if err := json.Unmarshal([]byte(val), dest); err != nil {
		return fmt.Errorf("cache unmarshal %q: %w", key, err)
	}
	return nil
}

// Set JSON-marshals val and stores it in Redis with the given TTL.
func (c *RedisCache) Set(ctx context.Context, key string, val interface{}, ttl time.Duration) error {
	data, err := json.Marshal(val)
	if err != nil {
		return fmt.Errorf("cache marshal %q: %w", key, err)
	}
	if err := c.client.Set(ctx, key, data, ttl).Err(); err != nil {
		return fmt.Errorf("cache set %q: %w", key, err)
	}
	return nil
}

// Delete removes a key from Redis.
func (c *RedisCache) Delete(ctx context.Context, key string) error {
	if err := c.client.Del(ctx, key).Err(); err != nil {
		return fmt.Errorf("cache delete %q: %w", key, err)
	}
	return nil
}

// releaseLockScript is a token-fenced compare-and-delete: it removes the lock
// ONLY when the caller's token still owns it, so a caller whose lock already
// expired (and was legitimately re-taken by another instance) never deletes the
// new holder's lock. Atomic in Redis — the GET and DEL can't interleave.
const releaseLockScript = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`

// AcquireLock takes a token-fenced distributed lock via SET key token NX PX ttl.
// Returns true only if THIS caller now holds it; false if another instance holds
// it (or a crashed holder's lock hasn't yet aged out). The token must be unique
// per acquisition so ReleaseLock only ever drops a lock this caller still owns.
// Backs the single-runner election for cluster-wide maintenance jobs (e.g. the
// search mapping rebuild) so parallel containers can't double-run one.
func (c *RedisCache) AcquireLock(ctx context.Context, key, token string, ttl time.Duration) (bool, error) {
	ok, err := c.client.SetNX(ctx, key, token, ttl).Result()
	if err != nil {
		return false, fmt.Errorf("cache acquire lock %q: %w", key, err)
	}
	return ok, nil
}

// ReleaseLock drops the lock only if the caller's token still owns it (see
// releaseLockScript). A no-op when the token no longer matches — safe to call
// even after the lock's TTL lapsed and someone else re-acquired it.
func (c *RedisCache) ReleaseLock(ctx context.Context, key, token string) error {
	if err := c.client.Eval(ctx, releaseLockScript, []string{key}, token).Err(); err != nil {
		return fmt.Errorf("cache release lock %q: %w", key, err)
	}
	return nil
}

// LockHeld reports whether the lock key currently exists. Used to reconcile a
// "running" status whose runner crashed: once the lock's TTL lapses the panel
// stops showing a phantom in-progress job.
func (c *RedisCache) LockHeld(ctx context.Context, key string) (bool, error) {
	n, err := c.client.Exists(ctx, key).Result()
	if err != nil {
		return false, fmt.Errorf("cache lock held %q: %w", key, err)
	}
	return n > 0, nil
}

// AllowRequest implements a fixed-window rate limiter: it increments the per-key
// counter and, on the first hit of a window, sets the window TTL. It reports
// whether the request is within `limit` for the current window. Used by the
// middleware.RateLimit middleware to throttle auth and webhook endpoints.
func (c *RedisCache) AllowRequest(ctx context.Context, key string, limit int, window time.Duration) (bool, error) {
	fullKey := "ratelimit:" + key
	count, err := c.client.Incr(ctx, fullKey).Result()
	if err != nil {
		return false, fmt.Errorf("rate limit increment %q: %w", key, err)
	}
	if count == 1 {
		if err := c.client.Expire(ctx, fullKey, window).Err(); err != nil {
			return false, fmt.Errorf("rate limit expire %q: %w", key, err)
		}
	}
	return count <= int64(limit), nil
}

// IncrementPresence records one active websocket connection for a user. It
// returns true when this connection transitions the user from offline to online.
func (c *RedisCache) IncrementPresence(ctx context.Context, userID string) (bool, error) {
	key := presenceKeyPrefix + userID
	count, err := c.client.Incr(ctx, key).Result()
	if err != nil {
		return false, fmt.Errorf("presence increment %q: %w", userID, err)
	}
	if err := c.client.Expire(ctx, key, presenceTTL).Err(); err != nil {
		return false, fmt.Errorf("presence expire %q: %w", userID, err)
	}
	return count == 1, nil
}

// DecrementPresence removes one active websocket connection for a user. It
// returns true when this disconnect transitions the user from online to offline.
func (c *RedisCache) DecrementPresence(ctx context.Context, userID string) (bool, error) {
	key := presenceKeyPrefix + userID
	count, err := c.client.Decr(ctx, key).Result()
	if err != nil {
		return false, fmt.Errorf("presence decrement %q: %w", userID, err)
	}
	if count <= 0 {
		if err := c.client.Del(ctx, key).Err(); err != nil {
			return false, fmt.Errorf("presence cleanup %q: %w", userID, err)
		}
		return true, nil
	}
	if err := c.client.Expire(ctx, key, presenceTTL).Err(); err != nil {
		return false, fmt.Errorf("presence expire %q: %w", userID, err)
	}
	return false, nil
}

// RefreshPresence extends the online marker for a user that still has a live
// websocket connection.
func (c *RedisCache) RefreshPresence(ctx context.Context, userID string) error {
	key := presenceKeyPrefix + userID
	ok, err := c.client.Expire(ctx, key, presenceTTL).Result()
	if err != nil {
		return fmt.Errorf("presence refresh %q: %w", userID, err)
	}
	if !ok {
		return ErrCacheMiss
	}
	return nil
}

// IsPresenceOnline reports whether any process has an active websocket
// connection for a user.
func (c *RedisCache) IsPresenceOnline(ctx context.Context, userID string) (bool, error) {
	count, err := c.client.Get(ctx, presenceKeyPrefix+userID).Int()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("presence get %q: %w", userID, err)
	}
	return count > 0, nil
}

// MarkNotificationAcked records that the user's client confirmed receipt of the
// desktop notification for messageID. Used by the deferred mobile-push fallback
// to cancel a push once the desktop has actually delivered the alert.
func (c *RedisCache) MarkNotificationAcked(ctx context.Context, userID, messageID string) error {
	if userID == "" || messageID == "" {
		return nil
	}
	if err := c.client.Set(ctx, notifAckKeyPrefix+userID+":"+messageID, "1", notifAckTTL).Err(); err != nil {
		return fmt.Errorf("notification ack set %q/%q: %w", userID, messageID, err)
	}
	return nil
}

// WasNotificationAcked reports whether the user's client has acknowledged the
// desktop notification for messageID. A Redis error or a missing key both
// resolve to false — "not acked" — so an ack lookup failure makes the fallback
// FedEx the push rather than silently swallow it (fail toward delivery).
func (c *RedisCache) WasNotificationAcked(ctx context.Context, userID, messageID string) bool {
	if userID == "" || messageID == "" {
		return false
	}
	n, err := c.client.Exists(ctx, notifAckKeyPrefix+userID+":"+messageID).Result()
	if err != nil {
		return false
	}
	return n > 0
}

// OnlinePresenceUserIDs returns all users with at least one active websocket
// connection across all backend processes.
const nameCacheKeyPrefix = "name:"

// nameCacheTTL is short because display names are only used in notification
// titles (cosmetic) — a rename shows the old name in a push title for at most
// this long, which is acceptable, and the alternative (invalidating on every
// channel/user update) isn't worth the coupling for a title string.
const nameCacheTTL = 5 * time.Minute

// GetName returns a cached display name for key (e.g. "chan:<id>"/"user:<id>").
func (c *RedisCache) GetName(ctx context.Context, key string) (string, bool) {
	v, err := c.client.Get(ctx, nameCacheKeyPrefix+key).Result()
	if err != nil {
		return "", false
	}
	return v, true
}

// SetName caches a display name with a short TTL.
func (c *RedisCache) SetName(ctx context.Context, key, val string) {
	_ = c.client.Set(ctx, nameCacheKeyPrefix+key, val, nameCacheTTL).Err()
}

func (c *RedisCache) OnlinePresenceUserIDs(ctx context.Context) ([]string, error) {
	var keys []string
	var cursor uint64
	for {
		batch, next, err := c.client.Scan(ctx, cursor, presenceKeyPrefix+"*", 100).Result()
		if err != nil {
			return nil, fmt.Errorf("presence list: %w", err)
		}
		keys = append(keys, batch...)
		if next == 0 {
			break
		}
		cursor = next
	}
	if len(keys) == 0 {
		return nil, nil
	}
	// One MGET instead of a GET per key — turns the previous O(online) Redis
	// round-trips into a single one.
	vals, err := c.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("presence list mget: %w", err)
	}
	ids := make([]string, 0, len(keys))
	for i, v := range vals {
		s, ok := v.(string)
		if !ok {
			continue // expired between scan and mget (nil), or unexpected type
		}
		if n, err := strconv.Atoi(s); err == nil && n > 0 {
			ids = append(ids, strings.TrimPrefix(keys[i], presenceKeyPrefix))
		}
	}
	return ids, nil
}

// userCacheRecord is the JSON shape used to cache users. The public model.User
// hides AvatarKey from JSON (json:"-") so it doesn't leak in API responses,
// but the avatar service needs the key to regenerate presigned URLs on read.
// We store it alongside the user so the round-trip preserves it.
type userCacheRecord struct {
	User      model.User `json:"user"`
	AvatarKey string     `json:"avatarKey,omitempty"`
}

// GetUser attempts to retrieve a cached User by ID. Returns ErrCacheMiss if
// the user is not in cache; callers are responsible for loading from the store.
func (c *RedisCache) GetUser(ctx context.Context, userID string) (*model.User, error) {
	var rec userCacheRecord
	if err := c.Get(ctx, userKeyPrefix+userID, &rec); err != nil {
		return nil, err
	}
	rec.User.AvatarKey = rec.AvatarKey
	return &rec.User, nil
}

// SetUser caches a User with a default TTL.
func (c *RedisCache) SetUser(ctx context.Context, user *model.User) error {
	rec := userCacheRecord{User: *user, AvatarKey: user.AvatarKey}
	return c.Set(ctx, userKeyPrefix+user.ID, rec, userCacheTTL)
}

// IncrementEmojiFrequency bumps the per-user usage count for a picked emoji
// shortcode, stored in a sorted set scored by frequency, and refreshes the
// key's TTL.
func (c *RedisCache) IncrementEmojiFrequency(ctx context.Context, userID, shortcode string) error {
	key := emojiFreqKeyPrefix + userID
	if err := c.client.ZIncrBy(ctx, key, 1, shortcode).Err(); err != nil {
		return fmt.Errorf("emoji freq increment %q: %w", userID, err)
	}
	if err := c.client.Expire(ctx, key, emojiFreqTTL).Err(); err != nil {
		return fmt.Errorf("emoji freq expire %q: %w", userID, err)
	}
	return nil
}

// FrequentEmojis returns up to limit of the user's most-used emoji shortcodes,
// highest count first.
func (c *RedisCache) FrequentEmojis(ctx context.Context, userID string, limit int) ([]string, error) {
	if limit <= 0 {
		return []string{}, nil
	}
	key := emojiFreqKeyPrefix + userID
	res, err := c.client.ZRangeArgs(ctx, redis.ZRangeArgs{
		Key:   key,
		Start: 0,
		Stop:  limit - 1,
		Rev:   true,
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("emoji freq list %q: %w", userID, err)
	}
	return res, nil
}

// Client returns the underlying Redis client for advanced operations.
func (c *RedisCache) Client() *redis.Client {
	return c.client
}
