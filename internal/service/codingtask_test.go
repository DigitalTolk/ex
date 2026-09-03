package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// ---------------------------------------------------------------- fakes

type fakeTaskStore struct {
	mu       sync.Mutex
	tasks    map[string]*model.CodingTask
	projects map[string]*model.CodingProject
}

func newFakeTaskStore() *fakeTaskStore {
	return &fakeTaskStore{tasks: map[string]*model.CodingTask{}, projects: map[string]*model.CodingProject{}}
}

func (f *fakeTaskStore) CreateTask(_ context.Context, t *model.CodingTask) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.tasks[t.ID]; ok {
		return store.ErrAlreadyExists
	}
	cp := *t
	f.tasks[t.ID] = &cp
	return nil
}

func (f *fakeTaskStore) GetTask(_ context.Context, id string) (*model.CodingTask, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	t, ok := f.tasks[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *t
	cp.Repos = append([]model.TaskRepo(nil), t.Repos...)
	return &cp, nil
}

func (f *fakeTaskStore) UpdateTask(_ context.Context, t *model.CodingTask, expect model.TaskState) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur, ok := f.tasks[t.ID]
	if !ok {
		return store.ErrNotFound
	}
	if cur.State != expect {
		return store.ErrStaleTask
	}
	cp := *t
	cp.Repos = append([]model.TaskRepo(nil), t.Repos...)
	f.tasks[t.ID] = &cp
	return nil
}

