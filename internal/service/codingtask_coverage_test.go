package service

// Coverage companions for codingtask.go: the error arms, validation rejects
// and best-effort branches the main suite leaves untouched. Reuses the
// taskFixture fakes; every new identifier is ctaskCov-prefixed.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// ---------------------------------------------------------- failing fakes

// ctaskCovStore wraps the in-memory task store with on-demand failures.
type ctaskCovStore struct {
	*fakeTaskStore
	getProjectErr    error
	updateProjectErr error
	createProjectErr error
	listErr          error
	createTaskErr    error
	updateTaskErr    error
}

func (s *ctaskCovStore) GetProject(ctx context.Context, key string) (*model.CodingProject, error) {
	if s.getProjectErr != nil {
		return nil, s.getProjectErr
	}
	return s.fakeTaskStore.GetProject(ctx, key)
}

func (s *ctaskCovStore) UpdateProject(ctx context.Context, p *model.CodingProject) error {
	if s.updateProjectErr != nil {
		return s.updateProjectErr
	}
	return s.fakeTaskStore.UpdateProject(ctx, p)
}

func (s *ctaskCovStore) CreateProject(ctx context.Context, p *model.CodingProject) error {
	if s.createProjectErr != nil {
		return s.createProjectErr
	}
	return s.fakeTaskStore.CreateProject(ctx, p)
}

func (s *ctaskCovStore) ListTasksByChannel(ctx context.Context, channelID string) ([]*model.CodingTask, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	return s.fakeTaskStore.ListTasksByChannel(ctx, channelID)
}

func (s *ctaskCovStore) CreateTask(ctx context.Context, t *model.CodingTask) error {
	if s.createTaskErr != nil {
		return s.createTaskErr
	}
	return s.fakeTaskStore.CreateTask(ctx, t)
}

func (s *ctaskCovStore) UpdateTask(ctx context.Context, t *model.CodingTask, expect model.TaskState) error {
	if s.updateTaskErr != nil {
		return s.updateTaskErr
	}
	return s.fakeTaskStore.UpdateTask(ctx, t, expect)
}

// ctaskCovChans wraps the channel fake with failures and a create race.
type ctaskCovChans struct {
	*fakeTaskChannels
	getByIDErr   error
	getByIDCalls int
	// raceChannel simulates a lost create race: the first GetByID misses,
	// every later one returns this channel (someone else created it).
	raceChannel *model.Channel
	createErr   error
	joinErr     map[string]error
}

func (c *ctaskCovChans) GetByID(ctx context.Context, id string) (*model.Channel, error) {
	c.getByIDCalls++
	if c.getByIDErr != nil {
		return nil, c.getByIDErr
	}
	if c.raceChannel != nil {
		if c.getByIDCalls == 1 {
			return nil, store.ErrNotFound
		}
		return c.raceChannel, nil
	}
	return c.fakeTaskChannels.GetByID(ctx, id)
}

func (c *ctaskCovChans) CreateWithID(ctx context.Context, userID, id, name string, chanType model.ChannelType, description string) (*model.Channel, error) {
	if c.createErr != nil {
		return nil, c.createErr
	}
	return c.fakeTaskChannels.CreateWithID(ctx, userID, id, name, chanType, description)
}

func (c *ctaskCovChans) AutoJoinChannel(ctx context.Context, userID, channelID string, role model.ChannelRole) error {
	if err := c.joinErr[userID]; err != nil {
		return err
	}
	return c.fakeTaskChannels.AutoJoinChannel(ctx, userID, channelID, role)
}

// ctaskCovMsgs wraps the message fake with per-surface failures.
type ctaskCovMsgs struct {
	*fakeTaskMessages
	sendErr            error
	failSendContaining string // when set, only bodies containing this fail
	pinErr             error
	rewriteErr         error
	accessErr          error
}

func (m *ctaskCovMsgs) SendAsAgentRun(ctx context.Context, agentID, invokerID, parentID, parentType, body, parentMessageID, runID string) (*model.Message, error) {
	if m.sendErr != nil && (m.failSendContaining == "" || strings.Contains(body, m.failSendContaining)) {
		return nil, m.sendErr
	}
	return m.fakeTaskMessages.SendAsAgentRun(ctx, agentID, invokerID, parentID, parentType, body, parentMessageID, runID)
}

func (m *ctaskCovMsgs) SetPinned(ctx context.Context, userID, parentID, parentType, msgID string, pinned bool) (*model.Message, error) {
	if m.pinErr != nil {
		return nil, m.pinErr
	}
	return m.fakeTaskMessages.SetPinned(ctx, userID, parentID, parentType, msgID, pinned)
}

func (m *ctaskCovMsgs) RewriteAgentMessage(ctx context.Context, agentID, parentID, parentType, msgID, body string) (*model.Message, error) {
	if m.rewriteErr != nil {
		return nil, m.rewriteErr
	}
	return m.fakeTaskMessages.RewriteAgentMessage(ctx, agentID, parentID, parentType, msgID, body)
}

func (m *ctaskCovMsgs) CheckAccess(ctx context.Context, userID, parentID, parentType string) error {
	if m.accessErr != nil {
		return m.accessErr
	}
	return m.fakeTaskMessages.CheckAccess(ctx, userID, parentID, parentType)
}

