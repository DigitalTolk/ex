package cache

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

// UserGroupCopies is the shared copy of user groups (their row, members
// included) that a group mention reads instead of DynamoDB. It is a copy,
// never the source: every write commits to the store first and then stores
// the row here, and an entry only ever moves forward in version, so two
// writers finishing out of order can't leave an older member list behind.
// The TTL only bounds a copy whose refresh was lost.
type UserGroupCopies struct {
	rdb redis.UniversalClient
	ttl time.Duration
}

// NewUserGroupCopies keeps each group's copy for at most ttl.
func NewUserGroupCopies(rdb redis.UniversalClient, ttl time.Duration) *UserGroupCopies {
	return &UserGroupCopies{rdb: rdb, ttl: ttl}
}

func userGroupKey(id string) string { return "ug:members:" + id }

// cachedUserGroup carries the version, which the group's JSON leaves out.
type cachedUserGroup struct {
	Version int64                  `json:"v"`
	Group   *model.UserGroupDetail `json:"g"`
}

// putUserGroupScript stores ARGV[2] unless the key already holds a version at
// least ARGV[1].
var putUserGroupScript = redis.NewScript(`
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, doc = pcall(cjson.decode, cur)
  if ok and tonumber(doc.v) and tonumber(doc.v) >= tonumber(ARGV[1]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`)

// Get returns the groups with these IDs that have a copy; the rest are
// absent. One round trip.
func (c *UserGroupCopies) Get(ctx context.Context, ids []string) (map[string]*model.UserGroupDetail, error) {
	out := make(map[string]*model.UserGroupDetail, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	keys := make([]string, len(ids))
	for i, id := range ids {
		keys[i] = userGroupKey(id)
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

// Put stores g unless a copy at the same or a newer version is there.
func (c *UserGroupCopies) Put(ctx context.Context, g *model.UserGroupDetail) error {
	// A struct of strings, numbers and times always marshals.
	raw, _ := json.Marshal(cachedUserGroup{Version: g.Version, Group: g})
	if err := putUserGroupScript.Run(ctx, c.rdb, []string{userGroupKey(g.ID)}, g.Version, raw, c.ttl.Milliseconds()).Err(); err != nil {
		return fmt.Errorf("user group copies: write %s: %w", g.ID, err)
	}
	return nil
}

// Forget drops a group's copy, so the next read goes to the store.
func (c *UserGroupCopies) Forget(ctx context.Context, id string) error {
	if err := c.rdb.Del(ctx, userGroupKey(id)).Err(); err != nil {
		return fmt.Errorf("user group copies: forget %s: %w", id, err)
	}
	return nil
}

// EntraUserIndex maps Microsoft Entra object IDs to ex user IDs, so syncing a
// linked user group reads only its members' entries instead of every
// account. The directory status sweep rebuilds it whole each run (Replace);
// a sign-in adds its user in between (Add).
type EntraUserIndex struct {
	rdb redis.UniversalClient
}

// NewEntraUserIndex wraps the shared Redis client.
func NewEntraUserIndex(rdb redis.UniversalClient) *EntraUserIndex {
	return &EntraUserIndex{rdb: rdb}
}

const (
	entraIndexKey = "msobj:users"
	// entraIndexBuilt marks a hash a full rebuild wrote, so an index holding
	// only the users who signed in since a flush isn't taken as complete.
	entraIndexBuilt = "_built"
	// entraIndexBatch bounds one HSET while a rebuild writes the hash.
	entraIndexBatch = 500
)

// Lookup returns the user ID of each object ID the index holds, and whether
// the index is complete (built by a full rebuild). One round trip.
func (x *EntraUserIndex) Lookup(ctx context.Context, objectIDs []string) (map[string]string, bool, error) {
	fields := append([]string{entraIndexBuilt}, objectIDs...)
	vals, err := x.rdb.HMGet(ctx, entraIndexKey, fields...).Result()
	if err != nil {
		return nil, false, fmt.Errorf("entra user index: read: %w", err)
	}
	out := make(map[string]string, len(objectIDs))
	for i, v := range vals[1:] {
		if s, ok := v.(string); ok {
			out[objectIDs[i]] = s
		}
	}
	return out, vals[0] != nil, nil
}

// Replace swaps the whole index for m: written under a temporary key and
// renamed over the index, so a reader never sees a half-built one. ttl bounds
// an index whose next rebuild never came.
func (x *EntraUserIndex) Replace(ctx context.Context, m map[string]string, ttl time.Duration) error {
	tmp := entraIndexKey + ":next:" + randomSuffix()
	batch := make([]any, 0, 2*entraIndexBatch)
	batch = append(batch, entraIndexBuilt, "1")
	flush := func() error {
		if err := x.rdb.HSet(ctx, tmp, batch...).Err(); err != nil {
			return err
		}
		batch = batch[:0]
		return nil
	}
	for objectID, userID := range m {
		batch = append(batch, objectID, userID)
		if len(batch) >= 2*entraIndexBatch {
			if err := flush(); err != nil {
				return fmt.Errorf("entra user index: write: %w", err)
			}
		}
	}
	if len(batch) > 0 {
		if err := flush(); err != nil {
			return fmt.Errorf("entra user index: write: %w", err)
		}
	}
	pipe := x.rdb.TxPipeline()
	pipe.PExpire(ctx, tmp, ttl)
	pipe.Rename(ctx, tmp, entraIndexKey)
	if _, err := pipe.Exec(ctx); err != nil {
		x.rdb.Del(context.WithoutCancel(ctx), tmp)
		return fmt.Errorf("entra user index: swap: %w", err)
	}
	return nil
}

// Add records one user (a sign-in). It never marks the index complete.
func (x *EntraUserIndex) Add(ctx context.Context, objectID, userID string) error {
	if err := x.rdb.HSet(ctx, entraIndexKey, objectID, userID).Err(); err != nil {
		return fmt.Errorf("entra user index: add: %w", err)
	}
	return nil
}

func randomSuffix() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
