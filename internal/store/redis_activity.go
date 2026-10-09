package store

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/redis/go-redis/v9"
)

// Stream caps. Addressed items (mentions, reactions, reminders, channel adds)
// and conversational items (DM messages, thread replies) are capped
// separately, so a busy DM can never push a mention or a fired reminder out of
// the stream.
const (
	activityMaxFeedItems = 500
	activityMaxChatItems = 300
	// ActivityMaxItems is the most items a stream can hold, and so the most ids
	// a per-item request can meaningfully name.
	ActivityMaxItems = activityMaxFeedItems + activityMaxChatItems
)

// activityTTL ages out a whole user's activity after 30 days without new
// activity; individual items older than that are trimmed on each add.
const activityTTL = 30 * 24 * time.Hour

// activityPruneAt bounds the per-parent hashes (read positions and newest-item
// times): past this many fields, fields older than the TTL window are dropped,
// then the oldest until a quarter of the room is free again.
const activityPruneAt = 1000

// activityBatchSize bounds one pipelined batch of per-user scripts.
const activityBatchSize = 500

// activityKeys names one user's activity keys. The {userID} hash tag keeps
// them in one cluster slot. (The two legacy keys don't share it; they matter
// only until each stream has been touched once, and this store runs on a
// single-node client.)
//
//   - items  HASH  item id → JSON(ActivityItem)
//   - feed   ZSET  addressed item ids, score = insertion time (ms)
//   - chat   ZSET  conversational item ids, score = insertion time (ms)
//   - marks  HASH  item id → "r<ms>" / "u<ms>": an explicit read/unread mark and when
//   - pos    HASH  parent key → "<position ms>:<set at ms>": how far the user has
//     read that channel, conversation or thread, and when they did
//   - last   HASH  parent key → newest item time (ms) for that parent
//   - msgs   HASH  "m:<messageID>" / "c:<channelID>" → item ids
//   - seen   STRING  "mark all read" watermark (insertion-time ms)
//
// legacy / legacySeen are the pre-rewrite keys (a ZSET of JSON members scored
// by message time, and its watermark). Every script folds them into the keys
// above on first touch.
type activityKeys struct {
	items, feed, chat, marks, pos, last, msgs, seen, legacy, legacySeen string
}

func keysFor(userID string) activityKeys {
	tag := "act:{" + userID + "}:"
	return activityKeys{
		items: tag + "items", feed: tag + "feed", chat: tag + "chat", marks: tag + "marks",
		pos: tag + "pos", last: tag + "last", msgs: tag + "msgs", seen: tag + "seen",
		legacy: "activity:" + userID, legacySeen: "activity:seen:" + userID,
	}
}

func (k activityKeys) all() []string {
	return []string{k.items, k.feed, k.chat, k.marks, k.pos, k.last, k.msgs, k.seen, k.legacy, k.legacySeen}
}