// ---------------------------------------------------------------- fixture

type ctaskCovFixture struct {
	*taskFixture
	store *ctaskCovStore
	chns  *ctaskCovChans
	msgs2 *ctaskCovMsgs
}

// newCtaskCovFixture is newTaskFixture with the service rebuilt on failing
// wrappers (the orchestrator keeps the plain inner fakes).
func newCtaskCovFixture(t *testing.T) *ctaskCovFixture {
	t.Helper()
	fx := newTaskFixture(t)
	st := &ctaskCovStore{fakeTaskStore: fx.tasks}
	ch := &ctaskCovChans{fakeTaskChannels: fx.chans, joinErr: map[string]error{}}
	ms := &ctaskCovMsgs{fakeTaskMessages: fx.tmsgs}
	svc := NewCodingTaskService(st, ch, ms, fx.users, fx.orch.agentSvc, fx.orch)
	svc.SetBaseURL("http://ex.test")
	svc.now = fx.orch.now
	fx.svc = svc
	return &ctaskCovFixture{taskFixture: fx, store: st, chns: ch, msgs2: ms}
}

// ctaskCovSeedTask plants a task with its own channel/thread ids.
func ctaskCovSeedTask(t *testing.T, fx *ctaskCovFixture, id string, state model.TaskState, requesterID string) *model.CodingTask {
	t.Helper()
	task := &model.CodingTask{
		ID: id, ProjectKey: "portal", ProjectName: "Portal", Title: "T", Goal: "g",
		Kind: model.TaskKindBug, State: state, Steering: model.TaskSteeringRequester,
		ChannelID: "chan-" + id, ThreadRootID: "card-" + id, RequesterID: requesterID, AgentID: testDevID,
		Repos: []model.TaskRepo{{Path: "g/r", Role: model.RepoRoleBackend, BaseBranch: "main", Branch: "ex/task-" + id}},
	}
	if err := fx.tasks.CreateTask(context.Background(), task); err != nil {
		t.Fatal(err)
	}
	return task
}

// ------------------------------------------------------------ pure helpers

func TestCtaskCovTaskURLAndPureHelpers(t *testing.T) {
	if got := (&CodingTaskService{}).TaskURL(&model.CodingTask{ChannelID: "c", ThreadRootID: "m"}); got != "" {
		t.Fatalf("no base URL must mean no link, got %q", got)
	}

	for _, bad := range []string{"has space", "a..b", strings.Repeat("b", model.TaskBranchMaxLen+1)} {
		if err := validBranchName(bad); !errors.Is(err, ErrValidation) {
			t.Fatalf("branch %q must be rejected, got %v", bad, err)
		}
	}

	long := taskBranch(&model.CodingTask{ID: "abcdef123456", Title: strings.Repeat("word-", 40)})
	if len(long) > model.TaskBranchMaxLen || !strings.HasPrefix(long, "ex/task-123456-") {
		t.Fatalf("long branch must be clipped, got %q (%d)", long, len(long))
	}

	if primaryBranch(&model.CodingTask{}) != "" {
		t.Fatal("no repos must mean no primary branch")
	}

	if got := invokeFailureDetail(fmt.Errorf("%w: gg isn't reachable", ErrAgentOffline)); got != "gg isn't reachable." {
		t.Fatalf("offline detail = %q", got)
	}
	if got := invokeFailureDetail(ErrAgentOffline); got != "your ex desktop app isn't online." {
		t.Fatalf("bare offline detail = %q", got)
	}
	if got := invokeFailureDetail(ErrAgentBusy); got != "dev is already busy in this thread." {
		t.Fatalf("busy detail = %q", got)
	}
	if got := invokeFailureDetail(errors.New("boom")); got != "the run couldn't start." {
		t.Fatalf("fallback detail = %q", got)
	}

	if got := cleanSteps([]string{" ", "", " a "}); len(got) != 1 || got[0] != "a" {
		t.Fatalf("cleanSteps = %v", got)
	}
	if looksLikeAPIOnly(model.TestPlan{}) {
		t.Fatal("an empty plan must not read as API-only")
	}

	sum := MRApprovalSummary(&model.CodingTask{ID: "t9", ProjectName: "P", Title: "T", Repos: []model.TaskRepo{{Path: "g/r", Branch: "ex/task-1"}}})
	if !strings.Contains(sum, "t9") || !strings.Contains(sum, "ex/task-1") {
		t.Fatalf("approval summary = %q", sum)
	}
}

func TestCtaskCovNormalizeRepos(t *testing.T) {
	out, err := normalizeRepos([]RepoInput{{Path: " / "}, {Path: "g/r"}, {Path: "g/r/"}}, "")
	if err != nil || len(out) != 1 || out[0].Path != "g/r" || out[0].Role != model.RepoRoleOther {
		t.Fatalf("blank/dup handling wrong: %+v %v", out, err)
	}
	if _, err := normalizeRepos([]RepoInput{{Path: "noslash"}}, ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("bad path must be rejected, got %v", err)
	}
	if _, err := normalizeRepos([]RepoInput{{Path: "g/r", Role: "boss"}}, ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("bad role must be rejected, got %v", err)
	}
	if _, err := normalizeRepos([]RepoInput{{Path: "g/r", BaseBranch: "a b"}}, ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("bad per-repo base branch must be rejected, got %v", err)
	}
	var many []RepoInput
	for i := 0; i <= model.TaskMaxRepos; i++ {
		many = append(many, RepoInput{Path: fmt.Sprintf("g/r%d", i)})
	}
	if _, err := normalizeRepos(many, ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("too many repos must be rejected, got %v", err)
	}
}

