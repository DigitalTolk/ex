// The notification audience cache: each channel's members + per-channel
// overrides/mutes, and each user's account notification settings, kept
// in-process and used ONLY while a Redis generation counter still matches.
// Every in-app change to an audience bumps its generation synchronously after
// the write commits, so every instance sees the change on its very next
// fan-out: a removed member is never alerted from a stale list, a newly
// joined member never missed. Without the cache a 1000-member channel cost
// ~21 round trips and ~1000 read units per message; with it, one MGET.

package service

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/cache"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/safe"
	"github.com/DigitalTolk/ex/internal/store"
	lru "github.com/hashicorp/golang-lru/v2"
	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/errgroup"
)

// AudienceInvalidator is told, synchronously and after the write committed,
// whenever a notification audience changed: a channel's membership, a
// member's role, mute or per-channel preferences, or a user's account
// notification settings (levels, keywords, follow-all).
type AudienceInvalidator interface {
	ChannelAudienceChanged(ctx context.Context, channelID string)
	UserAudienceChanged(ctx context.Context, userID string)
}

// AudienceGenerations holds one opaque generation per audience key. Values
// only ever need comparing for equality.
type AudienceGenerations interface {
	// Generations returns the current value of every key, in order — one
	// round trip in the steady state.
	Generations(ctx context.Context, keys []string) ([]string, error)
	// Bump moves every key to a new value.
	Bump(ctx context.Context, keys ...string) error
}

// RedisAudienceGenerations is the production AudienceGenerations. Keys are
// seeded with a random value and bumped by a random step, so a key lost to a
// Redis restart or eviction never comes back with a value an old cache entry
// still carries.
type RedisAudienceGenerations struct {
	rdb redis.UniversalClient
}

// NewRedisAudienceGenerations wraps a Redis client built through
// redisx.Options like every other client in the app.
func NewRedisAudienceGenerations(rdb redis.UniversalClient) *RedisAudienceGenerations {
	return &RedisAudienceGenerations{rdb: rdb}
}

