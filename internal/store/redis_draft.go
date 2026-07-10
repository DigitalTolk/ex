package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/redis/go-redis/v9"
)

// draftHashTTL ages out a user's whole draft set after this long with no draft
// activity. Drafts are ephemeral by nature; 180 days is generous. Refreshed on
// every accepted write so an actively-used composer never lapses.
const draftHashTTL = 180 * 24 * time.Hour

// draftHashTTLSeconds is the TTL the Lua scripts EXPIRE with — computed once.
var draftHashTTLSeconds = int(draftHashTTL.Seconds())

// legacyDraftGen is the generation reported for rows written before the gen
// protocol (raw JSON, no "g:" prefix). A client can only present it after
// reading the draft back, and the first accepted write rewrites the row in
// the new format — so legacy rows migrate lazily, one write at a time.
const legacyDraftGen = "legacy"

func draftHashKey(userID string) string { return "draft:" + userID }

// draftTSKey is the retired client-ts / tombstone hash from the pre-gen LWW
// protocol. It is no longer read or written; every accepted write DELs it so
// active users clean up their own leftovers (idle users' keys lapse via the
// TTL the old code set).
func draftTSKey(userID string) string { return "draftts:" + userID }

// RedisDraftStore stores composer drafts in Redis.
//
//	draft:{userID} HASH field=draftID → "g:<gen>|" + JSON(MessageDraft)
//
// Ordering is server-owned optimistic concurrency, not client clocks: every
// accepted write stores a server-minted generation token, and a write (save
// or clear) is applied only when the caller's basis generation equals the
// stored one — the empty basis means "the scope has no draft". A client
// acting on stale state is rejected with the current row, never merged. A
// cleared draft is actually deleted; absence rejects every non-empty basis,
// so a stale writer can never resurrect it and no tombstones are needed.
type RedisDraftStore struct {
	client *redis.Client
}

// NewRedisDraftStore builds a RedisDraftStore over the given client.
func NewRedisDraftStore(client *redis.Client) *RedisDraftStore {
	return &RedisDraftStore{client: client}
}

// DraftWriteResult reports the outcome of a compare-and-set draft write.
type DraftWriteResult struct {
	// OK reports whether the write was applied.
	OK bool
	// Current is the stored draft at decision time when the write was
	// rejected (nil when the scope has no draft). Always nil when OK.
	Current *model.MessageDraft
}

// storedGen extracts the generation of a stored hash value: "g:<gen>|…" for
// gen-protocol rows, the legacy sentinel for anything else (pre-gen raw JSON).
const luaStoredGen = `
local function stored_gen(v)
  if not v then return '' end
  if string.sub(v, 1, 2) == 'g:' then
    local sep = string.find(v, '|', 3, true)
    return string.sub(v, 3, sep - 1)
  end
  return 'legacy'
end
`

// KEYS[1]=draft:{u} KEYS[2]=draftts:{u}; ARGV: id, basisGen, encodedValue, ttlSeconds.
var draftUpsertScript = redis.NewScript(luaStoredGen + `
local stored = redis.call('HGET', KEYS[1], ARGV[1])
if stored_gen(stored) ~= ARGV[2] then
  if stored then return {0, stored} end
  return {0}
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
redis.call('DEL', KEYS[2])
return {1}
`)

// KEYS[1]=draft:{u} KEYS[2]=draftts:{u}; ARGV: id, basisGen.
// Clearing an absent draft with the empty basis is an accepted no-op, so
// clients can always report "the composer is empty now" without first
// knowing whether the server has anything — the server decides.
var draftDeleteScript = redis.NewScript(luaStoredGen + `
local stored = redis.call('HGET', KEYS[1], ARGV[1])
if stored_gen(stored) ~= ARGV[2] then
  if stored then return {0, stored} end
  return {0}
end
if stored then redis.call('HDEL', KEYS[1], ARGV[1]) end
redis.call('DEL', KEYS[2])
return {1}
`)