func TestCtaskCovLifecycleNotes(t *testing.T) {
	fx := newCtaskCovFixture(t)
	base := &model.CodingTask{Repos: []model.TaskRepo{{Path: "g/r", Branch: "ex/task-1", MRURL: "https://gitlab/x/-/merge_requests/2"}}}
	at := func(s model.TaskState) *model.CodingTask { cp := *base; cp.State = s; return &cp }

	if got := fx.svc.lifecycleNote(at(model.TaskStateInProgress), model.TaskStateInProgress, TaskUpdate{}); got != "" {
		t.Fatalf("same state and no note must say nothing, got %q", got)
	}
	wants := map[model.TaskState]string{
		model.TaskStateWorkspaceReady: "Workspace ready",
		model.TaskStateInProgress:     "Working on it",
		model.TaskStateSetupFailed:    "Setup failed",
		model.TaskStateDone:           "Done",
		model.TaskStateAbandoned:      "Task abandoned",
	}
	for state, want := range wants {
		if got := fx.svc.lifecycleNote(at(state), model.TaskStateCreated, TaskUpdate{}); !strings.Contains(got, want) {
			t.Fatalf("%s note = %q, want it to contain %q", state, got, want)
		}
	}
	if got := fx.svc.lifecycleNote(at(model.TaskStateCreated), model.TaskStateSetupFailed, TaskUpdate{}); got != "" {
		t.Fatalf("created has no standard line, got %q", got)
	}
}

func TestCtaskCovTestPlanNoteNotes(t *testing.T) {
	fx := newCtaskCovFixture(t)
	task := fx.seedTask(model.TaskStateAwaitingTest)
	task.TestPlan = &model.TestPlan{
		URL: "http://localhost:3000", Steps: []string{"open it"}, CounterSteps: []string{"no crash"},
		Accounts: "hr1", Notes: "seed the db first",
	}
	note := fx.svc.testPlanNote(task)
	for _, want := range []string{"Ready to test", "hr1", "open it", "no crash", "seed the db first"} {
		if !strings.Contains(note, want) {
			t.Fatalf("test-plan note missing %q:\n%s", want, note)
		}
	}
}

// ------------------------------------------------------------------ Create

func TestCtaskCovCreateValidation(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	run := &model.Run{ID: "ctaskcov-vrun", InvokerID: "u-alice", ParentID: "chan-general", ParentType: ParentChannel, MessageID: "cc-v"}
	base := CreateTaskInput{Project: "Portal", Repos: []RepoInput{{Path: "g/r"}}, Title: "T", Goal: "g"}
	cases := []struct {
		name string
		mut  func(in *CreateTaskInput)
	}{
		{"empty project", func(in *CreateTaskInput) { in.Project = "" }},
		{"project name over cap", func(in *CreateTaskInput) { in.Project = strings.Repeat("p", model.TaskProjectNameMaxLen+1) }},
		{"unusable key", func(in *CreateTaskInput) { in.Project = "---" }},
		{"empty title", func(in *CreateTaskInput) { in.Title = "  " }},
		{"empty goal", func(in *CreateTaskInput) { in.Goal = "" }},
		{"goal over cap", func(in *CreateTaskInput) { in.Goal = strings.Repeat("g", model.TaskGoalMaxLen+1) }},
		{"unknown kind", func(in *CreateTaskInput) { in.Kind = "epic" }},
		{"bad base branch", func(in *CreateTaskInput) { in.BaseBranch = "a b" }},
		{"bad repo path", func(in *CreateTaskInput) { in.Repos = []RepoInput{{Path: "noslash"}} }},
	}
	for _, tc := range cases {
		in := base
		tc.mut(&in)
		if _, err := fx.svc.Create(ctx, run, in); !errors.Is(err, ErrValidation) {
			t.Fatalf("%s: want ErrValidation, got %v", tc.name, err)
		}
	}
}

func TestCtaskCovCreateAgentAndRequesterGates(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	in := CreateTaskInput{Project: "Portal", Repos: []RepoInput{{Path: "g/r"}}, Title: "T", Goal: "g"}
	run := &model.Run{ID: "ctaskcov-arun", InvokerID: "u-ghost", ParentID: "chan-general", ParentType: ParentChannel}

	if _, err := fx.svc.Create(ctx, run, in); err == nil || !strings.Contains(err.Error(), "requester lookup") {
		t.Fatalf("unknown requester must fail the create, got %v", err)
	}

	delete(fx.users.users, testDevID)
	run.InvokerID = "u-alice"
	if _, err := fx.svc.Create(ctx, run, in); !errors.Is(err, ErrTaskAgent) {
		t.Fatalf("a missing dev agent must be ErrTaskAgent, got %v", err)
	}
}

