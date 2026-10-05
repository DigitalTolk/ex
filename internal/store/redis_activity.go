package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

// activityMaxItems caps a user's activity stream. The newest N are kept; older
// entries are trimmed on every add so the key never grows without bound.
const activityMaxItems = 500

// activityTTL ages out a whole user's activity stream after 30 days of no new
// activity, and individual entries older than 30 days are trimmed on each add.
// Refreshed on every add so an active user's stream never lapses mid-use.
const activityTTL = 30 * 24 * time.Hour

func activityKey(userID string) string       { return "activity:" + userID }
func activitySeenKey(userID string) string   { return "activity:seen:" + userID }
func activityReadKey(userID string) string   { return "activity:read:" + userID }
func activityUnreadKey(userID string) string { return "activity:unread:" + userID }

// RedisActivityStore stores per-user activity streams in Redis.
//
//   - activity:{userID}        ZSET    score=createdAt(epoch ms) → JSON(ActivityItem)
//   - activity:seen:{userID}   STRING  last-seen createdAt (epoch ms) — "mark all read" watermark
//   - activity:read:{userID}   SET     item ids read one by one (newer than the watermark)
//   - activity:unread:{userID} SET     item ids marked unread again (older than the watermark)
//
// The ZSET is scored by creation time so trimming to the newest N and dropping
// entries older than the TTL window are both range operations. An item is read
// when it is at or below the watermark, unless it sits in the unread set, or
// when it sits in the read set. Marking all read advances the watermark and
// clears both sets.
type RedisActivityStore struct {
	client *redis.Client
	now    func() time.Time
}

// NewRedisActivityStore builds a RedisActivityStore over the given client.
func NewRedisActivityStore(client *redis.Client) *RedisActivityStore {
	return &RedisActivityStore{client: client, now: time.Now}
}

// AddActivity prepends an item to the user's stream, trims to the newest
// activityMaxItems, drops anything older than the TTL window, and refreshes the
// key's expiry — all in one pipelined round-trip.
func (s *RedisActivityStore) AddActivity(ctx context.Context, userID string, item *model.ActivityItem) error {
	payload := mustJSON(json.Marshal(item))
	key := activityKey(userID)
	cutoff := s.now().Add(-activityTTL).UnixMilli()
	pipe := s.client.Pipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: float64(item.CreatedAt.UnixMilli()), Member: payload})
	pipe.ZRemRangeByScore(ctx, key, "-inf", "("+strconv.FormatInt(cutoff, 10))
	// Keep only the newest activityMaxItems (highest scores): drop ranks
	// [0, len-maxItems-1] from the low (oldest) end.
	pipe.ZRemRangeByRank(ctx, key, 0, int64(-activityMaxItems-1))
	pipe.Expire(ctx, key, activityTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("store: add activity: %w", err)
	}
	return nil
}

// ListActivity returns the user's activity items newest-first, skipping any that
// have aged past the TTL window, with each item's Read flag resolved from the
// user's read state. The stream and the three read-state keys are fetched in one
// pipelined round-trip; stale entries are physically trimmed on the next
// AddActivity.
func (s *RedisActivityStore) ListActivity(ctx context.Context, userID string) ([]*model.ActivityItem, error) {
	cutoff := s.now().Add(-activityTTL).UnixMilli()
	pipe := s.client.Pipeline()
	rangeCmd := pipe.ZRangeArgs(ctx, redis.ZRangeArgs{
		Key:     activityKey(userID),
		Start:   "+inf",
		Stop:    strconv.FormatInt(cutoff, 10),
		ByScore: true,
		Rev:     true,
		Count:   activityMaxItems,
	})
	seenCmd := pipe.Get(ctx, activitySeenKey(userID))
	readCmd := pipe.SMembersMap(ctx, activityReadKey(userID))
	unreadCmd := pipe.SMembersMap(ctx, activityUnreadKey(userID))
	// Exec reports the first failing command. A missing watermark is a
	// redis.Nil, which is fine — but it would hide a failure in a later
	// command, so the read-state commands are also checked one by one below.
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, fmt.Errorf("store: list activity: %w", err)
	}
	// The range is the first command, so any failure of it surfaced above.
	raw := rangeCmd.Val()
	// A missing watermark (redis.Nil) means nothing was ever marked read.
	seen, err := seenCmd.Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, fmt.Errorf("store: activity seen get: %w", err)
	}
	read, err := readCmd.Result()
	if err != nil {
		return nil, fmt.Errorf("store: activity read set: %w", err)
	}
	unread, err := unreadCmd.Result()
	if err != nil {
		return nil, fmt.Errorf("store: activity unread set: %w", err)
	}

	items := make([]*model.ActivityItem, 0, len(raw))
	for _, r := range raw {
		var item model.ActivityItem
		if err := json.Unmarshal([]byte(r), &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal activity: %w", err)
		}
		item.Read = activityItemRead(&item, seen, read, unread)
		items = append(items, &item)
	}
	return items, nil
}

