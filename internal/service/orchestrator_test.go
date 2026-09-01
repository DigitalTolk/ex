package service

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// ---------------------------------------------------------------- fakes

// fakeRunStore is an in-memory orchestratorRunStore with the same
// conditional-write semantics as the DynamoDB implementation.
type fakeRunStore struct {
	mu        sync.Mutex
	runs      map[string]*model.Run
	queue     map[string][]string // ownerID -> runIDs
	events    map[string]map[int64]*model.RunEvent
	digest    map[string]*model.RunDigest
	approvals map[string]*model.Approval // runID#approvalID
	artifacts map[string][]*model.Artifact
}

func newFakeRunStore() *fakeRunStore {
	return &fakeRunStore{
		runs:      map[string]*model.Run{},
		queue:     map[string][]string{},
		events:    map[string]map[int64]*model.RunEvent{},
		digest:    map[string]*model.RunDigest{},
		approvals: map[string]*model.Approval{},
		artifacts: map[string][]*model.Artifact{},
	}
}

func (f *fakeRunStore) CreateRun(_ context.Context, run *model.Run) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.runs[run.ID]; ok {
		return store.ErrAlreadyExists
	}
	cp := *run
	f.runs[run.ID] = &cp
	f.queue[run.OwnerID] = append(f.queue[run.OwnerID], run.ID)
	return nil
}

func (f *fakeRunStore) GetRun(_ context.Context, runID string) (*model.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	run, ok := f.runs[runID]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *run
	return &cp, nil
}

func (f *fakeRunStore) UpdateRun(_ context.Context, run *model.Run, expect model.RunState) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur, ok := f.runs[run.ID]
	if !ok {
		return store.ErrNotFound
	}
	if cur.State != expect {
		return store.ErrStaleRun
	}
	cp := *run
	f.runs[run.ID] = &cp
	return nil
}

func (f *fakeRunStore) RenewRunLease(_ context.Context, runID, runnerID string, lease time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur, ok := f.runs[runID]
	if !ok {
		return store.ErrNotFound
	}
	if cur.State.Terminal() || cur.RunnerID != runnerID {
		return store.ErrStaleRun
	}
	// Mutate ONLY the lease + updatedAt in place, mirroring the surgical partial
	// update — never touching Spend or any other field.
	l := lease
	cur.LeaseExpiresAt = &l
	cur.UpdatedAt = time.Now()
	return nil
}

func (f *fakeRunStore) ListQueuedRuns(_ context.Context, ownerID string, limit int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	q := f.queue[ownerID]
	if len(q) > limit {
		q = q[:limit]
	}
	return append([]string(nil), q...), nil
}

func (f *fakeRunStore) ClaimRun(_ context.Context, run *model.Run, runnerID string, lease time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cur, ok := f.runs[run.ID]
	if !ok {
		return store.ErrNotFound
	}
	if cur.State != model.RunStateQueued {
		return store.ErrStaleRun
	}
	cur.State = model.RunStateAcknowledged
	cur.RunnerID = runnerID
	cur.LeaseExpiresAt = &lease
	q := f.queue[cur.OwnerID]
	for i, id := range q {
		if id == run.ID {
			f.queue[cur.OwnerID] = append(q[:i], q[i+1:]...)
			break
		}
	}
	*run = *cur
	return nil
}

func (f *fakeRunStore) DeleteQueueEntry(_ context.Context, ownerID, runID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	q := f.queue[ownerID]
	for i, id := range q {
		if id == runID {
			f.queue[ownerID] = append(q[:i], q[i+1:]...)
			break
		}
	}
	return nil
}

