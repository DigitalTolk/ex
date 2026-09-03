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

func mkCodingTaskFixture(id, threadRootID string) *model.CodingTask {
	return &model.CodingTask{
		ID:           id,
		ProjectKey:   "acme",
		ProjectName:  "Acme",
		Title:        "fix login",
		Goal:         "login button does nothing",
		Kind:         "bug",
		State:        model.TaskStateCreated,
		ChannelID:    "ch-proj",
		ThreadRootID: threadRootID,
		RequesterID:  "u-alice",
		AgentID:      "a-dev",
	}
}

func mkCodingProjectFixture(key string) *model.CodingProject {
	now := time.Now().Truncate(time.Millisecond).UTC()
	return &model.CodingProject{
		Key:       key,
		Name:      "Acme",
		ChannelID: "ch-proj",
		CreatedBy: "u-alice",
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func TestTaskStore_TaskLifecycle(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTaskStore(db)

	task := mkCodingTaskFixture("task-1", "m-root-1")
	if err := s.CreateTask(ctx, task); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.CreateTask(ctx, mkCodingTaskFixture("task-1", "m-root-1")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate create: want ErrAlreadyExists, got %v", err)
	}
	// A task without a thread root yet (card not posted) skips the GSI2 keys.
	if err := s.CreateTask(ctx, mkCodingTaskFixture("task-2", "")); err != nil {
		t.Fatalf("create no-thread: %v", err)
	}

	got, err := s.GetTask(ctx, "task-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Title != task.Title || got.State != model.TaskStateCreated {
		t.Fatalf("get mismatch: %+v", got)
	}
	if _, err := s.GetTask(ctx, "task-absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get absent: want ErrNotFound, got %v", err)
	}

	// Optimistic transition: exactly one writer wins from an observed state.
	got.State = model.TaskStateInProgress
	if err := s.UpdateTask(ctx, got, model.TaskStateCreated); err != nil {
		t.Fatalf("update: %v", err)
	}
	stale := *got
	stale.State = model.TaskStateMRCreated
	if err := s.UpdateTask(ctx, &stale, model.TaskStateCreated); !errors.Is(err, ErrStaleTask) {
		t.Fatalf("stale update: want ErrStaleTask, got %v", err)
	}

	byChan, err := s.ListTasksByChannel(ctx, "ch-proj")
	if err != nil {
		t.Fatalf("list by channel: %v", err)
	}
	if len(byChan) != 2 {
		t.Fatalf("list by channel: want 2, got %d", len(byChan))
	}

	byThread, err := s.GetTaskByThread(ctx, "m-root-1")
	if err != nil {
		t.Fatalf("by thread: %v", err)
	}
	if byThread.ID != "task-1" {
		t.Fatalf("by thread: want task-1, got %s", byThread.ID)
	}
	if _, err := s.GetTaskByThread(ctx, ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("by empty thread: want ErrNotFound, got %v", err)
	}
	if _, err := s.GetTaskByThread(ctx, "m-not-a-task"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("by non-task thread: want ErrNotFound, got %v", err)
	}
}

func TestTaskStore_Task_Validation(t *testing.T) {
	db := setupDynamoDB(t)
	if err := NewTaskStore(db).CreateTask(context.Background(), &model.CodingTask{ID: "t"}); err == nil {
		t.Fatal("create without channel/requester: want error")
	}
}

func TestTaskStore_ProjectLifecycle(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	s := NewTaskStore(db)

	p := mkCodingProjectFixture("acme")
	if err := s.CreateProject(ctx, p); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := s.CreateProject(ctx, mkCodingProjectFixture("acme")); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate project: want ErrAlreadyExists, got %v", err)
	}
	if err := s.CreateProject(ctx, &model.CodingProject{Key: "half"}); err == nil {
		t.Fatal("create without channelID: want error")
	}

	p.Name = "Acme Corp"
	if err := s.UpdateProject(ctx, p); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, err := s.GetProject(ctx, "acme")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got.Name != "Acme Corp" {
		t.Fatalf("update not persisted: %+v", got)
	}
	if _, err := s.GetProject(ctx, "absent"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get absent: want ErrNotFound, got %v", err)
	}

	if err := s.CreateProject(ctx, mkCodingProjectFixture("beta")); err != nil {
		t.Fatalf("create beta: %v", err)
	}
	all, err := s.ListProjects(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("list: want 2 projects, got %d", len(all))
	}
}