// activityPrelude is shared by every activity script. ARGV[1] is the TTL in ms
// and ARGV[2] the current time in ms — 0 means "use the Redis clock", which is
// what production passes so insertion times, the watermark and mark times all
// come from one clock however many app instances write.
const activityPrelude = `
local items, feed, chat, marks, pos, last, msgs, seen, legacy, legacySeen =
  KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6], KEYS[7], KEYS[8], KEYS[9], KEYS[10]
local ttl = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
if now == 0 then
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local function bucketOf(t)
  if t == 'dm' or t == 'thread_reply' then return chat end
  return feed
end

-- indexKeyOf must match activityIndexKey in Go.
local function indexKeyOf(it)
  if it.type == 'channel_added' then
    if type(it.parentID) == 'string' and it.parentID ~= '' then return 'c:' .. it.parentID end
    return nil
  end
  if type(it.messageID) == 'string' and it.messageID ~= '' then return 'm:' .. it.messageID end
  return nil
end

local function index(k, id)
  local v = redis.call('HGET', msgs, k)
  if v then redis.call('HSET', msgs, k, v .. ' ' .. id) else redis.call('HSET', msgs, k, id) end
end

local function unindex(k, id)
  local v = redis.call('HGET', msgs, k)
  if not v then return end
  local rest = {}
  for x in string.gmatch(v, '%S+') do
    if x ~= id then rest[#rest + 1] = x end
  end
  if #rest == 0 then redis.call('HDEL', msgs, k) else redis.call('HSET', msgs, k, table.concat(rest, ' ')) end
end

-- removeItem drops an item and everything that refers to it; returns whether
-- the item existed.
local function removeItem(id)
  local raw = redis.call('HGET', items, id)
  redis.call('ZREM', feed, id)
  redis.call('ZREM', chat, id)
  redis.call('HDEL', marks, id)
  if not raw then return false end
  redis.call('HDEL', items, id)
  local ok, it = pcall(cjson.decode, raw)
  if ok and type(it) == 'table' then
    local k = indexKeyOf(it)
    if k then unindex(k, id) end
  end
  return true
end

-- prune keeps a per-parent hash bounded: past pruneAt fields, drop those
-- whose time (timeOf the value) is past the TTL window, then the oldest until
-- a quarter of the room is free.
local function prune(h, timeOf, pruneAt)
  if redis.call('HLEN', h) <= pruneAt then return end
  local all = redis.call('HGETALL', h)
  local keep = {}
  for i = 1, #all, 2 do
    local t = timeOf(all[i + 1])
    if t < now - ttl then redis.call('HDEL', h, all[i]) else keep[#keep + 1] = {all[i], t} end
  end
  local target = math.floor(pruneAt * 3 / 4)
  if #keep > target then
    table.sort(keep, function(a, b) return a[2] < b[2] end)
    for i = 1, #keep - target do redis.call('HDEL', h, keep[i][1]) end
  end
end
local function positionTime(v) return tonumber(string.match(v, ':(%d+)$')) or 0 end
local function lastTime(v) return tonumber(v) or 0 end

local function refresh()
  for _, k in ipairs({items, feed, chat, marks, pos, last, msgs, seen}) do
    redis.call('PEXPIRE', k, ttl)
  end
end

-- Fold the pre-rewrite stream into the current keys, once.
local migrated = false
if redis.call('EXISTS', legacy) == 1 then
  local rows = redis.call('ZRANGE', legacy, 0, -1, 'WITHSCORES')
  for i = 1, #rows, 2 do
    local ok, it = pcall(cjson.decode, rows[i])
    if ok and type(it) == 'table' and type(it.id) == 'string' and it.id ~= '' then
      -- Pre-rewrite items named the thread root threadRootID and stored a
      -- (meaningless) read flag.
      if (type(it.parentMessageID) ~= 'string' or it.parentMessageID == '') and type(it.threadRootID) == 'string' and it.threadRootID ~= '' then
        it.parentMessageID = it.threadRootID
      end
      it.threadRootID = nil
      it.read = nil
      redis.call('HSET', items, it.id, cjson.encode(it))
      redis.call('ZADD', bucketOf(it.type), rows[i + 1], it.id)
      local k = indexKeyOf(it)
      if k then index(k, it.id) end
    end
  end
  redis.call('DEL', legacy)
  migrated = true
end
if redis.call('EXISTS', legacySeen) == 1 then
  if redis.call('EXISTS', seen) == 0 then redis.call('SET', seen, redis.call('GET', legacySeen)) end
  redis.call('DEL', legacySeen)
  migrated = true
end
if migrated then refresh() end
`