func (f *fakeRunStore) ListActiveRunsPastDeadline(_ context.Context, now time.Time, _ int) ([]*model.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.Run
	for _, r := range f.runs {
		if !r.State.Terminal() && r.Deadline.Before(now) {
			cp := *r
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (f *fakeRunStore) ListActiveRuns(_ context.Context) ([]*model.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.Run
	for _, r := range f.runs {
		if !r.State.Terminal() {
			cp := *r
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (f *fakeRunStore) AppendRunEvent(_ context.Context, evt *model.RunEvent) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	byseq, ok := f.events[evt.RunID]
	if !ok {
		byseq = map[int64]*model.RunEvent{}
		f.events[evt.RunID] = byseq
	}
	if _, dup := byseq[evt.Seq]; dup {
		return nil // idempotent, like the conditional put
	}
	cp := *evt
	byseq[evt.Seq] = &cp
	return nil
}

func (f *fakeRunStore) ListRunEvents(_ context.Context, runID string) ([]*model.RunEvent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.RunEvent
	for _, e := range f.events[runID] {
		cp := *e
		out = append(out, &cp)
	}
	return out, nil
}

func (f *fakeRunStore) PutDigest(_ context.Context, d *model.RunDigest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *d
	f.digest[d.RunID] = &cp
	return nil
}

func (f *fakeRunStore) GetDigest(_ context.Context, runID string) (*model.RunDigest, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.digest[runID]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *d
	return &cp, nil
}

func (f *fakeRunStore) ListRunsByParent(_ context.Context, parentID string, limit int) ([]*model.Run, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.Run
	for _, r := range f.runs {
		if r.ParentID == parentID && len(out) < limit {
			cp := *r
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (f *fakeRunStore) PutApproval(_ context.Context, a *model.Approval) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *a
	f.approvals[a.RunID+"#"+a.ID] = &cp
	return nil
}

func (f *fakeRunStore) GetApproval(_ context.Context, runID, approvalID string) (*model.Approval, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.approvals[runID+"#"+approvalID]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *a
	return &cp, nil
}

func (f *fakeRunStore) SettleApproval(_ context.Context, runID, approvalID, state, decidedBy, choice, note string, decidedAt time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.approvals[runID+"#"+approvalID]
	if !ok {
		return store.ErrNotFound
	}
	if a.State != model.ApprovalPending {
		return store.ErrStaleApproval
	}
	a.State = state
	a.DecidedBy = decidedBy
	a.Choice = choice
	a.Note = note
	a.DecidedAt = &decidedAt
	return nil
}

func (f *fakeRunStore) ListApprovals(_ context.Context, runID string) ([]*model.Approval, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.Approval
	for k, a := range f.approvals {
		if strings.HasPrefix(k, runID+"#") {
			cp := *a
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (f *fakeRunStore) PutArtifact(_ context.Context, a *model.Artifact) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *a
	f.artifacts[a.RunID] = append(f.artifacts[a.RunID], &cp)
	return nil
}

func (f *fakeRunStore) ListArtifacts(_ context.Context, runID string) ([]*model.Artifact, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]*model.Artifact, 0, len(f.artifacts[runID]))
	for _, a := range f.artifacts[runID] {
		cp := *a
		out = append(out, &cp)
	}
	return out, nil
}

// fakeAgentDir is an in-memory AgentDirectoryStore.
type fakeAgentDir struct {
	mu        sync.Mutex
	templates map[string]*model.AgentTemplate
	agents    map[string]*model.User           // shared agent users, by ID
	prefs     map[string]*model.UserAgentPrefs // key: userID+"#"+slug
	runners   map[string][]*model.RunnerRegistration
	skills    map[string]*model.Skill
	memories  map[string]*model.AgentMemory       // invokerID#agentID
	subs      map[string]*model.AgentSubscription // by ID
	claims    map[string]*model.TaskClaim         // parentID#threadRoot#label
	follows   map[string]*model.AgentThreadFollow // parentID#threadRoot#agentID#invokerID
}

func newFakeAgentDir() *fakeAgentDir {
	return &fakeAgentDir{
		templates: map[string]*model.AgentTemplate{},
		agents:    map[string]*model.User{},
		prefs:     map[string]*model.UserAgentPrefs{},
		runners:   map[string][]*model.RunnerRegistration{},
	}
}

func (f *fakeAgentDir) PutTemplate(_ context.Context, tpl *model.AgentTemplate) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *tpl
	f.templates[tpl.Slug] = &cp
	return nil
}

func (f *fakeAgentDir) CreateTemplateIfAbsent(ctx context.Context, tpl *model.AgentTemplate) error {
	f.mu.Lock()
	if _, ok := f.templates[tpl.Slug]; ok {
		f.mu.Unlock()
		return store.ErrAlreadyExists
	}
	f.mu.Unlock()
	return f.PutTemplate(ctx, tpl)
}

func (f *fakeAgentDir) GetTemplate(_ context.Context, slug string) (*model.AgentTemplate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	tpl, ok := f.templates[slug]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *tpl
	return &cp, nil
}

func (f *fakeAgentDir) ListTemplates(_ context.Context) ([]*model.AgentTemplate, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.AgentTemplate
	for _, t := range f.templates {
		cp := *t
		out = append(out, &cp)
	}
	return out, nil
}

func (f *fakeAgentDir) CreateAgentUser(_ context.Context, user *model.User) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.agents[user.ID]; ok {
		return store.ErrAlreadyExists
	}
	cp := *user
	f.agents[user.ID] = &cp
	return nil
}

func (f *fakeAgentDir) PutAgentPrefs(_ context.Context, prefs *model.UserAgentPrefs) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *prefs
	f.prefs[prefs.UserID+"#"+prefs.Slug] = &cp
	return nil
}

func (f *fakeAgentDir) GetAgentPrefs(_ context.Context, userID, slug string) (*model.UserAgentPrefs, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	p, ok := f.prefs[userID+"#"+slug]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *p
	return &cp, nil
}

func (f *fakeAgentDir) PutRunner(_ context.Context, reg *model.RunnerRegistration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *reg
	regs := f.runners[reg.OwnerID]
	for i, r := range regs {
		if r.RunnerID == reg.RunnerID {
			regs[i] = &cp
			return nil
		}
	}
	f.runners[reg.OwnerID] = append(regs, &cp)
	return nil
}

func (f *fakeAgentDir) ListRunners(_ context.Context, ownerID string) ([]*model.RunnerRegistration, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.RunnerRegistration
	for _, r := range f.runners[ownerID] {
		cp := *r
		out = append(out, &cp)
	}
	return out, nil
}

func (f *fakeAgentDir) PutSkill(_ context.Context, sk *model.Skill) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.skills == nil {
		f.skills = map[string]*model.Skill{}
	}
	cp := *sk
	f.skills[sk.ID] = &cp
	return nil
}

func (f *fakeAgentDir) GetSkill(_ context.Context, id string) (*model.Skill, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	sk, ok := f.skills[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *sk
	return &cp, nil
}

func (f *fakeAgentDir) ListSkills(_ context.Context) ([]*model.Skill, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.Skill
	for _, sk := range f.skills {
		cp := *sk
		out = append(out, &cp)
	}
	return out, nil
}

func (f *fakeAgentDir) DeleteSkill(_ context.Context, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.skills, id)
	return nil
}

func (f *fakeAgentDir) PutAgentMemory(_ context.Context, m *model.AgentMemory) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.memories == nil {
		f.memories = map[string]*model.AgentMemory{}
	}
	cp := *m
	f.memories[m.InvokerID+"#"+m.AgentID] = &cp
	return nil
}

func (f *fakeAgentDir) GetAgentMemory(_ context.Context, invokerID, agentID string) (*model.AgentMemory, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, ok := f.memories[invokerID+"#"+agentID]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *m
	return &cp, nil
}

func (f *fakeAgentDir) PutAgentSubscription(_ context.Context, sub *model.AgentSubscription) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.subs == nil {
		f.subs = map[string]*model.AgentSubscription{}
	}
	cp := *sub
	f.subs[sub.ID] = &cp
	return nil
}

func (f *fakeAgentDir) ListSubscriptionsByParent(_ context.Context, parentID string) ([]*model.AgentSubscription, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.AgentSubscription
	for _, sub := range f.subs {
		if sub.ParentID == parentID {
			cp := *sub
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (f *fakeAgentDir) ListAllSubscriptions(_ context.Context) ([]*model.AgentSubscription, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.AgentSubscription
	for _, sub := range f.subs {
		cp := *sub
		out = append(out, &cp)
	}
	return out, nil
}

func (f *fakeAgentDir) DeleteAgentSubscription(_ context.Context, _, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.subs, id)
	return nil
}

func (f *fakeAgentDir) PutTaskClaim(_ context.Context, c *model.TaskClaim) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.claims == nil {
		f.claims = map[string]*model.TaskClaim{}
	}
	key := c.ParentID + "#" + c.ThreadRootID + "#" + c.Label
	if _, taken := f.claims[key]; taken {
		return store.ErrClaimTaken
	}
	cp := *c
	f.claims[key] = &cp
	return nil
}

func (f *fakeAgentDir) ListTaskClaims(_ context.Context, parentID, threadRootID string) ([]*model.TaskClaim, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.TaskClaim
	for _, c := range f.claims {
		if c.ParentID == parentID && c.ThreadRootID == threadRootID {
			out = append(out, c)
		}
	}
	return out, nil
}

func (f *fakeAgentDir) PutAgentFollow(_ context.Context, af *model.AgentThreadFollow) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.follows == nil {
		f.follows = map[string]*model.AgentThreadFollow{}
	}
	cp := *af
	f.follows[af.ParentID+"#"+af.ThreadRootID+"#"+af.AgentID+"#"+af.InvokerID] = &cp
	return nil
}

func (f *fakeAgentDir) ListAgentFollows(_ context.Context, parentID, threadRootID string) ([]*model.AgentThreadFollow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.AgentThreadFollow
	for _, af := range f.follows {
		if af.ParentID == parentID && af.ThreadRootID == threadRootID {
			out = append(out, af)
		}
	}
	return out, nil
}

func (f *fakeAgentDir) DeleteRunner(_ context.Context, ownerID, runnerID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	regs := f.runners[ownerID]
	for i, r := range regs {
		if r.RunnerID == runnerID {
			f.runners[ownerID] = append(regs[:i], regs[i+1:]...)
			break
		}
	}
	return nil
}

// fakeOrchMessages records posts and reactions.
type fakeOrchMessages struct {
	mu        sync.Mutex
	posts     []string
	postDest  []string // parentType|parentID for the matching posts entry
	reactions []string
	// thread backs ListThreadMessages/List for bundle-rendering tests.
	thread []*model.Message
}

func (f *fakeOrchMessages) SendAsAgentRun(_ context.Context, _, _, parentID, parentType, body, _, _ string) (*model.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.posts = append(f.posts, body)
	f.postDest = append(f.postDest, parentType+"|"+parentID)
	return &model.Message{ID: "m-posted", Body: body}, nil
}

func (f *fakeOrchMessages) SetMachineReaction(_ context.Context, _, _, _, _, state string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reactions = append(f.reactions, state)
	return nil
}

func (f *fakeOrchMessages) ListThreadMessages(_ context.Context, _, _, _, _ string) ([]*model.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*model.Message(nil), f.thread...), nil
}

