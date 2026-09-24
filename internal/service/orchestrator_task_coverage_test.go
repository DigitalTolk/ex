package service

// Statement-coverage tests for orchestrator_task.go. Everything new here is
// prefixed otaskCov (helpers/types) or TestOtaskCov (tests); fixtures are
// reused from orchestrator_test.go / codingtask_test.go.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// otaskCovRegistry is a connectorRegistry with an injectable index/error, so
// withTaskConnectors' InstalledIndex failure branch is reachable (the shared
// stubConnectorRegistry never errors).
type otaskCovRegistry struct {
	idx []ConnectorIndexEntry
	err error
}

func (r *otaskCovRegistry) KnownSlugs(context.Context) (map[string]bool, error) {
	return map[string]bool{}, nil
}

func (r *otaskCovRegistry) InstalledIndex(context.Context, string) ([]ConnectorIndexEntry, error) {
	return r.idx, r.err
}

// otaskCovSeed plants a task like seedTask but lets the caller mutate it
// before it is stored (different requester/agent/state/thread).
func otaskCovSeed(t *testing.T, fx *taskFixture, mutate func(*model.CodingTask)) *model.CodingTask {
	t.Helper()
	task := &model.CodingTask{
		ID: "t1", ProjectKey: "booking-portal", ProjectName: "Booking Portal", Title: "Fix Feb-29 crash",
		Goal: "the picker throws on Feb 29", Kind: model.TaskKindBug, State: model.TaskStateInProgress,
		Steering: model.TaskSteeringRequester, ChannelID: "chan1", ThreadRootID: "card1",
		RequesterID: "u-alice", AgentID: testDevID,
		Repos: []model.TaskRepo{
			{Path: "dt/booking-portal-api", Role: model.RepoRoleBackend, BaseBranch: "main", Branch: "ex/task-abc-fix"},
		},
		CreatedAt: *fx.now, UpdatedAt: *fx.now,
	}
	if mutate != nil {
		mutate(task)
	}
	if err := fx.tasks.CreateTask(context.Background(), task); err != nil {
		t.Fatalf("otaskCovSeed: %v", err)
	}
	return task
}

// ---------------------------------------------------------------- StartTaskRun

func TestOtaskCov_StartTaskRunAgentErrors(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	task := fx.seedTask(model.TaskStateInProgress)
	alice, _ := fx.users.GetUser(ctx, "u-alice")
	msg := &model.Message{ID: "m-cov1", ParentID: "chan1", AuthorID: "u-alice", Body: "kick"}

	// Agent user missing → wrapped lookup error.
	ghost := *task
	ghost.AgentID = "u-ghost"
	if err := fx.orch.StartTaskRun(ctx, &ghost, alice, msg, "go"); err == nil || !strings.Contains(err.Error(), "task agent") {
		t.Fatalf("missing agent must fail the task run, got %v", err)
	}

	// AgentID resolving to a human → refused.
	human := *task
	human.AgentID = "u-alice"
	if err := fx.orch.StartTaskRun(ctx, &human, alice, msg, "go"); err == nil || !strings.Contains(err.Error(), "not an agent") {
		t.Fatalf("human task agent must be refused, got %v", err)
	}
}

// ---------------------------------------------------------------- dispatchTask

func TestOtaskCov_DispatchTaskNonTaskThreadAndEmptyChannel(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	fx.seedTask(model.TaskStateInProgress)
	alice, _ := fx.users.GetUser(ctx, "u-alice")

	// Entry guard: a nil author (system message) never routes to a task.
	fx.orch.dispatchTask(ctx, &model.Message{ID: "m-cov0", ParentID: "chan1", ParentMessageID: "card1",
		Body: "system"}, ParentChannel, nil, map[string]bool{})
	// A reply in a thread that is NOT a task thread: GetTaskByThread misses.
	fx.orch.dispatchTask(ctx, &model.Message{ID: "m-cov2", ParentID: "chan1", ParentMessageID: "not-a-card",
		AuthorID: "u-alice", Body: "unrelated thread"}, ParentChannel, alice, map[string]bool{})
	// A top-level message in a channel with no tasks at all.
	fx.orch.dispatchTask(ctx, &model.Message{ID: "m-cov3", ParentID: "chan-empty",
		AuthorID: "u-alice", Body: "hello"}, ParentChannel, alice, map[string]bool{})

	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 0 {
		t.Fatalf("non-task messages must start nothing, got %d runs", len(runs))
	}
}