// activityAddScript stores one item. ARGV: 3 id, 4 JSON, 5 type, 6 feed cap,
// 7 chat cap, 8 index key ("" for none), 9 "1" to replace what the index key
// pointed at instead of appending, 10 parent key ("" when the item doesn't
// follow a parent's read position), 11 the item's message time (ms), 12 the
// prune threshold.
// Returns {watermark, the parent's read position, the insertion time} so the
// caller can resolve the new item's read state.
var activityAddScript = redis.NewScript(activityPrelude + `
local id, json, typ = ARGV[3], ARGV[4], ARGV[5]
local feedCap, chatCap = tonumber(ARGV[6]), tonumber(ARGV[7])
local idx, pk, created = ARGV[8], ARGV[10], tonumber(ARGV[11])
if idx ~= '' then
  if ARGV[9] == '1' then
    local old = redis.call('HGET', msgs, idx)
    if old then
      for x in string.gmatch(old, '%S+') do removeItem(x) end
    end
    redis.call('HSET', msgs, idx, id)
  else
    index(idx, id)
  end
end
redis.call('HSET', items, id, json)
redis.call('ZADD', bucketOf(typ), now, id)
if pk ~= '' then
  local l = tonumber(redis.call('HGET', last, pk) or '0')
  if created > l then redis.call('HSET', last, pk, created) end
  prune(last, lastTime, tonumber(ARGV[12]))
end
local cutoff = now - ttl
for _, b in ipairs({{feed, feedCap}, {chat, chatCap}}) do
  for _, x in ipairs(redis.call('ZRANGEBYSCORE', b[1], '-inf', '(' .. cutoff)) do removeItem(x) end
  for _, x in ipairs(redis.call('ZRANGE', b[1], 0, -(b[2] + 1))) do removeItem(x) end
end
refresh()
local p = ''
if pk ~= '' then p = redis.call('HGET', pos, pk) or '' end
return {redis.call('GET', seen) or '', p, tostring(now)}
`)

// activityListScript gathers everything ListActivity needs in one atomic read:
// {watermark, feed ids+scores, chat ids+scores, the items' JSON (feed ids then
// chat ids), marks, read positions}.
var activityListScript = redis.NewScript(activityPrelude + `
local cutoff = now - ttl
local f = redis.call('ZRANGEBYSCORE', feed, cutoff, '+inf', 'WITHSCORES')
local c = redis.call('ZRANGEBYSCORE', chat, cutoff, '+inf', 'WITHSCORES')
local ids = {}
for i = 1, #f, 2 do ids[#ids + 1] = f[i] end
for i = 1, #c, 2 do ids[#ids + 1] = c[i] end
local vals = {}
if #ids > 0 then vals = redis.call('HMGET', items, unpack(ids)) end
return {redis.call('GET', seen) or '', f, c, vals, redis.call('HGETALL', marks), redis.call('HGETALL', pos)}
`)

// activitySeenScript marks everything read: the watermark moves to the newest
// insertion time (or now, if later) and explicit marks are dropped — they all
// predate it.
var activitySeenScript = redis.NewScript(activityPrelude + `
local wm = now
for _, b in ipairs({feed, chat}) do
  local top = redis.call('ZREVRANGE', b, 0, 0, 'WITHSCORES')
  if #top == 2 and tonumber(top[2]) > wm then wm = tonumber(top[2]) end
end
redis.call('SET', seen, wm)
redis.call('DEL', marks)
refresh()
return wm
`)

// activityMarkScript records explicit read/unread marks. ARGV: 3 "r" or "u",
// 4.. item ids. Ids that aren't in the stream are ignored, so the marks hash
// can only ever name live items. Returns the ids it marked.
var activityMarkScript = redis.NewScript(activityPrelude + `
local applied = {}
for i = 4, #ARGV do
  if redis.call('HEXISTS', items, ARGV[i]) == 1 then
    redis.call('HSET', marks, ARGV[i], ARGV[3] .. now)
    applied[#applied + 1] = ARGV[i]
  end
end
if #applied > 0 then refresh() end
return applied
`)

// activityRemoveScript removes items by id. ARGV: 3.. item ids. Returns the ids
// that existed.
var activityRemoveScript = redis.NewScript(activityPrelude + `
local removed = {}
for i = 3, #ARGV do
  if removeItem(ARGV[i]) then removed[#removed + 1] = ARGV[i] end
end
return removed
`)