func (g *RedisAudienceGenerations) Generations(ctx context.Context, keys []string) ([]string, error) {
	vals, err := g.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	out := make([]string, len(keys))
	var missing []int
	for i, v := range vals {
		if s, ok := v.(string); ok {
			out[i] = s
		} else {
			missing = append(missing, i)
		}
	}
	if len(missing) == 0 {
		return out, nil
	}
	// Seed the missing keys (first use, or lost) and read back whichever
	// value won a concurrent seed.
	pipe := g.rdb.Pipeline()
	gets := make([]*redis.StringCmd, len(missing))
	for j, i := range missing {
		pipe.SetNX(ctx, keys[i], rand.Int64N(1<<62), cache.AudienceGenTTL)
		gets[j] = pipe.Get(ctx, keys[i])
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	for j, i := range missing {
		out[i] = gets[j].Val()
	}
	return out, nil
}

func (g *RedisAudienceGenerations) Bump(ctx context.Context, keys ...string) error {
	return cache.BumpAudienceGenerations(ctx, g.rdb, keys...)
}

// The keys are shared with the history importer, which bumps them without
// going through this package (internal/cache).
func channelAudienceKey(channelID string) string { return cache.ChannelAudienceKey(channelID) }
func userAudienceKey(userID string) string       { return cache.UserAudienceKey(userID) }

// Cache bounds. audienceEntryTTL is the backstop for an audience write whose
// bump was lost (Redis unreachable right after it, retried and logged at
// ERROR) or that bypasses every bumping writer (a hand-run migration): the
// generation check covers the services and the history importer, and nothing
// else can keep an entry stale for longer than this. Each expiry re-reads the
// channel's members, overrides and account settings consistently, so it is
// not shorter than it needs to be.
const (
	audienceChannelCacheSize = 2048
	audienceUserCacheSize    = 50_000
	audienceEntryTTL         = 5 * time.Minute
)

type channelAudienceEntry struct {
	gen       string
	loadedAt  time.Time
	memberIDs []string
	overrides map[string]*model.UserChannel
}

type userAudienceEntry struct {
	gen      string
	loadedAt time.Time
	acct     store.NotificationAccount
}

// AudienceCache is the generation-checked, bounded, in-process audience
// cache. Safe for concurrent use.
type AudienceCache struct {
	gens     AudienceGenerations
	channels *lru.Cache[string, channelAudienceEntry]
	users    *lru.Cache[string, userAudienceEntry]
	now      func() time.Time
}

// NewAudienceCache builds the cache over the shared generation store.
func NewAudienceCache(gens AudienceGenerations) *AudienceCache {
	return &AudienceCache{
		gens:     gens,
		channels: mustLRU(lru.New[string, channelAudienceEntry](audienceChannelCacheSize)),
		users:    mustLRU(lru.New[string, userAudienceEntry](audienceUserCacheSize)),
		now:      time.Now,
	}
}

// ChannelAudienceChanged bumps the channel's generation (every instance
// reloads it on its next fan-out) and drops the local entry.
func (c *AudienceCache) ChannelAudienceChanged(ctx context.Context, channelID string) {
	c.channels.Remove(channelID)
	c.bump(ctx, channelAudienceKey(channelID), "channelID", channelID)
}

// UserAudienceChanged bumps the user's generation and drops the local entry.
func (c *AudienceCache) UserAudienceChanged(ctx context.Context, userID string) {
	c.users.Remove(userID)
	c.bump(ctx, userAudienceKey(userID), "userID", userID)
}

func (c *AudienceCache) bump(ctx context.Context, key, idName, id string) {
	if _, err := retryAudienceLoad(context.WithoutCancel(ctx), func() (struct{}, error) {
		return struct{}{}, c.gens.Bump(context.WithoutCancel(ctx), key)
	}); err != nil {
		// Other instances keep their cached copy until it ages out
		// (audienceEntryTTL): alerts may follow the old audience until then.
		slog.ErrorContext(ctx, "notification audience change not propagated — other instances may alert the old audience briefly",
			idName, id, "error", err)
	}
}

func (c *AudienceCache) fresh(loadedAt time.Time) bool {
	return c.now().Sub(loadedAt) < audienceEntryTTL
}

// SetAudienceCache wires the generation-checked audience cache. Optional —
// without it every fan-out reads its audience from the stores.
func (s *NotificationService) SetAudienceCache(c *AudienceCache) { s.audience = c }

// consistentMemberLister is the strongly consistent member read of the
// membership store (the DynamoDB impl has it). A cache fill must read
// consistently: an eventually consistent read right after a join could miss
// the new member, and the cache would then keep them out until the next
// change. Plain test stores fall back to ListMembers.
type consistentMemberLister interface {
	ListMembersConsistent(ctx context.Context, channelID string) ([]*model.ChannelMembership, error)
}

// audienceBatchSize matches DynamoDB's BatchGetItem cap; audienceReadLimit
// bounds how many of a fan-out's batch reads run at once.
const (
	audienceBatchSize = 100
	audienceReadLimit = 8
)

// channelAudience is everything the fan-out needs about a channel's members.
// overridesOK is false when the per-channel overrides could not be read (the
// caller then over-notifies rather than drops anyone).
type channelAudience struct {
	memberIDs   []string
	overrides   map[string]*model.UserChannel
	overridesOK bool
	accounts    map[string]store.NotificationAccount
}

// loadChannelAudience resolves a channel's members, their per-channel
// overrides and their account settings — through the cache when wired. In
// the steady state that is ONE MGET (the channel's generation together with
// every member's); a changed channel reloads its members and overrides in
// parallel with the account reads.
func (s *NotificationService) loadChannelAudience(ctx context.Context, channelID string) (channelAudience, error) {
	if s.audience == nil {
		return s.readChannelAudience(ctx, channelID, false)
	}
	cached, have := s.audience.channels.Get(channelID)
	if have && s.audience.fresh(cached.loadedAt) {
		keys := make([]string, 0, len(cached.memberIDs)+1)
		keys = append(keys, channelAudienceKey(channelID))
		for _, uid := range cached.memberIDs {
			keys = append(keys, userAudienceKey(uid))
		}
		if gens, err := s.audience.gens.Generations(ctx, keys); err == nil && gens[0] == cached.gen {
			userGens := make(map[string]string, len(cached.memberIDs))
			for i, uid := range cached.memberIDs {
				userGens[uid] = gens[i+1]
			}
			return channelAudience{
				memberIDs:   cached.memberIDs,
				overrides:   cached.overrides,
				overridesOK: true,
				accounts:    s.cachedAccounts(ctx, cached.memberIDs, userGens),
			}, nil
		}
	}
	// Miss: read the generation FIRST, then the data. A change that lands
	// after this read bumps the generation past it, so the entry stored
	// below can never shadow that change.
	gens, err := s.audience.gens.Generations(ctx, []string{channelAudienceKey(channelID)})
	if err != nil {
		slog.WarnContext(ctx, "audience generation read failed; reading the audience uncached", "channelID", channelID, "error", err)
		return s.readChannelAudience(ctx, channelID, false)
	}
	aud, err := s.readChannelAudience(ctx, channelID, true)
	if err != nil {
		return aud, err
	}
	if aud.overridesOK {
		s.audience.channels.Add(channelID, channelAudienceEntry{
			gen: gens[0], loadedAt: s.audience.now(), memberIDs: aud.memberIDs, overrides: aud.overrides,
		})
	}
	return aud, nil
}

// readChannelAudience reads the members, then their overrides and account
// settings concurrently. consistent selects the strongly consistent reads a
// cache fill needs.
func (s *NotificationService) readChannelAudience(ctx context.Context, channelID string, consistent bool) (channelAudience, error) {
	list := s.members.ListMembers
	if cl, ok := s.members.(consistentMemberLister); ok && consistent {
		list = cl.ListMembersConsistent
	}
	members, err := retryAudienceLoad(ctx, func() ([]*model.ChannelMembership, error) {
		return list(ctx, channelID)
	})
	if err != nil {
		return channelAudience{}, err
	}
	ids := make([]string, 0, len(members))
	for _, m := range members {
		ids = append(ids, m.UserID)
	}
	aud := channelAudience{memberIDs: ids, overrides: map[string]*model.UserChannel{}}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		defer safe.Recover()
		aud.overrides, aud.overridesOK = s.readOverrides(ctx, channelID, ids)
	}()
	aud.accounts = s.accountsFor(ctx, ids)
	wg.Wait()
	return aud, nil
}

