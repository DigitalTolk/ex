//go:build integration

package store

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// recheckTopLevelMarker pins how long a "not seeded" answer is reused.
func recheckTopLevelMarker(t *testing.T, d time.Duration) {
	t.Helper()
	prev := topLevelIndexRecheck
	topLevelIndexRecheck = d
	t.Cleanup(func() { topLevelIndexRecheck = prev })
}

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
// and the bulk-import write (PutNewMessages). Returns the top-level IDs,
// oldest first.
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
	if err := ms.MarkTopLevelIndexSeeded(ctx); err != nil {
		t.Fatal(err)
	}

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
	if err := ms.MarkTopLevelIndexSeeded(ctx); err != nil {
		t.Fatal(err)
	}
	capped := NewMessageStore(withFault(db, func(f *faultClient) { f.transformQuery = capFirstQuery(1) }))
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
	if err := NewMessageStore(db).MarkTopLevelIndexSeeded(ctx); err != nil {
		t.Fatal(err)
	}
	seedThreadedParent(t, NewMessageStore(db), "ch-err", 1, 0)

	_, _, err := NewMessageStore(withFault(db, func(f *faultClient) { f.failGetItem = true })).ListTopLevelMessages(ctx, "ch-err", "", 10)
	if !errors.Is(err, errInjected) {
		t.Fatalf("marker read: want errInjected, got %v", err)
	}
	_, _, err = NewMessageStore(withFault(db, func(f *faultClient) { f.failQuery = true })).ListTopLevelMessages(ctx, "ch-err", "", 10)
	if !errors.Is(err, errInjected) {
		t.Fatalf("query: want errInjected, got %v", err)
	}
	_, _, err = NewMessageStore(withFault(db, func(f *faultClient) { f.transformQuery = corruptQuery })).ListTopLevelMessages(ctx, "ch-err", "", 10)
	assertUnmarshalErr(t, err, "ListTopLevelMessages")
	if err := NewMessageStore(withFault(db, func(f *faultClient) { f.failPutItem = true })).MarkTopLevelIndexSeeded(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("mark: want errInjected, got %v", err)
	}
}