func (f *fakeOrchMessages) List(_ context.Context, _, _, _, _ string, _ int) ([]*model.Message, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	// Newest-first, like the real List.
	out := make([]*model.Message, 0, len(f.thread))
	for i := len(f.thread) - 1; i >= 0; i-- {
		out = append(out, f.thread[i])
	}
	return out, false, nil
}

func (f *fakeOrchMessages) lastPost() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.posts) == 0 {
		return ""
	}
	return f.posts[len(f.posts)-1]
}

func (f *fakeOrchMessages) lastReaction() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.reactions) == 0 {
		return ""
	}
	return f.reactions[len(f.reactions)-1]
}

// fakeUsers implements orchestratorUsers.
type fakeUsers struct {
	users map[string]*model.User
}

func (f *fakeUsers) GetUser(_ context.Context, id string) (*model.User, error) {
	u, ok := f.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *u
	return &cp, nil
}

func (f *fakeUsers) UpdateUser(_ context.Context, user *model.User) error {
	if _, ok := f.users[user.ID]; !ok {
		return store.ErrNotFound
	}
	cp := *user
	f.users[user.ID] = &cp
	return nil
}

func (f *fakeUsers) GetUsersByIDs(_ context.Context, ids []string) ([]*model.User, error) {
	var out []*model.User
	for _, id := range ids {
		if u, ok := f.users[id]; ok {
			cp := *u
			out = append(out, &cp)
		}
	}
	return out, nil
}

