package pubsub

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/redis/go-redis/v9"
)

// RedisPubSub wraps a Redis client for publishing real-time events to channels.
type RedisPubSub struct {
	client *redis.Client
}

// NewRedisPubSub parses the Redis URL, creates a client, and verifies connectivity.
func NewRedisPubSub(redisURL string) (*RedisPubSub, error) {
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

	return &RedisPubSub{client: client}, nil
}

// Publish marshals the event to JSON and publishes it to the given Redis channel.
func (ps *RedisPubSub) Publish(ctx context.Context, channel string, event *events.Event) error {
	data, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("marshal event: %w", err)
	}
	if err := ps.client.Publish(ctx, channel, data).Err(); err != nil {
		return fmt.Errorf("redis publish: %w", err)
	}
	return nil
}

// ChannelName returns the Redis pub/sub channel name for a chat channel.
func ChannelName(channelID string) string {
	return "chan:" + channelID
}

// ConversationName returns the Redis pub/sub channel name for a conversation.
func ConversationName(convID string) string {
	return "conv:" + convID
}

// UserChannel returns the Redis pub/sub channel name for a user's personal channel.
func UserChannel(userID string) string {
	return "user:" + userID
}

// GlobalChannelEvents returns the Redis pub/sub channel name for global channel
// events (e.g. channel.new) that all connected users should receive.
func GlobalChannelEvents() string { return "global:channels" }

// GlobalEmojiEvents returns the Redis pub/sub channel name for global emoji
// catalog updates (emoji added/removed) seen by all connected users.
func GlobalEmojiEvents() string { return "global:emojis" }

// PresenceEvents returns the Redis pub/sub channel name for online/offline
// presence broadcasts seen by all connected users.
func PresenceEvents() string { return "global:presence" }

// UserEvents returns the Redis pub/sub channel name for global user-profile
// updates (user.updated events).
func UserEvents() string { return "global:users" }

// Client returns the underlying Redis client.
func (ps *RedisPubSub) Client() *redis.Client {
	return ps.client
}
