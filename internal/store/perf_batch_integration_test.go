//go:build integration

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// Batched multi-ID reads added for the APM perf work: conversations, channels
// and messages resolve META/row sets via chunked BatchGetItem instead of a
// GetItem per ID. Each suite pins: hits + missing IDs, empty input, the SDK
// error arm, the corrupt-row unmarshal arm and the UnprocessedKeys drain.

func TestConversationStore_GetConversationsByIDs(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewConversationStore(db)

	c1 := &model.Conversation{ID: "conv-bg-1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"a", "b"}, CreatedAt: time.Now()}
	c2 := &model.Conversation{ID: "conv-bg-2", Type: model.ConversationTypeDM, ParticipantIDs: []string{"a", "c"}, CreatedAt: time.Now()}
	for _, c := range []*model.Conversation{c1, c2} {
		if err := s.Create(ctx, c, nil); err != nil {
			t.Fatalf("Create %s: %v", c.ID, err)
		}
	}

	got, err := s.GetConversationsByIDs(ctx, []string{c1.ID, "conv-bg-missing", c2.ID})
	if err != nil {
		t.Fatalf("GetConversationsByIDs: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d conversations, want 2 (missing ID silently absent)", len(got))
	}
	byID := map[string]*model.Conversation{}
	for _, c := range got {
		byID[c.ID] = c
	}
	if byID[c1.ID] == nil || byID[c2.ID] == nil {
		t.Fatalf("resolved = %v, want both seeded conversations", byID)
	}

	if empty, err := s.GetConversationsByIDs(ctx, nil); err != nil || len(empty) != 0 {
		t.Fatalf("empty ids = %v (err=%v), want empty success", empty, err)
	}

	errStore := NewConversationStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true }))
	if _, err := errStore.GetConversationsByIDs(ctx, []string{c1.ID}); !errors.Is(err, errInjected) {
		t.Fatalf("BatchGetItem fault: want errInjected, got %v", err)
	}

	corruptStore := NewConversationStore(withFault(db, func(f *faultClient) { f.transformBatchGetItem = corruptBatchGetOut(db) }))
	_, err = corruptStore.GetConversationsByIDs(ctx, []string{c1.ID})
	assertUnmarshalErr(t, err, "conversation GetConversationsByIDs")

	drained := NewConversationStore(withFault(db, func(f *faultClient) {
		f.transformBatchGetItem = unprocessedOnce(db, compositeKey(convPK(c1.ID), metaSK()))
	}))
	got, err = drained.GetConversationsByIDs(ctx, []string{c1.ID})
	if err != nil || len(got) != 1 || got[0].ID != c1.ID {
		t.Fatalf("unprocessed drain = %v (err=%v), want the seeded conversation", got, err)
	}
}

func TestChannelStore_GetChannelsByIDs(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewChannelStore(db)

	ch1 := makeChannel("ch-bg-1", "bg one", "bg-one", model.ChannelTypePublic)
	ch2 := makeChannel("ch-bg-2", "bg two", "bg-two", model.ChannelTypePrivate)
	for _, ch := range []*model.Channel{ch1, ch2} {
		if err := s.Create(ctx, ch); err != nil {
			t.Fatalf("Create %s: %v", ch.ID, err)
		}
	}

	got, err := s.GetChannelsByIDs(ctx, []string{ch1.ID, "ch-bg-missing", ch2.ID})
	if err != nil {
		t.Fatalf("GetChannelsByIDs: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d channels, want 2", len(got))
	}
	byID := map[string]*model.Channel{}
	for _, ch := range got {
		byID[ch.ID] = ch
	}
	if byID[ch1.ID] == nil || byID[ch2.ID] == nil || byID[ch1.ID].Slug != "bg-one" {
		t.Fatalf("resolved = %v, want both seeded channels with META fields", byID)
	}

	if empty, err := s.GetChannelsByIDs(ctx, nil); err != nil || len(empty) != 0 {
		t.Fatalf("empty ids = %v (err=%v), want empty success", empty, err)
	}

	errStore := NewChannelStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true }))
	if _, err := errStore.GetChannelsByIDs(ctx, []string{ch1.ID}); !errors.Is(err, errInjected) {
		t.Fatalf("BatchGetItem fault: want errInjected, got %v", err)
	}

	corruptStore := NewChannelStore(withFault(db, func(f *faultClient) { f.transformBatchGetItem = corruptBatchGetOut(db) }))
	_, err = corruptStore.GetChannelsByIDs(ctx, []string{ch1.ID})
	assertUnmarshalErr(t, err, "channel GetChannelsByIDs")

	drained := NewChannelStore(withFault(db, func(f *faultClient) {
		f.transformBatchGetItem = unprocessedOnce(db, compositeKey(channelPK(ch1.ID), metaSK()))
	}))
	got, err = drained.GetChannelsByIDs(ctx, []string{ch1.ID})
	if err != nil || len(got) != 1 || got[0].ID != ch1.ID {
		t.Fatalf("unprocessed drain = %v (err=%v), want the seeded channel", got, err)
	}
}