type fakePub struct{}

func (fakePub) Publish(_ context.Context, _ string, _ *events.Event) error { return nil }

type fakeMinter struct{}

func (fakeMinter) GenerateRunToken(_, _, _ string, _ time.Time) (string, error) {
	return "run-token", nil
}

// ---------------------------------------------------------------- harness

type orchFixture struct {
	orch  *Orchestrator
	runs  *fakeRunStore
	msgs  *fakeOrchMessages
	users *fakeUsers
	dir   *fakeAgentDir
	now   *time.Time
}

// Deterministic shared-agent IDs, matching what SeedDefaults derives — so
// roster lookups (linkify, chaining) resolve in tests exactly as in prod.
var (
	testGGID  = AgentUserID(AgentSlugGG)
	testQibID = AgentUserID(AgentSlugQib)
)

func newOrchFixture(t *testing.T) *orchFixture {
	t.Helper()
	dir := newFakeAgentDir()
	human := &model.User{ID: "u-alice", DisplayName: "Alice"}
	// gg/qib are SHARED agents — owned by no one; runs execute on the
	// invoker's machine with the invoker's prefs.
	gg := &model.User{
		ID:          testGGID,
		DisplayName: "gg",
		Kind:        model.UserKindAgent,
		AgentConfig: &model.AgentConfig{TemplateSlug: AgentSlugGG},
	}
	qib := &model.User{
		ID:          testQibID,
		DisplayName: "qib",
		Kind:        model.UserKindAgent,
		AgentConfig: &model.AgentConfig{TemplateSlug: AgentSlugQib},
	}
	users := &fakeUsers{users: map[string]*model.User{human.ID: human, gg.ID: gg, qib.ID: qib}}
	agentSvc := NewAgentService(dir, users)
	if err := agentSvc.SeedDefaults(context.Background()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// The INVOKER (alice) has an online runner with claude, so invocations
	// pass the liveness gate.
	_ = dir.PutRunner(context.Background(), &model.RunnerRegistration{
		RunnerID: "r1", OwnerID: "u-alice",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessClaude}},
		LeaseExpiresAt: time.Now().Add(time.Hour),
	})
	runs := newFakeRunStore()
	msgs := &fakeOrchMessages{}
	orch := NewOrchestrator(runs, agentSvc, users, msgs, fakePub{}, fakeMinter{})
	now := time.Now()
	orch.now = func() time.Time { return now }
	return &orchFixture{orch: orch, runs: runs, msgs: msgs, users: users, dir: dir, now: &now}
}

func (fx *orchFixture) startRun(t *testing.T) *model.Run {
	t.Helper()
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] summarize"}
	agent, _ := fx.users.GetUser(context.Background(), testGGID)
	invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
	resolved, err := fx.orch.agentSvc.Resolve(context.Background(), agent, invoker.ID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	run, err := fx.orch.StartRun(context.Background(), agent, invoker, msg, ParentChannel, resolved, 0, nil)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	if run.OwnerID != invoker.ID {
		t.Fatalf("run must execute on the INVOKER's machine, got owner %q", run.OwnerID)
	}
	return run
}

func (fx *orchFixture) claim(t *testing.T) Assignment {
	t.Helper()
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(as) != 1 {
		t.Fatalf("expected 1 assignment, got %d", len(as))
	}
	return as[0]
}

// ---------------------------------------------------------------- tests

func TestOrchestrator_TurnCapAborts(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	maxTurns := run.Limits.TurnsFor(run.Mode) // direct runs get the task budget
	var batch []RunEventInput
	for i := 0; i <= maxTurns; i++ { // one past the cap
		batch = append(batch, RunEventInput{Seq: int64(i + 1), Type: "turn"})
	}
	abort, reason, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, batch)
	if err != nil {
		t.Fatalf("report: %v", err)
	}
	if !abort || reason != "turn_limit" {
		t.Fatalf("expected turn_limit abort, got abort=%v reason=%q", abort, reason)
	}
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed || got.FailReason != "turn_limit" {
		t.Fatalf("run not failed on turn limit: %+v", got)
	}
	if !strings.Contains(fx.msgs.lastPost(), "turn limit") {
		t.Fatalf("no convergence notice posted, got %q", fx.msgs.lastPost())
	}
	if fx.msgs.lastReaction() != StateEmojiFailed {
		t.Fatalf("expected ❌ state, got %q", fx.msgs.lastReaction())
	}
}

