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

// Forms' short-lived state: trigger_ids (under their token's hash), open
// views, and apps' idempotency keys.
const (
	triggerKeyPrefix     = "ixtrig:"
	viewKeyPrefix        = "ixview:"
	viewExternalPrefix   = "ixviewext:"
	idempotencyKeyPrefix = "ixidem:"
)

// dropIfOwner deletes an external_id's index entry only while it still
// names the view being closed: a newer form may hold that external_id now.
var dropIfOwner = redis.NewScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`)

// MintTrigger stores what a trigger_id stands for, usable once within ttl.
func (c *RedisCache) MintTrigger(ctx context.Context, tokenHash string, rec model.TriggerRecord, ttl time.Duration) error {
	if err := c.client.Set(ctx, triggerKeyPrefix+tokenHash, mustJSON(json.Marshal(rec)), ttl).Err(); err != nil {
		return fmt.Errorf("cache: mint trigger: %w", err)
	}
	return nil
}

// UseTrigger spends a trigger_id: the first use gets its record, any later
// one (or one after it expired) nil.
func (c *RedisCache) UseTrigger(ctx context.Context, tokenHash string) (*model.TriggerRecord, error) {
	raw, err := c.client.GetDel(ctx, triggerKeyPrefix+tokenHash).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cache: use trigger: %w", err)
	}
	var rec model.TriggerRecord
	if err := json.Unmarshal([]byte(raw), &rec); err != nil {
		return nil, fmt.Errorf("cache: trigger record: %w", err)
	}
	return &rec, nil
}

// SaveView stores an open form for ttl, findable by its ID and, when it
// has one, by its app's external_id.
func (c *RedisCache) SaveView(ctx context.Context, v *model.StoredView, ttl time.Duration) error {
	pipe := c.client.TxPipeline()
	pipe.Set(ctx, viewKeyPrefix+v.View.ID, mustJSON(json.Marshal(v)), ttl)
	if v.View.ExternalID != "" {
		pipe.Set(ctx, viewExternalKey(v.WebhookID, v.View.ExternalID), v.View.ID, ttl)
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("cache: save view: %w", err)
	}
	return nil
}

// GetView returns an open form, or nil once it is closed or expired.
func (c *RedisCache) GetView(ctx context.Context, id string) (*model.StoredView, error) {
	raw, err := c.client.Get(ctx, viewKeyPrefix+id).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cache: get view: %w", err)
	}
	var v model.StoredView
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return nil, fmt.Errorf("cache: view record: %w", err)
	}
	return &v, nil
}

// ViewIDByExternalID finds an app's open form by the external_id it gave;
// "" when there is none.
func (c *RedisCache) ViewIDByExternalID(ctx context.Context, webhookID, externalID string) (string, error) {
	id, err := c.client.Get(ctx, viewExternalKey(webhookID, externalID)).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("cache: view by external id: %w", err)
	}
	return id, nil
}

// DeleteView forgets a closed form, and its external_id while that still
// names it.
func (c *RedisCache) DeleteView(ctx context.Context, v *model.StoredView) error {
	if err := c.client.Del(ctx, viewKeyPrefix+v.View.ID).Err(); err != nil {
		return fmt.Errorf("cache: delete view: %w", err)
	}
	return c.DropViewExternalID(ctx, v.WebhookID, v.View.ExternalID, v.View.ID)
}

// DropViewExternalID forgets an app's external_id for a form, unless it has
// moved on to another form meanwhile. No external_id: nothing to do.
func (c *RedisCache) DropViewExternalID(ctx context.Context, webhookID, externalID, viewID string) error {
	if externalID == "" {
		return nil
	}
	if err := dropIfOwner.Run(ctx, c.client, []string{viewExternalKey(webhookID, externalID)}, viewID).Err(); err != nil {
		return fmt.Errorf("cache: drop view external id: %w", err)
	}
	return nil
}

func viewExternalKey(webhookID, externalID string) string {
	return viewExternalPrefix + webhookID + ":" + externalID
}

// ClaimIdempotencyKey claims an app's Idempotency-Key for ttl. The first
// claim gets claimed=true; a later one gets the answer the first stored
// (empty while the first is still running).
func (c *RedisCache) ClaimIdempotencyKey(ctx context.Context, scope, key string, ttl time.Duration) (prev []byte, claimed bool, err error) {
	k := idempotencyKeyPrefix + scope + ":" + key
	ok, err := c.client.SetNX(ctx, k, "", ttl).Result()
	if err != nil {
		return nil, false, fmt.Errorf("cache: claim idempotency key: %w", err)
	}
	if ok {
		return nil, true, nil
	}
	raw, err := c.client.Get(ctx, k).Bytes()
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, false, fmt.Errorf("cache: read idempotency key: %w", err)
	}
	return raw, false, nil
}

// FinishIdempotencyKey stores the answer to a claimed key, so a retry gets
// it again; answer nil releases the claim (the call failed and may be
// retried for real).
func (c *RedisCache) FinishIdempotencyKey(ctx context.Context, scope, key string, answer []byte, ttl time.Duration) error {
	k := idempotencyKeyPrefix + scope + ":" + key
	var err error
	if answer == nil {
		err = c.client.Del(ctx, k).Err()
	} else {
		err = c.client.Set(ctx, k, answer, ttl).Err()
	}
	if err != nil {
		return fmt.Errorf("cache: finish idempotency key: %w", err)
	}
	return nil
}