func TestTaskStore_SDKErrorArms(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()

	t.Run("CreateTask PutItemError", func(t *testing.T) {
		s := NewTaskStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.CreateTask(ctx, mkCodingTaskFixture("t-e", "m-e")); !errors.Is(err, errInjected) {
			t.Fatalf("CreateTask: want errInjected, got %v", err)
		}
	})
	t.Run("GetTask GetItemError", func(t *testing.T) {
		s := NewTaskStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetTask(ctx, "t-e"); !errors.Is(err, errInjected) {
			t.Fatalf("GetTask: want errInjected, got %v", err)
		}
	})
	t.Run("UpdateTask PutItemError", func(t *testing.T) {
		s := NewTaskStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.UpdateTask(ctx, mkCodingTaskFixture("t-e", "m-e"), model.TaskStateCreated); !errors.Is(err, errInjected) {
			t.Fatalf("UpdateTask: want errInjected, got %v", err)
		}
	})
	t.Run("ListTasksByChannel QueryError", func(t *testing.T) {
		s := NewTaskStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListTasksByChannel(ctx, "ch-e"); !errors.Is(err, errInjected) {
			t.Fatalf("ListTasksByChannel: want errInjected, got %v", err)
		}
	})
	t.Run("GetTaskByThread QueryError", func(t *testing.T) {
		s := NewTaskStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.GetTaskByThread(ctx, "m-e"); !errors.Is(err, errInjected) {
			t.Fatalf("GetTaskByThread: want errInjected, got %v", err)
		}
	})
	t.Run("CreateProject PutItemError", func(t *testing.T) {
		s := NewTaskStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.CreateProject(ctx, mkCodingProjectFixture("p-e")); !errors.Is(err, errInjected) {
			t.Fatalf("CreateProject: want errInjected, got %v", err)
		}
	})
	t.Run("UpdateProject PutItemError", func(t *testing.T) {
		s := NewTaskStore(withFault(db, func(f *faultClient) { f.failPutItem = true }))
		if err := s.UpdateProject(ctx, mkCodingProjectFixture("p-e")); !errors.Is(err, errInjected) {
			t.Fatalf("UpdateProject: want errInjected, got %v", err)
		}
	})
	t.Run("GetProject GetItemError", func(t *testing.T) {
		s := NewTaskStore(withFault(db, func(f *faultClient) { f.failGetItem = true }))
		if _, err := s.GetProject(ctx, "p-e"); !errors.Is(err, errInjected) {
			t.Fatalf("GetProject: want errInjected, got %v", err)
		}
	})
	t.Run("ListProjects QueryError", func(t *testing.T) {
		s := NewTaskStore(withFault(db, func(f *faultClient) { f.failQuery = true }))
		if _, err := s.ListProjects(ctx); !errors.Is(err, errInjected) {
			t.Fatalf("ListProjects: want errInjected, got %v", err)
		}
	})
}

func TestTaskStore_CorruptRows(t *testing.T) {
	db := setupDynamoDB(t)
	ctx := context.Background()
	corruptQ := func(f *faultClient) {
		f.transformQuery = func(o *dynamodb.QueryOutput) *dynamodb.QueryOutput {
			o.Items = []map[string]types.AttributeValue{corruptRow()}
			return o
		}
	}

	t.Run("GetTask", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })
		_, err := NewTaskStore(faulted).GetTask(ctx, "t-x")
		assertUnmarshalErr(t, err, "GetTask")
	})
	t.Run("GetProject", func(t *testing.T) {
		faulted := withFault(db, func(f *faultClient) { f.transformGetItem = corruptGetItem })
		_, err := NewTaskStore(faulted).GetProject(ctx, "p-x")
		assertUnmarshalErr(t, err, "GetProject")
	})
	t.Run("ListTasksByChannel", func(t *testing.T) {
		_, err := NewTaskStore(withFault(db, corruptQ)).ListTasksByChannel(ctx, "ch-x")
		assertUnmarshalErr(t, err, "ListTasksByChannel")
	})
	t.Run("GetTaskByThread", func(t *testing.T) {
		_, err := NewTaskStore(withFault(db, corruptQ)).GetTaskByThread(ctx, "m-x")
		assertUnmarshalErr(t, err, "GetTaskByThread")
	})
	t.Run("ListProjects", func(t *testing.T) {
		_, err := NewTaskStore(withFault(db, corruptQ)).ListProjects(ctx)
		assertUnmarshalErr(t, err, "ListProjects")
	})
}
