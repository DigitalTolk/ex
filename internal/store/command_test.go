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

// The external slash-command store, against DynamoDB Local. Two invariants drive
// the layout and therefore these tests: a trigger word is globally unique (a
// duplicate would make dispatch ambiguous), and the full list is readable without
// a Scan on the shared table.

func commandFixture(id, trigger string) *model.ExternalCommand {
	now := time.Now().Truncate(time.Millisecond)
	return &model.ExternalCommand{
		ID:         id,
		Trigger:    trigger,
		Title:      trigger,
		RequestURL: "https://hooks.example.com/" + trigger,
		Method:     model.CommandMethodPost,
		Token:      "excmd_" + id,
		CreatedBy:  "admin-1",
		CreatedAt:  now,
		UpdatedAt:  now,
	}
}

func TestExternalCommandStore_CreateGetListDelete(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewExternalCommandStore(db)

	cmd := commandFixture("cmd-1", "deploy")
	if err := s.CreateCommand(ctx, cmd); err != nil {
		t.Fatalf("CreateCommand: %v", err)
	}

	got, err := s.GetCommand(ctx, "cmd-1")
	if err != nil {
		t.Fatalf("GetCommand: %v", err)
	}
	if got.Trigger != "deploy" || got.RequestURL != cmd.RequestURL || got.Token != cmd.Token {
		t.Errorf("GetCommand = %+v, want the stored row", got)
	}

	// The trigger claim resolves back to the same command.
	byTrigger, err := s.GetCommandByTrigger(ctx, "DEPLOY")
	if err != nil {
		t.Fatalf("GetCommandByTrigger: %v", err)
	}
	if byTrigger.ID != "cmd-1" {
		t.Errorf("GetCommandByTrigger = %q, want cmd-1 (lookup is case-insensitive)", byTrigger.ID)
	}

	// The directory row makes the list a keyed read, not a Scan.
	list, err := s.ListCommands(ctx)
	if err != nil {
		t.Fatalf("ListCommands: %v", err)
	}
	if !containsCommandID(list, "cmd-1") {
		t.Errorf("ListCommands = %+v, want it to include cmd-1", list)
	}

	if err := s.DeleteCommand(ctx, "cmd-1"); err != nil {
		t.Fatalf("DeleteCommand: %v", err)
	}
	if _, err := s.GetCommand(ctx, "cmd-1"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetCommand after delete: %v, want ErrNotFound", err)
	}
	// Deleting releases the trigger claim, so the word is immediately reusable.
	if _, err := s.GetCommandByTrigger(ctx, "deploy"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetCommandByTrigger after delete: %v, want ErrNotFound", err)
	}
	if err := s.CreateCommand(ctx, commandFixture("cmd-1b", "deploy")); err != nil {
		t.Errorf("re-claiming a released trigger failed: %v", err)
	}
	list, err = s.ListCommands(ctx)
	if err != nil {
		t.Fatalf("ListCommands: %v", err)
	}
	if containsCommandID(list, "cmd-1") {
		t.Error("the deleted command is still in the directory")
	}
}

func TestExternalCommandStore_DuplicateTriggerRejected(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewExternalCommandStore(db)

	if err := s.CreateCommand(ctx, commandFixture("cmd-dup-1", "status")); err != nil {
		t.Fatalf("CreateCommand: %v", err)
	}
	// The claim row is what enforces this, in the same transaction as the write.
	err := s.CreateCommand(ctx, commandFixture("cmd-dup-2", "status"))
	if !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("second create: %v, want ErrAlreadyExists", err)
	}
	// The loser left nothing behind.
	if _, err := s.GetCommand(ctx, "cmd-dup-2"); !errors.Is(err, ErrNotFound) {
		t.Errorf("the rejected command left a META row: %v", err)
	}
}

func TestExternalCommandStore_DuplicateIDRejected(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewExternalCommandStore(db)

	if err := s.CreateCommand(ctx, commandFixture("cmd-same", "aaa")); err != nil {
		t.Fatalf("CreateCommand: %v", err)
	}
	if err := s.CreateCommand(ctx, commandFixture("cmd-same", "bbb")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate id: %v, want ErrAlreadyExists", err)
	}
}