func TestCtaskCovCreateStoreErrors(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	run := fx.intakeRun(t, testDevID, "cc-se1")
	in := CreateTaskInput{Project: "Portal", Repos: []RepoInput{{Path: "g/r", Role: model.RepoRoleBackend}}, Title: "T", Goal: "g"}

	fx.store.getProjectErr = errors.New("db down")
	if _, err := fx.svc.Create(ctx, run, in); err == nil || !strings.Contains(err.Error(), "project lookup") {
		t.Fatalf("project lookup error must surface, got %v", err)
	}
	fx.store.getProjectErr = nil

	if err := fx.tasks.CreateProject(ctx, &model.CodingProject{Key: "empty", Name: "Empty", ChannelID: ProjectChannelID("empty")}); err != nil {
		t.Fatal(err)
	}
	if _, err := fx.svc.Create(ctx, run, CreateTaskInput{Project: "Empty", Title: "T", Goal: "g"}); !errors.Is(err, ErrProjectUnknown) {
		t.Fatalf("a project with no repos on record must be ErrProjectUnknown, got %v", err)
	}

	fx.store.listErr = errors.New("list down")
	if _, err := fx.svc.Create(ctx, run, in); err == nil || !strings.Contains(err.Error(), "task: list") {
		t.Fatalf("task list error must surface, got %v", err)
	}
	fx.store.listErr = nil

	fx.chns.getByIDErr = errors.New("chan down")
	if _, err := fx.svc.Create(ctx, run, in); err == nil || !strings.Contains(err.Error(), "channel lookup") {
		t.Fatalf("channel lookup error must surface, got %v", err)
	}
	fx.chns.getByIDErr = nil

	fx.store.createProjectErr = errors.New("put down")
	if _, err := fx.svc.Create(ctx, run, in); err == nil || !strings.Contains(err.Error(), "create project") {
		t.Fatalf("create-project error must surface, got %v", err)
	}
	fx.store.createProjectErr = nil

	fx.msgs2.sendErr = errors.New("send down")
	fx.msgs2.failSendContaining = "[task:"
	if _, err := fx.svc.Create(ctx, run, in); err == nil || !strings.Contains(err.Error(), "post card") {
		t.Fatalf("card post error must surface, got %v", err)
	}
	fx.msgs2.sendErr = nil
	fx.msgs2.failSendContaining = ""

	fx.store.createTaskErr = errors.New("row down")
	if _, err := fx.svc.Create(ctx, run, in); err == nil || !strings.Contains(err.Error(), "task: create") {
		t.Fatalf("create-task error must surface, got %v", err)
	}
}

func TestCtaskCovCreateMembershipFailures(t *testing.T) {
	ctx := context.Background()
	in := CreateTaskInput{Project: "Portal", Repos: []RepoInput{{Path: "g/r"}}, Title: "T", Goal: "g"}

	// The channel pre-exists without the requester, and joining her fails.
	fx := newCtaskCovFixture(t)
	run := fx.intakeRun(t, testDevID, "cc-mb1")
	chID := ProjectChannelID("portal")
	fx.chans.channels[chID] = &model.Channel{ID: chID, Name: "portal", Slug: "portal"}
	fx.chans.members[chID] = map[string]bool{}
	fx.chns.joinErr["u-alice"] = errors.New("join down")
	if _, err := fx.svc.Create(ctx, run, in); err == nil || !strings.Contains(err.Error(), "add requester") {
		t.Fatalf("requester join failure must surface, got %v", err)
	}

	// Fresh channel (the requester creates it), and joining the agent fails.
	fx2 := newCtaskCovFixture(t)
	run2 := fx2.intakeRun(t, testDevID, "cc-mb2")
	fx2.chns.joinErr[testDevID] = errors.New("join down")
	if _, err := fx2.svc.Create(ctx, run2, in); err == nil || !strings.Contains(err.Error(), "add agent") {
		t.Fatalf("agent join failure must surface, got %v", err)
	}
}

func TestCtaskCovCreateMergeUpgradeSurvivesUpdateFailure(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	run := fx.intakeRun(t, testDevID, "cc-mg1")
	if err := fx.tasks.CreateProject(ctx, &model.CodingProject{
		Key: "portal", Name: "Portal", ChannelID: ProjectChannelID("portal"),
		Repos: []model.ProjectRepo{{Path: "g/r", Role: model.RepoRoleOther}},
	}); err != nil {
		t.Fatal(err)
	}
	fx.store.updateProjectErr = errors.New("merge down")
	res, err := fx.svc.Create(ctx, run, CreateTaskInput{Project: "Portal", Repos: []RepoInput{{Path: "g/r", Role: model.RepoRoleBackend}}, Title: "T", Goal: "g"})
	if err != nil || res.ProjectCreated {
		t.Fatalf("a failed repo-role merge must not fail the task: %v %+v", err, res)
	}
	if p, _ := fx.tasks.GetProject(ctx, "portal"); p.Repos[0].Role != model.RepoRoleOther {
		t.Fatalf("merge write failed, the stored role must be unchanged: %+v", p.Repos)
	}
}