// activityItemRead resolves one item's read state: an explicit "mark as
// unread" wins, then an explicit "mark as read", then the watermark.
func activityItemRead(item *model.ActivityItem, seen int64, read, unread map[string]struct{}) bool {
	if _, ok := unread[item.ID]; ok {
		return false
	}
	if _, ok := read[item.ID]; ok {
		return true
	}
	return item.CreatedAt.UnixMilli() <= seen
}

// SetActivityRead marks the given items read (read=true) or unread
// (read=false), independent of the watermark. Both sets are written in one
// transaction so an id never sits in both.
func (s *RedisActivityStore) SetActivityRead(ctx context.Context, userID string, ids []string, read bool) error {
	if len(ids) == 0 {
		return nil
	}
	members := make([]any, len(ids))
	for i, id := range ids {
		members[i] = id
	}
	addKey, remKey := activityReadKey(userID), activityUnreadKey(userID)
	if !read {
		addKey, remKey = remKey, addKey
	}
	pipe := s.client.TxPipeline()
	pipe.SAdd(ctx, addKey, members...)
	pipe.SRem(ctx, remKey, members...)
	pipe.Expire(ctx, addKey, activityTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("store: set activity read: %w", err)
	}
	return nil
}

// RemoveActivity deletes the given items from the user's stream (and from the
// read-state sets). Unknown ids are ignored. The stream holds at most
// activityMaxItems entries, so finding the members to remove is one bounded
// read.
func (s *RedisActivityStore) RemoveActivity(ctx context.Context, userID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	key := activityKey(userID)
	raw, err := s.client.ZRange(ctx, key, 0, -1).Result()
	if err != nil {
		return fmt.Errorf("store: list activity for removal: %w", err)
	}
	want := make(map[string]bool, len(ids))
	idMembers := make([]any, len(ids))
	for i, id := range ids {
		want[id] = true
		idMembers[i] = id
	}
	var drop []any
	for _, r := range raw {
		// Only the id is needed; a member that doesn't parse is left alone.
		var head struct {
			ID string `json:"id"`
		}
		if json.Unmarshal([]byte(r), &head) == nil && want[head.ID] {
			drop = append(drop, r)
		}
	}
	pipe := s.client.TxPipeline()
	if len(drop) > 0 {
		pipe.ZRem(ctx, key, drop...)
	}
	pipe.SRem(ctx, activityReadKey(userID), idMembers...)
	pipe.SRem(ctx, activityUnreadKey(userID), idMembers...)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("store: remove activity: %w", err)
	}
	return nil
}

// MarkActivitySeen advances the user's seen watermark so every item present now
// lists as read until the next item arrives, and clears the per-item read state
// (anything marked unread is now read too).
//
// The watermark is set to the max of wall-clock now and the newest existing
// item's score. Anchoring only to `now` leaves a race: an item added in the
// same millisecond as (or, under clock skew, just ahead of) now keeps a score
// >= now, so the exclusive `> watermark` read check in ListActivity would
// still report it unread even though it existed when the user marked read —
// the user clicks "mark read" but a just-landed item stays highlighted.
// Advancing to the newest score guarantees every item present at mark time is
// counted as read; genuinely newer items (higher score) remain unread.
func (s *RedisActivityStore) MarkActivitySeen(ctx context.Context, userID string) error {
	watermark := s.now().UnixMilli()
	top, err := s.client.ZRevRangeWithScores(ctx, activityKey(userID), 0, 0).Result()
	if err != nil {
		return fmt.Errorf("store: activity top score: %w", err)
	}
	if len(top) == 1 {
		if score := int64(top[0].Score); score > watermark {
			watermark = score
		}
	}
	if err := s.client.Set(ctx, activitySeenKey(userID), watermark, activityTTL).Err(); err != nil {
		return fmt.Errorf("store: activity mark seen: %w", err)
	}
	if err := s.client.Del(ctx, activityReadKey(userID), activityUnreadKey(userID)).Err(); err != nil {
		return fmt.Errorf("store: activity clear read state: %w", err)
	}
	return nil
}