func TestExternalCommandStore_Update(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewExternalCommandStore(db)

	cmd := commandFixture("cmd-upd", "rollout")
	if err := s.CreateCommand(ctx, cmd); err != nil {
		t.Fatalf("CreateCommand: %v", err)
	}
	cmd.Description = "now with more rollout"
	cmd.RequestURL = "https://hooks.example.com/v2"
	if err := s.UpdateCommand(ctx, cmd); err != nil {
		t.Fatalf("UpdateCommand: %v", err)
	}
	got, err := s.GetCommand(ctx, "cmd-upd")
	if err != nil {
		t.Fatalf("GetCommand: %v", err)
	}
	if got.Description != "now with more rollout" || got.RequestURL != "https://hooks.example.com/v2" {
		t.Errorf("GetCommand = %+v, want the update applied", got)
	}
	// The trigger claim is untouched by an update.
	if byTrigger, err := s.GetCommandByTrigger(ctx, "rollout"); err != nil || byTrigger.ID != "cmd-upd" {
		t.Errorf("GetCommandByTrigger = (%+v, %v), want the claim intact", byTrigger, err)
	}
}

func TestExternalCommandStore_MissingRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewExternalCommandStore(db)

	if _, err := s.GetCommand(ctx, "cmd-absent"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetCommand: %v, want ErrNotFound", err)
	}
	if _, err := s.GetCommandByTrigger(ctx, "absent"); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetCommandByTrigger: %v, want ErrNotFound", err)
	}
	// A blank trigger is rejected without a round trip.
	if _, err := s.GetCommandByTrigger(ctx, "   "); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetCommandByTrigger(blank): %v, want ErrNotFound", err)
	}
	if err := s.UpdateCommand(ctx, commandFixture("cmd-absent", "x")); !errors.Is(err, ErrNotFound) {
		t.Errorf("UpdateCommand: %v, want ErrNotFound", err)
	}
	if err := s.DeleteCommand(ctx, "cmd-absent"); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteCommand: %v, want ErrNotFound", err)
	}
}

// With no directory row at all (nothing ever registered), the list is an empty
// slice — not an error and not nil, so the handler serializes [].
func TestExternalCommandStore_ListEmptyDirectory(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	// Force the "directory row absent" arm regardless of what other tests in this
	// shared table have registered.
	s := NewExternalCommandStore(withFault(db, func(f *faultClient) {
		f.transformGetItem = func(out *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
			out.Item = nil
			return out
		}
	}))
	list, err := s.ListCommands(ctx)
	if err != nil {
		t.Fatalf("ListCommands: %v", err)
	}
	if list == nil || len(list) != 0 {
		t.Errorf("ListCommands = %#v, want an empty non-nil slice", list)
	}
}

// --- SDK error arms --------------------------------------------------------
// These pin the non-condition error returns a healthy DynamoDB Local never
// produces, by routing one operation through a faultClient.

func TestExternalCommandStore_CreateTransactError(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewExternalCommandStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	err := s.CreateCommand(context.Background(), commandFixture("cmd-fault-create", "faultcreate"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("CreateCommand: want errInjected, got %v", err)
	}
}

func TestExternalCommandStore_UpdatePutItemError(t *testing.T) {
	db := setupDynamoDB(t)
	s := NewExternalCommandStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
	err := s.UpdateCommand(context.Background(), commandFixture("cmd-fault-update", "faultupdate"))
	if !errors.Is(err, errInjected) {
		t.Fatalf("UpdateCommand: want errInjected, got %v", err)
	}
}

func TestExternalCommandStore_GetItemError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewExternalCommandStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
	if _, err := s.GetCommand(ctx, "anything"); !errors.Is(err, errInjected) {
		t.Fatalf("GetCommand: want errInjected, got %v", err)
	}
	if _, err := s.GetCommandByTrigger(ctx, "anything"); !errors.Is(err, errInjected) {
		t.Fatalf("GetCommandByTrigger: want errInjected, got %v", err)
	}
	if _, err := s.ListCommands(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("ListCommands: want errInjected, got %v", err)
	}
	if err := s.DeleteCommand(ctx, "anything"); !errors.Is(err, errInjected) {
		t.Fatalf("DeleteCommand: want errInjected, got %v", err)
	}
}

func TestExternalCommandStore_DeleteTransactError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	real := NewExternalCommandStore(db)
	if err := real.CreateCommand(ctx, commandFixture("cmd-fault-del", "faultdelete")); err != nil {
		t.Fatalf("CreateCommand: %v", err)
	}
	s := NewExternalCommandStore(withFault(db, func(f *faultClient) { f.failTransactWriteItems = true }))
	if err := s.DeleteCommand(ctx, "cmd-fault-del"); !errors.Is(err, errInjected) {
		t.Fatalf("DeleteCommand: want errInjected, got %v", err)
	}
}