func TestMessageStore_GetMessagesByIDs(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewMessageStore(db)

	m1 := &model.Message{ID: "m-bg-1", ParentID: "ch-bg", AuthorID: "u-1", Body: "one", CreatedAt: time.Now()}
	m2 := &model.Message{ID: "m-bg-2", ParentID: "ch-bg", AuthorID: "u-2", Body: "two", CreatedAt: time.Now()}
	for _, m := range []*model.Message{m1, m2} {
		if err := s.Create(ctx, m); err != nil {
			t.Fatalf("Create %s: %v", m.ID, err)
		}
	}

	got, err := s.GetMessagesByIDs(ctx, "ch-bg", []string{m1.ID, "m-bg-missing", m2.ID})
	if err != nil {
		t.Fatalf("GetMessagesByIDs: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d messages, want 2", len(got))
	}
	byID := map[string]*model.Message{}
	for _, m := range got {
		byID[m.ID] = m
	}
	if byID[m1.ID] == nil || byID[m2.ID] == nil || byID[m1.ID].Body != "one" {
		t.Fatalf("resolved = %v, want both seeded messages", byID)
	}

	if empty, err := s.GetMessagesByIDs(ctx, "ch-bg", nil); err != nil || len(empty) != 0 {
		t.Fatalf("empty ids = %v (err=%v), want empty success", empty, err)
	}

	errStore := NewMessageStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true }))
	if _, err := errStore.GetMessagesByIDs(ctx, "ch-bg", []string{m1.ID}); !errors.Is(err, errInjected) {
		t.Fatalf("BatchGetItem fault: want errInjected, got %v", err)
	}

	corruptStore := NewMessageStore(withFault(db, func(f *faultClient) { f.transformBatchGetItem = corruptBatchGetOut(db) }))
	_, err = corruptStore.GetMessagesByIDs(ctx, "ch-bg", []string{m1.ID})
	assertUnmarshalErr(t, err, "message GetMessagesByIDs")

	drained := NewMessageStore(withFault(db, func(f *faultClient) {
		f.transformBatchGetItem = unprocessedOnce(db, compositeKey(parentPK("ch-bg"), msgSK(m1.ID)))
	}))
	got, err = drained.GetMessagesByIDs(ctx, "ch-bg", []string{m1.ID})
	if err != nil || len(got) != 1 || got[0].ID != m1.ID {
		t.Fatalf("unprocessed drain = %v (err=%v), want the seeded message", got, err)
	}
}

// corruptBatchGetOut replaces the real BatchGetItem payload with a row no
// store struct can absorb, reaching the unmarshal error arms.
func corruptBatchGetOut(db *DB) func(*dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
	return func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
		out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {corruptRow()}}
		out.UnprocessedKeys = nil
		return out
	}
}