// encodeDraft renders the stored hash value. The generation is kept in the
// prefix — outside the JSON — so the Lua scripts can compare it without
// decoding the payload. ULID generations never contain '|'.
func encodeDraft(draft *model.MessageDraft) string {
	return "g:" + draft.Gen + "|" + string(mustJSON(json.Marshal(draft)))
}

// decodeDraft parses a stored hash value, tolerating pre-gen rows (raw JSON,
// reported as the legacy generation).
func decodeDraft(raw string) (*model.MessageDraft, error) {
	gen := legacyDraftGen
	if strings.HasPrefix(raw, "g:") {
		sep := strings.Index(raw, "|")
		gen = raw[2:sep]
		raw = raw[sep+1:]
	}
	var draft model.MessageDraft
	if err := json.Unmarshal([]byte(raw), &draft); err != nil {
		return nil, fmt.Errorf("store: unmarshal draft: %w", err)
	}
	draft.Gen = gen
	return &draft, nil
}

// casResult converts a CAS script reply ({1} accepted; {0[, stored]} rejected
// with the current row when one exists) into a DraftWriteResult.
func casResult(reply []any) (*DraftWriteResult, error) {
	if reply[0].(int64) == 1 {
		return &DraftWriteResult{OK: true}, nil
	}
	res := &DraftWriteResult{}
	if len(reply) > 1 {
		current, err := decodeDraft(reply[1].(string))
		if err != nil {
			return nil, err
		}
		res.Current = current
	}
	return res, nil
}

// Upsert applies the draft iff basisGen matches the stored generation (empty
// basis = the scope must have no draft). draft.Gen must carry the freshly
// minted generation to store.
func (s *RedisDraftStore) Upsert(ctx context.Context, draft *model.MessageDraft, basisGen string) (*DraftWriteResult, error) {
	reply, err := redisx.RunScript(ctx, s.client, draftUpsertScript,
		[]string{draftHashKey(draft.UserID), draftTSKey(draft.UserID)},
		draft.ID, basisGen, encodeDraft(draft), draftHashTTLSeconds,
	).Slice()
	if err != nil {
		return nil, fmt.Errorf("store: upsert draft: %w", err)
	}
	return casResult(reply)
}

func (s *RedisDraftStore) Get(ctx context.Context, userID, id string) (*model.MessageDraft, error) {
	raw, err := s.client.HGet(ctx, draftHashKey(userID), id).Result()
	if errors.Is(err, redis.Nil) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("store: get draft: %w", err)
	}
	return decodeDraft(raw)
}

func (s *RedisDraftStore) List(ctx context.Context, userID string) ([]*model.MessageDraft, error) {
	all, err := s.client.HGetAll(ctx, draftHashKey(userID)).Result()
	if err != nil {
		return nil, fmt.Errorf("store: list drafts: %w", err)
	}
	drafts := make([]*model.MessageDraft, 0, len(all))
	for _, raw := range all {
		draft, err := decodeDraft(raw)
		if err != nil {
			return nil, err
		}
		drafts = append(drafts, draft)
	}
	return drafts, nil
}

// Delete removes the draft iff basisGen matches the stored generation. A
// clear of an absent draft with the empty basis is an accepted no-op.
func (s *RedisDraftStore) Delete(ctx context.Context, userID, id, basisGen string) (*DraftWriteResult, error) {
	reply, err := redisx.RunScript(ctx, s.client, draftDeleteScript,
		[]string{draftHashKey(userID), draftTSKey(userID)},
		id, basisGen,
	).Slice()
	if err != nil {
		return nil, fmt.Errorf("store: delete draft: %w", err)
	}
	return casResult(reply)
}

// DeleteUnconditional removes the draft regardless of generation. Reserved
// for the message-send fold: sending IS the authoritative user event for the
// scope, so it always wins.
func (s *RedisDraftStore) DeleteUnconditional(ctx context.Context, userID, id string) error {
	pipe := s.client.Pipeline()
	pipe.HDel(ctx, draftHashKey(userID), id)
	pipe.Del(ctx, draftTSKey(userID))
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("store: delete draft unconditional: %w", err)
	}
	return nil
}