func TestOrchestrator_TokenBudgetAborts(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	abort, reason, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{
		{Seq: 1, Type: "usage", Payload: map[string]any{
			"inputTokens": float64(run.Limits.MaxTokens), "outputTokens": float64(1),
		}},
	})
	if err != nil {
		t.Fatalf("report: %v", err)
	}
	if !abort || reason != "token_budget" {
		t.Fatalf("expected token_budget abort, got abort=%v reason=%q", abort, reason)
	}
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed {
		t.Fatalf("run not failed on token budget: %+v", got)
	}
}

func TestOrchestrator_UsageReportsClamped(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	// A single absurd report is clamped, not trusted — but even the clamped
	// figure blows the budget, so the run still converges to failed.
	abort, reason, _ := fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{
		{Seq: 1, Type: "usage", Payload: map[string]any{"inputTokens": float64(1 << 60)}},
	})
	if !abort || reason != "token_budget" {
		t.Fatalf("expected token_budget abort, got abort=%v reason=%q", abort, reason)
	}
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.Spend.InputTokens > maxUsageReport {
		t.Fatalf("usage not clamped: %d", got.Spend.InputTokens)
	}
}

func TestOrchestrator_DeadlineAborts(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	// Direct runs carry the (long) task cap — advance past that.
	*fx.now = fx.now.Add(run.Limits.WallClockFor(run.Mode) + 10*time.Second)
	abort, reason, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{
		{Seq: 1, Type: "turn"},
	})
	if err != nil {
		t.Fatalf("report: %v", err)
	}
	if !abort || reason != "deadline" {
		t.Fatalf("expected deadline abort, got abort=%v reason=%q", abort, reason)
	}
}

func TestOrchestrator_LeaseExpiryFailsRun(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	// Lease lapses without a heartbeat: the timer path must fail the run as
	// runner_lost — the closed-laptop case (plan-v2 §11).
	*fx.now = fx.now.Add(runLeaseTTL + 5*time.Second)
	fx.orch.onLeaseExpired(run.ID)

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed || got.FailReason != "runner_lost" {
		t.Fatalf("expected runner_lost failure, got %+v", got)
	}
}

func TestOrchestrator_RenewedLeaseSurvivesTimerFire(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	// Heartbeat renews the lease; a stale timer firing afterwards must NOT
	// kill the run.
	reg := &model.RunnerRegistration{RunnerID: "r1", OwnerID: "u-alice",
		Harnesses: []model.RunnerHarness{{Name: model.HarnessClaude}}}
	if _, err := fx.orch.Heartbeat(context.Background(), reg, []string{run.ID}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	fx.orch.onLeaseExpired(run.ID)
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State.Terminal() {
		t.Fatalf("renewed run killed by stale timer: %+v", got)
	}
}

func TestOrchestrator_ClaimRaceSingleWinner(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)

	a1, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil {
		t.Fatalf("claim 1: %v", err)
	}
	a2, err := fx.orch.Claim(context.Background(), "u-alice", "r2", []string{model.HarnessClaude}, 1, 0)
	if err != nil {
		t.Fatalf("claim 2: %v", err)
	}
	if len(a1)+len(a2) != 1 {
		t.Fatalf("run claimed %d times", len(a1)+len(a2))
	}
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.RunnerID != "r1" {
		t.Fatalf("wrong claim winner: %q", got.RunnerID)
	}
}

func TestOrchestrator_WrongRunnerRejected(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	abort, reason, err := fx.orch.ReportEvents(context.Background(), "r-evil", run.ID, []RunEventInput{
		{Seq: 1, Type: "turn"},
	})
	if !abort || reason != "wrong_runner" || err == nil {
		t.Fatalf("expected wrong_runner rejection, got abort=%v reason=%q err=%v", abort, reason, err)
	}
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.Spend.Turns != 0 {
		t.Fatalf("foreign runner mutated spend: %+v", got.Spend)
	}
}

func TestOrchestrator_TerminalRunRejectsEverything(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "done!", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	abort, _, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{{Seq: 9, Type: "turn"}})
	if !abort || err == nil {
		t.Fatal("terminal run accepted events")
	}
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "again", nil); err == nil {
		t.Fatal("double complete accepted")
	}
	if _, err := fx.orch.GetLiveRun(context.Background(), run.ID); err == nil {
		t.Fatal("GetLiveRun returned a terminal run")
	}
}