// activityRemoveMessagesScript removes every item about the given messages.
// ARGV: 3.. message ids. Returns the removed ids.
var activityRemoveMessagesScript = redis.NewScript(activityPrelude + `
local removed = {}
for i = 3, #ARGV do
  local v = redis.call('HGET', msgs, 'm:' .. ARGV[i])
  if v then
    for x in string.gmatch(v, '%S+') do
      if removeItem(x) then removed[#removed + 1] = x end
    end
  end
end
return removed
`)

// activityPreviewScript rewrites the preview of every item about one message.
// ARGV: 3 message id, 4 the new preview. Returns the updated ids.
var activityPreviewScript = redis.NewScript(activityPrelude + `
local updated = {}
local v = redis.call('HGET', msgs, 'm:' .. ARGV[3])
if v then
  for x in string.gmatch(v, '%S+') do
    local raw = redis.call('HGET', items, x)
    local ok, it = false, nil
    if raw then ok, it = pcall(cjson.decode, raw) end
    if ok and type(it) == 'table' then
      if ARGV[4] == '' then it.messagePreview = nil else it.messagePreview = ARGV[4] end
      redis.call('HSET', items, x, cjson.encode(it))
      updated[#updated + 1] = x
    end
  end
end
return updated
`)

// activityRemoveParentScript removes every item from one channel or
// conversation. ARGV: 3 parent id. Returns the removed ids.
var activityRemoveParentScript = redis.NewScript(activityPrelude + `
local removed = {}
local all = redis.call('HGETALL', items)
for i = 1, #all, 2 do
  local ok, it = pcall(cjson.decode, all[i + 1])
  if ok and type(it) == 'table' and it.parentID == ARGV[3] then
    if removeItem(all[i]) then removed[#removed + 1] = all[i] end
  end
end
return removed
`)

// activityParentReadScript records how far the user has read one channel,
// conversation or thread. ARGV: 3 parent key, 4 read position (ms), 5 prune
// threshold. Returns 1 when the change can flip some item's read state (the
// parent has items newer than the lower of the old and new positions, or there
// are explicit marks a newer read could override), else 0.
var activityParentReadScript = redis.NewScript(activityPrelude + `
local pk, p, pruneAt = ARGV[3], tonumber(ARGV[4]), tonumber(ARGV[5])
local old = redis.call('HGET', pos, pk)
local oldp = 0
if old then oldp = tonumber(string.match(old, '^(%d+)')) or 0 end
redis.call('HSET', pos, pk, p .. ':' .. now)
prune(pos, positionTime, pruneAt)
prune(last, lastTime, pruneAt)

local changed = 0
local l = redis.call('HGET', last, pk)
if l and tonumber(l) > math.min(oldp, p) then changed = 1 end
if changed == 0 and redis.call('HLEN', marks) > 0 then changed = 1 end
refresh()
return changed
`)

// RedisActivityStore stores per-user activity streams in Redis (see
// activityKeys for the layout). Every operation is one Lua script, so each is
// atomic and costs a single round trip.
type RedisActivityStore struct {
	client *redis.Client
	// now pins the clock in tests; nil uses the Redis server's clock.
	now func() time.Time
}

// NewRedisActivityStore builds a RedisActivityStore over the given client.
func NewRedisActivityStore(client *redis.Client) *RedisActivityStore {
	return &RedisActivityStore{client: client}
}

// ActivityAdd is one item bound for one user's stream.
type ActivityAdd struct {
	UserID string
	Item   *model.ActivityItem
}

// activityCall is one per-user script invocation.
type activityCall struct {
	keys []string
	args []any
}

func (s *RedisActivityStore) call(userID string, extra ...any) activityCall {
	var now int64
	if s.now != nil {
		now = s.now().UnixMilli()
	}
	return activityCall{
		keys: keysFor(userID).all(),
		args: append([]any{activityTTL.Milliseconds(), now}, extra...),
	}
}

func (s *RedisActivityStore) run(ctx context.Context, script *redis.Script, c activityCall) *redis.Cmd {
	return redisx.RunScript(ctx, s.client, script, c.keys, c.args...)
}

