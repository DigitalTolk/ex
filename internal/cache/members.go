package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/redisx"
	"github.com/redis/go-redis/v9"
)

// MemberLists is the shared copy of channels' member rows: one hash per
// channel holding the audience generation it was read under and a field per
// member. It is valid only while that generation is the channel's current one
// (ChannelAudienceKey), which every membership write moves — the services and
// the history importer alike — so a change is never served stale; the TTL only
// bounds a generation move that was lost. A hash filled from the whole member
// list is marked complete and answers "who are the members"; one filled member
// by member answers only for those members.
type MemberLists struct {
	rdb redis.UniversalClient
	ttl time.Duration
}

// NewMemberLists keeps each channel's copy for at most ttl.
func NewMemberLists(rdb redis.UniversalClient, ttl time.Duration) *MemberLists {
	return &MemberLists{rdb: rdb, ttl: ttl}
}

const (
	membersGenField      = "_gen"
	membersCompleteField = "_complete"
)

func membersKey(channelID string) string { return "members:ch:" + channelID }

// tagGen marks a stored generation, so a missing field and a channel whose
// generation never moved (the empty generation) can't be mistaken.
func tagGen(gen string) string { return "g:" + gen }

// putMemberScript adds one member's row to a channel's hash when it holds the
// generation the row was read under, and otherwise starts the hash over at
// that generation. Adding a row never extends the hash's life: the TTL counts
// from the moment the generation was first stored.
var putMemberScript = redis.NewScript(`
if redis.call('HGET', KEYS[1], '_gen') ~= ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], '_gen', ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ARGV[4])
end
redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
return 1
`)

// Member returns userID's row in channelID's copy (nil when the copy doesn't
// hold one at the current generation), and the current generation to store a
// fill under. One round trip.
func (m *MemberLists) Member(ctx context.Context, channelID, userID string) (*model.ChannelMembership, string, error) {
	pipe := m.rdb.Pipeline()
	genCmd := pipe.Get(ctx, ChannelAudienceKey(channelID))
	vals := pipe.HMGet(ctx, membersKey(channelID), membersGenField, userID)
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, "", fmt.Errorf("member lists: read %s: %w", channelID, err)
	}
	gen := genCmd.Val()
	fields := vals.Val()
	if fields[0] != tagGen(gen) || fields[1] == nil {
		return nil, gen, nil
	}
	var row model.ChannelMembership
	if err := json.Unmarshal([]byte(fields[1].(string)), &row); err != nil {
		return nil, gen, fmt.Errorf("member lists: decode %s/%s: %w", channelID, userID, err)
	}
	return &row, gen, nil
}

// Members returns channelID's member rows when its copy is complete at the
// current generation (complete=false otherwise), and the current generation
// to store a fill under. One round trip.
func (m *MemberLists) Members(ctx context.Context, channelID string) ([]*model.ChannelMembership, string, bool, error) {
	pipe := m.rdb.Pipeline()
	genCmd := pipe.Get(ctx, ChannelAudienceKey(channelID))
	all := pipe.HGetAll(ctx, membersKey(channelID))
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, "", false, fmt.Errorf("member lists: read %s: %w", channelID, err)
	}
	gen := genCmd.Val()
	fields := all.Val()
	if fields[membersGenField] != tagGen(gen) || fields[membersCompleteField] == "" {
		return nil, gen, false, nil
	}
	rows := make([]*model.ChannelMembership, 0, len(fields)-2)
	for name, raw := range fields {
		if name == membersGenField || name == membersCompleteField {
			continue
		}
		var row model.ChannelMembership
		if err := json.Unmarshal([]byte(raw), &row); err != nil {
			return nil, gen, false, fmt.Errorf("member lists: decode %s/%s: %w", channelID, name, err)
		}
		rows = append(rows, &row)
	}
	return rows, gen, true, nil
}

// PutMember stores one member's row, read under gen.
func (m *MemberLists) PutMember(ctx context.Context, channelID, gen string, row *model.ChannelMembership) error {
	raw := mustJSON(json.Marshal(row))
	if err := redisx.RunScript(ctx, m.rdb, putMemberScript, []string{membersKey(channelID)},
		tagGen(gen), row.UserID, raw, m.ttl.Milliseconds()).Err(); err != nil {
		return fmt.Errorf("member lists: put %s/%s: %w", channelID, row.UserID, err)
	}
	return nil
}

// PutMembers stores channelID's complete member list, read under gen.
func (m *MemberLists) PutMembers(ctx context.Context, channelID, gen string, rows []*model.ChannelMembership) error {
	key := membersKey(channelID)
	fields := make([]any, 0, 4+2*len(rows))
	fields = append(fields, membersGenField, tagGen(gen), membersCompleteField, "1")
	for _, row := range rows {
		fields = append(fields, row.UserID, mustJSON(json.Marshal(row)))
	}
	if _, err := m.rdb.TxPipelined(ctx, func(p redis.Pipeliner) error {
		p.Del(ctx, key)
		p.HSet(ctx, key, fields...)
		p.PExpire(ctx, key, m.ttl)
		return nil
	}); err != nil {
		return fmt.Errorf("member lists: put %s: %w", channelID, err)
	}
	return nil
}
