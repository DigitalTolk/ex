//go:build integration

package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

// unprocessedDynamo hands back the first item of each BatchWriteItem call as
// unprocessed `keep` times (simulating throttling), then forwards normally.
type unprocessedDynamo struct {
	DynamoAPI
	keep  int
	calls int
	err   error
}

func (u *unprocessedDynamo) BatchWriteItem(ctx context.Context, in *dynamodb.BatchWriteItemInput, o ...func(*dynamodb.Options)) (*dynamodb.BatchWriteItemOutput, error) {
	u.calls++
	if u.err != nil {
		return nil, u.err
	}
	if u.keep > 0 {
		u.keep--
		for table, reqs := range in.RequestItems {
			head, rest := reqs[:1], reqs[1:]
			if len(rest) > 0 {
				if _, err := u.DynamoAPI.BatchWriteItem(ctx, &dynamodb.BatchWriteItemInput{
					RequestItems: map[string][]types.WriteRequest{table: rest},
				}, o...); err != nil {
					return nil, err
				}
			}
			return &dynamodb.BatchWriteItemOutput{UnprocessedItems: map[string][]types.WriteRequest{table: head}}, nil
		}
	}
	return u.DynamoAPI.BatchWriteItem(ctx, in, o...)
}

func fastRetries(t *testing.T, attempts int) {
	t.Helper()
	base, maxWait, n := batchRetryBase, batchRetryMax, batchRetryAttempts
	batchRetryBase, batchRetryMax, batchRetryAttempts = time.Millisecond, 2*time.Millisecond, attempts
	t.Cleanup(func() { batchRetryBase, batchRetryMax, batchRetryAttempts = base, maxWait, n })
}

func bulkMessages(parent string, n int) []*model.Message {
	at := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	out := make([]*model.Message, n)
	for i := range out {
		out[i] = &model.Message{ID: NewID() + string(rune('A'+i%26)), ParentID: parent, AuthorID: "u1", Body: "m", CreatedAt: at}
	}
	out[n-1].ParentMessageID = out[0].ID // one reply → thread index row
	return out
}

func TestPutNewMessages_BatchesAndDrainsUnprocessed(t *testing.T) {
	fastRetries(t, 10)
	db := setupDynamoDB(t)
	ctx := context.Background()
	u := &unprocessedDynamo{DynamoAPI: db.Client, keep: 3}
	ms := NewMessageStore(&DB{Client: u, Table: db.Table})
	msgs := bulkMessages("chan-bulk", 60) // 3 chunks of ≤25
	if err := ms.PutNewMessages(ctx, msgs); err != nil {
		t.Fatal(err)
	}
	got, _, err := NewMessageStore(db).ListMessages(ctx, "chan-bulk", "", 100)
	if err != nil || len(got) != 60 {
		t.Fatalf("listed %d messages, %v", len(got), err)
	}
	replies, err := NewMessageStore(db).ListThreadReplies(ctx, msgs[0].ID)
	if err != nil || len(replies) != 1 {
		t.Fatalf("thread index: %d replies, %v", len(replies), err)
	}
	if u.calls != 3+3 { // 3 chunks + 3 retries of an unprocessed item
		t.Fatalf("calls = %d", u.calls)
	}
}

func TestPutNewMessages_Errors(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	fastRetries(t, 2)
	exhausted := NewMessageStore(&DB{Client: &unprocessedDynamo{DynamoAPI: db.Client, keep: 5}, Table: db.Table})
	if err := exhausted.PutNewMessages(ctx, bulkMessages("c-x", 3)); err == nil || !strings.Contains(err.Error(), "unprocessed after 2 attempts") {
		t.Fatalf("exhausted: %v", err)
	}

	boom := errors.New("boom")
	failing := NewMessageStore(&DB{Client: &unprocessedDynamo{DynamoAPI: db.Client, err: boom}, Table: db.Table})
	if err := failing.PutNewMessages(ctx, bulkMessages("c-y", 2)); !errors.Is(err, boom) {
		t.Fatalf("client error: %v", err)
	}

	fastRetries(t, 10)
	batchRetryBase = time.Hour // the wait is interrupted by cancellation
	cctx, cancel := context.WithCancel(ctx)
	waiting := NewMessageStore(&DB{Client: &unprocessedDynamo{DynamoAPI: db.Client, keep: 1}, Table: db.Table})
	go func() { time.Sleep(20 * time.Millisecond); cancel() }()
	if err := waiting.PutNewMessages(cctx, bulkMessages("c-z", 2)); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled: %v", err)
	}
}

func TestSetIndexRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	pi := NewParentIndexStore(db)
	at := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	err := pi.SetIndexRows(ctx,
		[]PinIndexEntry{{ParentID: "p1", MessageID: "m1", PinnedBy: "u1", PinnedAt: at}},
		[]FileIndexEntry{
			{ParentID: "p1", AttachmentID: "a1", MessageID: "m1", AuthorID: "u1", CreatedAt: at},
			{ParentID: "p1", AttachmentID: "a2", MessageID: "m1", AuthorID: "u1", CreatedAt: at},
			{ParentID: "p1", AttachmentID: "a1", MessageID: "m2", AuthorID: "u2", CreatedAt: at.Add(time.Minute)}, // same file again: last wins
		})
	if err != nil {
		t.Fatal(err)
	}
	pins, _ := pi.ListPinIndex(ctx, "p1")
	files, _ := pi.ListFileIndex(ctx, "p1")
	if len(pins) != 1 || pins[0].PinnedBy != "u1" || len(files) != 2 {
		t.Fatalf("pins=%+v files=%d", pins, len(files))
	}
	for _, f := range files {
		if f.AttachmentID == "a1" && (f.MessageID != "m2" || f.AuthorID != "u2") {
			t.Fatalf("duplicate file must keep the last entry: %+v", f)
		}
	}
	if err := pi.SetIndexRows(ctx, nil, []FileIndexEntry{{ParentID: "p1"}}); err == nil {
		t.Fatal("empty attachment ID must fail")
	}
	if err := pi.SetIndexRows(ctx, nil, nil); err != nil {
		t.Fatalf("empty input: %v", err)
	}
	broken := NewParentIndexStore(&DB{Client: &unprocessedDynamo{DynamoAPI: db.Client, err: errors.New("down")}, Table: db.Table})
	if err := broken.SetIndexRows(ctx, []PinIndexEntry{{ParentID: "p1", MessageID: "m9", PinnedAt: at}}, nil); err == nil {
		t.Fatal("client error must surface")
	}
}