// runMany runs one script per call, pipelined in batches. A call the server
// rejects with NOSCRIPT (its script cache was flushed) is retried on its own
// through redisx.RunScript, which re-sends the source.
func (s *RedisActivityStore) runMany(ctx context.Context, script *redis.Script, calls []activityCall) []*redis.Cmd {
	cmds := make([]*redis.Cmd, len(calls))
	for start := 0; start < len(calls); start += activityBatchSize {
		end := min(start+activityBatchSize, len(calls))
		pipe := s.client.Pipeline()
		for i := start; i < end; i++ {
			cmds[i] = script.EvalSha(ctx, pipe, calls[i].keys, calls[i].args...)
		}
		// Each command carries its own error; they are inspected below.
		_, _ = pipe.Exec(ctx)
		for i := start; i < end; i++ {
			if err := cmds[i].Err(); err != nil && strings.Contains(err.Error(), "NOSCRIPT") {
				cmds[i] = s.run(ctx, script, calls[i])
			}
		}
	}
	return cmds
}

// activityIndexKey is the msgs-hash key an item is filed under; it must match
// indexKeyOf in activityPrelude. A channel-added item is filed under its
// channel and replaces the previous one there, so re-adding a user to a
// channel never stacks rows.
func activityIndexKey(item *model.ActivityItem) (key string, replace bool) {
	if item.Type == model.ActivityChannelAdded {
		if item.ParentID == "" {
			return "", false
		}
		return "c:" + item.ParentID, true
	}
	if item.MessageID == "" {
		return "", false
	}
	return "m:" + item.MessageID, false
}

// ActivityParentKey names the channel, conversation or thread whose read
// position decides a message-backed item's read state: the parent, or
// parent|threadRoot for a thread.
func ActivityParentKey(parentID, threadRootID string) string {
	if threadRootID == "" {
		return parentID
	}
	return parentID + "|" + threadRootID
}

// followsParent reports whether an item's read state follows its parent's
// read position: mentions, DM messages and thread replies are messages the
// user can read in place. Reactions, reminders and channel adds aren't.
func followsParent(t model.ActivityType) bool {
	return t == model.ActivityMention || t == model.ActivityDM || t == model.ActivityThreadReply
}

func itemParentKey(item *model.ActivityItem) string {
	if !followsParent(item.Type) {
		return ""
	}
	return ActivityParentKey(item.ParentID, item.ParentMessageID)
}

func (s *RedisActivityStore) addCall(userID string, item *model.ActivityItem) activityCall {
	idx, replace := activityIndexKey(item)
	repl := "0"
	if replace {
		repl = "1"
	}
	return s.call(userID, item.ID, mustJSON(json.Marshal(item)), string(item.Type),
		activityMaxFeedItems, activityMaxChatItems, idx, repl, itemParentKey(item), item.CreatedAt.UnixMilli(), activityPruneAt)
}

// ActivityAdded is the outcome of one AddActivityMany entry.
type ActivityAdded struct {
	// Read reports that the item arrived already read: the user had read past
	// its message before the (asynchronous) write landed.
	Read bool
	Err  error
}

// AddActivityMany stores one item per entry — each write also trims expired
// and over-cap items and refreshes the user's TTL — pipelined, and reports
// each entry's outcome.
func (s *RedisActivityStore) AddActivityMany(ctx context.Context, adds []ActivityAdd) []ActivityAdded {
	calls := make([]activityCall, len(adds))
	for i, a := range adds {
		calls[i] = s.addCall(a.UserID, a.Item)
	}
	out := make([]ActivityAdded, len(adds))
	for i, cmd := range s.runMany(ctx, activityAddScript, calls) {
		reply, err := cmd.Slice()
		if err != nil {
			out[i].Err = fmt.Errorf("store: add activity: %w", err)
			continue
		}
		// A new item has no explicit mark yet, so only the watermark and its
		// parent's read position can decide it.
		out[i].Read = activityRead(parseMillis(replyString(reply[2])), adds[i].Item.CreatedAt.UnixMilli(),
			parseMillis(replyString(reply[0])), "", replyString(reply[1]))
	}
	return out
}