// readOverrides batch-reads the members' per-channel overrides (incl. mute),
// chunked and bounded-parallel. On failure it reports !ok with an empty map —
// a missed mute/override is a minor over-notification, never a dropped member.
func (s *NotificationService) readOverrides(ctx context.Context, channelID string, ids []string) (map[string]*model.UserChannel, bool) {
	out := make(map[string]*model.UserChannel)
	var mu sync.Mutex
	err := parallelChunks(ctx, ids, func(ctx context.Context, chunk []string) error {
		got, err := s.members.UserChannelNotifPrefs(ctx, channelID, chunk)
		if err != nil {
			return err
		}
		mergeInto(&mu, out, got)
		return nil
	})
	if err != nil {
		return map[string]*model.UserChannel{}, false
	}
	return out, true
}

// accountsFor returns the account notification settings of ids — through the
// cache when wired (one MGET of their generations, then a read of the misses).
func (s *NotificationService) accountsFor(ctx context.Context, ids []string) map[string]store.NotificationAccount {
	if s.audience == nil {
		got, _ := s.readAccounts(ctx, ids)
		return got
	}
	keys := make([]string, len(ids))
	for i, uid := range ids {
		keys[i] = userAudienceKey(uid)
	}
	gens, err := s.audience.gens.Generations(ctx, keys)
	if err != nil {
		slog.WarnContext(ctx, "audience generation read failed; reading account settings uncached", "error", err)
		got, _ := s.readAccounts(ctx, ids)
		return got
	}
	userGens := make(map[string]string, len(ids))
	for i, uid := range ids {
		userGens[uid] = gens[i]
	}
	return s.cachedAccounts(ctx, ids, userGens)
}

// cachedAccounts serves each user's settings from the cache when its entry
// carries the generation just read, and reads (then caches) the rest. The
// generations were read before the misses are loaded, so a settings change
// racing this fan-out bumps past the stored generation.
func (s *NotificationService) cachedAccounts(ctx context.Context, ids []string, gens map[string]string) map[string]store.NotificationAccount {
	out := make(map[string]store.NotificationAccount, len(ids))
	var misses []string
	for _, uid := range ids {
		if e, ok := s.audience.users.Get(uid); ok && e.gen == gens[uid] && s.audience.fresh(e.loadedAt) {
			out[uid] = e.acct
			continue
		}
		misses = append(misses, uid)
	}
	if len(misses) == 0 {
		return out
	}
	got, ok := s.readAccounts(ctx, misses)
	now := s.audience.now()
	for uid, acct := range got {
		out[uid] = acct
		if ok {
			s.audience.users.Add(uid, userAudienceEntry{gen: gens[uid], loadedAt: now, acct: acct})
		}
	}
	return out
}

// readAccounts batch-reads account settings, chunked and bounded-parallel.
// Users without a profile row are absent (the caller defaults them, and they
// are never cached). ok is false when any chunk failed — what was read is
// still returned, but nothing from a partial read is cached.
func (s *NotificationService) readAccounts(ctx context.Context, ids []string) (map[string]store.NotificationAccount, bool) {
	out := make(map[string]store.NotificationAccount, len(ids))
	if s.users == nil {
		return out, false
	}
	var mu sync.Mutex
	err := parallelChunks(ctx, ids, func(ctx context.Context, chunk []string) error {
		got, err := s.users.NotificationAccountsFor(ctx, chunk)
		if err != nil {
			return err
		}
		mergeInto(&mu, out, got)
		return nil
	})
	return out, err == nil
}

// errAudienceChunkPanicked marks a batch read that panicked (recovered and
// logged by safe.Recover) — reported like any other failed chunk.
var errAudienceChunkPanicked = errors.New("notification audience: batch read panicked")

// parallelChunks runs fn over ids in audienceBatchSize chunks, at most
// audienceReadLimit at once, and returns the first error. Every chunk still
// runs when another fails, so partial results are as complete as possible.
func parallelChunks(ctx context.Context, ids []string, fn func(ctx context.Context, chunk []string) error) error {
	var g errgroup.Group
	g.SetLimit(audienceReadLimit)
	for start := 0; start < len(ids); start += audienceBatchSize {
		chunk := ids[start:min(start+audienceBatchSize, len(ids))]
		g.Go(func() (err error) {
			// Stays the result only if fn panics before returning.
			err = errAudienceChunkPanicked
			defer safe.Recover()
			return fn(ctx, chunk)
		})
	}
	return g.Wait()
}

func mergeInto[V any](mu *sync.Mutex, dst, src map[string]V) {
	mu.Lock()
	defer mu.Unlock()
	for k, v := range src {
		dst[k] = v
	}
}