func TestOtaskCov_DispatchTaskAmbiguousTopLevelDropped(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	fx.seedTask(model.TaskStateInProgress) // t1 in chan1
	otaskCovSeed(t, fx, func(c *model.CodingTask) {
		c.ID, c.ThreadRootID, c.Title = "t2", "card2", "Second task"
	})

	alice, _ := fx.users.GetUser(ctx, "u-alice")
	fx.orch.dispatchTask(ctx, &model.Message{ID: "m-cov4", ParentID: "chan1", AuthorID: "u-alice",
		Body: "which one is this for?"}, ParentChannel, alice, map[string]bool{})

	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 0 {
		t.Fatalf("ambiguous top-level steering must be dropped, got %d runs", len(runs))
	}
	if fx.msgs.lastPost() != "" {
		t.Fatalf("ambiguous routing must stay silent, posted %q", fx.msgs.lastPost())
	}
}

func TestOtaskCov_DispatchTaskTerminalTaskThreadIgnored(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	fx.seedTask(model.TaskStateDone)
	alice, _ := fx.users.GetUser(ctx, "u-alice")

	fx.orch.dispatchTask(ctx, &model.Message{ID: "m-cov5", ParentID: "chan1", ParentMessageID: "card1",
		AuthorID: "u-alice", Body: "one more thing"}, ParentChannel, alice, map[string]bool{})

	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 0 {
		t.Fatalf("a done task must not resume, got %d runs", len(runs))
	}
}

func TestOtaskCov_DispatchTaskAgentLookupFails(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	otaskCovSeed(t, fx, func(c *model.CodingTask) { c.AgentID = "u-ghost" })
	alice, _ := fx.users.GetUser(ctx, "u-alice")

	fx.orch.dispatchTask(ctx, &model.Message{ID: "m-cov6", ParentID: "chan1", ParentMessageID: "card1",
		AuthorID: "u-alice", Body: "steer"}, ParentChannel, alice, map[string]bool{})

	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 0 {
		t.Fatalf("unresolvable task agent must start nothing, got %d runs", len(runs))
	}
}

func TestOtaskCov_DispatchTaskRequesterLookupFails(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	// Steering=anyone lets bob steer, but the requester row is gone — the run
	// would have to execute as the requester, so it must be dropped.
	otaskCovSeed(t, fx, func(c *model.CodingTask) {
		c.RequesterID = "u-ghost"
		c.Steering = model.TaskSteeringAnyone
	})
	bob, _ := fx.users.GetUser(ctx, "u-bob")

	fx.orch.dispatchTask(ctx, &model.Message{ID: "m-cov7", ParentID: "chan1", ParentMessageID: "card1",
		AuthorID: "u-bob", Body: "steer"}, ParentChannel, bob, map[string]bool{})

	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 0 {
		t.Fatalf("missing requester must start nothing, got %d runs", len(runs))
	}
}

func TestOtaskCov_DispatchTaskInvokeFailurePosted(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	// Bob is the requester and has NO runner → invokeWith fails with
	// ErrAgentOffline (not busy) → the failure is posted in-thread.
	otaskCovSeed(t, fx, func(c *model.CodingTask) { c.RequesterID = "u-bob" })
	bob, _ := fx.users.GetUser(ctx, "u-bob")

	fx.orch.dispatchTask(ctx, &model.Message{ID: "m-cov8", ParentID: "chan1", ParentMessageID: "card1",
		AuthorID: "u-bob", Body: "please continue"}, ParentChannel, bob, map[string]bool{})

	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 0 {
		t.Fatalf("offline requester must queue nothing, got %d runs", len(runs))
	}
	if post := fx.msgs.lastPost(); !strings.Contains(post, "desktop") {
		t.Fatalf("invoke failure must be posted in-thread, got %q", post)
	}
}

