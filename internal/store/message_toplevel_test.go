//go:build integration

package store

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// rowsReadCounter sums the rows DynamoDB evaluated for every Query — the read
// cost a page load pays.
type rowsReadCounter struct {
	DynamoAPI
	scanned int32
	queries int
}

func (c *rowsReadCounter) Query(ctx context.Context, in *dynamodb.QueryInput, o ...func(*dynamodb.Options)) (*dynamodb.QueryOutput, error) {
	out, err := c.DynamoAPI.Query(ctx, in, o...)
	if err == nil {
		c.scanned += out.ScannedCount
		c.queries++
	}
	return out, err
}

// seedThreadedParent writes `roots` top-level messages, each followed by
// `replies` thread replies, alternating the interactive write (CreateMessage)
// and the bulk-import write (PutNewMessages). Returns the top-level IDs in
// key order — the index's order. Message IDs minted in the same millisecond
// aren't monotonic, so creation order can differ from it.
func seedThreadedParent(t *testing.T, ms *MessageStoreImpl, parentID string, roots, replies int) []string {
	t.Helper()
	ctx := context.Background()
	var top []string
	for i := range roots {
		root := makeMessage(parentID, NewID(), "u1", "root")
		batch := []*model.Message{root}
		for range replies {
			r := makeMessage(parentID, NewID(), "u2", "reply")
			r.ParentMessageID = root.ID
			batch = append(batch, r)
		}
		if i%2 == 0 {
			for _, m := range batch {
				if err := ms.CreateMessage(ctx, m); err != nil {
					t.Fatalf("create: %v", err)
				}
			}
		} else if err := ms.PutNewMessages(ctx, batch); err != nil {
			t.Fatalf("import: %v", err)
		}
		top = append(top, root.ID)
	}
	slices.Sort(top)
	return top
}

// A channel page reads the top-level rows it shows — not every thread reply
// in between. A page of 50 used to cost up to ~300 rows of reads (six rounds
// of filtering ListMessages).
func TestListTopLevelMessages_ReadsOnlyTheRowsItReturns(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	top := seedThreadedParent(t, ms, "ch-top", 10, 5)

	// A tombstone stays listed (rendered as a placeholder); a hard delete
	// leaves the index with its row.
	tomb, err := ms.GetMessage(ctx, "ch-top", top[3])
	if err != nil {
		t.Fatal(err)
	}
	tomb.Deleted, tomb.Body = true, ""
	if err := ms.UpdateMessage(ctx, tomb); err != nil {
		t.Fatal(err)
	}
	if err := ms.DeleteMessage(ctx, "ch-top", top[4]); err != nil {
		t.Fatal(err)
	}
	want := slices.Clone(top)
	want = slices.Delete(want, 4, 5)
	slices.Reverse(want) // newest first

	counter := &rowsReadCounter{DynamoAPI: db.Client}
	paged := NewMessageStore(&DB{Client: counter, Table: db.Table})
	var got []string
	cursor := ""
	for page := 0; ; page++ {
		before := counter.scanned
		msgs, hasMore, err := paged.ListTopLevelMessages(ctx, "ch-top", cursor, 4)
		if err != nil {
			t.Fatalf("page %d: %v", page, err)
		}
		if read := counter.scanned - before; read > 5 {
			t.Fatalf("page %d read %d rows for %d messages, want at most limit+1 = 5", page, read, len(msgs))
		}
		for _, m := range msgs {
			if m.ParentMessageID != "" {
				t.Fatalf("reply %s listed as top-level", m.ID)
			}
			got = append(got, m.ID)
		}
		if !hasMore {
			break
		}
		cursor = msgs[len(msgs)-1].ID
	}
	if !slices.Equal(got, want) {
		t.Fatalf("listed %v, want %v", got, want)
	}
	// 9 listed over 3 pages: every row read was a row returned, plus at most
	// one look-ahead row per page — none of the 50 replies.
	if counter.scanned < int32(len(want)) || counter.scanned > int32(len(want)+counter.queries) {
		t.Fatalf("read %d rows in %d queries for %d messages", counter.scanned, counter.queries, len(want))
	}
	if tm, _ := paged.GetMessage(ctx, "ch-top", top[3]); tm == nil || !tm.Deleted {
		t.Fatalf("tombstone = %+v", tm)
	}
}

// A response cut by the 1MB cap is continued, never returned as a short page
// or as the end of history.
func TestListTopLevelMessages_CappedResponseKeepsReading(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	top := seedThreadedParent(t, ms, "ch-cap2", 6, 1)
	capped := NewMessageStore(withFault(db, func(f *faultClient) { f.transformQuery = capFirstQuery(1, "GSI2PK", "GSI2SK") }))
	msgs, hasMore, err := capped.ListTopLevelMessages(ctx, "ch-cap2", "", 4)
	if err != nil || len(msgs) != 4 || !hasMore {
		t.Fatalf("capped page = %d msgs, hasMore=%v (err %v); want 4 and hasMore", len(msgs), hasMore, err)
	}
	if msgs[0].ID != top[5] || msgs[3].ID != top[2] {
		t.Fatalf("page order wrong: %s..%s", msgs[0].ID, msgs[3].ID)
	}
}

func TestListTopLevelMessages_Errors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	seedThreadedParent(t, NewMessageStore(db), "ch-err", 1, 0)

	_, _, err := NewMessageStore(withFault(db, func(f *faultClient) { f.failQuery = true })).ListTopLevelMessages(ctx, "ch-err", "", 10)
	if !errors.Is(err, errInjected) {
		t.Fatalf("query: want errInjected, got %v", err)
	}
	_, _, err = NewMessageStore(withFault(db, func(f *faultClient) { f.transformQuery = corruptQuery })).ListTopLevelMessages(ctx, "ch-err", "", 10)
	assertUnmarshalErr(t, err, "ListTopLevelMessages")
}