func TestCtaskCovCreateBestEffortPinAndLinkBack(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	run := fx.intakeRun(t, testDevID, "cc-be1")
	fx.msgs2.pinErr = errors.New("pin down")
	fx.msgs2.sendErr = errors.New("send down")
	fx.msgs2.failSendContaining = "Taking this to"
	res, err := fx.svc.Create(ctx, run, CreateTaskInput{Project: "Portal", Repos: []RepoInput{{Path: "g/r"}}, Title: "T", Goal: "g"})
	if err != nil {
		t.Fatalf("pin and link-back failures are best-effort: %v", err)
	}
	if res.Task.ThreadRootID == "" || fx.tmsgs.pinned[res.Task.ThreadRootID] {
		t.Fatalf("the card exists but must not be pinned: %+v", res.Task)
	}
	if got := fx.tmsgs.postsIn("chan-general", "cc-be1"); len(got) != 0 {
		t.Fatalf("the link-back failed, nothing must land where the ask happened: %v", got)
	}
}

func TestCtaskCovCreateSupersededCloseFailure(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	run := fx.intakeRun(t, testDevID, "cc-su1")
	chID := ProjectChannelID("portal")
	if err := fx.tasks.CreateProject(ctx, &model.CodingProject{
		Key: "portal", Name: "Portal", ChannelID: chID,
		Repos: []model.ProjectRepo{{Path: "g/r", Role: model.RepoRoleBackend}},
	}); err != nil {
		t.Fatal(err)
	}
	shipped := &model.CodingTask{
		ID: "t-old", ProjectKey: "portal", ProjectName: "Portal", Title: "Old", Goal: "g",
		Kind: model.TaskKindBug, State: model.TaskStateMRCreated, ChannelID: chID, ThreadRootID: "card-old",
		RequesterID: "u-alice", AgentID: testDevID,
		Repos: []model.TaskRepo{{Path: "g/r", Role: model.RepoRoleBackend, MRURL: "https://gitlab/x/-/merge_requests/1"}},
	}
	if err := fx.tasks.CreateTask(ctx, shipped); err != nil {
		t.Fatal(err)
	}
	fx.store.updateTaskErr = errors.New("update down")
	res, err := fx.svc.Create(ctx, run, CreateTaskInput{Project: "Portal", Title: "New", Goal: "g"})
	if err != nil || res.KickoffErr != nil {
		t.Fatalf("a failed supersede close must not fail the create: %v / kickoff %v", err, res.KickoffErr)
	}
	if got, _ := fx.tasks.GetTask(ctx, "t-old"); got.State != model.TaskStateMRCreated {
		t.Fatalf("the close failed, the old task must stay mr_created, got %s", got.State)
	}
}