// ---------------------------------------------------------- withTaskConnectors

func TestOtaskCov_WithTaskConnectors(t *testing.T) {
	fx := newOrchFixture(t)
	ctx := context.Background()

	// gitlab already picked → returned as-is, registry never consulted.
	fx.orch.SetConnectorRegistry(&otaskCovRegistry{err: errors.New("boom")})
	if got := fx.orch.withTaskConnectors(ctx, "u-alice", []string{"gitlab"}); len(got) != 1 || got[0] != "gitlab" {
		t.Fatalf("already-picked gitlab must pass through, got %v", got)
	}
	// InstalledIndex error → picks unchanged.
	if got := fx.orch.withTaskConnectors(ctx, "u-alice", []string{"jira"}); len(got) != 1 || got[0] != "jira" {
		t.Fatalf("index error must leave picks unchanged, got %v", got)
	}

	// gitlab installed → appended after the existing picks.
	fx.orch.SetConnectorRegistry(&otaskCovRegistry{idx: []ConnectorIndexEntry{{Slug: "jira"}, {Slug: "gitlab"}}})
	got := fx.orch.withTaskConnectors(ctx, "u-alice", []string{"jira"})
	if len(got) != 2 || got[0] != "jira" || got[1] != "gitlab" {
		t.Fatalf("installed gitlab must be appended, got %v", got)
	}

	// gitlab not installed → unchanged (nil stays nil).
	fx.orch.SetConnectorRegistry(&otaskCovRegistry{idx: []ConnectorIndexEntry{{Slug: "jira"}}})
	if got := fx.orch.withTaskConnectors(ctx, "u-alice", nil); got != nil {
		t.Fatalf("uninstalled gitlab must change nothing, got %v", got)
	}
}

// ---------------------------------------------------------------- taskForClaim

func TestOtaskCov_TaskForClaimLookupAndAffinity(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()

	// A plain chat run has no task to resolve.
	if task, err := fx.orch.taskForClaim(ctx, &model.Run{ID: "r-plain"}, "u-alice", "r1"); task != nil || err != nil {
		t.Fatalf("taskless run must resolve to (nil, nil), got %v %v", task, err)
	}

	// Task row gone → the run still executes, just with no spec.
	task, err := fx.orch.taskForClaim(ctx, &model.Run{ID: "r-x", TaskID: "nope"}, "u-alice", "r1")
	if task != nil || err != nil {
		t.Fatalf("missing task must degrade to (nil, nil), got %v %v", task, err)
	}

	// Pinned to ANOTHER runner that is still live → this machine must skip.
	seeded := fx.seedTask(model.TaskStateInProgress)
	seeded.RunnerID = "r2"
	if err := fx.tasks.UpdateTask(ctx, seeded, seeded.State); err != nil {
		t.Fatalf("pin: %v", err)
	}
	_ = fx.dir.PutRunner(ctx, &model.RunnerRegistration{
		RunnerID: "r2", OwnerID: "u-alice",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessClaude}},
		LeaseExpiresAt: time.Now().Add(time.Hour),
	})
	if _, err := fx.orch.taskForClaim(ctx, &model.Run{ID: "r-y", TaskID: "t1"}, "u-alice", "r1"); err == nil {
		t.Fatal("task pinned to a live runner must not be claimable elsewhere")
	}

	// Pinned to a DEAD runner → the pin releases and the claimer inherits.
	seeded.RunnerID = "r-dead"
	if err := fx.tasks.UpdateTask(ctx, seeded, seeded.State); err != nil {
		t.Fatalf("repin: %v", err)
	}
	task, err = fx.orch.taskForClaim(ctx, &model.Run{ID: "r-z", TaskID: "t1"}, "u-alice", "r1")
	if err != nil || task == nil || task.ID != "t1" {
		t.Fatalf("dead pin must release the task, got %v %v", task, err)
	}
}

// ----------------------------------------------------------------- pinTaskRun

