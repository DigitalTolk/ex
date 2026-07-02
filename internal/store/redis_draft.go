package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/redis/go-redis/v9"
)

// draftHashTTL ages out a user's whole draft set after this long with no draft
// activity. Drafts are ephemeral by nature; 180 days is generous. Refreshed on
// every write so an actively-used composer never lapses.
const draftHashTTL = 180 * 24 * time.Hour

// draftTombstoneTTL bounds how long a delete tombstone (the LWW client-ts a
// cleared draft leaves behind in draftts:{u}) is kept. Tombstones only need to
// outlive the race they guard — a delayed keystroke save arriving after the
// send that cleared the draft, a matter of seconds — so a week is extravagant
// margin. Without this horizon every scope a user EVER sent a message in kept a
// permanent hash field (draft IDs are deterministic per scope), and since every
// send also refreshes the hash TTL, an active user's draftts hash grew
// monotonically forever — the "Redis memory only ever goes up" leak. Expired
// tombstones are swept inside the write scripts, so every user's next draft
// write or send self-heals their hash.
const draftTombstoneTTL = 7 * 24 * time.Hour

// draftHashTTLSeconds is the TTL the Lua scripts EXPIRE with — computed once.
var draftHashTTLSeconds = int(draftHashTTL.Seconds())

func draftHashKey(userID string) string { return "draft:" + userID }
func draftTSKey(userID string) string   { return "draftts:" + userID }

// RedisDraftStore stores composer drafts in Redis.
//
//   - draft:{userID}   HASH  field=draftID → JSON(MessageDraft)   (content)
//   - draftts:{userID} HASH  field=draftID → client ts (epoch ms) (LWW clock)
//
// The timestamp hash is the last-write-wins register AND the delete tombstone in
// one: a save or delete only takes effect when its client ts is strictly newer
// (save) / not older (delete) than the recorded ts. After a delete the ts stays
// behind as a tombstone, so a delayed keystroke save (ts ≤ the send's ts) can't
// resurrect a draft the user already sent, while a genuinely newer edit
// (ts > the send's ts) still wins. Both hashes share the 180-day TTL.
type RedisDraftStore struct {
	client *redis.Client
	now    func() time.Time
}

// NewRedisDraftStore builds a RedisDraftStore over the given client.
func NewRedisDraftStore(client *redis.Client) *RedisDraftStore {
	return &RedisDraftStore{client: client, now: time.Now}
}

// tombstoneCutoffMs is the epoch-ms below which a pure tombstone (ts field
// with no surviving content field) is eligible for sweeping.
func (s *RedisDraftStore) tombstoneCutoffMs() int64 {
	return s.now().Add(-draftTombstoneTTL).UnixMilli()
}

// sweepTombstones drops aged-out pure tombstones: ts fields older than the
// cutoff whose content field is gone. Runs inside both write scripts so the
// hash prunes itself on every write instead of growing with every scope the
// user has ever sent in. The field the surrounding script just touched
// (ARGV[1]) is explicitly skipped so the op's own tombstone always survives
// its own write — client timestamps are client-supplied and may be
// arbitrarily skewed, and the LWW guard for THIS send must hold regardless.
const sweepTombstones = `
local cutoff = tonumber(ARGV_CUTOFF)
local ts = redis.call('HGETALL', KEYS[2])
for i = 1, #ts, 2 do
  local fts = tonumber(ts[i + 1]) or 0
  if ts[i] ~= ARGV[1] and fts < cutoff and redis.call('HEXISTS', KEYS[1], ts[i]) == 0 then
    redis.call('HDEL', KEYS[2], ts[i])
  end
end
`

// KEYS[1]=draft:{u} KEYS[2]=draftts:{u}; ARGV: id, json, ts, ttlSeconds, tombstoneCutoffMs.
var draftUpsertScript = redis.NewScript(`
local ets = tonumber(redis.call('HGET', KEYS[2], ARGV[1])) or 0
if tonumber(ARGV[3]) <= ets then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('EXPIRE', KEYS[2], ARGV[4])
` + replaceCutoff(sweepTombstones, "ARGV[5]") + `
return 1
`)

// KEYS[1]=draft:{u} KEYS[2]=draftts:{u}; ARGV: id, ts, ttlSeconds, tombstoneCutoffMs.
var draftDeleteScript = redis.NewScript(`
local ets = tonumber(redis.call('HGET', KEYS[2], ARGV[1])) or 0
if tonumber(ARGV[2]) < ets then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
` + replaceCutoff(sweepTombstones, "ARGV[4]") + `
return 1
`)

// replaceCutoff binds the sweep snippet's cutoff placeholder to the calling
// script's ARGV slot (the two scripts pass it at different positions).
func replaceCutoff(script, argv string) string {
	return strings.ReplaceAll(script, "ARGV_CUTOFF", argv)
}

func (s *RedisDraftStore) Upsert(ctx context.Context, draft *model.MessageDraft) error {
	payload, err := json.Marshal(draft)
	if err != nil { // coverage-ignore: MessageDraft is scalar fields + slices; Marshal cannot fail
		return fmt.Errorf("store: marshal draft: %w", err)
	}
	if err := draftUpsertScript.Run(ctx, s.client,
		[]string{draftHashKey(draft.UserID), draftTSKey(draft.UserID)},
		draft.ID, payload, draft.Ts, draftHashTTLSeconds, s.tombstoneCutoffMs(),
	).Err(); err != nil {
		return fmt.Errorf("store: upsert draft: %w", err)
	}
	return nil
}

func (s *RedisDraftStore) Get(ctx context.Context, userID, id string) (*model.MessageDraft, error) {
	raw, err := s.client.HGet(ctx, draftHashKey(userID), id).Result()
	if errors.Is(err, redis.Nil) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: get draft: %w", err)
	}
	var draft model.MessageDraft
	if err := json.Unmarshal([]byte(raw), &draft); err != nil { // coverage-ignore: round-trip of a value this store wrote
		return nil, fmt.Errorf("store: unmarshal draft: %w", err)
	}
	return &draft, nil
}

func (s *RedisDraftStore) List(ctx context.Context, userID string) ([]*model.MessageDraft, error) {
	all, err := s.client.HGetAll(ctx, draftHashKey(userID)).Result()
	if err != nil {
		return nil, fmt.Errorf("store: list drafts: %w", err)
	}
	drafts := make([]*model.MessageDraft, 0, len(all))
	for _, raw := range all {
		var draft model.MessageDraft
		if err := json.Unmarshal([]byte(raw), &draft); err != nil { // coverage-ignore: round-trip of values this store wrote
			return nil, fmt.Errorf("store: unmarshal draft: %w", err)
		}
		drafts = append(drafts, &draft)
	}
	return drafts, nil
}

// Delete tombstones the scope's draft at the given client ts (epoch ms). A
// delete older than the recorded ts is a no-op (a newer draft exists).
func (s *RedisDraftStore) Delete(ctx context.Context, userID, id string, ts int64) error {
	if err := draftDeleteScript.Run(ctx, s.client,
		[]string{draftHashKey(userID), draftTSKey(userID)},
		id, ts, draftHashTTLSeconds, s.tombstoneCutoffMs(),
	).Err(); err != nil {
		return fmt.Errorf("store: delete draft: %w", err)
	}
	return nil
}