func TestCtaskCovCreateKickoffFailureAndUncountedLinkBack(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	// Bob has no live runner and this run is unknown to the run store: the
	// link-back posts but cannot be counted, and the kickoff cannot start.
	run := &model.Run{ID: "ctaskcov-ghost-run", InvokerID: "u-bob", ParentID: "chan-general", ParentType: ParentChannel, MessageID: "cc-kb1"}
	res, err := fx.svc.Create(ctx, run, CreateTaskInput{Project: "Portal", Repos: []RepoInput{{Path: "g/r"}}, Title: "T", Goal: "g"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !errors.Is(res.KickoffErr, ErrAgentOffline) {
		t.Fatalf("an offline requester must surface as KickoffErr, got %v", res.KickoffErr)
	}
	notes := fx.tmsgs.postsIn(res.Task.ChannelID, res.Task.ThreadRootID)
	if len(notes) == 0 || !strings.Contains(notes[len(notes)-1], "Couldn't start working yet") {
		t.Fatalf("the kickoff failure must be told in the thread: %v", notes)
	}
	if back := fx.tmsgs.postsIn("chan-general", "cc-kb1"); len(back) != 1 {
		t.Fatalf("the link-back must still post: %v", back)
	}
}

func TestCtaskCovEnsureChannelRaceAndFailure(t *testing.T) {
	ctx := context.Background()
	alice := &model.User{ID: "u-alice"}
	longKey := strings.Repeat("k", 30) // forces the fallback-name clip
	proj := &model.CodingProject{Key: longKey, Name: "K", ChannelID: ProjectChannelID(longKey)}

	// Hard create failure on every candidate, and the read-back finds nothing.
	fx := newCtaskCovFixture(t)
	fx.chns.createErr = errors.New("create down")
	if _, _, err := fx.svc.ensureChannel(ctx, alice, proj.ChannelID, proj); err == nil || !strings.Contains(err.Error(), "create project channel") {
		t.Fatalf("hard create failure must surface, got %v", err)
	}

	// Lost create race: every candidate collides, the derived-ID read-back wins.
	fx2 := newCtaskCovFixture(t)
	want := &model.Channel{ID: proj.ChannelID, Name: longKey, Slug: longKey}
	fx2.chns.createErr = ErrAlreadyExists
	fx2.chns.raceChannel = want
	ch, created, err := fx2.svc.ensureChannel(ctx, alice, proj.ChannelID, proj)
	if err != nil || created || ch != want {
		t.Fatalf("a lost race must resolve by read-back: %v created=%v ch=%+v", err, created, ch)
	}
}

// ------------------------------------------------------------- read APIs

func TestCtaskCovReadAPIs(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	task := fx.seedTask(model.TaskStateInProgress)

	if got, err := fx.svc.Get(ctx, task.ID); err != nil || got.ID != task.ID {
		t.Fatalf("get: %v %+v", err, got)
	}
	if _, err := fx.svc.GetVisible(ctx, "u-alice", "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("get visible on an unknown id: %v", err)
	}
	if got, err := fx.svc.GetVisible(ctx, "u-alice", task.ID); err != nil || got.ID != task.ID {
		t.Fatalf("get visible: %v", err)
	}
	if list, err := fx.svc.ListByChannel(ctx, "u-alice", "chan1"); err != nil || len(list) != 1 {
		t.Fatalf("list by channel: %v (%d)", err, len(list))
	}
	if ps, err := fx.svc.ListProjects(ctx); err != nil || len(ps) != 0 {
		t.Fatalf("list projects: %v %v", err, ps)
	}

	fx.msgs2.accessErr = errors.New("no access")
	if _, err := fx.svc.GetVisible(ctx, "u-bob", task.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a blocked get-visible must be forbidden, got %v", err)
	}
	if _, err := fx.svc.ListByChannel(ctx, "u-bob", "chan1"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("a blocked list must be forbidden, got %v", err)
	}
}

// ----------------------------------------------------------------- Report

func TestCtaskCovReportGatesAndRepoFacts(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	task := fx.seedTask(model.TaskStateInProgress)

	if _, err := fx.svc.Report(ctx, &model.Run{ID: "r-plain"}, TaskUpdate{Note: "hi"}); !errors.Is(err, ErrNotTaskRun) {
		t.Fatalf("an unbound run must be refused, got %v", err)
	}
	if _, err := fx.svc.Report(ctx, &model.Run{ID: "r2", TaskID: "nope"}, TaskUpdate{}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an unknown task must surface, got %v", err)
	}

	run := &model.Run{ID: "ctaskcov-rep", TaskID: task.ID, InvokerID: "u-alice", ParentID: "chan1", ParentType: ParentChannel}
	if _, err := fx.svc.Report(ctx, run, TaskUpdate{State: "weird"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("an unknown state must be refused, got %v", err)
	}

	// Branch and base facts land; the base-branch learn finds no project row
	// and gives up quietly; an over-long note is clipped, not refused.
	got, err := fx.svc.Report(ctx, run, TaskUpdate{
		Note:  strings.Repeat("n", model.TaskNoteMaxLen+10),
		Repos: []RepoUpdate{{Path: "dt/booking-portal-frontend", Branch: "ex/task-abc-fix2", BaseBranch: "develop"}},
	})
	if err != nil {
		t.Fatalf("report: %v", err)
	}
	if r := got.Repo("dt/booking-portal-frontend"); r.Branch != "ex/task-abc-fix2" || r.BaseBranch != "develop" {
		t.Fatalf("repo facts not applied: %+v", r)
	}

	fx.store.updateTaskErr = errors.New("update down")
	if _, err := fx.svc.Report(ctx, run, TaskUpdate{Note: "x"}); err == nil || !strings.Contains(err.Error(), "update down") {
		t.Fatalf("the task write failure must surface, got %v", err)
	}
}

func TestCtaskCovLearnDefaultBranchUpdateFailure(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	task := fx.seedTask(model.TaskStateInProgress)
	if err := fx.tasks.CreateProject(ctx, &model.CodingProject{
		Key: "booking-portal", Name: "Booking Portal", ChannelID: "chan1",
		Repos: []model.ProjectRepo{{Path: "dt/booking-portal-api", Role: model.RepoRoleBackend, DefaultBranch: "main"}},
	}); err != nil {
		t.Fatal(err)
	}
	fx.store.updateProjectErr = errors.New("learn down")
	run := &model.Run{ID: "ctaskcov-lrn", TaskID: task.ID, InvokerID: "u-alice", ParentID: "chan1", ParentType: ParentChannel}
	if _, err := fx.svc.Report(ctx, run, TaskUpdate{Repos: []RepoUpdate{{Path: "dt/booking-portal-api", BaseBranch: "develop"}}}); err != nil {
		t.Fatalf("a failed default-branch learn must not fail the report: %v", err)
	}
	if p, _ := fx.tasks.GetProject(ctx, "booking-portal"); p.Repos[0].DefaultBranch != "main" {
		t.Fatalf("the learn write failed, the project must be unchanged: %+v", p.Repos)
	}
}

// -------------------------------------------------------- PublishTestPlan

func TestCtaskCovPublishTestPlanGates(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	task := fx.seedTask(model.TaskStateInProgress)
	run := &model.Run{ID: "ctaskcov-pub", TaskID: task.ID, InvokerID: "u-alice", ParentID: "chan1", ParentType: ParentChannel}

	if _, err := fx.svc.PublishTestPlan(ctx, &model.Run{ID: "r"}, model.TestPlan{}); !errors.Is(err, ErrNotTaskRun) {
		t.Fatalf("an unbound run must be refused, got %v", err)
	}
	if _, err := fx.svc.PublishTestPlan(ctx, &model.Run{ID: "r", TaskID: "nope"}, model.TestPlan{}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an unknown task must surface, got %v", err)
	}
	if _, err := fx.svc.PublishTestPlan(ctx, run, model.TestPlan{URL: "ftp://x", Steps: []string{"a"}, CounterSteps: []string{"b"}}); !errors.Is(err, ErrValidation) {
		t.Fatalf("a non-http URL must be refused, got %v", err)
	}
	if _, err := fx.svc.PublishTestPlan(ctx, run, model.TestPlan{URL: "http://x", CounterSteps: []string{"b"}}); !errors.Is(err, ErrValidation) {
		t.Fatalf("a plan without steps must be refused, got %v", err)
	}
	many := model.TestPlan{URL: "http://x", CounterSteps: []string{"never"}}
	for i := 0; i <= model.TestPlanMaxSteps; i++ {
		many.Steps = append(many.Steps, fmt.Sprintf("step %d", i))
	}
	if _, err := fx.svc.PublishTestPlan(ctx, run, many); !errors.Is(err, ErrValidation) {
		t.Fatalf("too many steps must be refused, got %v", err)
	}

	fx.store.updateTaskErr = errors.New("update down")
	good := model.TestPlan{URL: "http://localhost:3000", Steps: []string{"Open the page and click the button"}, CounterSteps: []string{"An IC must not see it"}}
	if _, err := fx.svc.PublishTestPlan(ctx, run, good); err == nil || !strings.Contains(err.Error(), "update down") {
		t.Fatalf("the plan write failure must surface, got %v", err)
	}
}

// ---------------------------------------------------------------- MR gate

func TestCtaskCovRequestMRGatesAndApproval(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	task := fx.seedTask(model.TaskStateAwaitingTest)

	if _, _, err := fx.svc.RequestMR(ctx, &model.Run{ID: "r"}, ""); !errors.Is(err, ErrNotTaskRun) {
		t.Fatalf("an unbound run must be refused, got %v", err)
	}
	if _, _, err := fx.svc.RequestMR(ctx, &model.Run{ID: "r", TaskID: "nope"}, ""); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an unknown task must surface, got %v", err)
	}
	early := ctaskCovSeedTask(t, fx, "t-early", model.TaskStateCreated, "u-alice")
	if status, _, err := fx.svc.RequestMR(ctx, &model.Run{ID: "r3", TaskID: early.ID, InvokerID: "u-alice"}, ""); err != nil || status != MRStatusNotReady {
		t.Fatalf("a task before testing must be not_ready, got %q %v", status, err)
	}

	// An approved approval naming this exact task flips the sign-off.
	run := &model.Run{ID: "ctaskcov-mr", TaskID: task.ID, InvokerID: "u-alice", ParentID: "chan1", ParentType: ParentChannel}
	if err := fx.runs.PutApproval(ctx, &model.Approval{ID: "ap1", RunID: run.ID, State: model.ApprovalApproved, Summary: MRApprovalSummary(task)}); err != nil {
		t.Fatal(err)
	}
	status, got, err := fx.svc.RequestMR(ctx, run, "ap1")
	if err != nil || status != MRStatusApproved || got.SignedOffAt == nil {
		t.Fatalf("an approved approval must sign off: %q %v %+v", status, err, got)
	}

	// The same path with a failing sign-off write.
	task2 := ctaskCovSeedTask(t, fx, "t-mr2", model.TaskStateAwaitingTest, "u-alice")
	run2 := &model.Run{ID: "ctaskcov-mr2", TaskID: task2.ID, InvokerID: "u-alice", ParentID: "chan1", ParentType: ParentChannel}
	if err := fx.runs.PutApproval(ctx, &model.Approval{ID: "ap2", RunID: run2.ID, State: model.ApprovalApproved, Summary: "task " + task2.ID}); err != nil {
		t.Fatal(err)
	}
	fx.store.updateTaskErr = errors.New("update down")
	if _, _, err := fx.svc.RequestMR(ctx, run2, "ap2"); err == nil || !strings.Contains(err.Error(), "update down") {
		t.Fatalf("the sign-off write failure must surface, got %v", err)
	}
}

// ----------------------------------------------------------------- SignOff

func TestCtaskCovSignOffErrorArms(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()

	if _, err := fx.svc.SignOff(ctx, "u-alice", "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an unknown task must surface, got %v", err)
	}
	busy := ctaskCovSeedTask(t, fx, "t-so1", model.TaskStateInProgress, "u-alice")
	if _, err := fx.svc.SignOff(ctx, "u-alice", busy.ID); !errors.Is(err, ErrTaskNotReady) {
		t.Fatalf("an in-progress sign-off must be refused, got %v", err)
	}

	waiting := ctaskCovSeedTask(t, fx, "t-so2", model.TaskStateAwaitingTest, "u-alice")
	fx.store.updateTaskErr = errors.New("update down")
	if _, err := fx.svc.SignOff(ctx, "u-alice", waiting.ID); err == nil || !strings.Contains(err.Error(), "update down") {
		t.Fatalf("the sign-off write failure must surface, got %v", err)
	}
	fx.store.updateTaskErr = nil

	// A requester row that no longer resolves: the sign-off lands, no MR run.
	ghost := ctaskCovSeedTask(t, fx, "t-so3", model.TaskStateAwaitingTest, "u-ghost")
	got, err := fx.svc.SignOff(ctx, "u-ghost", ghost.ID)
	if err != nil || got.SignedOffAt == nil {
		t.Fatalf("ghost sign-off: %v %+v", err, got)
	}
	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 0 {
		t.Fatalf("no requester user means no MR run, got %d", len(runs))
	}

	// The requester resolves but their runner is offline: the MR run fails.
	offline := ctaskCovSeedTask(t, fx, "t-so4", model.TaskStateAwaitingTest, "u-bob")
	if _, err := fx.svc.SignOff(ctx, "u-bob", offline.ID); err != nil {
		t.Fatalf("the sign-off itself must land: %v", err)
	}
	notes := fx.tmsgs.postsIn(offline.ChannelID, offline.ThreadRootID)
	if !strings.Contains(strings.Join(notes, "\n"), "Couldn't start the MR run") {
		t.Fatalf("the MR-run failure must be told in the thread: %v", notes)
	}
}

// ------------------------------------------------------------- SetSteering

func TestCtaskCovSetSteering(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	task := ctaskCovSeedTask(t, fx, "t-st", model.TaskStateInProgress, "u-alice")

	if _, err := fx.svc.SetSteering(ctx, "u-alice", task.ID, "boss"); !errors.Is(err, ErrValidation) {
		t.Fatalf("an unknown mode must be refused, got %v", err)
	}
	if _, err := fx.svc.SetSteering(ctx, "u-alice", "nope", model.TaskSteeringAnyone); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an unknown task must surface, got %v", err)
	}
	if got, err := fx.svc.SetSteering(ctx, "u-alice", task.ID, model.TaskSteeringRequester); err != nil || got.Steering != model.TaskSteeringRequester {
		t.Fatalf("a same-mode set must be a no-op: %v %+v", err, got)
	}
	fx.store.updateTaskErr = errors.New("update down")
	if _, err := fx.svc.SetSteering(ctx, "u-alice", task.ID, model.TaskSteeringAnyone); err == nil || !strings.Contains(err.Error(), "update down") {
		t.Fatalf("the steering write failure must surface, got %v", err)
	}
	fx.store.updateTaskErr = nil
	if _, err := fx.svc.SetSteering(ctx, "u-alice", task.ID, model.TaskSteeringAnyone); err != nil {
		t.Fatal(err)
	}
	if got, err := fx.svc.SetSteering(ctx, "u-alice", task.ID, model.TaskSteeringRequester); err != nil || got.Steering != model.TaskSteeringRequester {
		t.Fatalf("back to requester-only: %v", err)
	}
	notes := fx.tmsgs.postsIn(task.ChannelID, task.ThreadRootID)
	if !strings.Contains(strings.Join(notes, "\n"), "back to the requester") {
		t.Fatalf("the mode flip must be narrated: %v", notes)
	}
}