func (f *fakeTaskStore) ListTasksByChannel(_ context.Context, channelID string) ([]*model.CodingTask, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.CodingTask
	for _, t := range f.tasks {
		if t.ChannelID == channelID {
			cp := *t
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (f *fakeTaskStore) GetTaskByThread(_ context.Context, threadRootID string) (*model.CodingTask, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, t := range f.tasks {
		if t.ThreadRootID == threadRootID && threadRootID != "" {
			cp := *t
			return &cp, nil
		}
	}
	return nil, store.ErrNotFound
}

func (f *fakeTaskStore) CreateProject(_ context.Context, p *model.CodingProject) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.projects[p.Key]; ok {
		return store.ErrAlreadyExists
	}
	cp := *p
	f.projects[p.Key] = &cp
	return nil
}

func (f *fakeTaskStore) UpdateProject(_ context.Context, p *model.CodingProject) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *p
	f.projects[p.Key] = &cp
	return nil
}

func (f *fakeTaskStore) GetProject(_ context.Context, key string) (*model.CodingProject, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.projects[key]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *p
	cp.Repos = append([]model.ProjectRepo(nil), p.Repos...)
	return &cp, nil
}

func (f *fakeTaskStore) ListProjects(_ context.Context) ([]*model.CodingProject, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.CodingProject
	for _, p := range f.projects {
		cp := *p
		out = append(out, &cp)
	}
	return out, nil
}

// fakeTaskChannels is an in-memory taskChannels.
type fakeTaskChannels struct {
	mu       sync.Mutex
	channels map[string]*model.Channel
	members  map[string]map[string]bool // channelID -> userID
}

func newFakeTaskChannels() *fakeTaskChannels {
	return &fakeTaskChannels{channels: map[string]*model.Channel{}, members: map[string]map[string]bool{}}
}

func (f *fakeTaskChannels) GetByID(_ context.Context, id string) (*model.Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch, ok := f.channels[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return ch, nil
}

func (f *fakeTaskChannels) GetBySlug(_ context.Context, slug string) (*model.Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, ch := range f.channels {
		if ch.Slug == slug {
			return ch, nil
		}
	}
	return nil, store.ErrNotFound
}

func (f *fakeTaskChannels) CreateWithID(_ context.Context, userID, id, name string, chanType model.ChannelType, description string) (*model.Channel, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Enforce the real naming rules — the prod service rejects non-slug
	// names, and a fake that accepts anything hid exactly that regression.
	if err := ValidateChannelName(name); err != nil {
		return nil, err
	}
	if err := ValidateChannelDescription(description); err != nil {
		return nil, err
	}
	slug := slugify(name)
	for _, ch := range f.channels {
		if ch.Slug == slug || ch.ID == id {
			return nil, ErrAlreadyExists
		}
	}
	ch := &model.Channel{ID: id, Name: name, Slug: slug, Type: chanType, Description: description, CreatedBy: userID}
	f.channels[id] = ch
	f.members[id] = map[string]bool{userID: true}
	return ch, nil
}

func (f *fakeTaskChannels) AutoJoinChannel(_ context.Context, userID, channelID string, _ model.ChannelRole) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.channels[channelID]; !ok {
		return store.ErrNotFound
	}
	f.members[channelID][userID] = true
	return nil
}

func (f *fakeTaskChannels) IsMember(_ context.Context, userID, channelID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.members[channelID][userID]
}

// fakeTaskMessages records agent posts and card rewrites.
type fakeTaskMessages struct {
	mu       sync.Mutex
	seq      int
	posts    []*model.Message
	rewrites map[string]string // msgID -> latest body
	pinned   map[string]bool
}

func newFakeTaskMessages() *fakeTaskMessages {
	return &fakeTaskMessages{rewrites: map[string]string{}, pinned: map[string]bool{}}
}

func (f *fakeTaskMessages) SendAsAgentRun(_ context.Context, agentID, invokerID, parentID, parentType, body, parentMessageID, runID string) (*model.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	m := &model.Message{
		ID: fmt.Sprintf("msg-%d", f.seq), ParentID: parentID, ParentType: parentType, AuthorID: agentID,
		AgentInvokerID: invokerID, Body: body, ParentMessageID: parentMessageID, AgentRunID: runID,
	}
	f.posts = append(f.posts, m)
	return m, nil
}

func (f *fakeTaskMessages) RewriteAgentMessage(_ context.Context, _, _, _, msgID, body string) (*model.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rewrites[msgID] = body
	return &model.Message{ID: msgID, Body: body}, nil
}

func (f *fakeTaskMessages) SetPinned(_ context.Context, _, _, _, msgID string, pinned bool) (*model.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pinned[msgID] = pinned
	return &model.Message{ID: msgID, Pinned: pinned}, nil
}

func (f *fakeTaskMessages) CheckAccess(context.Context, string, string, string) error { return nil }

func (f *fakeTaskMessages) postsIn(parentID, threadRoot string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, m := range f.posts {
		if m.ParentID == parentID && m.ParentMessageID == threadRoot {
			out = append(out, m.Body)
		}
	}
	return out
}

// ---------------------------------------------------------------- fixture

var testDevID = AgentUserID(AgentSlugDev)

type taskFixture struct {
	*orchFixture
	tasks *fakeTaskStore
	chans *fakeTaskChannels
	tmsgs *fakeTaskMessages
	svc   *CodingTaskService
}

// newTaskFixture extends the orchestrator fixture with the dev agent (seeded
// by SeedDefaults, so only the user row is missing), a second human (bob), the
// task store and the task service.
func newTaskFixture(t *testing.T) *taskFixture {
	t.Helper()
	fx := newOrchFixture(t)
	fx.users.users[testDevID] = &model.User{
		ID: testDevID, DisplayName: "dev", Kind: model.UserKindAgent,
		AgentConfig: &model.AgentConfig{TemplateSlug: AgentSlugDev},
	}
	fx.users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	tasks := newFakeTaskStore()
	fx.orch.SetTaskStore(tasks)
	chans := newFakeTaskChannels()
	tmsgs := newFakeTaskMessages()
	svc := NewCodingTaskService(tasks, chans, tmsgs, fx.users, fx.orch.agentSvc, fx.orch)
	svc.SetBaseURL("http://ex.test")
	svc.now = fx.orch.now
	return &taskFixture{orchFixture: fx, tasks: tasks, chans: chans, tmsgs: tmsgs, svc: svc}
}

var bookingRepos = []RepoInput{
	{Path: "dt/booking-portal-frontend", Role: model.RepoRoleFrontend},
	{Path: "dt/booking-portal-api", Role: model.RepoRoleBackend},
}

// seedTask plants an active task in chan1 rooted at card1.
func (fx *taskFixture) seedTask(state model.TaskState) *model.CodingTask {
	task := &model.CodingTask{
		ID: "t1", ProjectKey: "booking-portal", ProjectName: "Booking Portal", Title: "Fix Feb-29 crash",
		Goal: "the picker throws on Feb 29", Kind: model.TaskKindBug, State: state, Steering: model.TaskSteeringRequester,
		ChannelID: "chan1", ThreadRootID: "card1", RequesterID: "u-alice", AgentID: testDevID,
		Repos: []model.TaskRepo{
			{Path: "dt/booking-portal-frontend", Role: model.RepoRoleFrontend, BaseBranch: "main", Branch: "ex/task-abc-fix"},
			{Path: "dt/booking-portal-api", Role: model.RepoRoleBackend, BaseBranch: "main", Branch: "ex/task-abc-fix"},
		},
		CreatedAt: *fx.now, UpdatedAt: *fx.now,
	}
	if err := fx.tasks.CreateTask(context.Background(), task); err != nil {
		panic(err)
	}
	return task
}

func (fx *taskFixture) runsByMode(mode string) []*model.Run {
	fx.runs.mu.Lock()
	defer fx.runs.mu.Unlock()
	var out []*model.Run
	for _, r := range fx.runs.runs {
		if r.Mode == mode {
			cp := *r
			out = append(out, &cp)
		}
	}
	return out
}

func (fx *taskFixture) intakeRun(t *testing.T, agentID, msgID string) *model.Run {
	t.Helper()
	ctx := context.Background()
	agent, _ := fx.users.GetUser(ctx, agentID)
	alice, _ := fx.users.GetUser(ctx, "u-alice")
	resolved, err := fx.orch.agentSvc.Resolve(ctx, agent, alice.ID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	run, err := fx.orch.StartRun(ctx, agent, alice, &model.Message{ID: msgID, ParentID: "chan-general", AuthorID: "u-alice", Body: "@dev fix"}, ParentChannel, resolved, 0, nil)
	if err != nil {
		t.Fatalf("intake run: %v", err)
	}
	return run
}

// ---------------------------------------------------------------- dispatch

func TestOrchestrator_TaskThreadReplyResumesTaskRun(t *testing.T) {
	fx := newTaskFixture(t)
	fx.seedTask(model.TaskStateAwaitingTest)
	ctx := context.Background()

	fx.orch.OnMessage(ctx, &model.Message{ID: "m2", ParentID: "chan1", ParentMessageID: "card1", AuthorID: "u-alice", Body: "the tooltip clips now"}, ParentChannel)

	runs := fx.runsByMode(model.RunModeTask)
	if len(runs) != 1 {
		t.Fatalf("expected exactly one task run, got %d", len(runs))
	}
	run := runs[0]
	if run.TaskID != "t1" || run.AgentID != testDevID || run.InvokerID != "u-alice" || run.ThreadRootID != "card1" {
		t.Fatalf("run not bound to the task: %+v", run)
	}
	if run.Prompt != "the tooltip clips now" {
		t.Fatalf("thread reply should be the prompt verbatim, got %q", run.Prompt)
	}

	as, err := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil || len(as) != 1 {
		t.Fatalf("claim: %v (%d)", err, len(as))
	}
	if as[0].Task == nil || as[0].Task.ID != "t1" || len(as[0].Task.Repos) != 2 || as[0].Task.Repos[0].Branch != "ex/task-abc-fix" || as[0].Task.ProjectName != "Booking Portal" {
		t.Fatalf("assignment lacks the task spec: %+v", as[0].Task)
	}
	if as[0].Mode != model.RunModeTask {
		t.Fatalf("assignment mode = %q", as[0].Mode)
	}
	task, _ := fx.tasks.GetTask(ctx, "t1")
	if task.RunnerID != "r1" || len(task.RunIDs) != 1 {
		t.Fatalf("claim must pin the task to the runner: %+v", task)
	}
	claimed, _ := fx.runs.GetRun(ctx, run.ID)
	if claimed.HardDeadline.Sub(*fx.now) < 20*24*time.Hour {
		t.Fatalf("task runs must not carry the 2h ceiling: hard deadline %v", claimed.HardDeadline.Sub(*fx.now))
	}
	if len(claimed.ConnectorSlugs) != 0 {
		t.Fatalf("no connector registry → no auto-attach, got %v", claimed.ConnectorSlugs)
	}
	if !strings.Contains(as[0].ContextBundle, "# Coding task") || !strings.Contains(as[0].ContextBundle, "Repo (frontend): dt/booking-portal-frontend") {
		t.Fatalf("bundle must carry the task section with repos:\n%s", as[0].ContextBundle)
	}

	batch := make([]RunEventInput, 0, 300)
	for i := 1; i <= 300; i++ {
		batch = append(batch, RunEventInput{Seq: int64(i), Type: "turn"})
	}
	batch = append(batch, RunEventInput{Seq: 301, Type: "usage", Payload: map[string]any{"inputTokens": float64(5_000_000), "outputTokens": float64(0)}})
	abort, reason, err := fx.orch.ReportEvents(ctx, "r1", run.ID, batch)
	if err != nil || abort {
		t.Fatalf("task run must be uncapped: abort=%v reason=%q err=%v", abort, reason, err)
	}
}

func TestOrchestrator_TaskMentionInThreadBindsAndOtherAgentsDont(t *testing.T) {
	fx := newTaskFixture(t)
	fx.seedTask(model.TaskStateInProgress)
	ctx := context.Background()

	fx.orch.OnMessage(ctx, &model.Message{ID: "m3", ParentID: "chan1", ParentMessageID: "card1", AuthorID: "u-alice",
		Body: "@[" + testDevID + "|dev] also fix the tooltip"}, ParentChannel)
	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 1 || runs[0].TaskID != "t1" {
		t.Fatalf("mentioning dev in the task thread must bind the run, got %+v", runs)
	}
	fx.orch.OnMessage(ctx, &model.Message{ID: "m4", ParentID: "chan1", ParentMessageID: "card1", AuthorID: "u-alice",
		Body: "@[" + testGGID + "|gg] what do you think"}, ParentChannel)
	direct := fx.runsByMode(model.RunModeDirect)
	if len(direct) != 1 || direct[0].TaskID != "" || direct[0].AgentID != testGGID {
		t.Fatalf("another agent in the thread must not become a task run: %+v", direct)
	}
}

func TestOrchestrator_TaskTopLevelRoutingAndSteering(t *testing.T) {
	fx := newTaskFixture(t)
	fx.seedTask(model.TaskStateAwaitingTest)
	ctx := context.Background()

	fx.orch.OnMessage(ctx, &model.Message{ID: "m5", ParentID: "chan1", AuthorID: "u-bob", Body: "use the seed db"}, ParentChannel)
	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 0 {
		t.Fatalf("non-requester must not steer by default, got %d runs", len(runs))
	}
	fx.orch.OnMessage(ctx, &model.Message{ID: "m6", ParentID: "chan1", AuthorID: "u-alice", Body: "use the seed db"}, ParentChannel)
	runs := fx.runsByMode(model.RunModeTask)
	if len(runs) != 1 {
		t.Fatalf("expected the top-level message to route to the task, got %d runs", len(runs))
	}
	if runs[0].ThreadRootID != "card1" || runs[0].MessageID != "m6" || !strings.Contains(runs[0].Prompt, "[steering from ~booking-portal") {
		t.Fatalf("routed run mis-threaded: %+v", runs[0])
	}
	if err := fx.orch.cancelRun(ctx, runs[0], "u-alice"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	task, _ := fx.tasks.GetTask(ctx, "t1")
	task.Steering = model.TaskSteeringAnyone
	_ = fx.tasks.UpdateTask(ctx, task, task.State)
	fx.orch.OnMessage(ctx, &model.Message{ID: "m7", ParentID: "chan1", ParentMessageID: "card1", AuthorID: "u-bob", Body: "also check Feb 28"}, ParentChannel)
	var bobRun *model.Run
	for _, r := range fx.runsByMode(model.RunModeTask) {
		if r.MessageID == "m7" {
			bobRun = r
		}
	}
	if bobRun == nil {
		t.Fatal("with steering=anyone, bob's reply must resume the task")
	}
	if bobRun.InvokerID != "u-alice" || bobRun.OwnerID != "u-alice" {
		t.Fatalf("steering by others must run on the REQUESTER's machine/quota: %+v", bobRun)
	}
	if !strings.Contains(bobRun.Prompt, "[steering by Bob") {
		t.Fatalf("non-requester steering must be attributed in the prompt: %q", bobRun.Prompt)
	}
}

func TestOrchestrator_TaskSteeringWhileBusyIsDeferred(t *testing.T) {
	fx := newTaskFixture(t)
	fx.seedTask(model.TaskStateInProgress)
	ctx := context.Background()

	fx.orch.OnMessage(ctx, &model.Message{ID: "m8", ParentID: "chan1", ParentMessageID: "card1", AuthorID: "u-alice", Body: "first"}, ParentChannel)
	first := fx.runsByMode(model.RunModeTask)
	if len(first) != 1 {
		t.Fatalf("expected 1 run, got %d", len(first))
	}
	fx.orch.OnMessage(ctx, &model.Message{ID: "m9", ParentID: "chan1", ParentMessageID: "card1", AuthorID: "u-alice", Body: "second — also X"}, ParentChannel)
	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 1 {
		t.Fatalf("busy thread must not stack runs, got %d", len(runs))
	}
	as, err := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil || len(as) != 1 {
		t.Fatalf("claim: %v", err)
	}
	if err := fx.orch.CompleteRun(ctx, "r1", first[0].ID, "done for now", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	runs := fx.runsByMode(model.RunModeTask)
	if len(runs) != 2 {
		t.Fatalf("deferred steering must start after the run ends, got %d runs", len(runs))
	}
	var second *model.Run
	for _, r := range runs {
		if r.ID != first[0].ID {
			second = r
		}
	}
	if second == nil || second.TaskID != "t1" || second.Prompt != "second — also X" || second.ThreadRootID != "card1" {
		t.Fatalf("deferred run not bound to the task: %+v", second)
	}
}

func TestOrchestrator_ProjectsIndexInBundle(t *testing.T) {
	fx := newTaskFixture(t)
	_ = fx.tasks.CreateProject(context.Background(), &model.CodingProject{
		Key: "cliffhub", Name: "CliffHub", ChannelID: "chan-ch",
		Repos: []model.ProjectRepo{{Path: "dtolk/internal-tools/cliffhub-2-backend", Role: "backend"}, {Path: "dtolk/internal-tools/cliffhub-2-frontend", Role: "frontend"}},
	})
	run := fx.startRun(t) // a plain gg run
	bundle, _ := fx.orch.buildBundle(context.Background(), run)
	if !strings.Contains(bundle, "# Known coding projects") || !strings.Contains(bundle, "CliffHub: dtolk/internal-tools/cliffhub-2-backend (backend), dtolk/internal-tools/cliffhub-2-frontend (frontend)") {
		t.Fatalf("plain runs must see the projects index:\n%s", bundle)
	}
}

// ---------------------------------------------------------------- service

// A shipped task (mr_created) must not block its project's next task — the
// merge watcher is v2, so without this a project was stuck after its first
// MR. The requester can also end a task by hand from the card.
func TestCodingTaskService_SupersedeShippedTaskAndClose(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	repos := []RepoInput{{Path: "dt/portal-api", Role: "backend"}}
	first, err := fx.svc.Create(ctx, fx.intakeRun(t, testGGID, "ask-s1"), CreateTaskInput{Project: "Portal", Repos: repos, Title: "First &amp; foremost", Goal: "g &lt; h"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Task.Title != "First & foremost" || first.Task.Goal != "g < h" {
		t.Fatalf("ticket HTML entities must be decoded: %q / %q", first.Task.Title, first.Task.Goal)
	}
	// Still being worked → the next ask is refused.
	if _, err := fx.svc.Create(ctx, fx.intakeRun(t, testGGID, "ask-s2"), CreateTaskInput{Project: "Portal", Title: "Second", Goal: "g"}); !errors.Is(err, ErrTaskActive) {
		t.Fatalf("an in-flight task must still block, got %v", err)
	}
	// Close: requester-only, and "done" is only legal once MRs are open.
	if _, err := fx.svc.Close(ctx, "u-not-the-requester", first.Task.ID, "abandoned"); !errors.Is(err, ErrNotRequester) {
		t.Fatalf("close must be requester-only, got %v", err)
	}
	if _, err := fx.svc.Close(ctx, first.Task.RequesterID, first.Task.ID, "done"); !errors.Is(err, ErrTaskTransition) {
		t.Fatalf("done before MRs must be refused, got %v", err)
	}
	if _, err := fx.svc.Close(ctx, first.Task.RequesterID, first.Task.ID, "later"); !errors.Is(err, ErrValidation) {
		t.Fatalf("unknown close state must be refused, got %v", err)
	}
	// Ship it (the MR step itself is covered elsewhere).
	old := first.Task
	prev := old.State
	old.State = model.TaskStateMRCreated
	old.Repos[0].MRURL = "https://gitlab/x/-/merge_requests/9"
	if err := fx.tasks.UpdateTask(ctx, old, prev); err != nil {
		t.Fatal(err)
	}
	second, err := fx.svc.Create(ctx, fx.intakeRun(t, testGGID, "ask-s3"), CreateTaskInput{Project: "Portal", Title: "Second", Goal: "g"})
	if err != nil {
		t.Fatalf("a shipped task must not block the next one: %v", err)
	}
	got, _ := fx.tasks.GetTask(ctx, old.ID)
	if got.State != model.TaskStateDone {
		t.Fatalf("superseded task must be done, got %s", got.State)
	}
	found := false
	for _, n := range fx.tmsgs.postsIn(old.ChannelID, old.ThreadRootID) {
		if strings.Contains(n, "Superseded by a new task") && strings.Contains(n, "merge_requests/9") {
			found = true
		}
	}
	if !found {
		t.Fatalf("superseded task must be told in its thread: %v", fx.tmsgs.postsIn(old.ChannelID, old.ThreadRootID))
	}
	// Abandon the new one by hand; terminal tasks then close idempotently.
	if _, err := fx.svc.Close(ctx, second.Task.RequesterID, second.Task.ID, "abandoned"); err != nil {
		t.Fatal(err)
	}
	if got2, _ := fx.tasks.GetTask(ctx, second.Task.ID); got2.State != model.TaskStateAbandoned {
		t.Fatalf("abandon must land, got %s", got2.State)
	}
	if _, err := fx.svc.Close(ctx, second.Task.RequesterID, second.Task.ID, "done"); err != nil {
		t.Fatalf("closing a terminal task must be a no-op, got %v", err)
	}
}

func TestCodingTaskService_CreateFlowAndGates(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	intake := fx.intakeRun(t, testDevID, "ask1")

	// Unknown product without repos → ask the requester.
	if _, err := fx.svc.Create(ctx, intake, CreateTaskInput{Project: "Booking Portal", Title: "T", Goal: "g"}); !errors.Is(err, ErrProjectUnknown) {
		t.Fatalf("new project without repos must be refused, got %v", err)
	}
	// A repo path as the project name is the classic mistake.
	if _, err := fx.svc.Create(ctx, intake, CreateTaskInput{Project: "dt/booking-portal-api", Repos: bookingRepos, Title: "T", Goal: "g"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("repo path as project must be refused, got %v", err)
	}

	res, err := fx.svc.Create(ctx, intake, CreateTaskInput{
		Project: "Booking Portal", Repos: bookingRepos, Title: "Fix Feb-29 date picker crash",
		Goal: "The booking form date picker throws on Feb 29.", Kind: "bug",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	task := res.Task
	wantChan := ProjectChannelID("booking-portal")
	if task.ChannelID != wantChan || !res.ChannelCreated || !res.ProjectCreated || res.Channel.Slug != "booking-portal" || res.Channel.Type != model.ChannelTypePrivate {
		t.Fatalf("project channel wrong: task=%+v channel=%+v", task, res.Channel)
	}
	if task.ProjectKey != "booking-portal" || task.ProjectName != "Booking Portal" || len(task.Repos) != 2 || task.Repos[0].Branch != task.Repos[1].Branch || !strings.HasPrefix(task.Repos[0].Branch, "ex/task-") {
		t.Fatalf("task repos wrong: %+v", task)
	}
	if !fx.chans.IsMember(ctx, "u-alice", wantChan) || !fx.chans.IsMember(ctx, testDevID, wantChan) {
		t.Fatal("requester and dev must be members of the project channel")
	}
	proj, err := fx.tasks.GetProject(ctx, "booking-portal")
	if err != nil || len(proj.Repos) != 2 || proj.ChannelID != wantChan {
		t.Fatalf("project must be recorded with its repos: %+v %v", proj, err)
	}
	cards := fx.tmsgs.postsIn(wantChan, "")
	if len(cards) != 1 || !strings.HasPrefix(cards[0], "[task:"+task.ID+"|") || !strings.Contains(cards[0], "|created|bug|Booking Portal]") {
		t.Fatalf("task card marker wrong: %v", cards)
	}
	if !fx.tmsgs.pinned[task.ThreadRootID] {
		t.Fatal("task card must be pinned")
	}
	back := fx.tmsgs.postsIn("chan-general", "ask1")
	if len(back) != 1 || !strings.Contains(back[0], "Taking this to ~booking-portal") || !strings.Contains(back[0], "booking-portal-frontend, booking-portal-api") {
		t.Fatalf("link-back wrong: %v", back)
	}
	if r, _ := fx.runs.GetRun(ctx, intake.ID); r.Spend.Posts != 1 {
		t.Fatalf("link-back must count as the intake run's post, posts=%d", r.Spend.Posts)
	}
	kick := fx.runsByMode(model.RunModeTask)
	if len(kick) != 1 || kick[0].TaskID != task.ID || kick[0].ThreadRootID != task.ThreadRootID || kick[0].ParentID != wantChan {
		t.Fatalf("kickoff run wrong: %+v", kick)
	}
	if !strings.Contains(kick[0].Prompt, "publish_test_plan") {
		t.Fatalf("kickoff prompt wrong: %q", kick[0].Prompt)
	}

	// One active task per project (v0); a known project needs no repos.
	if _, err := fx.svc.Create(ctx, intake, CreateTaskInput{Project: "booking portal", Title: "Another", Goal: "x"}); !errors.Is(err, ErrTaskActive) {
		t.Fatalf("second task on the project must be refused, got %v", err)
	}
	// Any agent may OPEN a task (a hand-off), but dev is the one who works it.
	ggRun := fx.intakeRun(t, testGGID, "ask2")
	other, err := fx.svc.Create(ctx, ggRun, CreateTaskInput{Project: "Other", Repos: []RepoInput{{Path: "dt/other"}}, Title: "T", Goal: "g"})
	if err != nil {
		t.Fatalf("gg handing off must work, got %v", err)
	}
	if other.Task.AgentID != testDevID || other.Task.Repos[0].Role != model.RepoRoleOther {
		t.Fatalf("tasks are always dev's: %+v", other.Task)
	}

	// Lifecycle reports from the kickoff run: workspace ready with per-repo
	// facts → note + card + project learns the default branch.
	run := kick[0]
	tr := true
	if _, err := fx.svc.Report(ctx, run, TaskUpdate{State: model.TaskStateWorkspaceReady, Note: "📁 Cloned both repos.",
		Repos: []RepoUpdate{{Path: "dt/booking-portal-api", BaseBranch: "develop", WorkspaceDir: "~/ex-workspace/booking-portal/booking-portal-api"}, {Path: "not/in-task", Changed: &tr}}}); err != nil {
		t.Fatalf("report workspace_ready: %v", err)
	}
	got, _ := fx.tasks.GetTask(ctx, task.ID)
	if got.Repo("dt/booking-portal-api").BaseBranch != "develop" || got.Repo("dt/booking-portal-api").WorkspaceDir == "" {
		t.Fatalf("per-repo report not applied: %+v", got.Repos)
	}
	if p, _ := fx.tasks.GetProject(ctx, "booking-portal"); p.Repos[1].DefaultBranch != "develop" {
		t.Fatalf("project must learn the default branch: %+v", p.Repos)
	}
	if body := fx.tmsgs.rewrites[task.ThreadRootID]; !strings.Contains(body, "|workspace_ready|") {
		t.Fatalf("card must be rewritten with the new state, got %q", body)
	}
	if _, err := fx.svc.Report(ctx, run, TaskUpdate{State: model.TaskStateDone}); !errors.Is(err, ErrTaskTransition) {
		t.Fatalf("workspace_ready → done must be refused, got %v", err)
	}

	// Test plan gates: the project has a UI → API-only or URL-less plans are
	// refused; a counter-check is mandatory; a proper plan moves to
	// awaiting_user_test with a requester-facing note.
	apiOnly := model.TestPlan{URL: "http://localhost:8000/api/leave/overview", Steps: []string{"GET /api/leave/overview?include_pending=1 with a Sanctum token"}, CounterSteps: []string{"GET without the param returns the old shape"}}
	if _, err := fx.svc.PublishTestPlan(ctx, run, apiOnly); !errors.Is(err, ErrValidation) {
		t.Fatalf("API-only plan on a UI project must be refused, got %v", err)
	}
	noURL := model.TestPlan{Steps: []string{"Open the leave calendar"}, CounterSteps: []string{"An IC must not see sick-leave types"}}
	if _, err := fx.svc.PublishTestPlan(ctx, run, noURL); !errors.Is(err, ErrValidation) {
		t.Fatalf("plan without a UI URL on a UI project must be refused, got %v", err)
	}
	noCounter := model.TestPlan{URL: "http://localhost:3000/leaves", Steps: []string{"Open the leave calendar as hr1"}}
	if _, err := fx.svc.PublishTestPlan(ctx, run, noCounter); !errors.Is(err, ErrValidation) {
		t.Fatalf("plan without a counter-check must be refused, got %v", err)
	}
	good := model.TestPlan{
		URL:          "http://localhost:3000/leaves",
		Accounts:     "hr1@test.com (HR), ica1@test.com (plain IC) — password in the dev seed",
		Steps:        []string{"Sign in as hr1 and open Leaves → Overview for Feb 2026", "Tick 'include pending' — 6 pending rows appear with an orange pill"},
		CounterSteps: []string{"Sign in as ica1: sick leave shows as 'Time off', never the real type", "Untick both options: the list is exactly what it was before this change"},
	}
	tk, err := fx.svc.PublishTestPlan(ctx, run, good)
	if err != nil || tk.State != model.TaskStateAwaitingTest || tk.TestPlan == nil || tk.TestPlan.URL != good.URL {
		t.Fatalf("publish test plan: %v %+v", err, tk)
	}
	notes := fx.tmsgs.postsIn(wantChan, task.ThreadRootID)
	last := notes[len(notes)-1]
	for _, want := range []string{"Ready to test", "http://localhost:3000/leaves", "Should work", "1. Sign in as hr1", "Should NOT work", "Sign in as ica1", "Alice's machine"} {
		if !strings.Contains(last, want) {
			t.Fatalf("test-plan note missing %q:\n%s", want, last)
		}
	}

	// The MR gate.
	if status, _, err := fx.svc.RequestMR(ctx, run, ""); err != nil || status != MRStatusAsk {
		t.Fatalf("request_mr before sign-off must ask, got %q %v", status, err)
	}
	if status, _, _ := fx.svc.RequestMR(ctx, run, "bogus"); status != MRStatusDenied {
		t.Fatalf("unknown approval must be denied, got %q", status)
	}
	if _, err := fx.svc.Report(ctx, run, TaskUpdate{State: model.TaskStateMRCreated, Repos: []RepoUpdate{{Path: "dt/booking-portal-api", MRURL: "https://gitlab/x/-/merge_requests/1"}}}); !errors.Is(err, ErrTaskTransition) {
		t.Fatalf("mr_created without sign-off must be refused, got %v", err)
	}
	if _, err := fx.svc.SignOff(ctx, "u-bob", task.ID); !errors.Is(err, ErrNotRequester) {
		t.Fatalf("bob sign-off must be refused, got %v", err)
	}
	_ = fx.orch.cancelRun(ctx, run, "u-alice")
	signed, err := fx.svc.SignOff(ctx, "u-alice", task.ID)
	if err != nil || signed.SignedOffAt == nil {
		t.Fatalf("alice sign-off: %v %+v", err, signed)
	}
	var mrRun *model.Run
	for _, r := range fx.runsByMode(model.RunModeTask) {
		if r.TaskID == task.ID && r.ID != run.ID {
			mrRun = r
		}
	}
	if mrRun == nil || !strings.Contains(mrRun.Prompt, "request_mr") {
		t.Fatalf("sign-off must start the MR run: %+v", mrRun)
	}
	if status, _, err := fx.svc.RequestMR(ctx, mrRun, ""); err != nil || status != MRStatusApproved {
		t.Fatalf("request_mr after sign-off must be approved, got %q %v", status, err)
	}
	// mr_created needs at least one MR URL even after sign-off.
	if _, err := fx.svc.Report(ctx, mrRun, TaskUpdate{State: model.TaskStateMRCreated}); !errors.Is(err, ErrTaskTransition) {
		t.Fatalf("mr_created without an MR URL must be refused, got %v", err)
	}
	done, err := fx.svc.Report(ctx, mrRun, TaskUpdate{State: model.TaskStateMRCreated, Repos: []RepoUpdate{
		{Path: "dt/booking-portal-frontend", MRURL: "https://gitlab/fe/-/merge_requests/7", Changed: &tr},
		{Path: "dt/booking-portal-api", MRURL: "https://gitlab/api/-/merge_requests/3", Changed: &tr},
	}})
	if err != nil || done.State != model.TaskStateMRCreated || len(done.MRURLs()) != 2 {
		t.Fatalf("mr_created after sign-off: %v %+v", err, done)
	}
	if body := fx.tmsgs.rewrites[task.ThreadRootID]; !strings.Contains(body, "|mr_created|") {
		t.Fatalf("card must show mr_created, got %q", body)
	}
	if _, err := fx.svc.SetSteering(ctx, "u-bob", task.ID, model.TaskSteeringAnyone); !errors.Is(err, ErrNotRequester) {
		t.Fatalf("bob toggling steering must be refused, got %v", err)
	}
	if st, err := fx.svc.SetSteering(ctx, "u-alice", task.ID, model.TaskSteeringAnyone); err != nil || st.Steering != model.TaskSteeringAnyone {
		t.Fatalf("alice toggling steering: %v %+v", err, st)
	}
}

func TestCodingTaskService_KnownProjectAndChannelFallback(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	// A human channel already owns ~cliffhub: the project channel falls back
	// to "cliffhub code", keyed by the derived ID either way.
	fx.chans.channels["human"] = &model.Channel{ID: "human", Name: "CliffHub", Slug: "cliffhub"}
	fx.chans.members["human"] = map[string]bool{}
	run := fx.intakeRun(t, testDevID, "ask3")
	res, err := fx.svc.Create(ctx, run, CreateTaskInput{Project: "CliffHub", Repos: []RepoInput{{Path: "dtolk/internal-tools/cliffhub-2-backend", Role: "backend"}}, Title: "T", Goal: "g"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if res.Channel.ID != ProjectChannelID("cliffhub") || res.Channel.Slug != "cliffhub-code" {
		t.Fatalf("expected the '<name> code' fallback, got %+v", res.Channel)
	}
	// Finish it, then a later task on the same product with a NEW repo (the
	// frontend) reuses the channel, defaults to the known repos, and the
	// project learns the frontend.
	tk, _ := fx.tasks.GetTask(ctx, res.Task.ID)
	tk.State = model.TaskStateDone
	_ = fx.tasks.UpdateTask(ctx, tk, model.TaskStateCreated)
	res2, err := fx.svc.Create(ctx, run, CreateTaskInput{Project: "cliffhub", Repos: []RepoInput{
		{Path: "dtolk/internal-tools/cliffhub-2-backend", Role: "backend"},
		{Path: "dtolk/internal-tools/cliffhub-2-frontend", Role: "frontend"},
	}, Title: "T2", Goal: "g2"})
	if err != nil {
		t.Fatalf("second task: %v", err)
	}
	if res2.ChannelCreated || res2.ProjectCreated || res2.Channel.ID != res.Channel.ID || len(res2.Task.Repos) != 2 {
		t.Fatalf("second task must reuse the project channel and take both repos: %+v", res2)
	}
	if p, _ := fx.tasks.GetProject(ctx, "cliffhub"); len(p.Repos) != 2 || !res2.Task.HasRole(model.RepoRoleFrontend) {
		t.Fatalf("project must learn the new repo: %+v", p)
	}
	tk2, _ := fx.tasks.GetTask(ctx, res2.Task.ID)
	tk2.State = model.TaskStateDone
	_ = fx.tasks.UpdateTask(ctx, tk2, model.TaskStateCreated)
	// Third task, no repos given → defaults to every known repo.
	res3, err := fx.svc.Create(ctx, run, CreateTaskInput{Project: "CliffHub", Title: "T3", Goal: "g3"})
	if err != nil || len(res3.Task.Repos) != 2 {
		t.Fatalf("known project must default to its repos: %v %+v", err, res3)
	}
}

func TestTaskTransitions(t *testing.T) {
	ok := [][2]model.TaskState{
		{model.TaskStateCreated, model.TaskStateWorkspaceReady},
		{model.TaskStateWorkspaceReady, model.TaskStateInProgress},
		{model.TaskStateInProgress, model.TaskStateAwaitingTest},
		{model.TaskStateAwaitingTest, model.TaskStateInProgress},
		{model.TaskStateAwaitingTest, model.TaskStateMRCreated},
		{model.TaskStateMRCreated, model.TaskStateDone},
		{model.TaskStateMRCreated, model.TaskStateInProgress},
		{model.TaskStateSetupFailed, model.TaskStateInProgress},
		{model.TaskStateInProgress, model.TaskStateInProgress},
	}
	for _, e := range ok {
		if !model.CanTransition(e[0], e[1]) {
			t.Errorf("%s → %s should be allowed", e[0], e[1])
		}
	}
	bad := [][2]model.TaskState{
		{model.TaskStateCreated, model.TaskStateMRCreated},
		{model.TaskStateInProgress, model.TaskStateMRCreated},
		{model.TaskStateInProgress, model.TaskStateDone},
		{model.TaskStateDone, model.TaskStateInProgress},
		{model.TaskStateAbandoned, model.TaskStateCreated},
	}
	for _, e := range bad {
		if model.CanTransition(e[0], e[1]) {
			t.Errorf("%s → %s must be refused", e[0], e[1])
		}
	}
	if !model.ValidProjectPath("dt/booking-portal") || model.ValidProjectPath("booking-portal") || model.ValidProjectPath("a/../b") {
		t.Error("project path validation wrong")
	}
	if ProjectKey("CliffHub") != "cliffhub" || ProjectKey("  Booking Portal ") != "booking-portal" {
		t.Error("project key derivation wrong")
	}
	if TaskMarker(&model.CodingTask{ID: "x", Title: "a|b [c]", State: model.TaskStateCreated, Kind: "bug", ProjectName: "Cliff|Hub"}) != "[task:x|a b  c |created|bug|Cliff Hub]" {
		t.Error("marker must strip marker syntax from the title and project")
	}
	if !looksLikeAPIOnly(model.TestPlan{Steps: []string{"curl -H auth http://x/api/y", "GET /api/z"}}) || looksLikeAPIOnly(model.TestPlan{Steps: []string{"Open Leaves and click Overview"}}) {
		t.Error("API-only detection wrong")
	}
}

func TestCodingTask_LegacyRowsNormalizeAndSignOffRetries(t *testing.T) {
	// A row written by the single-repo model: no repos/project, legacy fields.
	legacy := &model.CodingTask{
		ID: "old", Title: "CS-7", Kind: model.TaskKindFeature, State: model.TaskStateAwaitingTest,
		ChannelID: "chan-old", ThreadRootID: "card-old", RequesterID: "u-alice", AgentID: testDevID,
		LegacyProjectPath: "dtolk/internal-tools/cliffhub-2-backend", LegacyBranch: "ex/task-qnt6r3-cs-7",
		LegacyBaseBranch: "main", LegacyWorkspaceDir: "~/ex-workspace/dtolk/internal-tools/cliffhub-2-backend",
		LegacyTestURL: "http://localhost:8000/api/leave/overview", LegacyTestNotes: "hit it with your token",
	}
	legacy.NormalizeLegacy()
	if len(legacy.Repos) != 1 || legacy.Repos[0].Path != "dtolk/internal-tools/cliffhub-2-backend" || legacy.Repos[0].Branch != "ex/task-qnt6r3-cs-7" || legacy.Repos[0].BaseBranch != "main" {
		t.Fatalf("legacy repo not folded into Repos: %+v", legacy.Repos)
	}
	if legacy.ProjectKey != "cliffhub-2-backend" || legacy.ProjectName != "cliffhub-2-backend" {
		t.Fatalf("legacy project naming wrong: %q %q", legacy.ProjectKey, legacy.ProjectName)
	}
	if legacy.TestPlan == nil || legacy.TestPlan.URL != "http://localhost:8000/api/leave/overview" || len(legacy.TestPlan.Steps) != 2 {
		t.Fatalf("legacy test link not folded into a plan: %+v", legacy.TestPlan)
	}
	if legacy.LegacyProjectPath != "" || legacy.LegacyTestURL != "" {
		t.Fatal("legacy fields must be cleared after normalization")
	}
	legacy.NormalizeLegacy() // idempotent
	if len(legacy.Repos) != 1 {
		t.Fatal("normalization must be idempotent")
	}

	// Sign-off on a task whose MR run died: the second click retries instead
	// of returning silently.
	fx := newTaskFixture(t)
	ctx := context.Background()
	task := fx.seedTask(model.TaskStateAwaitingTest)
	if _, err := fx.svc.SignOff(ctx, "u-alice", task.ID); err != nil {
		t.Fatalf("sign-off: %v", err)
	}
	first := fx.runsByMode(model.RunModeTask)
	if len(first) != 1 {
		t.Fatalf("expected the MR run, got %d", len(first))
	}
	// The MR run fails (e.g. workspace_failed) — the task is still awaiting.
	if err := fx.orch.failRun(ctx, first[0], "workspace_failed"); err != nil {
		t.Fatalf("fail run: %v", err)
	}
	got, err := fx.svc.SignOff(ctx, "u-alice", task.ID)
	if err != nil || got.SignedOffAt == nil {
		t.Fatalf("retry sign-off: %v", err)
	}
	if runs := fx.runsByMode(model.RunModeTask); len(runs) != 2 {
		t.Fatalf("second click must start another MR run, got %d", len(runs))
	}
	notes := fx.tmsgs.postsIn("chan1", "card1")
	if !strings.Contains(strings.Join(notes, "\n"), "Retrying the merge-request step") {
		t.Fatalf("retry must be announced in the thread: %v", notes)
	}
}
