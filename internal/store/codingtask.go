package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/attributevalue"
	"github.com/aws/aws-sdk-go-v2/feature/dynamodb/expression"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
)

// Coding tasks (plan-coding-agent.md): one META row per task, indexed two
// ways — by project channel (the channel's task list, active-task checks) and
// by thread root (every reply in a task thread must resolve its task in one
// read; that is the hot path in OnMessage).

// ErrStaleTask is returned by conditional task transitions when the row no
// longer matches the state the caller observed.
var ErrStaleTask = errors.New("store: task state changed concurrently")

// TaskStore persists coding tasks.
type TaskStore struct {
	*DB
}

// NewTaskStore returns a TaskStore backed by the shared DB.
func NewTaskStore(db *DB) *TaskStore { return &TaskStore{DB: db} }

type taskItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI1PK string `dynamodbav:"GSI1PK"`
	GSI1SK string `dynamodbav:"GSI1SK"`
	GSI2PK string `dynamodbav:"GSI2PK,omitempty"`
	GSI2SK string `dynamodbav:"GSI2SK,omitempty"`
	model.CodingTask
}

func taskPK(id string) string                   { return "TASK#" + id }
func taskChannelGSI1PK(channelID string) string { return "TASKCHAN#" + channelID }
func taskGSI1SK(id string) string               { return "TASK#" + id }
func taskThreadGSI2PK(threadRootID string) string {
	return "TASKTHREAD#" + threadRootID
}

func (s *TaskStore) item(t *model.CodingTask) taskItem {
	it := taskItem{
		PK:         taskPK(t.ID),
		SK:         metaSK(),
		GSI1PK:     taskChannelGSI1PK(t.ChannelID),
		GSI1SK:     taskGSI1SK(t.ID),
		CodingTask: *t,
	}
	if t.ThreadRootID != "" {
		it.GSI2PK = taskThreadGSI2PK(t.ThreadRootID)
		it.GSI2SK = taskGSI1SK(t.ID)
	}
	return it
}

// CreateTask writes a new task; ErrAlreadyExists if the ID is taken.
func (s *TaskStore) CreateTask(ctx context.Context, t *model.CodingTask) error {
	if t.ID == "" || t.ChannelID == "" || t.RequesterID == "" {
		return errors.New("store: task id, channelID and requesterID required")
	}
	av := mustAttrs(attributevalue.MarshalMap(s.item(t)))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	}); err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create task: %w", err)
	}
	return nil
}

// GetTask fetches one task by ID.
func (s *TaskStore) GetTask(ctx context.Context, id string) (*model.CodingTask, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(taskPK(id), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get task: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var it taskItem
	if err := attributevalue.UnmarshalMap(out.Item, &it); err != nil {
		return nil, fmt.Errorf("store: unmarshal task: %w", err)
	}
	it.CodingTask.NormalizeLegacy()
	return &it.CodingTask, nil
}

// UpdateTask rewrites a task conditioned on the state the caller observed
// (optimistic concurrency, like runs): two writers racing a transition
// resolve to exactly one winner.
func (s *TaskStore) UpdateTask(ctx context.Context, t *model.CodingTask, expectState model.TaskState) error {
	av := mustAttrs(attributevalue.MarshalMap(s.item(t)))
	cond := expression.Name("state").Equal(expression.Value(string(expectState)))
	expr := mustExpr(expression.NewBuilder().WithCondition(cond).Build())
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:                 aws.String(s.Table),
		Item:                      av,
		ConditionExpression:       expr.Condition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	}); err != nil {
		if isConditionCheckFailed(err) {
			return ErrStaleTask
		}
		return fmt.Errorf("store: update task: %w", err)
	}
	return nil
}

// ListTasksByChannel returns every task in a project channel (any state).
func (s *TaskStore) ListTasksByChannel(ctx context.Context, channelID string) ([]*model.CodingTask, error) {
	keyCond := expression.Key("GSI1PK").Equal(expression.Value(taskChannelGSI1PK(channelID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI1"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list tasks by channel: %w", err)
	}
	out := make([]*model.CodingTask, 0, len(items))
	for _, raw := range items {
		var it taskItem
		if err := attributevalue.UnmarshalMap(raw, &it); err != nil {
			return nil, fmt.Errorf("store: unmarshal task: %w", err)
		}
		it.CodingTask.NormalizeLegacy()
		out = append(out, &it.CodingTask)
	}
	return out, nil
}

// GetTaskByThread resolves the task whose card roots the given thread.
// ErrNotFound when the thread is not a task thread.
func (s *TaskStore) GetTaskByThread(ctx context.Context, threadRootID string) (*model.CodingTask, error) {
	if threadRootID == "" {
		return nil, ErrNotFound
	}
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(taskThreadGSI2PK(threadRootID)))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	out, err := s.Client.Query(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
		Limit:                     aws.Int32(1),
	})
	if err != nil {
		return nil, fmt.Errorf("store: task by thread: %w", err)
	}
	if len(out.Items) == 0 {
		return nil, ErrNotFound
	}
	var it taskItem
	if err := attributevalue.UnmarshalMap(out.Items[0], &it); err != nil {
		return nil, fmt.Errorf("store: unmarshal task: %w", err)
	}
	it.CodingTask.NormalizeLegacy()
	return &it.CodingTask, nil
}