func TestOrchestrator_CompletePostsFinalTextWhenAgentNeverPosted(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "the summary", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if fx.msgs.lastPost() != "the summary" {
		t.Fatalf("final text not posted, got %q", fx.msgs.lastPost())
	}
	if fx.msgs.lastReaction() != StateEmojiDone {
		t.Fatalf("expected ✅, got %q", fx.msgs.lastReaction())
	}
	if fx.runs.digest[run.ID] == nil || fx.runs.digest[run.ID].Summary != "the summary" {
		t.Fatalf("digest missing/wrong: %+v", fx.runs.digest[run.ID])
	}
}

func TestOrchestrator_EventAppendIdempotent(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	batch := []RunEventInput{{Seq: 1, Type: "tool", Payload: map[string]any{"name": "post_message"}}}
	if _, _, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, batch); err != nil {
		t.Fatalf("report 1: %v", err)
	}
	if _, _, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, batch); err != nil {
		t.Fatalf("report 2 (retry): %v", err)
	}
	evts, _ := fx.runs.ListRunEvents(context.Background(), run.ID)
	count := 0
	for _, e := range evts {
		if e.Type == "tool" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("retried batch duplicated timeline: %d tool events", count)
	}
}

func TestOrchestrator_MentionGatedInvocation(t *testing.T) {
	fx := newOrchFixture(t)

	// Agent-authored message mentioning another agent must start nothing:
	// no self-triggering, no agent-triggers-agent at Phase 1.
	agentMsg := &model.Message{ID: "m2", ParentID: "chan1", AuthorID: testGGID, Body: "@[" + testGGID + "|gg] loop!"}
	fx.orch.OnMessage(context.Background(), agentMsg, ParentChannel)
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatalf("agent-authored mention started %d runs", len(ids))
	}

	// Human-authored mention starts exactly one.
	humanMsg := &model.Message{ID: "m3", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] hi"}
	fx.orch.OnMessage(context.Background(), humanMsg, ParentChannel)
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 1 {
		t.Fatalf("human mention started %d runs, want 1", len(ids))
	}
}

func TestOrchestrator_OfflineAgentFailsFast(t *testing.T) {
	fx := newOrchFixture(t)
	// Lapse the runner lease → agent offline.
	_ = fx.dir.PutRunner(context.Background(), &model.RunnerRegistration{
		RunnerID: "r1", OwnerID: "u-alice",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessClaude}},
		LeaseExpiresAt: time.Now().Add(-time.Minute),
	})
	msg := &model.Message{ID: "m4", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] hello?"}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)

	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatalf("offline agent queued a run")
	}
	if !strings.Contains(fx.msgs.lastPost(), "desktop app") {
		t.Fatalf("no offline notice posted, got %q", fx.msgs.lastPost())
	}
}

func TestOrchestrator_HarnessMismatchNotClaimed(t *testing.T) {
	fx := newOrchFixture(t)
	fx.startRun(t) // snapshot harness = claude

	// A runner that only has codex must not claim a claude run.
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessCodex}, 1, 0)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(as) != 0 {
		t.Fatalf("codex-only runner claimed a claude run")
	}
}

func TestOrchestrator_SnapshotFreezesConfig(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)

	// Edit the invoker's persona prefs AFTER the run started: the claimed
	// assignment must carry the snapshot, not the edit (plan-v2 §4).
	newPersona := "You are someone else entirely."
	_ = fx.dir.PutAgentPrefs(context.Background(), &model.UserAgentPrefs{
		UserID: "u-alice", Slug: "gg", Persona: newPersona,
	})

	a := fx.claim(t)
	if a.Persona == newPersona {
		t.Fatal("mid-flight config edit leaked into the claimed run")
	}
	if a.RunID != run.ID || a.Harness != model.HarnessClaude {
		t.Fatalf("assignment doesn't match snapshot: %+v", a)
	}
}

func TestOrchestrator_ReconcilerFailsExpiredRuns(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	// Past the task cap (direct runs get the long budget).
	*fx.now = fx.now.Add(run.Limits.WallClockFor(run.Mode) + time.Hour)
	fx.orch.sweepDeadlines(context.Background())

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed {
		t.Fatalf("deadline sweep left run in %s", got.State)
	}
}

func TestOrchestrator_RecoverActiveFailsLapsedLeases(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	// Simulate a server restart after the runner vanished: boot recovery
	// must fail the run rather than leave it running forever.
	*fx.now = fx.now.Add(runLeaseTTL + time.Minute)
	fx.orch.recoverActive(context.Background())

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed || got.FailReason != "runner_lost" {
		t.Fatalf("boot recovery left run in %s/%s", got.State, got.FailReason)
	}
}

func TestOrchestrator_PostCapTracked(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	var remaining int
	for i := 0; i < run.Limits.MaxPosts; i++ {
		var err error
		remaining, err = fx.orch.RecordAgentPost(context.Background(), run.ID)
		if err != nil {
			t.Fatalf("record post %d: %v", i, err)
		}
	}
	if remaining != 0 {
		t.Fatalf("expected 0 remaining after cap, got %d", remaining)
	}
}

// ---------------------------------------------------------- conversation

func (fx *orchFixture) completeActive(t *testing.T, runID string) {
	t.Helper()
	if err := fx.orch.CompleteRun(context.Background(), "r1", runID, "done", nil); err != nil {
		t.Fatalf("complete %s: %v", runID, err)
	}
}