// unprocessedOnce reports the WHOLE first response as unprocessed (empty
// Responses), forcing the drain loop through a second, passthrough iteration
// — DynamoDB Local never produces UnprocessedKeys on its own.
func unprocessedOnce(db *DB, key map[string]types.AttributeValue) func(*dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
	fired := false
	return func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
		if fired {
			return out
		}
		fired = true
		return &dynamodb.BatchGetItemOutput{
			Responses: map[string][]map[string]types.AttributeValue{},
			UnprocessedKeys: map[string]types.KeysAndAttributes{
				db.Table: {Keys: []map[string]types.AttributeValue{key}},
			},
		}
	}
}

// --- thread-participation index primitives ---------------------------------

func TestThreadFollowStore_SetIfAbsent(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(db)

	// Absent → the implicit participation row is written.
	if err := s.SetIfAbsent(ctx, makeThreadFollow("u-ifa", "ch-ifa", "root-1")); err != nil {
		t.Fatalf("SetIfAbsent: %v", err)
	}
	got, err := s.Get(ctx, "u-ifa", "ch-ifa", "root-1")
	if err != nil || !got.Following {
		t.Fatalf("Get after SetIfAbsent = %+v (err=%v), want Following=true", got, err)
	}

	// A deliberate unfollow is NEVER clobbered by an implicit re-follow: the
	// conditional write no-ops (nil error) and the record keeps Following=false.
	unfollow := makeThreadFollow("u-ifa", "ch-ifa", "root-out")
	unfollow.Following = false
	if err := s.Set(ctx, unfollow); err != nil {
		t.Fatalf("Set unfollow: %v", err)
	}
	if err := s.SetIfAbsent(ctx, makeThreadFollow("u-ifa", "ch-ifa", "root-out")); err != nil {
		t.Fatalf("SetIfAbsent over existing: %v", err)
	}
	got, err = s.Get(ctx, "u-ifa", "ch-ifa", "root-out")
	if err != nil || got.Following {
		t.Fatalf("Get after conditional no-op = %+v (err=%v), want Following=false preserved", got, err)
	}

	// Non-conditional SDK failures still surface.
	errStore := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	if err := errStore.SetIfAbsent(ctx, makeThreadFollow("u-ifa", "ch-ifa", "root-2")); !errors.Is(err, errInjected) {
		t.Fatalf("SetIfAbsent fault: want errInjected, got %v", err)
	}
}

func TestThreadFollowStore_SeedMarker(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewThreadFollowStore(db)

	seeded, err := s.IsThreadIndexSeeded(ctx, "u-seed")
	if err != nil || seeded {
		t.Fatalf("IsThreadIndexSeeded before mark = %v (err=%v), want false", seeded, err)
	}
	if err := s.MarkThreadIndexSeeded(ctx, "u-seed"); err != nil {
		t.Fatalf("MarkThreadIndexSeeded: %v", err)
	}
	seeded, err = s.IsThreadIndexSeeded(ctx, "u-seed")
	if err != nil || !seeded {
		t.Fatalf("IsThreadIndexSeeded after mark = %v (err=%v), want true", seeded, err)
	}

	// The marker row lives OUTSIDE the THREAD# SK prefix — a seeded user's
	// follow listing must never surface it as a phantom follow.
	if err := s.Set(ctx, makeThreadFollow("u-seed", "ch-seed", "root-1")); err != nil {
		t.Fatalf("Set: %v", err)
	}
	follows, err := s.ListUser(ctx, "u-seed")
	if err != nil || len(follows) != 1 || follows[0].ThreadRootID != "root-1" {
		t.Fatalf("ListUser with marker present = %+v (err=%v), want only the real follow", follows, err)
	}

	getErrStore := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	if _, err := getErrStore.IsThreadIndexSeeded(ctx, "u-seed"); !errors.Is(err, errInjected) {
		t.Fatalf("IsThreadIndexSeeded fault: want errInjected, got %v", err)
	}
	putErrStore := NewThreadFollowStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	if err := putErrStore.MarkThreadIndexSeeded(ctx, "u-seed"); !errors.Is(err, errInjected) {
		t.Fatalf("MarkThreadIndexSeeded fault: want errInjected, got %v", err)
	}
}
