package handler

// Coverage tests for internal/handler/agent.go. Every identifier is prefixed
// hagentCov / TestHagentCov to stay clear of parallel work in this package.
// The handler takes concrete services, so the fakes live at the SERVICE
// constructor seams: an AgentDirectoryStore + run-store pair with per-method
// error injection drives every handler arm through real service code.

import (
	"context"
	"crypto"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/auth"
	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
	"github.com/golang-jwt/jwt/v5"
)

var errHagentCov = errors.New("hagentCov: boom")

// hagentCovFails injects failures per method name: the Nth and later calls to
// a method named in failFrom return an error (errs override, default boom).
type hagentCovFails struct {
	calls    map[string]int
	failFrom map[string]int
	errs     map[string]error
}

func hagentCovNewFails() hagentCovFails {
	return hagentCovFails{calls: map[string]int{}, failFrom: map[string]int{}, errs: map[string]error{}}
}

func (f *hagentCovFails) trip(name string) error {
	f.calls[name]++
	from, ok := f.failFrom[name]
	if !ok || f.calls[name] < from {
		return nil
	}
	if e := f.errs[name]; e != nil {
		return e
	}
	return errHagentCov
}

// ------------------------------------------------------------ directory fake

// hagentCovDir implements service.AgentDirectoryStore in memory.
type hagentCovDir struct {
	hagentCovFails
	users     *mockUserStore // CreateAgentUser lands agent rows here
	templates map[string]*model.AgentTemplate
	prefs     map[string]*model.UserAgentPrefs
	skills    map[string]*model.Skill
	runners   map[string][]*model.RunnerRegistration
	subs      map[string][]*model.AgentSubscription
	memories  map[string]*model.AgentMemory
}

func hagentCovNewDir(users *mockUserStore) *hagentCovDir {
	return &hagentCovDir{
		hagentCovFails: hagentCovNewFails(),
		users:          users,
		templates:      map[string]*model.AgentTemplate{},
		prefs:          map[string]*model.UserAgentPrefs{},
		skills:         map[string]*model.Skill{},
		runners:        map[string][]*model.RunnerRegistration{},
		subs:           map[string][]*model.AgentSubscription{},
		memories:       map[string]*model.AgentMemory{},
	}
}

func (d *hagentCovDir) PutTemplate(_ context.Context, tpl *model.AgentTemplate) error {
	if err := d.trip("PutTemplate"); err != nil {
		return err
	}
	d.templates[tpl.Slug] = tpl
	return nil
}

func (d *hagentCovDir) CreateTemplateIfAbsent(_ context.Context, tpl *model.AgentTemplate) error {
	if err := d.trip("CreateTemplateIfAbsent"); err != nil {
		return err
	}
	if _, ok := d.templates[tpl.Slug]; ok {
		return store.ErrAlreadyExists
	}
	d.templates[tpl.Slug] = tpl
	return nil
}

func (d *hagentCovDir) GetTemplate(_ context.Context, slug string) (*model.AgentTemplate, error) {
	if err := d.trip("GetTemplate"); err != nil {
		return nil, err
	}
	tpl, ok := d.templates[slug]
	if !ok {
		return nil, store.ErrNotFound
	}
	return tpl, nil
}

func (d *hagentCovDir) ListTemplates(_ context.Context) ([]*model.AgentTemplate, error) {
	if err := d.trip("ListTemplates"); err != nil {
		return nil, err
	}
	out := make([]*model.AgentTemplate, 0, len(d.templates))
	for _, tpl := range d.templates {
		out = append(out, tpl)
	}
	return out, nil
}

func (d *hagentCovDir) CreateAgentUser(_ context.Context, user *model.User) error {
	if err := d.trip("CreateAgentUser"); err != nil {
		return err
	}
	if _, ok := d.users.users[user.ID]; ok {
		return store.ErrAlreadyExists
	}
	d.users.users[user.ID] = user
	return nil
}

func (d *hagentCovDir) PutAgentPrefs(_ context.Context, prefs *model.UserAgentPrefs) error {
	if err := d.trip("PutAgentPrefs"); err != nil {
		return err
	}
	d.prefs[prefs.UserID+"|"+prefs.Slug] = prefs
	return nil
}

func (d *hagentCovDir) GetAgentPrefs(_ context.Context, userID, slug string) (*model.UserAgentPrefs, error) {
	if err := d.trip("GetAgentPrefs"); err != nil {
		return nil, err
	}
	p, ok := d.prefs[userID+"|"+slug]
	if !ok {
		return nil, store.ErrNotFound
	}
	return p, nil
}

func (d *hagentCovDir) PutRunner(_ context.Context, reg *model.RunnerRegistration) error {
	if err := d.trip("PutRunner"); err != nil {
		return err
	}
	d.runners[reg.OwnerID] = append(d.runners[reg.OwnerID], reg)
	return nil
}

func (d *hagentCovDir) ListRunners(_ context.Context, ownerID string) ([]*model.RunnerRegistration, error) {
	if err := d.trip("ListRunners"); err != nil {
		return nil, err
	}
	return append([]*model.RunnerRegistration(nil), d.runners[ownerID]...), nil
}

func (d *hagentCovDir) DeleteRunner(_ context.Context, ownerID, runnerID string) error {
	return d.trip("DeleteRunner")
}

func (d *hagentCovDir) PutSkill(_ context.Context, sk *model.Skill) error {
	if err := d.trip("PutSkill"); err != nil {
		return err
	}
	d.skills[sk.ID] = sk
	return nil
}

