//go:build integration

package store

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// putLegacyTaskRow writes a task the way every row was keyed before the
// active/done split: GSI1SK "TASK#<id>" whatever its state.
func putLegacyTaskRow(t *testing.T, db *DB, task *model.CodingTask) {
	t.Helper()
	it := NewTaskStore(db).item(task)
	it.GSI1SK = "TASK#" + task.ID
	av, err := attributevalue.MarshalMap(it)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Client.PutItem(context.Background(), &dynamodb.PutItemInput{TableName: aws.String(db.Table), Item: av}); err != nil {
		t.Fatal(err)
	}
}

// The dispatcher reads a project channel's tasks on EVERY top-level message,
// and that read returned every task the channel ever had. The active listing
// reads only live rows: terminal tasks are keyed out of it, and a legacy
// terminal row is re-keyed the first time it is seen, so it is read at most
// once more.
func TestTaskStore_ListActiveTasksByChannelReadsOnlyLiveRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	read := 0
	counted := withFault(db, func(f *faultClient) {
		f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
			read += len(o.Items)
			return o
		}
	})
	s := NewTaskStore(counted)

	live := mkCodingTaskFixture("t-live", "m-live")
	if err := s.CreateTask(ctx, live); err != nil {
		t.Fatal(err)
	}
	done := mkCodingTaskFixture("t-done", "m-done")
	done.State = model.TaskStateDone
	if err := s.CreateTask(ctx, done); err != nil {
		t.Fatal(err)
	}
	// A live task that finishes moves out of the active listing.
	closing := mkCodingTaskFixture("t-closing", "m-closing")
	if err := s.CreateTask(ctx, closing); err != nil {
		t.Fatal(err)
	}
	closing.State = model.TaskStateAbandoned
	if err := s.UpdateTask(ctx, closing, model.TaskStateCreated); err != nil {
		t.Fatal(err)
	}
	legacyDone := mkCodingTaskFixture("t-legacy-done", "m-legacy-done")
	legacyDone.State = model.TaskStateDone
	putLegacyTaskRow(t, db, legacyDone)
	legacyLive := mkCodingTaskFixture("t-legacy-live", "m-legacy-live")
	putLegacyTaskRow(t, db, legacyLive)

	read = 0
	got, err := s.ListActiveTasksByChannel(ctx, "ch-proj")
	if err != nil {
		t.Fatalf("active: %v", err)
	}
	if ids := taskIDs(got); len(ids) != 2 || ids[0] != "t-legacy-live" || ids[1] != "t-live" {
		t.Fatalf("active tasks = %v, want [t-legacy-live t-live]", ids)
	}
	if read != 3 { // two live rows + the not-yet-migrated legacy terminal row
		t.Fatalf("first active read touched %d rows, want 3", read)
	}
	read = 0
	if got, err = s.ListActiveTasksByChannel(ctx, "ch-proj"); err != nil || len(got) != 2 {
		t.Fatalf("second active read: %v %v", taskIDs(got), err)
	}
	if read != 2 {
		t.Fatalf("after migration the active read touched %d rows, want only the 2 live ones", read)
	}
	// The full history listing still has everything, in id order.
	all, err := s.ListTasksByChannel(ctx, "ch-proj")
	if err != nil {
		t.Fatal(err)
	}
	if ids := taskIDs(all); len(ids) != 5 || ids[0] != "t-closing" || ids[4] != "t-live" {
		t.Fatalf("all tasks = %v", ids)
	}
}

// A failed re-key leaves the legacy row where it was (read again next time);
// the listing itself still answers correctly.
func TestTaskStore_ListActiveTasksByChannelArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	legacyDone := mkCodingTaskFixture("t-legacy-done", "m-ld")
	legacyDone.State = model.TaskStateDone
	putLegacyTaskRow(t, db, legacyDone)

	s := NewTaskStore(withFault(db, func(f *faultClient) { f.failUpdateItem = true }))
	if got, err := s.ListActiveTasksByChannel(ctx, "ch-proj"); err != nil || len(got) != 0 {
		t.Fatalf("re-key failure: %v %v", taskIDs(got), err)
	}
	if _, err := NewTaskStore(withFault(db, func(f *faultClient) { f.failQuery = true })).ListActiveTasksByChannel(ctx, "ch-proj"); !errors.Is(err, errInjected) {
		t.Fatalf("query error: want errInjected, got %v", err)
	}
	corrupt := withFault(db, func(f *faultClient) { f.transformQuery = corruptQuery })
	_, err := NewTaskStore(corrupt).ListActiveTasksByChannel(ctx, "ch-proj")
	assertUnmarshalErr(t, err, "ListActiveTasksByChannel")
}

func taskIDs(ts []*model.CodingTask) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.ID)
	}
	return out
}
