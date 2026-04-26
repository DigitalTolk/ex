package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

// ErrCacheMiss is returned when a key is not found in the cache.
var ErrCacheMiss = errors.New("cache miss")

const userKeyPrefix = "user:"
const userCacheTTL = 15 * time.Minute

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

// Client returns the underlying Redis client for advanced operations.
func (c *RedisCache) Client() *redis.Client {
	return c.client
}