// ------------------------------------------------------------------- Close

func TestCtaskCovCloseArmsAndBestEffortMessaging(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()

	if _, err := fx.svc.Close(ctx, "u-alice", "nope", "done"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("an unknown task must surface, got %v", err)
	}

	shipped := ctaskCovSeedTask(t, fx, "t-cl1", model.TaskStateMRCreated, "u-alice")
	shipped.Repos[0].MRURL = "https://gitlab/x/-/merge_requests/5"
	if err := fx.tasks.UpdateTask(ctx, shipped, model.TaskStateMRCreated); err != nil {
		t.Fatal(err)
	}
	got, err := fx.svc.Close(ctx, "u-alice", shipped.ID, "done")
	if err != nil || got.State != model.TaskStateDone {
		t.Fatalf("close done: %v %+v", err, got)
	}
	notes := fx.tmsgs.postsIn(shipped.ChannelID, shipped.ThreadRootID)
	if !strings.Contains(strings.Join(notes, "\n"), "merge_requests/5") {
		t.Fatalf("the done note must carry the MR link: %v", notes)
	}

	stuck := ctaskCovSeedTask(t, fx, "t-cl2", model.TaskStateInProgress, "u-alice")
	fx.store.updateTaskErr = errors.New("update down")
	if _, err := fx.svc.Close(ctx, "u-alice", stuck.ID, "abandoned"); err == nil || !strings.Contains(err.Error(), "update down") {
		t.Fatalf("the close write failure must surface, got %v", err)
	}
	fx.store.updateTaskErr = nil

	// Note and card-refresh failures are best-effort.
	fx.msgs2.sendErr = errors.New("send down")
	fx.msgs2.rewriteErr = errors.New("rewrite down")
	if got, err := fx.svc.Close(ctx, "u-alice", stuck.ID, "abandoned"); err != nil || got.State != model.TaskStateAbandoned {
		t.Fatalf("a close must survive messaging failures: %v %+v", err, got)
	}
}
