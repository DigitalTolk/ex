package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

// UserGroupCopies is the shared copy of user groups (their row and members)
// that a group mention reads instead of DynamoDB. It is a copy, never the
// source: a reader that misses reads the store and stores what it read, and
// every committed change deletes the copy. A reader that read the store just
// before a change can store the previous members after the delete; the short
// TTL bounds how long that copy lives.
type UserGroupCopies struct {
	rdb redis.UniversalClient
	ttl time.Duration
}

// NewUserGroupCopies keeps each group's copy for at most ttl.
func NewUserGroupCopies(rdb redis.UniversalClient, ttl time.Duration) *UserGroupCopies {
	return &UserGroupCopies{rdb: rdb, ttl: ttl}
}

func userGroupCopyKey(id string) string { return "ug:copy:" + id }

// cachedUserGroup carries the version, which the group's JSON leaves out.
type cachedUserGroup struct {
	Version int64                  `json:"v"`
	Group   *model.UserGroupDetail `json:"g"`
}

// Get returns the copies of the groups with these IDs; groups without one are
// absent. One round trip.
func (c *UserGroupCopies) Get(ctx context.Context, ids []string) (map[string]*model.UserGroupDetail, error) {
	out := make(map[string]*model.UserGroupDetail, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = userGroupCopyKey(id)
	}
	vals, err := c.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("user group copies: read: %w", err)
	}
	for i, v := range vals {
		s, ok := v.(string)
		if !ok {
			continue
		}
		var doc cachedUserGroup
		if err := json.Unmarshal([]byte(s), &doc); err != nil || doc.Group == nil {
			continue // unreadable: read through to the store
		}
		doc.Group.Version = doc.Version
		out[ids[i]] = doc.Group
	}
	return out, nil
}

// Put stores g, as read from the store.
func (c *UserGroupCopies) Put(ctx context.Context, g *model.UserGroupDetail) error {
	// A struct of strings, numbers and times always marshals.
	raw, _ := json.Marshal(cachedUserGroup{Version: g.Version, Group: g})
	if err := c.rdb.Set(ctx, userGroupCopyKey(g.ID), raw, c.ttl).Err(); err != nil {
		return fmt.Errorf("user group copies: write %s: %w", g.ID, err)
	}
	return nil
}

// Forget deletes a group's copy after a committed change, so the next reader
// reads the store.
func (c *UserGroupCopies) Forget(ctx context.Context, id string) error {
	if err := c.rdb.Del(ctx, userGroupCopyKey(id)).Err(); err != nil {
		return fmt.Errorf("user group copies: forget %s: %w", id, err)
	}
	return nil
}