func TestOrchestrator_MultiAgentMentionsRunInParallel(t *testing.T) {
	fx := newOrchFixture(t)
	msg := &model.Message{
		ID: "m10", ParentID: "chan1", AuthorID: "u-alice",
		Body: "@[" + testGGID + "|gg] & @[" + testQibID + "|qib] discuss Go vs PHP",
	}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)

	// BOTH agents start at once — like two people reading the same message.
	// Each acknowledges (👀) immediately; the prompt (re-read before posting)
	// owns dedup, and chains carry the conversation from there.
	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 2 {
		t.Fatalf("expected 2 queued runs, got %d", len(ids))
	}
	agents := map[string]bool{}
	for _, id := range ids {
		run, _ := fx.runs.GetRun(context.Background(), id)
		agents[run.AgentID] = true
		if len(run.PendingAgentIDs) != 0 {
			t.Fatalf("parallel runs must carry no pending roster: %+v", run.PendingAgentIDs)
		}
		if run.Round != 0 {
			t.Fatalf("human invocation is round 0, got %d", run.Round)
		}
	}
	if !agents[testGGID] || !agents[testQibID] {
		t.Fatalf("expected gg and qib, got %v", agents)
	}
}

func TestOrchestrator_AgentPostChainsMentionedAgent(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t) // gg, round 0
	fx.claim(t)

	// gg posts a reply tagging qib (already linkified server-side).
	post := &model.Message{
		ID: "m20", ParentID: "chan1", AuthorID: testGGID, ParentMessageID: "m1",
		Body: "My pick: Go. @[" + testQibID + "|qib] your turn.",
	}
	fx.orch.ChainFromAgentPost(context.Background(), run, post)

	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	var qibRun *model.Run
	for _, id := range ids {
		r, _ := fx.runs.GetRun(context.Background(), id)
		if r.AgentID == testQibID {
			qibRun = r
		}
	}
	if qibRun == nil {
		t.Fatal("qib turn not started from gg's mention")
	}
	if qibRun.Round != 1 {
		t.Fatalf("chained run should be round 1, got %d", qibRun.Round)
	}
	if qibRun.InvokerID != "u-alice" {
		t.Fatalf("chain must keep the ORIGINAL invoker's attribution, got %q", qibRun.InvokerID)
	}
	if qibRun.ThreadRootID != "m1" {
		t.Fatalf("chained run must stay in the thread, got %q", qibRun.ThreadRootID)
	}
}

func TestOrchestrator_ChainRoundCapConverges(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)
	run.Round = run.Limits.MaxChainRounds // simulate the last allowed turn

	post := &model.Message{
		ID: "m21", ParentID: "chan1", AuthorID: testGGID, ParentMessageID: "m1",
		Body: "Still going! @[" + testQibID + "|qib] respond!",
	}
	fx.orch.ChainFromAgentPost(context.Background(), run, post)

	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	for _, id := range ids {
		r, _ := fx.runs.GetRun(context.Background(), id)
		if r.AgentID == testQibID {
			t.Fatal("round cap exceeded: chain did not converge")
		}
	}
}

func TestOrchestrator_ChainNeverSelfTriggers(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	post := &model.Message{
		ID: "m22", ParentID: "chan1", AuthorID: testGGID, ParentMessageID: "m1",
		Body: "As I (@[" + testGGID + "|gg]) said before…",
	}
	fx.orch.ChainFromAgentPost(context.Background(), run, post)

	// gg's own slot is taken by the ACTIVE run; a self-trigger would surface
	// as a second gg run or an ErrAgentBusy failure post. Neither may happen.
	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 0 {
		t.Fatalf("self-mention started a run: %v", ids)
	}
	if fx.msgs.lastPost() != "" {
		t.Fatalf("self-mention produced a post: %q", fx.msgs.lastPost())
	}
}

func TestOrchestrator_BusyAgentNotRestartedInThread(t *testing.T) {
	fx := newOrchFixture(t)
	fx.startRun(t) // gg active in thread m1

	// A second human mention of gg in the same thread while it's mid-turn:
	// silently deduped (its reply is already coming), no error post.
	msg := &model.Message{
		ID: "m1", ParentID: "chan1", AuthorID: "u-alice",
		Body: "@[" + testGGID + "|gg] hurry up!",
	}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)

	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("busy dedup failed: %d runs queued", len(ids))
	}
	if fx.msgs.lastPost() != "" {
		t.Fatalf("busy dedup posted noise: %q", fx.msgs.lastPost())
	}
}

func TestOrchestrator_LinkifyMentions(t *testing.T) {
	fx := newOrchFixture(t)
	ctx := context.Background()
	run := fx.startRun(t)

	got := fx.orch.LinkifyMentions(ctx, run, "Over to you @qib — and thanks @gg.")
	want := "Over to you @[" + testQibID + "|qib] — and thanks @[" + testGGID + "|gg]."
	if got != want {
		t.Fatalf("linkify agents:\n got %q\nwant %q", got, want)
	}

	// Humans in the thread linkify too — the invoker at minimum — including
	// case-insensitive matches ("@alice" for display name "Alice").
	got = fx.orch.LinkifyMentions(ctx, run, "Good question @alice, checking now.")
	want = "Good question @[u-alice|Alice], checking now."
	if got != want {
		t.Fatalf("linkify humans:\n got %q\nwant %q", got, want)
	}

	// Already-markup mentions and mid-word @ must pass through untouched.
	pre := "ping @[" + testQibID + "|qib] and mail me at me@ggmail.com"
	if got := fx.orch.LinkifyMentions(ctx, run, pre); got != pre {
		t.Fatalf("linkify mangled safe text: %q", got)
	}
}

