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
	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/redis/go-redis/v9"
)

// ErrCacheMiss is returned when a key is not found in the cache.
var ErrCacheMiss = errors.New("cache miss")

const userKeyPrefix = "user:"
const userCacheTTL = 15 * time.Minute
// presenceKeyPrefix keys a PER-USER SORTED SET of live connection IDs, each
// scored by its own expiry (unix ms). This replaced the old plain INCR/DECR
// counter, whose value was an opaque integer that couldn't say WHICH
// connection contributed: a crashed instance's +1 leaked until the whole-key
// TTL, a DECR on a lapsed key drove the count negative and flapped a live
// user offline, and a lost marker could never self-heal. With per-connection
// members every connection expires independently, ZREM of a missing member
// is a no-op, and the keep-alive's ZADD recreates a lost entry within one
// interval. (New key prefix vs. the old counter's "presence:online:" so a
// mixed-version fleet during a rolling deploy never type-clashes.)
const presenceKeyPrefix = "presence:conns:"

// presenceIndexKey is a sorted set of every online userID, scored by the unix
// millisecond at which that user's presence marker expires. It exists so the
// online snapshot is O(online users) (ZRANGEBYSCORE) instead of a full
// keyspace SCAN — the scan walked EVERY key in the database (drafts, unread
// watermarks, streams, …) and outgrew the 500ms presence budget in
// production. Every write that extends the per-user marker also re-scores the
// index entry, so index freshness always matches the marker TTL.
const presenceIndexKey = "presence:index"

// notifAckKeyPrefix / notifAckTTL back the desktop-delivery acknowledgement
// marker. When a client receives a `notification.new` it acks over its
// WebSocket; the backend records the ack here so the deferred mobile-push
// fallback can tell "the desktop actually delivered this" from "presence merely
// claimed the user was online". The TTL must outlive the deferred-push window
// plus every source of delivery lag — the asynq worker reads the ack at
// DELIVERY time, which trails service.ackFallbackDelay (30s) by the delayed-
// task promotion interval (up to 5s) plus queue/retry wait — otherwise a
// recorded ack could expire before the worker reads it and the push would
// fire despite a healthy desktop. 5m clears all of it with a wide margin at
// negligible Redis cost. Cross-instance by construction (Redis), so the ack
// and the scheduled push can land on different backend instances. See
// CLAUDE.md (Notifications).
const notifAckKeyPrefix = "notifack:"
const notifAckTTL = 5 * time.Minute

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
// account doesn't keep stale favourites forever. Both reads AND writes refresh
// it (see FrequentEmojis), so any active user — one who so much as opens the
// picker within a year — keeps their favourites; only a truly gone account
// expires.
const emojiFreqTTL = 365 * 24 * time.Hour

// emojiFreqDecay is the PER-EVENT decay factor: on every pick, all existing
// scores are multiplied by this before the picked emoji gains +1. Decay is
// keyed to USE, not to wall-clock time — so using OTHER emojis is what pushes a
// stale one down, and it does so immediately (a time-based decay left an
// entrenched count "stuck" during a session because almost no time passes).
// 0.9 means ~7 picks of other emojis halve a score and dislodge even a
// maxed-out favourite; scores converge to 1/(1-0.9)=10, so nothing runs away.
// Lower = more aggressively recency-driven; higher = stickier. Tune here.
const emojiFreqDecay = 0.9

// emojiFreqIncrScript atomically, per pick: (1) multiplies every member's score
// by emojiFreqDecay — RESCALING only, never removing, so a stale emoji merely
// sinks in the ranking and nothing is ever purged (the shelf stays full from
// history); (2) adds 1 to the picked emoji; (3) refreshes the key's TTL.
// Deterministic (no clock), so it's replication-safe and easy to reason about.
var emojiFreqIncrScript = redis.NewScript(`
local member = ARGV[1]
local decay = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local flat = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
for i = 1, #flat, 2 do
  redis.call('ZADD', KEYS[1], tonumber(flat[i + 1]) * decay, flat[i])
end
redis.call('ZINCRBY', KEYS[1], 1, member)
redis.call('EXPIRE', KEYS[1], ttl)
return 1
`)