// ListActivity returns the user's stream newest-first (by when each item
// arrived), skipping items past the TTL window, with each item's read state
// resolved.
func (s *RedisActivityStore) ListActivity(ctx context.Context, userID string) ([]*model.ActivityFeedItem, error) {
	reply, err := s.run(ctx, activityListScript, s.call(userID)).Slice()
	if err != nil {
		return nil, fmt.Errorf("store: list activity: %w", err)
	}
	seen := parseMillis(replyString(reply[0]))
	type entry struct {
		id    string
		score int64
	}
	var entries []entry
	for _, part := range []any{reply[1], reply[2]} {
		flat := toStrings(part)
		for i := 0; i+1 < len(flat); i += 2 {
			entries = append(entries, entry{id: flat[i], score: parseMillis(flat[i+1])})
		}
	}
	vals, _ := reply[3].([]any)
	marks := pairs(toStrings(reply[4]))
	positions := pairs(toStrings(reply[5]))

	items := make([]*model.ActivityFeedItem, 0, len(entries))
	scores := make(map[*model.ActivityFeedItem]int64, len(entries))
	for i, e := range entries {
		raw, ok := vals[i].(string)
		if !ok {
			// Trimmed between the range and the read can't happen inside one
			// script; a missing body is a stale id — skip it.
			continue
		}
		var it model.ActivityFeedItem
		if err := json.Unmarshal([]byte(raw), &it.ActivityItem); err != nil {
			return nil, fmt.Errorf("store: unmarshal activity: %w", err)
		}
		it.Read = activityRead(e.score, it.CreatedAt.UnixMilli(), seen, marks[e.id], positions[itemParentKey(&it.ActivityItem)])
		items = append(items, &it)
		scores[&it] = e.score
	}
	sort.SliceStable(items, func(a, b int) bool {
		if scores[items[a]] != scores[items[b]] {
			return scores[items[a]] > scores[items[b]]
		}
		return items[a].ID > items[b].ID
	})
	return items, nil
}

// activityRead resolves an item's read state from the signals that can decide
// it, the most recent one winning:
//
//   - mark all read: read when the item arrived at or before the watermark;
//   - the item's parent read position (mentions, DM messages, thread replies):
//     read when the message is at or before how far the user has read that
//     channel, conversation or thread — so reading a DM reads its items, and
//     marking a message unread there makes its item unread again;
//   - an explicit "mark as read/unread" on the item itself.
//
// With no signal an item is unread.
func activityRead(score, created, seen int64, mark, position string) bool {
	read, at := false, int64(-1)
	if seen > 0 && score <= seen {
		read, at = true, seen
	}
	if p, set, ok := parsePosition(position); ok && set > at {
		read, at = created <= p, set
	}
	if len(mark) > 1 {
		if t := parseMillis(mark[1:]); t > at {
			read = mark[0] == 'r'
		}
	}
	return read
}

// parsePosition splits a "<position ms>:<set at ms>" read-position value.
func parsePosition(v string) (position, set int64, ok bool) {
	p, at, found := strings.Cut(v, ":")
	if !found {
		return 0, 0, false
	}
	return parseMillis(p), parseMillis(at), true
}

// MarkActivitySeen marks every item read ("mark all read").
func (s *RedisActivityStore) MarkActivitySeen(ctx context.Context, userID string) error {
	if err := s.run(ctx, activitySeenScript, s.call(userID)).Err(); err != nil {
		return fmt.Errorf("store: activity mark seen: %w", err)
	}
	return nil
}

// SetActivityRead marks the given items read or unread, returning the ids that
// are in the stream (the others are ignored).
func (s *RedisActivityStore) SetActivityRead(ctx context.Context, userID string, ids []string, read bool) ([]string, error) {
	flag := "u"
	if read {
		flag = "r"
	}
	args := append([]any{flag}, stringsToAny(ids)...)
	reply, err := s.run(ctx, activityMarkScript, s.call(userID, args...)).StringSlice()
	if err != nil {
		return nil, fmt.Errorf("store: set activity read: %w", err)
	}
	return reply, nil
}