func TestOtaskCov_PinTaskRunNoopTruncateAndUpdateFailure(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()

	// Same runner, run already recorded → nothing changes, no store write.
	task := fx.seedTask(model.TaskStateInProgress)
	task.RunnerID = "r1"
	task.RunIDs = []string{"run-1"}
	if err := fx.tasks.UpdateTask(ctx, task, task.State); err != nil {
		t.Fatalf("seed pin: %v", err)
	}
	fx.orch.pinTaskRun(ctx, task, &model.Run{ID: "run-1"}, "r1")
	if task.LastRunAt != nil || len(task.RunIDs) != 1 {
		t.Fatalf("no-op pin must not touch the task: %+v", task)
	}

	// The run-id ring keeps only the latest 50.
	ids := make([]string, 0, 50)
	for i := 0; i < 50; i++ {
		ids = append(ids, fmt.Sprintf("run-%d", i))
	}
	task.RunIDs = ids
	if err := fx.tasks.UpdateTask(ctx, task, task.State); err != nil {
		t.Fatalf("seed ring: %v", err)
	}
	fx.orch.pinTaskRun(ctx, task, &model.Run{ID: "run-new"}, "r1")
	if len(task.RunIDs) != 50 || task.RunIDs[49] != "run-new" || task.RunIDs[0] != "run-1" {
		t.Fatalf("run-id ring wrong: len=%d first=%q last=%q", len(task.RunIDs), task.RunIDs[0], task.RunIDs[49])
	}
	if task.LastRunAt == nil {
		t.Fatal("pin must stamp LastRunAt")
	}
	stored, _ := fx.tasks.GetTask(ctx, task.ID)
	if len(stored.RunIDs) != 50 {
		t.Fatalf("truncated ring not persisted: %d", len(stored.RunIDs))
	}

	// A store failure is logged, never fatal to the claim.
	ghost := &model.CodingTask{ID: "ghost", State: model.TaskStateInProgress}
	fx.orch.pinTaskRun(ctx, ghost, &model.Run{ID: "r-g"}, "r9")
	if ghost.RunnerID != "r9" {
		t.Fatalf("pin must still mutate the in-memory task, got %q", ghost.RunnerID)
	}
}

// ------------------------------------------------------------ spec + rendering

func TestOtaskCov_TaskSpecAndSectionRendering(t *testing.T) {
	now := time.Now()
	task := &model.CodingTask{
		ID: "t9", ProjectKey: "bp", ProjectName: "Booking Portal", Title: "Fix it", Goal: "g",
		Kind: model.TaskKindBug, State: model.TaskStateMRCreated, ChannelID: "chan1", ThreadRootID: "card1",
		SignedOffAt: &now, RunnerID: "r1",
		TestPlan: &model.TestPlan{URL: "http://localhost:3000/leaves"},
		Ticket:   &model.TaskTicket{Connector: "cliffhub", ID: "CH-7", URL: "http://ch/7"},
		Repos: []model.TaskRepo{
			{Path: "dt/api", Role: "backend", Branch: "ex/t", BaseBranch: "main", MRURL: "https://gl/-/merge_requests/1"},
		},
	}

	spec := taskSpecOf(task)
	if spec.TestURL != "http://localhost:3000/leaves" || !spec.SignedOff || spec.RunnerID != "r1" {
		t.Fatalf("spec wrong: %+v", spec)
	}
	if len(spec.Repos) != 1 || spec.Repos[0].MRURL != "https://gl/-/merge_requests/1" {
		t.Fatalf("spec repos wrong: %+v", spec.Repos)
	}

	section := renderTaskSection(task)
	for _, want := range []string{
		"Test plan published for: http://localhost:3000/leaves",
		"The requester has SIGNED OFF",
		"Ticket: cliffhub CH-7 http://ch/7",
		" — MR https://gl/-/merge_requests/1",
	} {
		if !strings.Contains(section, want) {
			t.Errorf("task section missing %q:\n%s", want, section)
		}
	}

	if got := mrSuffix(model.TaskRepo{}); got != "" {
		t.Fatalf("no MR must render nothing, got %q", got)
	}
	if got := renderProjectsIndex(nil); got != "" {
		t.Fatalf("no projects must render nothing, got %q", got)
	}
}
