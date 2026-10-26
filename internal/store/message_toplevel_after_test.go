//go:build integration

package store

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Scrolling down (or jumping forward) reads the top-level index too: each
// page reads the rows it shows, not every thread reply in between.
func TestListTopLevelMessagesAfter_ReadsOnlyTheRowsItReturns(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	top := seedThreadedParent(t, ms, "ch-fwd", 10, 5)
	if err := ms.MarkTopLevelIndexSeeded(ctx); err != nil {
		t.Fatal(err)
	}
	// A hard delete leaves the index with its row.
	if err := ms.DeleteMessage(ctx, "ch-fwd", top[5]); err != nil {
		t.Fatal(err)
	}
	want := slices.Delete(slices.Clone(top[1:]), 4, 5) // oldest first

	counter := &rowsReadCounter{DynamoAPI: db.Client}
	paged := NewMessageStore(&DB{Client: counter, Table: db.Table})
	var got []string
	cursor := top[0]
	for page := 0; ; page++ {
		before := counter.scanned
		msgs, hasMore, err := paged.ListTopLevelMessagesAfter(ctx, "ch-fwd", cursor, 3)
		if err != nil {
			t.Fatalf("page %d: %v", page, err)
		}
		if read := counter.scanned - before; read > 4 {
			t.Fatalf("page %d read %d rows for %d messages, want at most limit+1 = 4", page, read, len(msgs))
		}
		// Newest first, like every message page.
		for i := len(msgs) - 1; i >= 0; i-- {
			if msgs[i].ParentMessageID != "" {
				t.Fatalf("reply %s listed as top-level", msgs[i].ID)
			}
			got = append(got, msgs[i].ID)
		}
		if !hasMore {
			break
		}
		cursor = msgs[0].ID
	}
	if !slices.Equal(got, want) {
		t.Fatalf("listed %v, want %v", got, want)
	}
	if counter.scanned > int32(len(want)+counter.queries) {
		t.Fatalf("read %d rows in %d queries for %d messages", counter.scanned, counter.queries, len(want))
	}

	// The page nearest the cursor comes first; the rest is "more".
	msgs, hasMore, err := ms.ListTopLevelMessagesAfter(ctx, "ch-fwd", top[0], 2)
	if err != nil || !hasMore || len(msgs) != 2 || msgs[0].ID != top[2] || msgs[1].ID != top[1] {
		t.Fatalf("first page = %v (hasMore=%v, err %v), want [%s %s]", topLevelIDs(msgs), hasMore, err, top[2], top[1])
	}
	// At the live tail there is nothing newer.
	if msgs, hasMore, err := ms.ListTopLevelMessagesAfter(ctx, "ch-fwd", top[9], 5); err != nil || hasMore || len(msgs) != 0 {
		t.Fatalf("after the newest = %v (hasMore=%v, err %v)", topLevelIDs(msgs), hasMore, err)
	}
	// No cursor, no page — and no read.
	before := counter.queries
	if msgs, hasMore, err := paged.ListTopLevelMessagesAfter(ctx, "ch-fwd", "", 5); err != nil || hasMore || msgs != nil || counter.queries != before {
		t.Fatalf("empty cursor = %v (hasMore=%v, err %v, queries %d)", msgs, hasMore, err, counter.queries-before)
	}
}

func topLevelIDs(msgs []*model.Message) []string {
	out := make([]string, len(msgs))
	for i, m := range msgs {
		out[i] = m.ID
	}
	return out
}

// A response cut by the 1MB cap is continued forward too.
func TestListTopLevelMessagesAfter_CappedResponseKeepsReading(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	top := seedThreadedParent(t, ms, "ch-fwdcap", 6, 1)
	if err := ms.MarkTopLevelIndexSeeded(ctx); err != nil {
		t.Fatal(err)
	}
	capped := NewMessageStore(withFault(db, func(f *faultClient) { f.transformQuery = capFirstQuery(1, "GSI2PK", "GSI2SK") }))
	msgs, hasMore, err := capped.ListTopLevelMessagesAfter(ctx, "ch-fwdcap", top[0], 3)
	if err != nil || len(msgs) != 3 || !hasMore {
		t.Fatalf("capped page = %d msgs, hasMore=%v (err %v); want 3 and hasMore", len(msgs), hasMore, err)
	}
	if msgs[0].ID != top[3] || msgs[2].ID != top[1] {
		t.Fatalf("page = %v, want %s..%s", topLevelIDs(msgs), top[3], top[1])
	}
}

func TestListTopLevelMessagesAfter_ErrorsAndPending(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	recheckTopLevelMarker(t, time.Hour)
	top := seedThreadedParent(t, NewMessageStore(db), "ch-fwderr", 2, 0)

	if _, _, err := NewMessageStore(db).ListTopLevelMessagesAfter(ctx, "ch-fwderr", top[0], 10); !errors.Is(err, ErrTopLevelIndexPending) {
		t.Fatalf("before the backfill: err = %v, want ErrTopLevelIndexPending", err)
	}
	if err := NewMessageStore(db).MarkTopLevelIndexSeeded(ctx); err != nil {
		t.Fatal(err)
	}
	_, _, err := NewMessageStore(withFault(db, func(f *faultClient) { f.failGetItem = true })).ListTopLevelMessagesAfter(ctx, "ch-fwderr", top[0], 10)
	if !errors.Is(err, errInjected) {
		t.Fatalf("marker read: want errInjected, got %v", err)
	}
	_, _, err = NewMessageStore(withFault(db, func(f *faultClient) { f.failQuery = true })).ListTopLevelMessagesAfter(ctx, "ch-fwderr", top[0], 10)
	if !errors.Is(err, errInjected) {
		t.Fatalf("query: want errInjected, got %v", err)
	}
	_, _, err = NewMessageStore(withFault(db, func(f *faultClient) { f.transformQuery = corruptQuery })).ListTopLevelMessagesAfter(ctx, "ch-fwderr", top[0], 10)
	assertUnmarshalErr(t, err, "ListTopLevelMessagesAfter")
}
