package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

// activityMaxItems caps a user's activity stream. The newest N are kept; older
// entries are trimmed on every add so the key never grows without bound.
const activityMaxItems = 200

// activityTTL ages out a whole user's activity stream after a week of no new
// activity, and individual entries older than a week are trimmed on each add.
// Refreshed on every add so an active user's stream never lapses mid-use.
const activityTTL = 7 * 24 * time.Hour

func activityKey(userID string) string     { return "activity:" + userID }
func activitySeenKey(userID string) string { return "activity:seen:" + userID }

// RedisActivityStore stores per-user activity streams in Redis.
//
//   - activity:{userID}      ZSET    score=createdAt(epoch ms) → JSON(ActivityItem)
//   - activity:seen:{userID} STRING  last-seen createdAt (epoch ms) — unread watermark
//
// The ZSET is scored by creation time so trimming to the newest N and dropping
// entries older than the TTL window are both range operations, and the unread
// count is a single ZCOUNT above the seen watermark.
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
// have aged past the TTL window. A single score-ranged read both filters expired
// entries and caps the result; stale entries are physically trimmed on the next
// AddActivity.
func (s *RedisActivityStore) ListActivity(ctx context.Context, userID string) ([]*model.ActivityItem, error) {
	key := activityKey(userID)
	cutoff := s.now().Add(-activityTTL).UnixMilli()
	raw, err := s.client.ZRangeArgs(ctx, redis.ZRangeArgs{
		Key:     key,
		Start:   "+inf",
		Stop:    strconv.FormatInt(cutoff, 10),
		ByScore: true,
		Rev:     true,
		Count:   activityMaxItems,
	}).Result()
	if err != nil {
		return nil, fmt.Errorf("store: list activity: %w", err)
	}
	items := make([]*model.ActivityItem, 0, len(raw))
	for _, r := range raw {
		var item model.ActivityItem
		if err := json.Unmarshal([]byte(r), &item); err != nil {
			return nil, fmt.Errorf("store: unmarshal activity: %w", err)
		}
		items = append(items, &item)
	}
	return items, nil
}

// UnreadActivityCount reports how many items are newer than the user's seen
// watermark.
func (s *RedisActivityStore) UnreadActivityCount(ctx context.Context, userID string) (int, error) {
	seen, err := s.client.Get(ctx, activitySeenKey(userID)).Int64()
	if err != nil && err != redis.Nil {
		return 0, fmt.Errorf("store: activity seen get: %w", err)
	}
	// err == redis.Nil → seen stays 0 → everything counts as unread.
	n, err := s.client.ZCount(ctx, activityKey(userID), "("+strconv.FormatInt(seen, 10), "+inf").Result()
	if err != nil {
		return 0, fmt.Errorf("store: activity unread count: %w", err)
	}
	return int(n), nil
}

// MarkActivitySeen advances the user's seen watermark so subsequent
// UnreadActivityCount calls return 0 until the next item arrives.
//
// The watermark is set to the max of wall-clock now and the newest existing
// item's score. Anchoring only to `now` leaves a race: an item added in the
// same millisecond as (or, under clock skew, just ahead of) now keeps a score
// >= now, so the exclusive `> watermark` count in UnreadActivityCount would
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
	return nil
}