// ------------------------------------------------------------- projects

// Projects (products): PROJECT#<key>/META, listed via GSI2 ALL_CODEPROJECTS
// for the bundle's "known projects" index.

type projectItem struct {
	PK     string `dynamodbav:"PK"`
	SK     string `dynamodbav:"SK"`
	GSI2PK string `dynamodbav:"GSI2PK"`
	GSI2SK string `dynamodbav:"GSI2SK"`
	model.CodingProject
}

func projectPK(key string) string { return "CODEPROJECT#" + key }
func allProjectsGSI2PK() string   { return "ALL_CODEPROJECTS" }

func (s *TaskStore) projectItem(p *model.CodingProject) projectItem {
	return projectItem{
		PK:            projectPK(p.Key),
		SK:            metaSK(),
		GSI2PK:        allProjectsGSI2PK(),
		GSI2SK:        projectPK(p.Key),
		CodingProject: *p,
	}
}

// CreateProject writes a new project; ErrAlreadyExists if the key is taken.
func (s *TaskStore) CreateProject(ctx context.Context, p *model.CodingProject) error {
	if p.Key == "" || p.ChannelID == "" {
		return errors.New("store: project key and channelID required")
	}
	av := mustAttrs(attributevalue.MarshalMap(s.projectItem(p)))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName:           aws.String(s.Table),
		Item:                av,
		ConditionExpression: aws.String("attribute_not_exists(PK)"),
	}); err != nil {
		if isConditionCheckFailed(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("store: create project: %w", err)
	}
	return nil
}

// UpdateProject rewrites a project (last write wins — repo lists are small
// and edits are rare).
func (s *TaskStore) UpdateProject(ctx context.Context, p *model.CodingProject) error {
	av := mustAttrs(attributevalue.MarshalMap(s.projectItem(p)))
	if _, err := s.Client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.Table),
		Item:      av,
	}); err != nil {
		return fmt.Errorf("store: update project: %w", err)
	}
	return nil
}

// GetProject fetches one project by key.
func (s *TaskStore) GetProject(ctx context.Context, key string) (*model.CodingProject, error) {
	out, err := s.Client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: aws.String(s.Table),
		Key:       compositeKey(projectPK(key), metaSK()),
	})
	if err != nil {
		return nil, fmt.Errorf("store: get project: %w", err)
	}
	if out.Item == nil {
		return nil, ErrNotFound
	}
	var it projectItem
	if err := attributevalue.UnmarshalMap(out.Item, &it); err != nil {
		return nil, fmt.Errorf("store: unmarshal project: %w", err)
	}
	return &it.CodingProject, nil
}

// ListProjects returns every known project.
func (s *TaskStore) ListProjects(ctx context.Context) ([]*model.CodingProject, error) {
	keyCond := expression.Key("GSI2PK").Equal(expression.Value(allProjectsGSI2PK()))
	expr := mustExpr(expression.NewBuilder().WithKeyCondition(keyCond).Build())
	items, err := s.queryAll(ctx, &dynamodb.QueryInput{
		TableName:                 aws.String(s.Table),
		IndexName:                 aws.String("GSI2"),
		KeyConditionExpression:    expr.KeyCondition(),
		ExpressionAttributeNames:  expr.Names(),
		ExpressionAttributeValues: expr.Values(),
	})
	if err != nil {
		return nil, fmt.Errorf("store: list projects: %w", err)
	}
	out := make([]*model.CodingProject, 0, len(items))
	for _, raw := range items {
		var it projectItem
		if err := attributevalue.UnmarshalMap(raw, &it); err != nil {
			return nil, fmt.Errorf("store: unmarshal project: %w", err)
		}
		out = append(out, &it.CodingProject)
	}
	return out, nil
}