// RemoveActivity deletes the given items, returning the ids that existed.
func (s *RedisActivityStore) RemoveActivity(ctx context.Context, userID string, ids []string) ([]string, error) {
	reply, err := s.run(ctx, activityRemoveScript, s.call(userID, stringsToAny(ids)...)).StringSlice()
	if err != nil {
		return nil, fmt.Errorf("store: remove activity: %w", err)
	}
	return reply, nil
}

// RemoveActivityForMessages deletes every item about the given messages from
// each user's stream, returning the removed ids per user (users with none are
// left out). A user whose removal failed is skipped and the first error
// returned.
func (s *RedisActivityStore) RemoveActivityForMessages(ctx context.Context, userIDs, messageIDs []string) (map[string][]string, error) {
	return s.perUser(ctx, activityRemoveMessagesScript, userIDs, "remove activity for messages", stringsToAny(messageIDs)...)
}

// UpdateActivityPreview rewrites the preview of every item about one message
// in each user's stream, returning the updated ids per user.
func (s *RedisActivityStore) UpdateActivityPreview(ctx context.Context, userIDs []string, messageID, preview string) (map[string][]string, error) {
	return s.perUser(ctx, activityPreviewScript, userIDs, "update activity preview", messageID, preview)
}

func (s *RedisActivityStore) perUser(ctx context.Context, script *redis.Script, userIDs []string, op string, args ...any) (map[string][]string, error) {
	calls := make([]activityCall, len(userIDs))
	for i, u := range userIDs {
		calls[i] = s.call(u, args...)
	}
	out := map[string][]string{}
	var firstErr error
	for i, cmd := range s.runMany(ctx, script, calls) {
		ids, err := cmd.StringSlice()
		if err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("store: %s for %s: %w", op, userIDs[i], err)
			}
			continue
		}
		if len(ids) > 0 {
			out[userIDs[i]] = ids
		}
	}
	return out, firstErr
}

// RemoveActivityForParent deletes every item from one channel or conversation
// — used when the user loses access to it — returning the removed ids.
func (s *RedisActivityStore) RemoveActivityForParent(ctx context.Context, userID, parentID string) ([]string, error) {
	reply, err := s.run(ctx, activityRemoveParentScript, s.call(userID, parentID)).StringSlice()
	if err != nil {
		return nil, fmt.Errorf("store: remove activity for parent: %w", err)
	}
	return reply, nil
}

// MarkActivityParentRead records that the user has read the parent (see
// ActivityParentKey) up to position, and reports whether that can change some
// item's read state.
func (s *RedisActivityStore) MarkActivityParentRead(ctx context.Context, userID, parentKey string, position time.Time) (bool, error) {
	n, err := s.run(ctx, activityParentReadScript, s.call(userID, parentKey, position.UnixMilli(), activityPruneAt)).Int()
	if err != nil {
		return false, fmt.Errorf("store: mark activity parent read: %w", err)
	}
	return n == 1, nil
}

// replyString reads a Lua string reply field; a missing (false) field reads
// as "".
func replyString(v any) string {
	s, _ := v.(string)
	return s
}

func toStrings(v any) []string {
	arr, _ := v.([]any)
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		s, _ := x.(string)
		out = append(out, s)
	}
	return out
}

func pairs(flat []string) map[string]string {
	m := make(map[string]string, len(flat)/2)
	for i := 0; i+1 < len(flat); i += 2 {
		m[flat[i]] = flat[i+1]
	}
	return m
}

func parseMillis(v string) int64 {
	n, _ := strconv.ParseInt(v, 10, 64)
	return n
}

// stringsToAny spreads ids into script arguments: go-redis only flattens a
// []string passed as the sole argument, and script calls always lead with the
// TTL and clock.
func stringsToAny(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}