func (d *hagentCovDir) GetSkill(_ context.Context, id string) (*model.Skill, error) {
	if err := d.trip("GetSkill"); err != nil {
		return nil, err
	}
	sk, ok := d.skills[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	return sk, nil
}

func (d *hagentCovDir) ListSkills(_ context.Context) ([]*model.Skill, error) {
	if err := d.trip("ListSkills"); err != nil {
		return nil, err
	}
	out := make([]*model.Skill, 0, len(d.skills))
	for _, sk := range d.skills {
		out = append(out, sk)
	}
	return out, nil
}

func (d *hagentCovDir) DeleteSkill(_ context.Context, id string) error {
	if err := d.trip("DeleteSkill"); err != nil {
		return err
	}
	delete(d.skills, id)
	return nil
}

func (d *hagentCovDir) PutAgentMemory(_ context.Context, m *model.AgentMemory) error {
	if err := d.trip("PutAgentMemory"); err != nil {
		return err
	}
	d.memories[m.InvokerID+"|"+m.AgentID] = m
	return nil
}

func (d *hagentCovDir) GetAgentMemory(_ context.Context, invokerID, agentID string) (*model.AgentMemory, error) {
	if err := d.trip("GetAgentMemory"); err != nil {
		return nil, err
	}
	m, ok := d.memories[invokerID+"|"+agentID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return m, nil
}

func (d *hagentCovDir) PutAgentSubscription(_ context.Context, sub *model.AgentSubscription) error {
	if err := d.trip("PutAgentSubscription"); err != nil {
		return err
	}
	list := d.subs[sub.ParentID]
	for i, s := range list {
		if s.ID == sub.ID {
			list[i] = sub
			return nil
		}
	}
	d.subs[sub.ParentID] = append(list, sub)
	return nil
}

func (d *hagentCovDir) ListSubscriptionsByParent(_ context.Context, parentID string) ([]*model.AgentSubscription, error) {
	if err := d.trip("ListSubscriptionsByParent"); err != nil {
		return nil, err
	}
	return d.subs[parentID], nil
}

func (d *hagentCovDir) ListAllSubscriptions(_ context.Context) ([]*model.AgentSubscription, error) {
	if err := d.trip("ListAllSubscriptions"); err != nil {
		return nil, err
	}
	var out []*model.AgentSubscription
	for _, list := range d.subs {
		out = append(out, list...)
	}
	return out, nil
}

func (d *hagentCovDir) DeleteAgentSubscription(_ context.Context, parentID, id string) error {
	if err := d.trip("DeleteAgentSubscription"); err != nil {
		return err
	}
	list := d.subs[parentID]
	for i, s := range list {
		if s.ID == id {
			d.subs[parentID] = append(list[:i], list[i+1:]...)
			break
		}
	}
	return nil
}

func (d *hagentCovDir) PutTaskClaim(_ context.Context, _ *model.TaskClaim) error {
	return d.trip("PutTaskClaim")
}

func (d *hagentCovDir) ListTaskClaims(_ context.Context, _, _ string) ([]*model.TaskClaim, error) {
	return nil, d.trip("ListTaskClaims")
}

func (d *hagentCovDir) PutAgentFollow(_ context.Context, _ *model.AgentThreadFollow) error {
	return d.trip("PutAgentFollow")
}

func (d *hagentCovDir) ListAgentFollows(_ context.Context, _, _ string) ([]*model.AgentThreadFollow, error) {
	return nil, d.trip("ListAgentFollows")
}

// ------------------------------------------------------------ run-store fake

// hagentCovRunStore implements the orchestrator's run persistence surface.
type hagentCovRunStore struct {
	hagentCovFails
	runs      map[string]*model.Run
	events    map[string][]*model.RunEvent
	arts      map[string][]*model.Artifact
	approvals map[string]*model.Approval
	byParent  map[string][]*model.Run
}

func hagentCovNewRunStore() *hagentCovRunStore {
	return &hagentCovRunStore{
		hagentCovFails: hagentCovNewFails(),
		runs:           map[string]*model.Run{},
		events:         map[string][]*model.RunEvent{},
		arts:           map[string][]*model.Artifact{},
		approvals:      map[string]*model.Approval{},
		byParent:       map[string][]*model.Run{},
	}
}

func (s *hagentCovRunStore) CreateRun(_ context.Context, run *model.Run) error {
	if err := s.trip("CreateRun"); err != nil {
		return err
	}
	s.runs[run.ID] = run
	return nil
}

func (s *hagentCovRunStore) GetRun(_ context.Context, runID string) (*model.Run, error) {
	if err := s.trip("GetRun"); err != nil {
		return nil, err
	}
	run, ok := s.runs[runID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return run, nil
}

func (s *hagentCovRunStore) UpdateRun(_ context.Context, run *model.Run, _ model.RunState) error {
	if err := s.trip("UpdateRun"); err != nil {
		return err
	}
	s.runs[run.ID] = run
	return nil
}

func (s *hagentCovRunStore) RenewRunLease(_ context.Context, _, _ string, _ time.Time) error {
	return s.trip("RenewRunLease")
}

func (s *hagentCovRunStore) ListQueuedRuns(_ context.Context, _ string, _ int) ([]string, error) {
	return nil, s.trip("ListQueuedRuns")
}

func (s *hagentCovRunStore) ClaimRun(_ context.Context, _ *model.Run, _ string, _ time.Time) error {
	return s.trip("ClaimRun")
}

func (s *hagentCovRunStore) DeleteQueueEntry(_ context.Context, _, _ string) error {
	return s.trip("DeleteQueueEntry")
}

func (s *hagentCovRunStore) ListActiveRunsPastDeadline(_ context.Context, _ time.Time, _ int) ([]*model.Run, error) {
	return nil, s.trip("ListActiveRunsPastDeadline")
}

func (s *hagentCovRunStore) ListActiveRuns(_ context.Context) ([]*model.Run, error) {
	return nil, s.trip("ListActiveRuns")
}

func (s *hagentCovRunStore) AppendRunEvent(_ context.Context, evt *model.RunEvent) error {
	if err := s.trip("AppendRunEvent"); err != nil {
		return err
	}
	s.events[evt.RunID] = append(s.events[evt.RunID], evt)
	return nil
}

func (s *hagentCovRunStore) ListRunEvents(_ context.Context, runID string) ([]*model.RunEvent, error) {
	if err := s.trip("ListRunEvents"); err != nil {
		return nil, err
	}
	return s.events[runID], nil
}

func (s *hagentCovRunStore) DeleteRunEvents(_ context.Context, _ string) error {
	return s.trip("DeleteRunEvents")
}

func (s *hagentCovRunStore) PutDigest(_ context.Context, _ *model.RunDigest) error {
	return s.trip("PutDigest")
}

func (s *hagentCovRunStore) GetDigest(_ context.Context, _ string) (*model.RunDigest, error) {
	if err := s.trip("GetDigest"); err != nil {
		return nil, err
	}
	return nil, store.ErrNotFound
}

func (s *hagentCovRunStore) ListRunsByParent(_ context.Context, parentID string, _ int) ([]*model.Run, error) {
	if err := s.trip("ListRunsByParent"); err != nil {
		return nil, err
	}
	return s.byParent[parentID], nil
}

func (s *hagentCovRunStore) PutApproval(_ context.Context, a *model.Approval) error {
	if err := s.trip("PutApproval"); err != nil {
		return err
	}
	s.approvals[a.RunID+"|"+a.ID] = a
	return nil
}

func (s *hagentCovRunStore) GetApproval(_ context.Context, runID, approvalID string) (*model.Approval, error) {
	if err := s.trip("GetApproval"); err != nil {
		return nil, err
	}
	a, ok := s.approvals[runID+"|"+approvalID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return a, nil
}

func (s *hagentCovRunStore) SettleApproval(_ context.Context, _, _, _, _, _, _ string, _ time.Time) error {
	return s.trip("SettleApproval")
}

func (s *hagentCovRunStore) ListApprovals(_ context.Context, _ string) ([]*model.Approval, error) {
	return nil, s.trip("ListApprovals")
}

func (s *hagentCovRunStore) PutArtifact(_ context.Context, a *model.Artifact) error {
	if err := s.trip("PutArtifact"); err != nil {
		return err
	}
	s.arts[a.RunID] = append(s.arts[a.RunID], a)
	return nil
}

func (s *hagentCovRunStore) ListArtifacts(_ context.Context, runID string) ([]*model.Artifact, error) {
	if err := s.trip("ListArtifacts"); err != nil {
		return nil, err
	}
	return s.arts[runID], nil
}

// --------------------------------------------------------- small orch fakes

type hagentCovOrchUsers struct{ users *mockUserStore }

func (u *hagentCovOrchUsers) GetUser(ctx context.Context, id string) (*model.User, error) {
	return u.users.GetUser(ctx, id)
}

func (u *hagentCovOrchUsers) GetUsersByIDs(ctx context.Context, ids []string) ([]*model.User, error) {
	var out []*model.User
	for _, id := range ids {
		if usr, err := u.users.GetUser(ctx, id); err == nil {
			out = append(out, usr)
		}
	}
	return out, nil
}

type hagentCovMessages struct {
	thread    []*model.Message
	threadErr error
}

func (m *hagentCovMessages) SendAsAgentRun(_ context.Context, _, _, _, _, _, _, _ string) (*model.Message, error) {
	return &model.Message{ID: "m-agent"}, nil
}

func (m *hagentCovMessages) SetMachineReaction(_ context.Context, _, _, _, _, _ string) error {
	return nil
}

func (m *hagentCovMessages) ListThreadMessages(_ context.Context, _, _, _, _ string) ([]*model.Message, error) {
	return m.thread, m.threadErr
}

func (m *hagentCovMessages) List(_ context.Context, _, _, _, _ string, _ int) ([]*model.Message, bool, error) {
	return nil, false, nil
}

type hagentCovPub struct{}

func (hagentCovPub) Publish(_ context.Context, _ string, _ *events.Event) error { return nil }

type hagentCovAccess struct {
	err   error
	calls int
}

func (a *hagentCovAccess) CheckAccess(_ context.Context, _, _, _ string) error {
	a.calls++
	return a.err
}

// ------------------------------------------------------------------ harness

type hagentCovEnv struct {
	dir     *hagentCovDir
	runs    *hagentCovRunStore
	users   *mockUserStore
	msgs    *hagentCovMessages
	agentID string
	h       *AgentHandler
}

// hagentCovNewEnv builds a handler over real services with one seeded shared
// agent "gg" (claude harness), humans u1/u2, and injectable stores.
func hagentCovNewEnv() *hagentCovEnv {
	users := newMockUserStore()
	users.users["u1"] = &model.User{ID: "u1", Email: "u1@example.com", DisplayName: "User One", SystemRole: model.SystemRoleMember, Status: "active"}
	users.users["u2"] = &model.User{ID: "u2", Email: "u2@example.com", DisplayName: "User Two", SystemRole: model.SystemRoleMember, Status: "active"}
	agentID := service.AgentUserID("gg")
	users.users[agentID] = &model.User{
		ID: agentID, DisplayName: "gg", SystemRole: model.SystemRoleMember, Status: "active",
		Kind: model.UserKindAgent, AgentConfig: &model.AgentConfig{TemplateSlug: "gg"},
	}
	dir := hagentCovNewDir(users)
	dir.templates["gg"] = &model.AgentTemplate{
		Slug: "gg", DisplayName: "gg", Harness: model.HarnessClaude, Persona: "be gg",
		Limits: model.DefaultAgentLimits(), MaxConcurrentRuns: 1,
	}
	runs := hagentCovNewRunStore()
	msgs := &hagentCovMessages{}
	agentSvc := service.NewAgentService(dir, users)
	userSvc := service.NewUserService(users, &mockCache{}, nil, nil)
	jwtMgr := auth.NewJWTManager("hagent-cov-secret", 15*time.Minute, 720*time.Hour)
	orch := service.NewOrchestrator(runs, agentSvc, &hagentCovOrchUsers{users: users}, msgs, hagentCovPub{}, jwtMgr)
	h := NewAgentHandler(agentSvc, orch, userSvc, jwtMgr)
	return &hagentCovEnv{dir: dir, runs: runs, users: users, msgs: msgs, agentID: agentID, h: h}
}

// seedRun stores a run both by ID and in its parent's listing.
func (e *hagentCovEnv) seedRun(run *model.Run) {
	e.runs.runs[run.ID] = run
	e.runs.byParent[run.ParentID] = append(e.runs.byParent[run.ParentID], run)
}

func hagentCovReq(method, target, body, uid string, pv map[string]string) *http.Request {
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rd)
	if uid != "" {
		req = req.WithContext(middleware.ContextWithClaims(req.Context(), &model.TokenClaims{UserID: uid}))
	}
	for k, v := range pv {
		req.SetPathValue(k, v)
	}
	return req
}

func hagentCovDo(h http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func hagentCovWant(t *testing.T, rec *httptest.ResponseRecorder, code int) {
	t.Helper()
	if rec.Code != code {
		t.Fatalf("status = %d, want %d; body: %s", rec.Code, code, rec.Body.String())
	}
}

func hagentCovJSON(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode body: %v; body: %s", err, rec.Body.String())
	}
	return m
}

// ------------------------------------------------------------------- agents

func TestHagentCovCreateAgent(t *testing.T) {
	env := hagentCovNewEnv()

	rec := hagentCovDo(env.h.CreateAgent, hagentCovReq(http.MethodPost, "/api/v1/agents", "{", "u1", nil))
	hagentCovWant(t, rec, http.StatusBadRequest)

	rec = hagentCovDo(env.h.CreateAgent, hagentCovReq(http.MethodPost, "/api/v1/agents", `{"slug":"X","persona":"p"}`, "u1", nil))
	hagentCovWant(t, rec, http.StatusBadRequest)

	env.dir.failFrom["PutTemplate"] = 1
	rec = hagentCovDo(env.h.CreateAgent, hagentCovReq(http.MethodPost, "/api/v1/agents", `{"slug":"zed","persona":"p"}`, "u1", nil))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "PutTemplate")

	rec = hagentCovDo(env.h.CreateAgent, hagentCovReq(http.MethodPost, "/api/v1/agents", `{"slug":"zed","displayName":"Zed","persona":"p"}`, "u1", nil))
	hagentCovWant(t, rec, http.StatusCreated)
	if _, ok := hagentCovJSON(t, rec)["agent"]; !ok {
		t.Fatalf("missing agent in body: %s", rec.Body.String())
	}
}

func TestHagentCovRenameAgent(t *testing.T) {
	env := hagentCovNewEnv()
	slug := map[string]string{"slug": "gg"}

	rec := hagentCovDo(env.h.RenameAgent, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg", "{", "u1", slug))
	hagentCovWant(t, rec, http.StatusBadRequest)

	rec = hagentCovDo(env.h.RenameAgent, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg", `{}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusBadRequest)

	// Validation arm of fail(): display name over 64 chars.
	long := strings.Repeat("n", 65)
	rec = hagentCovDo(env.h.RenameAgent, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg", `{"displayName":"`+long+`"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusBadRequest)

	// Not-found arm: unknown agent.
	rec = hagentCovDo(env.h.RenameAgent, hagentCovReq(http.MethodPatch, "/api/v1/agents/nope", `{"displayName":"New"}`, "u1", map[string]string{"slug": "nope"}))
	hagentCovWant(t, rec, http.StatusNotFound)

	// Internal arm: template save fails.
	env.dir.failFrom["PutTemplate"] = 1
	rec = hagentCovDo(env.h.RenameAgent, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg", `{"displayName":"New"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "PutTemplate")

	// Skills error arm: unknown skill id.
	rec = hagentCovDo(env.h.RenameAgent, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg", `{"skillIDs":["nope"]}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusBadRequest)

	// Happy path exercising both branches: rename + clear skills.
	rec = hagentCovDo(env.h.RenameAgent, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg", `{"displayName":"GG2","skillIDs":[]}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusOK)
	if _, ok := hagentCovJSON(t, rec)["agent"]; !ok {
		t.Fatalf("missing agent in body: %s", rec.Body.String())
	}
}

func TestHagentCovListErrors(t *testing.T) {
	// Template listing fails.
	env := hagentCovNewEnv()
	env.dir.failFrom["ListTemplates"] = 1
	rec := hagentCovDo(env.h.List, hagentCovReq(http.MethodGet, "/api/v1/agents", "", "u1", nil))
	hagentCovWant(t, rec, http.StatusInternalServerError)

	// view: prefs read fails (non-NotFound).
	env = hagentCovNewEnv()
	env.dir.failFrom["GetAgentPrefs"] = 1
	rec = hagentCovDo(env.h.List, hagentCovReq(http.MethodGet, "/api/v1/agents", "", "u1", nil))
	hagentCovWant(t, rec, http.StatusInternalServerError)

	// view: resolve fails (template read fails after listing).
	env = hagentCovNewEnv()
	env.dir.failFrom["GetTemplate"] = 1
	rec = hagentCovDo(env.h.List, hagentCovReq(http.MethodGet, "/api/v1/agents", "", "u1", nil))
	hagentCovWant(t, rec, http.StatusInternalServerError)
}

func TestHagentCovListStatuses(t *testing.T) {
	env := hagentCovNewEnv()

	status := func() string {
		rec := hagentCovDo(env.h.List, hagentCovReq(http.MethodGet, "/api/v1/agents", "", "u1", nil))
		hagentCovWant(t, rec, http.StatusOK)
		agents, ok := hagentCovJSON(t, rec)["agents"].([]any)
		if !ok || len(agents) != 1 {
			t.Fatalf("agents = %v", agents)
		}
		return agents[0].(map[string]any)["status"].(string)
	}

	if got := status(); got != model.AgentStatusOffline {
		t.Fatalf("status = %q, want offline", got)
	}

	env.dir.runners["u1"] = []*model.RunnerRegistration{{
		RunnerID: "rn1", OwnerID: "u1", LeaseExpiresAt: time.Now().Add(time.Hour),
		Harnesses: []model.RunnerHarness{{Name: model.HarnessCodex}},
	}}
	if got := status(); got != model.AgentStatusNeedsSetup {
		t.Fatalf("status = %q, want needs_setup", got)
	}

	env.dir.runners["u1"] = []*model.RunnerRegistration{{
		RunnerID: "rn1", OwnerID: "u1", LeaseExpiresAt: time.Now().Add(time.Hour),
		Harnesses: []model.RunnerHarness{{Name: model.HarnessClaude}},
	}}
	if got := status(); got != model.AgentStatusActive {
		t.Fatalf("status = %q, want active", got)
	}
}

func TestHagentCovUpdatePrefs(t *testing.T) {
	env := hagentCovNewEnv()
	slug := map[string]string{"slug": "gg"}

	rec := hagentCovDo(env.h.UpdatePrefs, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg/prefs", "{", "u1", slug))
	hagentCovWant(t, rec, http.StatusBadRequest)

	rec = hagentCovDo(env.h.UpdatePrefs, hagentCovReq(http.MethodPatch, "/api/v1/agents/nope/prefs", `{}`, "u1", map[string]string{"slug": "nope"}))
	hagentCovWant(t, rec, http.StatusNotFound)

	rec = hagentCovDo(env.h.UpdatePrefs, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg/prefs", `{"harness":"weird"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusBadRequest)

	// Agent user lookup fails after a successful prefs write.
	env.users.getUserErr = errHagentCov
	rec = hagentCovDo(env.h.UpdatePrefs, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg/prefs", `{"model":"m1"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	env.users.getUserErr = nil

	// view fails: prefs read blows up on its second call (first one served
	// the service-level UpdatePrefs).
	env2 := hagentCovNewEnv()
	env2.dir.failFrom["GetAgentPrefs"] = 2
	rec = hagentCovDo(env2.h.UpdatePrefs, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg/prefs", `{"model":"m1"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusInternalServerError)

	rec = hagentCovDo(env.h.UpdatePrefs, hagentCovReq(http.MethodPatch, "/api/v1/agents/gg/prefs", `{"model":"m1"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusOK)
	body := hagentCovJSON(t, rec)
	if body["slug"] != "gg" {
		t.Fatalf("slug = %v, want gg", body["slug"])
	}
}

func TestHagentCovMintRunnerToken(t *testing.T) {
	env := hagentCovNewEnv()

	// Caller lookup fails.
	rec := hagentCovDo(env.h.MintRunnerToken, hagentCovReq(http.MethodPost, "/api/v1/agents/runner-token", "", "ghost", nil))
	hagentCovWant(t, rec, http.StatusInternalServerError)

	// Agents may not mint runner tokens.
	rec = hagentCovDo(env.h.MintRunnerToken, hagentCovReq(http.MethodPost, "/api/v1/agents/runner-token", "", env.agentID, nil))
	hagentCovWant(t, rec, http.StatusForbidden)

	// Signing fails: the JWT manager reads the package-level HS256 method at
	// call time, so an unavailable hash makes SignedString error. Swapped for
	// exactly one request (this package's non-integration tests run
	// sequentially), then restored.
	realHS256 := jwt.SigningMethodHS256
	jwt.SigningMethodHS256 = &jwt.SigningMethodHMAC{Name: "HS256", Hash: crypto.Hash(0)}
	rec = hagentCovDo(env.h.MintRunnerToken, hagentCovReq(http.MethodPost, "/api/v1/agents/runner-token", "", "u1", nil))
	jwt.SigningMethodHS256 = realHS256
	hagentCovWant(t, rec, http.StatusInternalServerError)

	rec = hagentCovDo(env.h.MintRunnerToken, hagentCovReq(http.MethodPost, "/api/v1/agents/runner-token", "", "u1", nil))
	hagentCovWant(t, rec, http.StatusOK)
	if tok, _ := hagentCovJSON(t, rec)["token"].(string); tok == "" {
		t.Fatalf("empty token in body: %s", rec.Body.String())
	}
}

// --------------------------------------------------------------------- runs

func hagentCovRun(id, agentID string) *model.Run {
	return &model.Run{
		ID: id, AgentID: agentID, OwnerID: "u1", InvokerID: "u1",
		ParentID: "p1", ParentType: "channel", MessageID: "m1",
		State: model.RunStateCompleted, Mode: model.RunModeDirect,
	}
}

func TestHagentCovTimeline(t *testing.T) {
	env := hagentCovNewEnv()
	pv := map[string]string{"id": "r1"}

	rec := hagentCovDo(env.h.Timeline, hagentCovReq(http.MethodGet, "/api/v1/runs/r1", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusNotFound)

	env.runs.failFrom["GetRun"] = 1
	rec = hagentCovDo(env.h.Timeline, hagentCovReq(http.MethodGet, "/api/v1/runs/r1", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.runs.failFrom, "GetRun")

	run := hagentCovRun("r1", env.agentID)
	env.seedRun(run)
	env.runs.events["r1"] = []*model.RunEvent{{RunID: "r1", Seq: 1, Type: "run.created"}}
	env.runs.arts["r1"] = []*model.Artifact{{ID: "art1", RunID: "r1", Title: "doc"}}

	// Non-invoker with no access checker wired: forbidden.
	rec = hagentCovDo(env.h.Timeline, hagentCovReq(http.MethodGet, "/api/v1/runs/r1", "", "u2", pv))
	hagentCovWant(t, rec, http.StatusForbidden)

	// Artifacts load fails for the invoker.
	env.runs.failFrom["ListArtifacts"] = 1
	rec = hagentCovDo(env.h.Timeline, hagentCovReq(http.MethodGet, "/api/v1/runs/r1", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.runs.failFrom, "ListArtifacts")

	rec = hagentCovDo(env.h.Timeline, hagentCovReq(http.MethodGet, "/api/v1/runs/r1", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusOK)
	body := hagentCovJSON(t, rec)
	if users, ok := body["users"].(map[string]any); !ok || users["u1"] != "User One" {
		t.Fatalf("users = %v", body["users"])
	}

	// Non-invoker allowed through the membership checker.
	env.h.SetTimelineAccess(&hagentCovAccess{})
	rec = hagentCovDo(env.h.Timeline, hagentCovReq(http.MethodGet, "/api/v1/runs/r1", "", "u2", pv))
	hagentCovWant(t, rec, http.StatusOK)
}

func TestHagentCovThreadTimeline(t *testing.T) {
	env := hagentCovNewEnv()

	rec := hagentCovDo(env.h.ThreadTimeline, hagentCovReq(http.MethodGet, "/api/v1/runs/thread", "", "u1", nil))
	hagentCovWant(t, rec, http.StatusBadRequest)

	target := "/api/v1/runs/thread?parent=p1&root=root1"

	env.runs.failFrom["ListRunsByParent"] = 1
	rec = hagentCovDo(env.h.ThreadTimeline, hagentCovReq(http.MethodGet, target, "", "u1", nil))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.runs.failFrom, "ListRunsByParent")

	rec = hagentCovDo(env.h.ThreadTimeline, hagentCovReq(http.MethodGet, target, "", "u1", nil))
	hagentCovWant(t, rec, http.StatusNotFound)

	r1 := hagentCovRun("r1", env.agentID)
	r1.ThreadRootID = "root1"
	r2 := hagentCovRun("r2", env.agentID)
	r2.ThreadRootID = "root1"
	env.seedRun(r2) // newest-first in the store listing
	env.seedRun(r1)
	env.runs.events["r1"] = []*model.RunEvent{{RunID: "r1", Seq: 1, Type: "run.created"}}
	env.runs.events["r2"] = []*model.RunEvent{{RunID: "r2", Seq: 2, Type: "run.created"}}
	env.runs.arts["r1"] = []*model.Artifact{{ID: "art1", RunID: "r1"}}

	// Neither invoker nor member: forbidden (no access checker wired).
	rec = hagentCovDo(env.h.ThreadTimeline, hagentCovReq(http.MethodGet, target, "", "u9", nil))
	hagentCovWant(t, rec, http.StatusForbidden)

	env.msgs.thread = []*model.Message{
		{ID: "tm1", AuthorID: "u1", Deleted: true},
		{ID: "tm2", AuthorID: "u2", Body: strings.Repeat("x", 601)},
		{ID: "tm3", AuthorID: "u1", Body: "short"},
	}
	rec = hagentCovDo(env.h.ThreadTimeline, hagentCovReq(http.MethodGet, target, "", "u1", nil))
	hagentCovWant(t, rec, http.StatusOK)
	body := hagentCovJSON(t, rec)
	if runs := body["runs"].([]any); len(runs) != 2 {
		t.Fatalf("runs = %d, want 2", len(runs))
	}
	msgs := body["messages"].([]any)
	if len(msgs) != 2 {
		t.Fatalf("messages = %d, want 2 (tombstone dropped)", len(msgs))
	}
	clipped := msgs[0].(map[string]any)["body"].(string)
	if got := len([]rune(clipped)); got != 601 { // 600 + ellipsis
		t.Fatalf("clipped body runes = %d, want 601", got)
	}
	if users := body["users"].(map[string]any); users["u2"] != "User Two" {
		t.Fatalf("author name missing: %v", users)
	}
}

func TestHagentCovStopRun(t *testing.T) {
	env := hagentCovNewEnv()
	pv := map[string]string{"id": "r1"}

	rec := hagentCovDo(env.h.StopRun, hagentCovReq(http.MethodPost, "/api/v1/runs/r1/stop", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusNotFound)

	env.runs.failFrom["GetRun"] = 1
	rec = hagentCovDo(env.h.StopRun, hagentCovReq(http.MethodPost, "/api/v1/runs/r1/stop", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.runs.failFrom, "GetRun")

	env.runs.runs["r1"] = hagentCovRun("r1", env.agentID) // no parent listing yet

	rec = hagentCovDo(env.h.StopRun, hagentCovReq(http.MethodPost, "/api/v1/runs/r1/stop", "", "u2", pv))
	hagentCovWant(t, rec, http.StatusForbidden)

	env.runs.failFrom["ListRunsByParent"] = 1
	rec = hagentCovDo(env.h.StopRun, hagentCovReq(http.MethodPost, "/api/v1/runs/r1/stop", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.runs.failFrom, "ListRunsByParent")

	rec = hagentCovDo(env.h.StopRun, hagentCovReq(http.MethodPost, "/api/v1/runs/r1/stop", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusOK)
	if got := hagentCovJSON(t, rec)["stopped"].(float64); got != 0 {
		t.Fatalf("stopped = %v, want 0", got)
	}
}

func TestHagentCovGetArtifact(t *testing.T) {
	env := hagentCovNewEnv()
	pv := map[string]string{"id": "r1", "artifactID": "art1"}

	rec := hagentCovDo(env.h.GetArtifact, hagentCovReq(http.MethodGet, "/api/v1/runs/r1/artifacts/art1", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusNotFound)

	env.runs.failFrom["GetRun"] = 1
	rec = hagentCovDo(env.h.GetArtifact, hagentCovReq(http.MethodGet, "/api/v1/runs/r1/artifacts/art1", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.runs.failFrom, "GetRun")

	env.runs.runs["r1"] = hagentCovRun("r1", env.agentID)
	env.runs.arts["r1"] = []*model.Artifact{{ID: "art1", RunID: "r1", Title: "doc"}}

	rec = hagentCovDo(env.h.GetArtifact, hagentCovReq(http.MethodGet, "/api/v1/runs/r1/artifacts/art1", "", "u2", pv))
	hagentCovWant(t, rec, http.StatusForbidden)

	env.runs.failFrom["ListArtifacts"] = 1
	rec = hagentCovDo(env.h.GetArtifact, hagentCovReq(http.MethodGet, "/api/v1/runs/r1/artifacts/art1", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.runs.failFrom, "ListArtifacts")

	rec = hagentCovDo(env.h.GetArtifact, hagentCovReq(http.MethodGet, "/api/v1/runs/r1/artifacts/art1", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusOK)
	if _, ok := hagentCovJSON(t, rec)["artifact"]; !ok {
		t.Fatalf("missing artifact in body: %s", rec.Body.String())
	}

	rec = hagentCovDo(env.h.GetArtifact, hagentCovReq(http.MethodGet, "/api/v1/runs/r1/artifacts/nope", "", "u1",
		map[string]string{"id": "r1", "artifactID": "nope"}))
	hagentCovWant(t, rec, http.StatusNotFound)
}

func TestHagentCovDecideApproval(t *testing.T) {
	env := hagentCovNewEnv()
	pv := map[string]string{"id": "r1", "approvalID": "a1"}
	target := "/api/v1/runs/r1/approvals/a1"

	rec := hagentCovDo(env.h.DecideApproval, hagentCovReq(http.MethodPost, target, "{", "u1", pv))
	hagentCovWant(t, rec, http.StatusBadRequest)

	rec = hagentCovDo(env.h.DecideApproval, hagentCovReq(http.MethodPost, target, `{"approve":true}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusNotFound)

	env.runs.failFrom["GetApproval"] = 1
	rec = hagentCovDo(env.h.DecideApproval, hagentCovReq(http.MethodPost, target, `{"approve":true}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.runs.failFrom, "GetApproval")

	env.runs.approvals["r1|a1"] = &model.Approval{ID: "a1", RunID: "r1", InvokerID: "u2", State: model.ApprovalPending}
	rec = hagentCovDo(env.h.DecideApproval, hagentCovReq(http.MethodPost, target, `{"approve":true}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusForbidden)

	env.runs.approvals["r1|a1"] = &model.Approval{ID: "a1", RunID: "r1", InvokerID: "u1", State: model.ApprovalApproved}
	rec = hagentCovDo(env.h.DecideApproval, hagentCovReq(http.MethodPost, target, `{"approve":true}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusConflict)

	// Happy path: pending, invoker decides; the run row itself is gone so the
	// post-settle bookkeeping is skipped.
	env.runs.approvals["r1|a1"] = &model.Approval{ID: "a1", RunID: "r1", InvokerID: "u1", State: model.ApprovalPending}
	rec = hagentCovDo(env.h.DecideApproval, hagentCovReq(http.MethodPost, target, `{"approve":true}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusOK)
	if got := hagentCovJSON(t, rec)["state"]; got != model.ApprovalApproved {
		t.Fatalf("state = %v, want approved", got)
	}
}

// ------------------------------------------------------------ subscriptions

func TestHagentCovListSubscriptions(t *testing.T) {
	env := hagentCovNewEnv()

	rec := hagentCovDo(env.h.ListSubscriptions, hagentCovReq(http.MethodGet, "/api/v1/agents/nope/subscriptions", "", "u1", map[string]string{"slug": "nope"}))
	hagentCovWant(t, rec, http.StatusInternalServerError)

	env.dir.subs["p1"] = []*model.AgentSubscription{{ID: "s1", AgentID: env.agentID, CreatorID: "u1", ParentID: "p1", ParentType: "channel"}}
	rec = hagentCovDo(env.h.ListSubscriptions, hagentCovReq(http.MethodGet, "/api/v1/agents/gg/subscriptions", "", "u1", map[string]string{"slug": "gg"}))
	hagentCovWant(t, rec, http.StatusOK)
	if subs := hagentCovJSON(t, rec)["subscriptions"].([]any); len(subs) != 1 {
		t.Fatalf("subscriptions = %d, want 1", len(subs))
	}
}

func TestHagentCovListParentWatchers(t *testing.T) {
	env := hagentCovNewEnv()
	pv := map[string]string{"id": "p1"}

	env.dir.failFrom["ListSubscriptionsByParent"] = 1
	rec := hagentCovDo(env.h.ListParentWatchers, hagentCovReq(http.MethodGet, "/api/v1/channels/p1/watchers", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "ListSubscriptionsByParent")

	env.dir.subs["p1"] = []*model.AgentSubscription{
		{ID: "s1", AgentID: env.agentID, CreatorID: "u1", ParentID: "p1"},
		{ID: "s2", AgentID: env.agentID, CreatorID: "u2", ParentID: "p1"},
	}
	rec = hagentCovDo(env.h.ListParentWatchers, hagentCovReq(http.MethodGet, "/api/v1/channels/p1/watchers", "", "u1", pv))
	hagentCovWant(t, rec, http.StatusOK)
	if ws := hagentCovJSON(t, rec)["watchers"].([]any); len(ws) != 1 {
		t.Fatalf("watchers = %d, want 1 (only the caller's own)", len(ws))
	}
}

func TestHagentCovCreateSubscription(t *testing.T) {
	env := hagentCovNewEnv()
	slug := map[string]string{"slug": "gg"}
	target := "/api/v1/agents/gg/subscriptions"

	rec := hagentCovDo(env.h.CreateSubscription, hagentCovReq(http.MethodPost, target, "{", "u1", slug))
	hagentCovWant(t, rec, http.StatusBadRequest)

	// No access checker wired: forbidden (also walks the parentType default).
	rec = hagentCovDo(env.h.CreateSubscription, hagentCovReq(http.MethodPost, target, `{"parentID":"p1"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusForbidden)

	env.h.SetTimelineAccess(&hagentCovAccess{})

	rec = hagentCovDo(env.h.CreateSubscription, hagentCovReq(http.MethodPost, "/api/v1/agents/nope/subscriptions", `{"parentID":"p1"}`, "u1", map[string]string{"slug": "nope"}))
	hagentCovWant(t, rec, http.StatusNotFound)

	rec = hagentCovDo(env.h.CreateSubscription, hagentCovReq(http.MethodPost, target, `{"parentID":"p1","actionMode":"bogus"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusBadRequest)

	env.dir.failFrom["PutAgentSubscription"] = 1
	rec = hagentCovDo(env.h.CreateSubscription, hagentCovReq(http.MethodPost, target, `{"parentID":"p1"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "PutAgentSubscription")

	rec = hagentCovDo(env.h.CreateSubscription, hagentCovReq(http.MethodPost, target,
		`{"parentID":"p1","parentType":"conversation","keywords":["ops"],"heartbeatMins":30,"instruction":"watch","actionMode":"notify"}`, "u1", slug))
	hagentCovWant(t, rec, http.StatusCreated)
	if _, ok := hagentCovJSON(t, rec)["subscription"]; !ok {
		t.Fatalf("missing subscription in body: %s", rec.Body.String())
	}
}

func TestHagentCovDeleteSubscription(t *testing.T) {
	env := hagentCovNewEnv()
	env.dir.subs["p1"] = []*model.AgentSubscription{
		{ID: "s1", AgentID: env.agentID, CreatorID: "u1", ParentID: "p1"},
		{ID: "s2", AgentID: env.agentID, CreatorID: "u2", ParentID: "p1"},
	}
	pv := func(id string) map[string]string {
		return map[string]string{"slug": "gg", "parentID": "p1", "id": id}
	}
	target := "/api/v1/agents/gg/subscriptions/p1/"

	rec := hagentCovDo(env.h.DeleteSubscription, hagentCovReq(http.MethodDelete, target+"s2", "", "u1", pv("s2")))
	hagentCovWant(t, rec, http.StatusForbidden)

	rec = hagentCovDo(env.h.DeleteSubscription, hagentCovReq(http.MethodDelete, target+"sX", "", "u1", pv("sX")))
	hagentCovWant(t, rec, http.StatusNotFound)

	env.dir.failFrom["ListSubscriptionsByParent"] = 1
	rec = hagentCovDo(env.h.DeleteSubscription, hagentCovReq(http.MethodDelete, target+"s1", "", "u1", pv("s1")))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "ListSubscriptionsByParent")

	rec = hagentCovDo(env.h.DeleteSubscription, hagentCovReq(http.MethodDelete, target+"s1", "", "u1", pv("s1")))
	hagentCovWant(t, rec, http.StatusOK)
}

func TestHagentCovUpdateSubscription(t *testing.T) {
	env := hagentCovNewEnv()
	env.dir.subs["p1"] = []*model.AgentSubscription{
		{ID: "s1", AgentID: env.agentID, CreatorID: "u1", ParentID: "p1", ActionMode: "notify"},
		{ID: "s2", AgentID: env.agentID, CreatorID: "u2", ParentID: "p1", ActionMode: "notify"},
	}
	pv := func(id string) map[string]string {
		return map[string]string{"slug": "gg", "parentID": "p1", "id": id}
	}
	target := "/api/v1/agents/gg/subscriptions/p1/"

	rec := hagentCovDo(env.h.UpdateSubscription, hagentCovReq(http.MethodPatch, target+"s1", "{", "u1", pv("s1")))
	hagentCovWant(t, rec, http.StatusBadRequest)

	rec = hagentCovDo(env.h.UpdateSubscription, hagentCovReq(http.MethodPatch, target+"s2", `{"instruction":"x"}`, "u1", pv("s2")))
	hagentCovWant(t, rec, http.StatusForbidden)

	rec = hagentCovDo(env.h.UpdateSubscription, hagentCovReq(http.MethodPatch, target+"s1", `{"actionMode":"bogus"}`, "u1", pv("s1")))
	hagentCovWant(t, rec, http.StatusBadRequest)

	rec = hagentCovDo(env.h.UpdateSubscription, hagentCovReq(http.MethodPatch, target+"sX", `{"instruction":"x"}`, "u1", pv("sX")))
	hagentCovWant(t, rec, http.StatusNotFound)

	env.dir.failFrom["ListSubscriptionsByParent"] = 1
	rec = hagentCovDo(env.h.UpdateSubscription, hagentCovReq(http.MethodPatch, target+"s1", `{"instruction":"x"}`, "u1", pv("s1")))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "ListSubscriptionsByParent")

	rec = hagentCovDo(env.h.UpdateSubscription, hagentCovReq(http.MethodPatch, target+"s1", `{"instruction":"do x","actionMode":"reply"}`, "u1", pv("s1")))
	hagentCovWant(t, rec, http.StatusOK)
	if _, ok := hagentCovJSON(t, rec)["subscription"]; !ok {
		t.Fatalf("missing subscription in body: %s", rec.Body.String())
	}
}

func TestHagentCovDecideCatchUp(t *testing.T) {
	env := hagentCovNewEnv()
	pv := map[string]string{"parentID": "p1", "id": "s1"}
	target := "/api/v1/watchers/p1/s1/catchup"

	rec := hagentCovDo(env.h.DecideCatchUp, hagentCovReq(http.MethodPost, target, "{", "u1", pv))
	hagentCovWant(t, rec, http.StatusBadRequest)

	rec = hagentCovDo(env.h.DecideCatchUp, hagentCovReq(http.MethodPost, target, `{"process":true}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusNotFound)

	env.dir.failFrom["ListSubscriptionsByParent"] = 1
	rec = hagentCovDo(env.h.DecideCatchUp, hagentCovReq(http.MethodPost, target, `{"process":true}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "ListSubscriptionsByParent")

	sub := &model.AgentSubscription{
		ID: "s1", AgentID: env.agentID, CreatorID: "u1", ParentID: "p1", ParentType: "channel",
		ActionMode: "notify",
	}
	env.dir.subs["p1"] = []*model.AgentSubscription{sub}

	rec = hagentCovDo(env.h.DecideCatchUp, hagentCovReq(http.MethodPost, target, `{"process":true}`, "u2", pv))
	hagentCovWant(t, rec, http.StatusForbidden)

	// No pending backlog: idempotent OK.
	rec = hagentCovDo(env.h.DecideCatchUp, hagentCovReq(http.MethodPost, target, `{"process":true}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusOK)

	// Backlog pending but the creator has no live runner: the coalesced run
	// can't start right now.
	sub.PendingCatchUp = true
	rec = hagentCovDo(env.h.DecideCatchUp, hagentCovReq(http.MethodPost, target, `{"process":true}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusConflict)
}

// ------------------------------------------------------------------- skills

func TestHagentCovListSkills(t *testing.T) {
	env := hagentCovNewEnv()

	env.dir.failFrom["ListSkills"] = 1
	rec := hagentCovDo(env.h.ListSkills, hagentCovReq(http.MethodGet, "/api/v1/skills", "", "u1", nil))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "ListSkills")

	env.dir.skills["sk1"] = &model.Skill{ID: "sk1", Name: "notes", Instructions: "take notes", CreatedBy: "u1"}
	rec = hagentCovDo(env.h.ListSkills, hagentCovReq(http.MethodGet, "/api/v1/skills", "", "u1", nil))
	hagentCovWant(t, rec, http.StatusOK)
	if sk := hagentCovJSON(t, rec)["skills"].([]any); len(sk) != 1 {
		t.Fatalf("skills = %d, want 1", len(sk))
	}
}

func TestHagentCovCreateSkill(t *testing.T) {
	env := hagentCovNewEnv()

	rec := hagentCovDo(env.h.CreateSkill, hagentCovReq(http.MethodPost, "/api/v1/skills", "{", "u1", nil))
	hagentCovWant(t, rec, http.StatusBadRequest)

	rec = hagentCovDo(env.h.CreateSkill, hagentCovReq(http.MethodPost, "/api/v1/skills", `{"name":"","instructions":"i"}`, "u1", nil))
	hagentCovWant(t, rec, http.StatusBadRequest)

	env.dir.failFrom["PutSkill"] = 1
	rec = hagentCovDo(env.h.CreateSkill, hagentCovReq(http.MethodPost, "/api/v1/skills", `{"name":"n","instructions":"i"}`, "u1", nil))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "PutSkill")

	rec = hagentCovDo(env.h.CreateSkill, hagentCovReq(http.MethodPost, "/api/v1/skills", `{"name":"n","description":"d","instructions":"i"}`, "u1", nil))
	hagentCovWant(t, rec, http.StatusCreated)
	if _, ok := hagentCovJSON(t, rec)["skill"]; !ok {
		t.Fatalf("missing skill in body: %s", rec.Body.String())
	}
}

func TestHagentCovUpdateSkill(t *testing.T) {
	env := hagentCovNewEnv()
	env.dir.skills["sk1"] = &model.Skill{ID: "sk1", Name: "notes", Instructions: "take notes", CreatedBy: "u1"}
	pv := map[string]string{"id": "sk1"}

	rec := hagentCovDo(env.h.UpdateSkill, hagentCovReq(http.MethodPatch, "/api/v1/skills/sk1", "{", "u1", pv))
	hagentCovWant(t, rec, http.StatusBadRequest)

	// writeSkillError: not found.
	rec = hagentCovDo(env.h.UpdateSkill, hagentCovReq(http.MethodPatch, "/api/v1/skills/zzz", `{"name":"x"}`, "u1", map[string]string{"id": "zzz"}))
	hagentCovWant(t, rec, http.StatusNotFound)

	// writeSkillError: validation (blanked name).
	rec = hagentCovDo(env.h.UpdateSkill, hagentCovReq(http.MethodPatch, "/api/v1/skills/sk1", `{"name":""}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusBadRequest)

	// writeSkillError: default/internal (save fails).
	env.dir.failFrom["PutSkill"] = 1
	rec = hagentCovDo(env.h.UpdateSkill, hagentCovReq(http.MethodPatch, "/api/v1/skills/sk1", `{"name":"renamed"}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusInternalServerError)
	delete(env.dir.failFrom, "PutSkill")

	rec = hagentCovDo(env.h.UpdateSkill, hagentCovReq(http.MethodPatch, "/api/v1/skills/sk1", `{"name":"renamed"}`, "u1", pv))
	hagentCovWant(t, rec, http.StatusOK)
	if _, ok := hagentCovJSON(t, rec)["skill"]; !ok {
		t.Fatalf("missing skill in body: %s", rec.Body.String())
	}
}

func TestHagentCovDeleteSkill(t *testing.T) {
	env := hagentCovNewEnv()
	env.dir.skills["sk1"] = &model.Skill{ID: "sk1", Name: "notes", Instructions: "take notes", CreatedBy: "u1"}
	env.dir.skills["sk2"] = &model.Skill{ID: "sk2", Name: "other", Instructions: "o", CreatedBy: "u2"}

	// writeSkillError: forbidden (not the author).
	rec := hagentCovDo(env.h.DeleteSkill, hagentCovReq(http.MethodDelete, "/api/v1/skills/sk2", "", "u1", map[string]string{"id": "sk2"}))
	hagentCovWant(t, rec, http.StatusForbidden)

	rec = hagentCovDo(env.h.DeleteSkill, hagentCovReq(http.MethodDelete, "/api/v1/skills/sk1", "", "u1", map[string]string{"id": "sk1"}))
	hagentCovWant(t, rec, http.StatusOK)
}