// RedisCache wraps a Redis client to provide typed caching operations.
type RedisCache struct {
	client *redis.Client
}

// NewRedisCache parses the given Redis URL, creates a client, and verifies
// connectivity with a PING.
func NewRedisCache(redisURL string) (*RedisCache, error) {
	opts, err := redisx.Options(redisURL)
	if err != nil {
		return nil, err
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
	// One atomic MULTI/EXEC round trip: INCR the window counter and ensure it
	// carries the window TTL. PEXPIRE NX sets the TTL only when the key has
	// none — the first hit of a window, plus healing any legacy TTL-less key —
	// so this closes the partial-failure hole (a successful INCR whose EXPIRE
	// never ran leaving an immortal counter) without a Lua script. The NX flag
	// needs Redis >= 7.0; the deployment floor is 7.1.
	pipe := c.client.TxPipeline()
	incr := pipe.Incr(ctx, fullKey)
	pipe.Do(ctx, "pexpire", fullKey, window.Milliseconds(), "NX")
	if _, err := pipe.Exec(ctx); err != nil {
		return false, fmt.Errorf("rate limit increment %q: %w", key, err)
	}
	return incr.Val() <= int64(limit), nil
}

// presenceIndexScore is the online-index expiry score matching a marker
// extended right now.
func presenceIndexScore() float64 {
	return float64(time.Now().Add(presenceTTL).UnixMilli())
}

// IncrementPresence records one active websocket connection for a user. It
// returns true when this connection transitions the user from offline to online.
// Marker INCR, marker TTL and index re-score ride one pipeline — this runs on
// every WS connect, and reconnect storms multiply any extra round trip.
// presenceConnScore is a connection's expiry score: a member whose score is
// in the future is live; at or below now it has lapsed (its keep-alive
// stopped). Same clock/format as the presence index.
func presenceConnScore() float64 {
	return float64(time.Now().Add(presenceTTL).UnixMilli())
}

// presenceNowCutoff is the exclusive lower bound for "live" members.
func presenceNowCutoff() string {
	return "(" + strconv.FormatInt(time.Now().UnixMilli(), 10)
}

// IncrementPresence records connID as a live connection for the user and
// reports whether this made the user online (first live connection anywhere
// in the fleet). Lapsed members are pruned in the same pipeline so a crashed
// instance's leftovers can't inflate the count past their TTL.
func (c *RedisCache) IncrementPresence(ctx context.Context, userID, connID string) (bool, error) {
	key := presenceKeyPrefix + userID
	now := time.Now().UnixMilli()
	pipe := c.client.Pipeline()
	pipe.ZRemRangeByScore(ctx, key, "-inf", strconv.FormatInt(now, 10))
	pipe.ZAdd(ctx, key, redis.Z{Score: presenceConnScore(), Member: connID})
	card := pipe.ZCard(ctx, key)
	// Key-level backstop so an orphaned set (instance died mid-teardown)
	// vanishes shortly after its members lapse.
	pipe.Expire(ctx, key, presenceTTL+time.Minute)
	pipe.ZAdd(ctx, presenceIndexKey, redis.Z{Score: presenceIndexScore(), Member: userID})
	if _, err := pipe.Exec(ctx); err != nil {
		return false, fmt.Errorf("presence increment %q: %w", userID, err)
	}
	return card.Val() == 1, nil
}

// DecrementPresence removes connID and reports whether the user is now
// offline (no live connections remain). ZREM of an already-expired/missing
// member is a harmless no-op — the old counter's negative-value flap (a DECR
// against a lapsed key knocking a still-connected user offline) is
// structurally impossible here. Two round trips: the removal+count, then the
// branch-dependent index update.
func (c *RedisCache) DecrementPresence(ctx context.Context, userID, connID string) (bool, error) {
	key := presenceKeyPrefix + userID
	now := time.Now().UnixMilli()
	pipe := c.client.Pipeline()
	pipe.ZRem(ctx, key, connID)
	pipe.ZRemRangeByScore(ctx, key, "-inf", strconv.FormatInt(now, 10))
	card := pipe.ZCard(ctx, key)
	if _, err := pipe.Exec(ctx); err != nil {
		return false, fmt.Errorf("presence decrement %q: %w", userID, err)
	}
	pipe = c.client.Pipeline()
	if card.Val() == 0 {
		// Redis deletes an empty sorted set automatically; only the index
		// entry needs cleanup.
		pipe.ZRem(ctx, presenceIndexKey, userID)
		if _, err := pipe.Exec(ctx); err != nil {
			return false, fmt.Errorf("presence cleanup %q: %w", userID, err)
		}
		return true, nil
	}
	pipe.Expire(ctx, key, presenceTTL+time.Minute)
	pipe.ZAdd(ctx, presenceIndexKey, redis.Z{Score: presenceIndexScore(), Member: userID})
	if _, err := pipe.Exec(ctx); err != nil {
		return false, fmt.Errorf("presence expire %q: %w", userID, err)
	}
	return false, nil
}

// RefreshPresence re-scores connID's expiry. This is the single most frequent
// Redis operation in the backend (every connection, every keep-alive
// interval). The plain ZADD is the SELF-HEAL path: a member lost to a Redis
// blip (or a whole set lost to an eviction) is recreated within one
// keep-alive interval — under the old counter design a lapsed marker stayed
// gone until the user physically reconnected, showing a live user offline
// indefinitely. The index re-score keeps the snapshot source fresh the same
// way.
func (c *RedisCache) RefreshPresence(ctx context.Context, userID, connID string) error {
	key := presenceKeyPrefix + userID
	pipe := c.client.Pipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: presenceConnScore(), Member: connID})
	pipe.Expire(ctx, key, presenceTTL+time.Minute)
	pipe.ZAdd(ctx, presenceIndexKey, redis.Z{Score: presenceIndexScore(), Member: userID})
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("presence refresh %q: %w", userID, err)
	}
	return nil
}

