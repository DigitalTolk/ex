package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/DigitalTolk/ex/internal/model"
)

// Interactivity's short-lived state. Response URLs live under the hash of
// their token (the token itself exists only in the URL the app holds).
const (
	responseURLKeyPrefix  = "ixurl:"
	interactionsKeyPrefix = "ixhist:"
	appFailuresKeyPrefix  = "ixfail:"
	appPausedKeyPrefix    = "ixpause:"

	// interactionHistoryLen is how many interactions the webhooks panel
	// shows per app, for interactionHistoryTTL after the last one.
	interactionHistoryLen = 100
	interactionHistoryTTL = 7 * 24 * time.Hour
	// appFailuresWindow forgets a failure streak an hour after its last
	// failure.
	appFailuresWindow = time.Hour
)

// useResponseURL spends one use of a response URL atomically: two requests
// racing for the last use can't both have it. Missing (expired or unknown)
// returns nil; otherwise {uses left after this one, the record}.
var useResponseURL = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return nil end
local left = redis.call('HINCRBY', KEYS[1], 'uses', -1)
return {left, redis.call('HGET', KEYS[1], 'rec')}
`)

// MintResponseURL stores what a response URL stands for, good for `uses`
// uses within ttl.
func (c *RedisCache) MintResponseURL(ctx context.Context, tokenHash string, rec model.ResponseURLRecord, uses int, ttl time.Duration) error {
	key := responseURLKeyPrefix + tokenHash
	pipe := c.client.TxPipeline()
	pipe.HSet(ctx, key, "rec", mustJSON(json.Marshal(rec)), "uses", uses)
	pipe.PExpire(ctx, key, ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("cache: mint response url: %w", err)
	}
	return nil
}

// UseResponseURL spends one use of a response URL. It returns the record
// and the uses left after this one — negative once they are all spent — or
// a nil record for an expired or unknown URL.
func (c *RedisCache) UseResponseURL(ctx context.Context, tokenHash string) (*model.ResponseURLRecord, int, error) {
	res, err := useResponseURL.Run(ctx, c.client, []string{responseURLKeyPrefix + tokenHash}).Slice()
	if errors.Is(err, redis.Nil) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, fmt.Errorf("cache: use response url: %w", err)
	}
	left, _ := res[0].(int64)
	raw, _ := res[1].(string)
	var rec model.ResponseURLRecord
	if err := json.Unmarshal([]byte(raw), &rec); err != nil {
		return nil, 0, fmt.Errorf("cache: response url record: %w", err)
	}
	return &rec, int(left), nil
}

// RecordInteraction adds one line to an app's history, newest first,
// keeping the last interactionHistoryLen.
func (c *RedisCache) RecordInteraction(ctx context.Context, webhookID string, entry model.InteractionEntry) error {
	key := interactionsKeyPrefix + webhookID
	pipe := c.client.TxPipeline()
	pipe.LPush(ctx, key, mustJSON(json.Marshal(entry)))
	pipe.LTrim(ctx, key, 0, interactionHistoryLen-1)
	pipe.Expire(ctx, key, interactionHistoryTTL)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("cache: record interaction: %w", err)
	}
	return nil
}

// ListInteractions is an app's history, newest first. A line that can't be
// read is left out.
func (c *RedisCache) ListInteractions(ctx context.Context, webhookID string) ([]model.InteractionEntry, error) {
	raws, err := c.client.LRange(ctx, interactionsKeyPrefix+webhookID, 0, interactionHistoryLen-1).Result()
	if err != nil {
		return nil, fmt.Errorf("cache: list interactions: %w", err)
	}
	out := make([]model.InteractionEntry, 0, len(raws))
	for _, raw := range raws {
		var e model.InteractionEntry
		if json.Unmarshal([]byte(raw), &e) == nil {
			out = append(out, e)
		}
	}
	return out, nil
}

// NoteAppFailure counts a failed click in an app's current streak and, at
// `threshold` in a row, pauses the app for `pause` — the streak goes on, so
// the first click after the pause that fails pauses it again. Returns how
// long the app is paused for (zero when it isn't).
func (c *RedisCache) NoteAppFailure(ctx context.Context, webhookID string, threshold int, pause time.Duration) (time.Duration, error) {
	key := appFailuresKeyPrefix + webhookID
	pipe := c.client.TxPipeline()
	n := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, appFailuresWindow)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, fmt.Errorf("cache: note app failure: %w", err)
	}
	if n.Val() < int64(threshold) {
		return 0, nil
	}
	if err := c.client.Set(ctx, appPausedKeyPrefix+webhookID, "1", pause).Err(); err != nil {
		return 0, fmt.Errorf("cache: pause app: %w", err)
	}
	return pause, nil
}

// NoteAppSuccess ends an app's failure streak.
func (c *RedisCache) NoteAppSuccess(ctx context.Context, webhookID string) error {
	if err := c.client.Del(ctx, appFailuresKeyPrefix+webhookID).Err(); err != nil {
		return fmt.Errorf("cache: note app success: %w", err)
	}
	return nil
}

// AppPausedFor is how much longer an app stays paused for failing (zero
// when it isn't).
func (c *RedisCache) AppPausedFor(ctx context.Context, webhookID string) (time.Duration, error) {
	ttl, err := c.client.PTTL(ctx, appPausedKeyPrefix+webhookID).Result()
	if err != nil {
		return 0, fmt.Errorf("cache: app paused: %w", err)
	}
	if ttl < 0 {
		return 0, nil
	}
	return ttl, nil
}