func TestExternalCommandStore_ListBatchGetError(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	real := NewExternalCommandStore(db)
	if err := real.CreateCommand(ctx, commandFixture("cmd-fault-list", "faultlist")); err != nil {
		t.Fatalf("CreateCommand: %v", err)
	}
	s := NewExternalCommandStore(withFault(db, func(f *faultClient) { f.failBatchGetItem = true }))
	if _, err := s.ListCommands(ctx); !errors.Is(err, errInjected) {
		t.Fatalf("ListCommands: want errInjected, got %v", err)
	}
}

// BatchGetItem may return UnprocessedKeys under throttling; the store must
// continue rather than silently drop those commands.
func TestExternalCommandStore_ListRetriesUnprocessedKeys(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	real := NewExternalCommandStore(db)
	if err := real.CreateCommand(ctx, commandFixture("cmd-unproc", "unproc")); err != nil {
		t.Fatalf("CreateCommand: %v", err)
	}

	first := true
	s := NewExternalCommandStore(withFault(db, func(f *faultClient) {
		f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
			if !first {
				out.UnprocessedKeys = nil
				return out
			}
			first = false
			// Withhold the rows on the first page and ask for the same keys again,
			// which is what DynamoDB does under throttling.
			deferred := out.Responses[db.Table]
			keys := make([]map[string]types.AttributeValue, 0, len(deferred))
			for _, row := range deferred {
				keys = append(keys, map[string]types.AttributeValue{"PK": row["PK"], "SK": row["SK"]})
			}
			out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {}}
			out.UnprocessedKeys = map[string]types.KeysAndAttributes{db.Table: {Keys: keys}}
			return out
		}
	}))
	list, err := s.ListCommands(ctx)
	if err != nil {
		t.Fatalf("ListCommands: %v", err)
	}
	if !containsCommandID(list, "cmd-unproc") {
		t.Error("a command deferred via UnprocessedKeys was dropped")
	}
}

func containsCommandID(list []*model.ExternalCommand, id string) bool {
	for _, c := range list {
		if c != nil && c.ID == id {
			return true
		}
	}
	return false
}

// Unmarshal error arms. A corrupt (or foreign-written) row is the runtime
// condition these branches guard, and a healthy DynamoDB Local never produces
// one — the transform hooks rewrite the real container's output into a row no
// store struct can absorb.

func TestExternalCommandStore_CorruptRowArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	corruptGet := withFault(db, func(f *faultClient) {
		f.transformGetItem = func(out *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
			out.Item = corruptRow()
			return out
		}
	})

	t.Run("GetCommand", func(t *testing.T) {
		_, err := NewExternalCommandStore(corruptGet).GetCommand(ctx, "cmd-corrupt")
		assertUnmarshalErr(t, err, "GetCommand")
	})

	t.Run("GetCommandByTrigger claim row", func(t *testing.T) {
		// The claim row is read first; a corrupt one must fail before the META read.
		_, err := NewExternalCommandStore(corruptGet).GetCommandByTrigger(ctx, "corrupt")
		assertUnmarshalErr(t, err, "GetCommandByTrigger")
	})

	t.Run("ListCommands directory row", func(t *testing.T) {
		// The directory row projects only `ids`, so the corruption has to hit that
		// field — an unknown attribute would simply be ignored.
		faulted := withFault(db, func(f *faultClient) {
			f.transformGetItem = func(out *dynamodb.GetItemOutput) *dynamodb.GetItemOutput {
				out.Item = map[string]types.AttributeValue{
					"ids": &types.AttributeValueMemberM{Value: map[string]types.AttributeValue{}},
				}
				return out
			}
		})
		_, err := NewExternalCommandStore(faulted).ListCommands(ctx)
		assertUnmarshalErr(t, err, "ListCommands directory")
	})

	t.Run("ListCommands batch page", func(t *testing.T) {
		real := NewExternalCommandStore(db)
		if err := real.CreateCommand(ctx, commandFixture("cmd-corrupt-list", "corruptlist")); err != nil {
			t.Fatalf("CreateCommand: %v", err)
		}
		faulted := withFault(db, func(f *faultClient) {
			f.transformBatchGetItem = func(out *dynamodb.BatchGetItemOutput) *dynamodb.BatchGetItemOutput {
				out.Responses = map[string][]map[string]types.AttributeValue{db.Table: {corruptRow()}}
				out.UnprocessedKeys = nil
				return out
			}
		})
		_, err := NewExternalCommandStore(faulted).ListCommands(ctx)
		assertUnmarshalErr(t, err, "ListCommands batch")
	})
}