// IsPresenceOnline reports whether any process has a LIVE (non-lapsed)
// websocket connection for a user. Pure read — lapsed members are ignored by
// score, not pruned here.
func (c *RedisCache) IsPresenceOnline(ctx context.Context, userID string) (bool, error) {
	count, err := c.client.ZCount(ctx, presenceKeyPrefix+userID, presenceNowCutoff(), "+inf").Result()
	if err != nil {
		return false, fmt.Errorf("presence zcount %q: %w", userID, err)
	}
	return count > 0, nil
}

// ArePresenceOnline reports online status for many users in ONE pipelined
// round trip — the notification fan-out needs the whole recipient set at
// once, and a read per recipient made every message cost O(members) Redis
// calls. A missing set counts zero live members (offline), same as
// IsPresenceOnline.
func (c *RedisCache) ArePresenceOnline(ctx context.Context, userIDs []string) (map[string]bool, error) {
	out := make(map[string]bool, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	cutoff := presenceNowCutoff()
	pipe := c.client.Pipeline()
	counts := make([]*redis.IntCmd, len(userIDs))
	for i, id := range userIDs {
		counts[i] = pipe.ZCount(ctx, presenceKeyPrefix+id, cutoff, "+inf")
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, fmt.Errorf("presence pipeline: %w", err)
	}
	for i, cmd := range counts {
		out[userIDs[i]] = cmd.Val() > 0
	}
	return out, nil
}

// wsTicketKeyPrefix / wsTicketTTL back the one-time WebSocket upgrade
// tickets. A browser cannot set an Authorization header on a WebSocket, so
// the upgrade used to carry the full 15-minute access JWT in the URL query —
// visible to LB/proxy logs, browser history, and APM URL capture. A ticket is
// a single-use, 30-second, high-entropy opaque token minted over an authed
// POST; the only thing that ever appears in a URL. GETDEL redemption makes
// replay structurally impossible.
const wsTicketKeyPrefix = "wsticket:"
const wsTicketTTL = 30 * time.Second

// MintWSTicket stores a one-time WebSocket upgrade ticket for the user. The
// session deadline rides along so the socket inherits the access token's
// remaining lifetime (bounding a deactivated user's exposure even if the
// ephemeral force-logout event is lost).
func (c *RedisCache) MintWSTicket(ctx context.Context, ticket, userID string, sessionDeadline time.Time) error {
	if ticket == "" || userID == "" {
		return errors.New("cache: empty ws ticket or user")
	}
	val := userID + "|" + strconv.FormatInt(sessionDeadline.UnixMilli(), 10)
	if err := c.client.Set(ctx, wsTicketKeyPrefix+ticket, val, wsTicketTTL).Err(); err != nil {
		return fmt.Errorf("cache: mint ws ticket: %w", err)
	}
	return nil
}

// ConsumeWSTicket atomically redeems a ticket (GETDEL — a second redemption
// of the same ticket finds nothing). Returns ("", zero, nil) for an unknown,
// expired, or already-used ticket; the caller answers 401.
func (c *RedisCache) ConsumeWSTicket(ctx context.Context, ticket string) (string, time.Time, error) {
	if ticket == "" {
		return "", time.Time{}, nil
	}
	val, err := c.client.GetDel(ctx, wsTicketKeyPrefix+ticket).Result()
	if errors.Is(err, redis.Nil) {
		return "", time.Time{}, nil
	}
	if err != nil {
		return "", time.Time{}, fmt.Errorf("cache: consume ws ticket: %w", err)
	}
	sep := strings.LastIndexByte(val, '|')
	if sep <= 0 {
		return "", time.Time{}, nil
	}
	ms, perr := strconv.ParseInt(val[sep+1:], 10, 64)
	if perr != nil {
		return "", time.Time{}, nil
	}
	return val[:sep], time.UnixMilli(ms), nil
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
	// Reads come from the online index, NOT a keyspace SCAN: SCAN's cost is
	// proportional to EVERY key in the database and blew the presence budget
	// once the durable key families (unread watermarks, drafts, streams)
	// grew. The index is O(online users).
	now := strconv.FormatInt(time.Now().UnixMilli(), 10)
	// Prune members whose marker has expired so the index stays bounded even
	// for sessions that never decrement (killed instance, dead socket).
	if err := c.client.ZRemRangeByScore(ctx, presenceIndexKey, "-inf", now).Err(); err != nil {
		return nil, fmt.Errorf("presence index prune: %w", err)
	}
	members, err := c.client.ZRangeArgs(ctx, redis.ZRangeArgs{
		Key: presenceIndexKey, ByScore: true, Start: "(" + now, Stop: "+inf",
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("presence index range: %w", err)
	}
	if len(members) == 0 {
		return nil, nil
	}
	// Verify against the authoritative per-user connection sets in one
	// pipeline: an index entry can outlive its set (crash between cleanup and
	// ZREM), and only a set with a live (non-lapsed) member means online.
	verified, err := c.ArePresenceOnline(ctx, members)
	if err != nil {
		return nil, fmt.Errorf("presence list verify: %w", err)
	}
	ids := make([]string, 0, len(members))
	for _, id := range members {
		if verified[id] {
			ids = append(ids, id)
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

// IncrementEmojiFrequency records one use of a picked emoji shortcode as a
// PER-EVENT recency-decayed count: every existing score is multiplied by
// emojiFreqDecay, then the picked emoji gets +1 (see emojiFreqIncrScript). So
// the shelf tracks current habits — using OTHER emojis pushes a stale one down
// right away — while nothing is ever removed (a favourite only sinks, never
// vanishes). Every pick path records a use (picker, quick-reaction bar, and the
// composer :shortcode: typeahead — the typeahead not recording was the original
// "shelf never updates" bug).
func (c *RedisCache) IncrementEmojiFrequency(ctx context.Context, userID, shortcode string) error {
	err := redisx.RunScript(
		ctx,
		c.client,
		emojiFreqIncrScript,
		[]string{emojiFreqKeyPrefix + userID},
		shortcode,
		emojiFreqDecay,
		int(emojiFreqTTL.Seconds()),
	).Err()
	if err != nil {
		return fmt.Errorf("emoji freq increment %q: %w", userID, err)
	}
	return nil
}

// FrequentEmojis returns up to limit of the user's most-used emoji shortcodes,
// highest count first. Reading ALSO refreshes the TTL: merely opening the
// emoji picker (or rendering the quick-reaction bar, which reads this list)
// keeps a user's favourites alive, so an active user never loses them to the
// inactivity TTL — only a user who is gone for the whole TTL window ages out.
func (c *RedisCache) FrequentEmojis(ctx context.Context, userID string, limit int) ([]string, error) {
	if limit <= 0 {
		return []string{}, nil
	}
	key := emojiFreqKeyPrefix + userID
	pipe := c.client.Pipeline()
	rangeCmd := pipe.ZRangeArgs(ctx, redis.ZRangeArgs{
		Key:   key,
		Start: 0,
		Stop:  limit - 1,
		Rev:   true,
	})
	// Refresh the TTL on read so opening the picker keeps a favourite alive;
	// Expire on a missing key is a harmless no-op. The read does NOT decay:
	// decay is per-pick only, so reads never change the ranking.
	pipe.Expire(ctx, key, emojiFreqTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, fmt.Errorf("emoji freq list %q: %w", userID, err)
	}
	return rangeCmd.Result()
}

// Client returns the underlying Redis client for advanced operations.
func (c *RedisCache) Client() *redis.Client {
	return c.client
}

// GetUsers retrieves many cached users in ONE MGET round trip instead of a
// GET per ID (the pattern that made /users/batch cost 2N sequential Redis
// calls). Misses and undecodable records are simply absent from the result;
// callers resolve them from the store.
func (c *RedisCache) GetUsers(ctx context.Context, userIDs []string) (map[string]*model.User, error) {
	if len(userIDs) == 0 {
		return map[string]*model.User{}, nil
	}
	keys := make([]string, len(userIDs))
	for i, id := range userIDs {
		keys[i] = userKeyPrefix + id
	}
	vals, err := c.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("cache mget users: %w", err)
	}
	out := make(map[string]*model.User, len(vals))
	for i, v := range vals {
		s, ok := v.(string)
		if !ok {
			continue // miss
		}
		var rec userCacheRecord
		if err := json.Unmarshal([]byte(s), &rec); err != nil {
			continue // stale/corrupt entry: treat as a miss, the store heals it
		}
		rec.User.AvatarKey = rec.AvatarKey
		u := rec.User
		out[userIDs[i]] = &u
	}
	return out, nil
}

// SetUsers caches many users in one pipelined write (misses filled after a
// batched store read shouldn't cost a round trip each).
func (c *RedisCache) SetUsers(ctx context.Context, users []*model.User) error {
	if len(users) == 0 {
		return nil
	}
	pipe := c.client.Pipeline()
	for _, u := range users {
		rec := userCacheRecord{User: *u, AvatarKey: u.AvatarKey}
		pipe.Set(ctx, userKeyPrefix+u.ID, mustJSON(json.Marshal(rec)), userCacheTTL)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("cache pipeline set users: %w", err)
	}
	return nil
}

// GetManyJSON MGETs raw JSON values for the given keys in one round trip.
// The result is key-aligned; a nil slot is a miss.
func (c *RedisCache) GetManyJSON(ctx context.Context, keys []string) ([][]byte, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	vals, err := c.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("cache mget: %w", err)
	}
	out := make([][]byte, len(vals))
	for i, v := range vals {
		if s, ok := v.(string); ok {
			out[i] = []byte(s)
		}
	}
	return out, nil
}

// SetManyJSON writes many JSON values (key-aligned with values, one shared
// TTL) in one pipelined round trip. Signature stays primitive-typed so
// service-layer capability assertions don't need a shared struct type.
func (c *RedisCache) SetManyJSON(ctx context.Context, keys []string, values []any, ttl time.Duration) error {
	if len(keys) == 0 {
		return nil
	}
	pipe := c.client.Pipeline()
	for i, key := range keys {
		data, err := json.Marshal(values[i])
		if err != nil {
			return fmt.Errorf("cache marshal %q: %w", key, err)
		}
		pipe.Set(ctx, key, data, ttl)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("cache pipeline set: %w", err)
	}
	return nil
}