// Until the backfill has marked the table, the index can't be trusted: rows
// written before it existed are invisible to it. "Not yet" is re-read at most
// once per recheck window; "seeded" is permanent for the process.
func TestListTopLevelMessages_PendingUntilSeeded(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	recheckTopLevelMarker(t, time.Hour)

	ms := NewMessageStore(db)
	if _, _, err := ms.ListTopLevelMessages(ctx, "ch-p", "", 10); !errors.Is(err, ErrTopLevelIndexPending) {
		t.Fatalf("before the backfill: err = %v, want ErrTopLevelIndexPending", err)
	}
	if err := NewMessageStore(db).MarkTopLevelIndexSeeded(ctx); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ms.ListTopLevelMessages(ctx, "ch-p", "", 10); !errors.Is(err, ErrTopLevelIndexPending) {
		t.Fatalf("within the recheck window the cached answer stands: err = %v", err)
	}

	recheckTopLevelMarker(t, 0)
	if _, _, err := ms.ListTopLevelMessages(ctx, "ch-p", "", 10); err != nil {
		t.Fatalf("after the window the marker is re-read: %v", err)
	}
	if _, err := db.Client.DeleteItem(ctx, &dynamodb.DeleteItemInput{
		TableName: aws.String(db.Table),
		Key:       compositeKey(topLevelIndexSeededPK, metaSK()),
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ms.ListTopLevelMessages(ctx, "ch-p", "", 10); err != nil {
		t.Fatalf("seeded is cached for the process lifetime: %v", err)
	}
	if _, _, err := NewMessageStore(db).ListTopLevelMessages(ctx, "ch-p", "", 10); !errors.Is(err, ErrTopLevelIndexPending) {
		t.Fatalf("a fresh store re-reads the (now absent) marker: err = %v", err)
	}
}

// stripTopLevelIndex turns a row back into one written before the index
// existed.
func stripTopLevelIndex(t *testing.T, db *DB, parentID, msgID string) {
	t.Helper()
	if _, err := db.Client.UpdateItem(context.Background(), &dynamodb.UpdateItemInput{
		TableName:        aws.String(db.Table),
		Key:              compositeKey(parentPK(parentID), msgSK(msgID)),
		UpdateExpression: aws.String("REMOVE GSI2PK, GSI2SK"),
	}); err != nil {
		t.Fatal(err)
	}
}

func rawRow(t *testing.T, db *DB, pk, sk string) map[string]types.AttributeValue {
	t.Helper()
	out, err := db.Client.GetItem(context.Background(), &dynamodb.GetItemInput{
		TableName: aws.String(db.Table), Key: compositeKey(pk, sk), ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	return out.Item
}

func gsiValue(row map[string]types.AttributeValue, attr string) string {
	if v, ok := row[attr].(*types.AttributeValueMemberS); ok {
		return v.Value
	}
	return ""
}

// The backfill stamps every pre-index top-level row — in channels and
// conversations alike — leaves replies alone, previews without writing, and
// is idempotent; once marked, the legacy history is listed like new messages.
func TestBackfillTopLevelIndex(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	chTop := seedThreadedParent(t, ms, "ch-legacy", 3, 2)
	dmTop := seedThreadedParent(t, ms, DeriveDMConversationID("u1", "u2"), 2, 1)
	legacy := map[string][]string{"ch-legacy": chTop, DeriveDMConversationID("u1", "u2"): dmTop}
	for parent, ids := range legacy {
		for _, id := range ids {
			stripTopLevelIndex(t, db, parent, id)
		}
	}
	fresh := makeMessage("ch-legacy", NewID(), "u1", "after the deploy")
	if err := ms.CreateMessage(ctx, fresh); err != nil {
		t.Fatal(err)
	}

	preview, err := ms.BackfillTopLevelIndex(ctx, true, 4)
	if err != nil || preview != (TopLevelBackfill{Found: 5, Stamped: 5}) {
		t.Fatalf("dry run = %+v (err %v), want 5 found", preview, err)
	}
	if row := rawRow(t, db, parentPK("ch-legacy"), msgSK(chTop[0])); gsiValue(row, "GSI2PK") != "" {
		t.Fatal("dry run wrote")
	}

	done, err := ms.BackfillTopLevelIndex(ctx, false, 4)
	if err != nil || done != (TopLevelBackfill{Found: 5, Stamped: 5}) {
		t.Fatalf("apply = %+v (err %v), want 5 stamped", done, err)
	}
	for parent, ids := range legacy {
		for _, id := range ids {
			row := rawRow(t, db, parentPK(parent), msgSK(id))
			if gsiValue(row, "GSI2PK") != topLevelGSI2PK(parent) || gsiValue(row, "GSI2SK") != msgSK(id) {
				t.Fatalf("%s/%s not stamped: %v", parent, id, row)
			}
			if gsiValue(row, "body") != "root" {
				t.Fatalf("stamp touched more than the index keys: %v", row)
			}
		}
	}
	replies, _ := ms.ListThreadReplies(ctx, chTop[0])
	for _, r := range replies {
		if gsiValue(rawRow(t, db, parentPK("ch-legacy"), msgSK(r.ID)), "GSI2PK") != "" {
			t.Fatalf("reply %s stamped into the top-level index", r.ID)
		}
	}

	again, err := ms.BackfillTopLevelIndex(ctx, false, 4)
	if err != nil || again != (TopLevelBackfill{}) {
		t.Fatalf("second run = %+v (err %v), want nothing left", again, err)
	}

	if err := ms.MarkTopLevelIndexSeeded(ctx); err != nil {
		t.Fatal(err)
	}
	msgs, hasMore, err := ms.ListTopLevelMessages(ctx, "ch-legacy", "", 10)
	if err != nil || hasMore || len(msgs) != 4 || msgs[0].ID != fresh.ID || msgs[3].ID != chTop[0] {
		t.Fatalf("listed %d (hasMore=%v, err %v), want fresh + the 3 legacy roots", len(msgs), hasMore, err)
	}
}

// deleteBeforeUpdate hard-deletes the row an UpdateItem targets just before it
// runs — a message deleted between the backfill's scan and its stamp.
type deleteBeforeUpdate struct{ DynamoAPI }

func (d *deleteBeforeUpdate) UpdateItem(ctx context.Context, in *dynamodb.UpdateItemInput, o ...func(*dynamodb.Options)) (*dynamodb.UpdateItemOutput, error) {
	if _, err := d.DeleteItem(ctx, &dynamodb.DeleteItemInput{TableName: in.TableName, Key: in.Key}); err != nil {
		return nil, err
	}
	return d.DynamoAPI.UpdateItem(ctx, in, o...)
}

func TestBackfillTopLevelIndex_RacesAndFaults(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	ms := NewMessageStore(db)
	top := seedThreadedParent(t, ms, "ch-race", 1, 0)
	stripTopLevelIndex(t, db, "ch-race", top[0])

	if _, err := NewMessageStore(withFault(db, func(f *faultClient) { f.failScan = true })).BackfillTopLevelIndex(ctx, false, 2); !errors.Is(err, errInjected) {
		t.Fatalf("scan: want errInjected, got %v", err)
	}
	_, err := NewMessageStore(withFault(db, func(f *faultClient) { f.transformScan = corruptScan })).BackfillTopLevelIndex(ctx, false, 2)
	assertUnmarshalErr(t, err, "BackfillTopLevelIndex")
	res, err := NewMessageStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true })).BackfillTopLevelIndex(ctx, false, 2)
	if !errors.Is(err, errInjected) || res.Found != 1 || res.Stamped != 0 {
		t.Fatalf("stamp fault = %+v, %v; want errInjected with nothing stamped", res, err)
	}

	res, err = NewMessageStore(&DB{Client: &deleteBeforeUpdate{DynamoAPI: db.Client}, Table: db.Table}).BackfillTopLevelIndex(ctx, false, 0)
	if err != nil || res != (TopLevelBackfill{Found: 1, Gone: 1}) {
		t.Fatalf("deleted mid-run = %+v (err %v), want it counted as gone", res, err)
	}
	assertNoRow(t, db, parentPK("ch-race"), msgSK(top[0])) // not resurrected as a key-only stub
}