func TestOrchestrator_BusyChainHandoffDeferredNotDropped(t *testing.T) {
	fx := newOrchFixture(t)
	ggRun := fx.startRun(t) // gg mid-turn in thread m1
	fx.claim(t)

	// While gg is STILL working, a qib run (round 1) posts a reply tagging
	// gg. The old behavior dropped this handoff — the conversation died.
	qibRun := &model.Run{
		ID: "run-qib", AgentID: testQibID, InvokerID: "u-alice", OwnerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, ThreadRootID: "m1", MessageID: "m1",
		Round: 1,
	}
	post := &model.Message{
		ID: "m30", ParentID: "chan1", AuthorID: testQibID, ParentMessageID: "m1",
		Body: "Disagree — @[" + testGGID + "|gg] defend your take.",
	}
	fx.orch.ChainFromAgentPost(context.Background(), qibRun, post)

	// Nothing new queued yet (gg is busy), but nothing lost either…
	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 0 {
		t.Fatalf("busy target should not stack runs, got %d", len(ids))
	}

	// …because gg finishing its turn starts the deferred handoff at round 2.
	fx.completeActive(t, ggRun.ID)
	ids, _ = fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("deferred handoff not started after gg finished: %d queued", len(ids))
	}
	next, _ := fx.runs.GetRun(context.Background(), ids[0])
	if next.AgentID != testGGID || next.Round != 2 {
		t.Fatalf("wrong deferred turn: agent=%s round=%d", next.AgentID, next.Round)
	}
}

// A failed run must SAY so in the conversation. Before this, failRun set the ❌
// reaction and posted nothing, so an invoker saw an unanswered question with a
// cross and no way to tell whether to wait, retry, or fix their machine — the
// exact confusion reported 2026-08-21 for a runner_error crash.
func TestOrchestrator_FailRunPostsNotice(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)

	if err := fx.orch.FailRun(context.Background(), "r1", run.ID, "runner_error: Error: ENOENT: open '/tmp/x/mcp.json'"); err != nil {
		t.Fatalf("fail: %v", err)
	}

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed {
		t.Fatalf("run not failed: %+v", got)
	}
	if fx.msgs.lastReaction() != StateEmojiFailed {
		t.Fatalf("expected ❌ state, got %q", fx.msgs.lastReaction())
	}
	post := fx.msgs.lastPost()
	if post == "" {
		t.Fatal("failed run posted nothing — silent failure")
	}
	// Says what happened and what to do, and carries the detail.
	for _, want := range []string{"stopped", "your machine", "ask again"} {
		if !strings.Contains(strings.ToLower(post), want) {
			t.Errorf("notice missing %q: %q", want, post)
		}
	}
	if !strings.Contains(post, "ENOENT") {
		t.Errorf("notice dropped the actual error: %q", post)
	}
}

func TestFailNoticeCoversEveryReason(t *testing.T) {
	// Every reason the runner or orchestrator can report must produce a
	// non-empty, human-readable line — including ones nobody mapped yet.
	for _, reason := range []string{
		"runner_error: boom", "runner_lost", "lease_expired", "harness_missing:codex",
		"token_mint_failed", "spawn_failed: no such binary", "no_runner",
		"something_new_nobody_mapped", "",
	} {
		got := failNotice(reason)
		if strings.TrimSpace(got) == "" {
			t.Errorf("reason %q produced an empty notice", reason)
		}
		if !strings.Contains(got, "stopped") {
			t.Errorf("reason %q notice does not say it stopped: %q", reason, got)
		}
	}
	// An unbounded error tail is clipped rather than pasted whole into chat.
	long := failNotice("runner_error: " + strings.Repeat("x", 500))
	if len(long) > 400 {
		t.Errorf("notice not clipped: %d chars", len(long))
	}
}

// A watcher in notify/draft/reply mode cannot post publicly, so its failure
// notice must not be the thing that leaks it into the channel.
func TestOrchestrator_FailRunGatedWatcherStaysPrivate(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	run.ActionMode = model.WatchActionNotify
	if err := fx.runs.UpdateRun(context.Background(), run, run.State); err != nil {
		t.Fatalf("update: %v", err)
	}
	before := fx.msgs.lastPost()

	if err := fx.orch.FailRun(context.Background(), "r1", run.ID, "runner_lost"); err != nil {
		t.Fatalf("fail: %v", err)
	}

	// No ownerDM resolver in the fixture → nothing posted anywhere public.
	if got := fx.msgs.lastPost(); got != before {
		t.Fatalf("gated watcher posted publicly on failure: %q", got)
	}
}
