package handler

// Statement-coverage tests for internal/handler/agentrunner.go.
//
// Everything here is self-contained: hrunnerCov-prefixed fakes implement the
// store surfaces the real services need, so the handlers run against real
// *service.Orchestrator / *service.AgentService / *service.MessageService /
// *service.ContextService instances, exactly as wired in production.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
	"github.com/DigitalTolk/ex/internal/store"
)

const (
	hrunnerCovInvoker = "hrc-invoker"
	hrunnerCovChan    = "hrc-chan"
	hrunnerCovConv    = "hrc-conv"
	hrunnerCovRoot    = "hrc-root-msg"
	hrunnerCovRunID   = "hrc-run-1"
	hrunnerCovRunner  = "hrc-runner-1"
)

var hrunnerCovAgentID = service.AgentUserID("gg")

// ------------------------------------------------------------ run store fake

type hrunnerCovRunStore struct {
	mu        sync.Mutex
	runs      map[string]*model.Run
	queue     []string
	events    []*model.RunEvent
	digests   map[string]*model.RunDigest
	approvals map[string]*model.Approval
	artifacts []*model.Artifact

	listQueuedErr   error
	getRunErr       error
	getRunErrAfter  int // -1 = disabled; otherwise error once this many GetRun calls succeeded
	getRunCalls     int
	updateErr       error
	putApprovalErr  error
	putArtifactErr  error
	listArtifactsErr error
}

func hrunnerCovNewRunStore() *hrunnerCovRunStore {
	return &hrunnerCovRunStore{
		runs:           make(map[string]*model.Run),
		digests:        make(map[string]*model.RunDigest),
		approvals:      make(map[string]*model.Approval),
		getRunErrAfter: -1,
	}
}

func (s *hrunnerCovRunStore) put(run *model.Run) {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *run
	s.runs[run.ID] = &cp
}

func (s *hrunnerCovRunStore) CreateRun(_ context.Context, run *model.Run) error {
	s.put(run)
	return nil
}

func (s *hrunnerCovRunStore) GetRun(_ context.Context, runID string) (*model.Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.getRunErrAfter >= 0 && s.getRunCalls >= s.getRunErrAfter {
		if s.getRunErr != nil {
			return nil, s.getRunErr
		}
		return nil, errors.New("hrunnerCov: getrun blew up")
	}
	run, ok := s.runs[runID]
	if !ok {
		return nil, store.ErrNotFound
	}
	s.getRunCalls++
	cp := *run
	return &cp, nil
}

func (s *hrunnerCovRunStore) UpdateRun(_ context.Context, run *model.Run, expectState model.RunState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.updateErr != nil {
		return s.updateErr
	}
	stored, ok := s.runs[run.ID]
	if !ok || stored.State != expectState {
		return store.ErrStaleRun
	}
	cp := *run
	s.runs[run.ID] = &cp
	return nil
}

func (s *hrunnerCovRunStore) RenewRunLease(_ context.Context, runID, runnerID string, lease time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	stored, ok := s.runs[runID]
	if !ok || stored.State.Terminal() || stored.RunnerID != runnerID {
		return store.ErrStaleRun
	}
	stored.LeaseExpiresAt = &lease
	return nil
}

func (s *hrunnerCovRunStore) ListQueuedRuns(_ context.Context, _ string, _ int) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listQueuedErr != nil {
		return nil, s.listQueuedErr
	}
	return append([]string(nil), s.queue...), nil
}

func (s *hrunnerCovRunStore) ClaimRun(_ context.Context, run *model.Run, runnerID string, lease time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	stored, ok := s.runs[run.ID]
	if !ok || stored.State != model.RunStateQueued {
		return store.ErrStaleRun
	}
	claimed := *run
	claimed.State = model.RunStateAcknowledged
	claimed.RunnerID = runnerID
	claimed.LeaseExpiresAt = &lease
	claimed.UpdatedAt = time.Now()
	cp := claimed
	s.runs[run.ID] = &cp
	kept := s.queue[:0]
	for _, id := range s.queue {
		if id != run.ID {
			kept = append(kept, id)
		}
	}
	s.queue = kept
	*run = claimed
	return nil
}

func (s *hrunnerCovRunStore) DeleteQueueEntry(_ context.Context, _, runID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.queue[:0]
	for _, id := range s.queue {
		if id != runID {
			kept = append(kept, id)
		}
	}
	s.queue = kept
	return nil
}

func (s *hrunnerCovRunStore) ListActiveRunsPastDeadline(context.Context, time.Time, int) ([]*model.Run, error) {
	return nil, nil
}
func (s *hrunnerCovRunStore) ListActiveRuns(context.Context) ([]*model.Run, error) { return nil, nil }

func (s *hrunnerCovRunStore) AppendRunEvent(_ context.Context, evt *model.RunEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.events = append(s.events, evt)
	return nil
}

func (s *hrunnerCovRunStore) ListRunEvents(context.Context, string) ([]*model.RunEvent, error) {
	return nil, nil
}
func (s *hrunnerCovRunStore) DeleteRunEvents(context.Context, string) error { return nil }

func (s *hrunnerCovRunStore) PutDigest(_ context.Context, d *model.RunDigest) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.digests[d.RunID] = d
	return nil
}

func (s *hrunnerCovRunStore) GetDigest(_ context.Context, runID string) (*model.RunDigest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.digests[runID]; ok {
		return d, nil
	}
	return nil, store.ErrNotFound
}

func (s *hrunnerCovRunStore) ListRunsByParent(context.Context, string, int) ([]*model.Run, error) {
	return nil, nil
}

func (s *hrunnerCovRunStore) PutApproval(_ context.Context, a *model.Approval) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.putApprovalErr != nil {
		return s.putApprovalErr
	}
	s.approvals[a.RunID+"#"+a.ID] = a
	return nil
}

func (s *hrunnerCovRunStore) GetApproval(_ context.Context, runID, approvalID string) (*model.Approval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a, ok := s.approvals[runID+"#"+approvalID]; ok {
		cp := *a
		return &cp, nil
	}
	return nil, store.ErrNotFound
}

func (s *hrunnerCovRunStore) SettleApproval(_ context.Context, runID, approvalID, state, decidedBy, choice, note string, decidedAt time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.approvals[runID+"#"+approvalID]
	if !ok {
		return store.ErrNotFound
	}
	a.State, a.DecidedBy, a.Choice, a.Note, a.DecidedAt = state, decidedBy, choice, note, &decidedAt
	return nil
}

func (s *hrunnerCovRunStore) ListApprovals(_ context.Context, runID string) ([]*model.Approval, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []*model.Approval
	for _, a := range s.approvals {
		if a.RunID == runID {
			cp := *a
			out = append(out, &cp)
		}
	}
	return out, nil
}

func (s *hrunnerCovRunStore) PutArtifact(_ context.Context, a *model.Artifact) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.putArtifactErr != nil {
		return s.putArtifactErr
	}
	s.artifacts = append(s.artifacts, a)
	return nil
}

func (s *hrunnerCovRunStore) ListArtifacts(_ context.Context, runID string) ([]*model.Artifact, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listArtifactsErr != nil {
		return nil, s.listArtifactsErr
	}
	var out []*model.Artifact
	for _, a := range s.artifacts {
		if a.RunID == runID {
			out = append(out, a)
		}
	}
	return out, nil
}

// ------------------------------------------------------- agent directory fake

type hrunnerCovDir struct {
	mu         sync.Mutex
	templates  []*model.AgentTemplate
	skills     map[string]*model.Skill
	taskClaims []*model.TaskClaim

	listTemplatesErr error
	listSkillsErr    error
	putRunnerErr     error
	putMemoryErr     error
	putTaskClaimErr  error
}

func hrunnerCovNewDir() *hrunnerCovDir {
	return &hrunnerCovDir{skills: make(map[string]*model.Skill)}
}

func (d *hrunnerCovDir) PutTemplate(context.Context, *model.AgentTemplate) error           { return nil }
func (d *hrunnerCovDir) CreateTemplateIfAbsent(context.Context, *model.AgentTemplate) error { return nil }
func (d *hrunnerCovDir) GetTemplate(context.Context, string) (*model.AgentTemplate, error) {
	return nil, store.ErrNotFound
}

func (d *hrunnerCovDir) ListTemplates(context.Context) ([]*model.AgentTemplate, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.listTemplatesErr != nil {
		return nil, d.listTemplatesErr
	}
	return append([]*model.AgentTemplate(nil), d.templates...), nil
}

func (d *hrunnerCovDir) CreateAgentUser(context.Context, *model.User) error       { return nil }
func (d *hrunnerCovDir) PutAgentPrefs(context.Context, *model.UserAgentPrefs) error { return nil }
func (d *hrunnerCovDir) GetAgentPrefs(context.Context, string, string) (*model.UserAgentPrefs, error) {
	return nil, store.ErrNotFound
}

func (d *hrunnerCovDir) PutRunner(context.Context, *model.RunnerRegistration) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.putRunnerErr
}

func (d *hrunnerCovDir) ListRunners(context.Context, string) ([]*model.RunnerRegistration, error) {
	return nil, nil
}
func (d *hrunnerCovDir) DeleteRunner(context.Context, string, string) error { return nil }
func (d *hrunnerCovDir) PutSkill(context.Context, *model.Skill) error       { return nil }

func (d *hrunnerCovDir) GetSkill(_ context.Context, id string) (*model.Skill, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if sk, ok := d.skills[id]; ok {
		return sk, nil
	}
	return nil, store.ErrNotFound
}

func (d *hrunnerCovDir) ListSkills(context.Context) ([]*model.Skill, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.listSkillsErr != nil {
		return nil, d.listSkillsErr
	}
	var out []*model.Skill
	for _, sk := range d.skills {
		out = append(out, sk)
	}
	return out, nil
}

func (d *hrunnerCovDir) DeleteSkill(context.Context, string) error { return nil }

func (d *hrunnerCovDir) PutAgentMemory(context.Context, *model.AgentMemory) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.putMemoryErr
}

func (d *hrunnerCovDir) GetAgentMemory(context.Context, string, string) (*model.AgentMemory, error) {
	return nil, store.ErrNotFound
}

func (d *hrunnerCovDir) PutAgentSubscription(context.Context, *model.AgentSubscription) error {
	return nil
}
func (d *hrunnerCovDir) ListSubscriptionsByParent(context.Context, string) ([]*model.AgentSubscription, error) {
	return nil, nil
}
func (d *hrunnerCovDir) ListAllSubscriptions(context.Context) ([]*model.AgentSubscription, error) {
	return nil, nil
}
func (d *hrunnerCovDir) DeleteAgentSubscription(context.Context, string, string) error { return nil }

func (d *hrunnerCovDir) PutTaskClaim(_ context.Context, c *model.TaskClaim) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.putTaskClaimErr != nil {
		return d.putTaskClaimErr
	}
	d.taskClaims = append(d.taskClaims, c)
	return nil
}

func (d *hrunnerCovDir) ListTaskClaims(context.Context, string, string) ([]*model.TaskClaim, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]*model.TaskClaim(nil), d.taskClaims...), nil
}

func (d *hrunnerCovDir) PutAgentFollow(context.Context, *model.AgentThreadFollow) error { return nil }
func (d *hrunnerCovDir) ListAgentFollows(context.Context, string, string) ([]*model.AgentThreadFollow, error) {
	return nil, nil
}

// --------------------------------------------------------------- users fake

type hrunnerCovUsers struct {
	mu    sync.Mutex
	users map[string]*model.User
}

func (f *hrunnerCovUsers) GetUser(_ context.Context, id string) (*model.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	u, ok := f.users[id]
	if !ok {
		return nil, store.ErrNotFound
	}
	cp := *u
	return &cp, nil
}

func (f *hrunnerCovUsers) UpdateUser(_ context.Context, u *model.User) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	cp := *u
	f.users[u.ID] = &cp
	return nil
}

func (f *hrunnerCovUsers) GetUsersByIDs(_ context.Context, ids []string) ([]*model.User, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []*model.User
	for _, id := range ids {
		if u, ok := f.users[id]; ok {
			cp := *u
			out = append(out, &cp)
		}
	}
	return out, nil
}

// ---------------------------------------------- orchestrator messages fake

type hrunnerCovOrchMsgs struct {
	mu   sync.Mutex
	sent []string
}

func (f *hrunnerCovOrchMsgs) SendAsAgentRun(_ context.Context, agentID, _, parentID, parentType, body, parentMessageID, runID string) (*model.Message, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, body)
	return &model.Message{
		ID: fmt.Sprintf("hrc-om-%d", len(f.sent)), ParentID: parentID, ParentType: parentType,
		AuthorID: agentID, Body: body, ParentMessageID: parentMessageID, AgentRunID: runID,
		CreatedAt: time.Now(),
	}, nil
}

func (f *hrunnerCovOrchMsgs) SetMachineReaction(context.Context, string, string, string, string, string) error {
	return nil
}
func (f *hrunnerCovOrchMsgs) ListThreadMessages(context.Context, string, string, string, string) ([]*model.Message, error) {
	return nil, nil
}
func (f *hrunnerCovOrchMsgs) List(context.Context, string, string, string, string, int) ([]*model.Message, bool, error) {
	return nil, false, nil
}

// ------------------------------------------------- pub / broker / minter

type hrunnerCovPub struct{}

func (hrunnerCovPub) Publish(context.Context, string, *events.Event) error { return nil }

type hrunnerCovBroker struct{}

func (hrunnerCovBroker) Subscribe(string, string)   {}
func (hrunnerCovBroker) Unsubscribe(string, string) {}

type hrunnerCovMinter struct{}

func (hrunnerCovMinter) GenerateRunToken(string, string, string, time.Time) (string, error) {
	return "hrc-run-token", nil
}

// -------------------------------------------- concrete message-service fakes

type hrunnerCovMsgStore struct {
	mu    sync.Mutex
	byKey map[string]*model.Message
}

func (s *hrunnerCovMsgStore) CreateMessage(_ context.Context, msg *model.Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byKey[msg.ParentID+"#"+msg.ID] = msg
	return nil
}

func (s *hrunnerCovMsgStore) GetMessage(_ context.Context, parentID, msgID string) (*model.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if m, ok := s.byKey[parentID+"#"+msgID]; ok {
		cp := *m
		return &cp, nil
	}
	return nil, store.ErrNotFound
}

func (s *hrunnerCovMsgStore) UpdateMessage(context.Context, *model.Message) error  { return nil }
func (s *hrunnerCovMsgStore) DeleteMessage(context.Context, string, string) error  { return nil }
func (s *hrunnerCovMsgStore) ListMessages(context.Context, string, string, int) ([]*model.Message, bool, error) {
	return nil, false, nil
}
func (s *hrunnerCovMsgStore) ListThreadReplies(context.Context, string) ([]*model.Message, error) {
	return nil, nil
}
func (s *hrunnerCovMsgStore) ListMessagesAfter(context.Context, string, string, int) ([]*model.Message, bool, error) {
	return nil, false, nil
}
func (s *hrunnerCovMsgStore) ListMessagesAround(context.Context, string, string, int, int) ([]*model.Message, bool, bool, error) {
	return nil, false, false, nil
}
func (s *hrunnerCovMsgStore) IncrementReplyMetadata(context.Context, string, string, time.Time, string) (*model.Message, error) {
	return nil, nil
}

type hrunnerCovMembershipStore struct {
	members map[string]bool // channelID#userID
}

func (s hrunnerCovMembershipStore) AddMember(context.Context, *model.ChannelMembership, *model.UserChannel) error {
	return nil
}
func (s hrunnerCovMembershipStore) RemoveMember(context.Context, string, string) error { return nil }
func (s hrunnerCovMembershipStore) GetMembership(_ context.Context, channelID, userID string) (*model.ChannelMembership, error) {
	if s.members[channelID+"#"+userID] {
		return &model.ChannelMembership{ChannelID: channelID, UserID: userID}, nil
	}
	return nil, store.ErrNotFound
}
func (s hrunnerCovMembershipStore) UpdateMemberRole(context.Context, string, string, model.ChannelRole) error {
	return nil
}
func (s hrunnerCovMembershipStore) ListMembers(context.Context, string) ([]*model.ChannelMembership, error) {
	return nil, nil
}
func (s hrunnerCovMembershipStore) ListUserChannels(context.Context, string) ([]*model.UserChannel, error) {
	return nil, nil
}
func (s hrunnerCovMembershipStore) UserChannelNotifPrefs(context.Context, string, []string) (map[string]*model.UserChannel, error) {
	return nil, nil
}
func (s hrunnerCovMembershipStore) SetMute(context.Context, string, string, bool) error { return nil }
func (s hrunnerCovMembershipStore) SetChannelLastRead(context.Context, string, string, int64) error {
	return nil
}
func (s hrunnerCovMembershipStore) SetFavorite(context.Context, string, string, bool) error {
	return nil
}
func (s hrunnerCovMembershipStore) SetCategory(context.Context, string, string, string, *int) error {
	return nil
}
func (s hrunnerCovMembershipStore) SetNotifPrefs(context.Context, string, string, model.ChannelNotificationOverride) error {
	return nil
}

type hrunnerCovConvStore struct {
	convs map[string]*model.Conversation
}

func (s hrunnerCovConvStore) CreateConversation(context.Context, *model.Conversation, []*model.UserConversation) error {
	return nil
}
func (s hrunnerCovConvStore) GetConversation(_ context.Context, id string) (*model.Conversation, error) {
	if c, ok := s.convs[id]; ok {
		return c, nil
	}
	return nil, store.ErrNotFound
}
func (s hrunnerCovConvStore) ListUserConversations(context.Context, string) ([]*model.UserConversation, error) {
	return nil, nil
}
func (s hrunnerCovConvStore) ActivateConversation(context.Context, string, []string) error {
	return nil
}
func (s hrunnerCovConvStore) TouchConversation(context.Context, string, []string, time.Time) error {
	return nil
}
func (s hrunnerCovConvStore) IncrementMessageSeq(context.Context, string) (int64, error) {
	return 0, nil
}
func (s hrunnerCovConvStore) SetConversationLastRead(context.Context, string, string, int64) error {
	return nil
}
func (s hrunnerCovConvStore) SetFavorite(context.Context, string, string, bool) error { return nil }
func (s hrunnerCovConvStore) SetCategory(context.Context, string, string, string, *int) error {
	return nil
}

type hrunnerCovCtxStore struct {
	mu     sync.Mutex
	listN  int
	putErr error
	items  []*model.ContextItem
}

func (s *hrunnerCovCtxStore) PutContextItem(_ context.Context, it *model.ContextItem) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.putErr != nil {
		return s.putErr
	}
	s.items = append(s.items, it)
	return nil
}

func (s *hrunnerCovCtxStore) GetContextItem(context.Context, string, string, string) (*model.ContextItem, error) {
	return nil, store.ErrNotFound
}

func (s *hrunnerCovCtxStore) ListContextItems(context.Context, string, string) ([]*model.ContextItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]*model.ContextItem, 0, s.listN+len(s.items))
	for i := 0; i < s.listN; i++ {
		out = append(out, &model.ContextItem{ID: fmt.Sprintf("hrc-ci-%d", i), AuthorID: hrunnerCovInvoker, Body: "x"})
	}
	return append(out, s.items...), nil
}

func (s *hrunnerCovCtxStore) DeleteContextItem(context.Context, string, string, string) error {
	return nil
}

// ------------------------------------------------------------------ fixture

type hrunnerCovFix struct {
	runs    *hrunnerCovRunStore
	dir     *hrunnerCovDir
	users   *hrunnerCovUsers
	omsgs   *hrunnerCovOrchMsgs
	msgs    *hrunnerCovMsgStore
	ctxst   *hrunnerCovCtxStore
	orch    *service.Orchestrator
	runnerH *AgentRunnerHandler
	toolH   *AgentRunToolHandler
}

func hrunnerCovNewFix(t *testing.T) *hrunnerCovFix {
	t.Helper()
	invoker := &model.User{ID: hrunnerCovInvoker, DisplayName: "Inva Person"}
	agent := &model.User{
		ID: hrunnerCovAgentID, DisplayName: "gg", Kind: model.UserKindAgent,
		AgentConfig: &model.AgentConfig{TemplateSlug: "gg"},
	}
	users := &hrunnerCovUsers{users: map[string]*model.User{invoker.ID: invoker, agent.ID: agent}}
	dir := hrunnerCovNewDir()
	dir.templates = []*model.AgentTemplate{{Slug: "gg", DisplayName: "gg", Harness: model.HarnessClaude}}
	runs := hrunnerCovNewRunStore()
	omsgs := &hrunnerCovOrchMsgs{}
	agentSvc := service.NewAgentService(dir, users)
	orch := service.NewOrchestrator(runs, agentSvc, users, omsgs, hrunnerCovPub{}, hrunnerCovMinter{})

	msgs := &hrunnerCovMsgStore{byKey: map[string]*model.Message{
		hrunnerCovChan + "#" + hrunnerCovRoot: {ID: hrunnerCovRoot, ParentID: hrunnerCovChan, AuthorID: hrunnerCovInvoker, Body: "root"},
	}}
	members := hrunnerCovMembershipStore{members: map[string]bool{hrunnerCovChan + "#" + hrunnerCovInvoker: true}}
	convs := hrunnerCovConvStore{convs: map[string]*model.Conversation{
		hrunnerCovConv: {ID: hrunnerCovConv, ParticipantIDs: []string{hrunnerCovInvoker, hrunnerCovAgentID}},
	}}
	msgSvc := service.NewMessageService(msgs, members, convs, nil, hrunnerCovBroker{})
	ctxst := &hrunnerCovCtxStore{}
	ctxSvc := service.NewContextService(ctxst, msgSvc)

	return &hrunnerCovFix{
		runs: runs, dir: dir, users: users, omsgs: omsgs, msgs: msgs, ctxst: ctxst, orch: orch,
		runnerH: NewAgentRunnerHandler(agentSvc, orch),
		toolH:   NewAgentRunToolHandler(orch, msgSvc, ctxSvc, agentSvc),
	}
}

// addRun seeds a run with sane live defaults; overrides are applied by the
// caller mutating the returned value BEFORE addRun (pass a partially-filled
// run) — zero fields get defaults.
func (fx *hrunnerCovFix) addRun(run *model.Run) *model.Run {
	if run.ID == "" {
		run.ID = hrunnerCovRunID
	}
	if run.AgentID == "" {
		run.AgentID = hrunnerCovAgentID
	}
	if run.InvokerID == "" {
		run.InvokerID = hrunnerCovInvoker
	}
	if run.OwnerID == "" {
		run.OwnerID = hrunnerCovInvoker
	}
	if run.ParentID == "" && run.ParentType == "" {
		run.ParentID, run.ParentType = hrunnerCovChan, service.ParentChannel
	}
	if run.MessageID == "" {
		run.MessageID = hrunnerCovRoot
	}
	if run.State == "" {
		run.State = model.RunStateRunning
	}
	if run.RunnerID == "" && !run.State.Terminal() && run.State != model.RunStateQueued {
		run.RunnerID = hrunnerCovRunner
	}
	if run.Harness == "" {
		run.Harness = model.HarnessClaude
	}
	if run.Mode == "" {
		run.Mode = model.RunModeDirect
	}
	zero := model.AgentLimits{}
	if run.Limits == zero {
		run.Limits = model.DefaultAgentLimits()
	}
	if run.Deadline.IsZero() {
		run.Deadline = time.Now().Add(time.Hour)
	}
	if run.HardDeadline.IsZero() {
		run.HardDeadline = time.Now().Add(2 * time.Hour)
	}
	if run.CreatedAt.IsZero() {
		run.CreatedAt = time.Now()
	}
	fx.runs.put(run)
	return run
}

func hrunnerCovRunnerClaims() *model.TokenClaims {
	return &model.TokenClaims{UserID: hrunnerCovInvoker}
}

func hrunnerCovToolClaims(runID string) *model.TokenClaims {
	return &model.TokenClaims{UserID: hrunnerCovInvoker, ActorID: hrunnerCovAgentID, RunID: runID}
}

func hrunnerCovDo(t *testing.T, h http.HandlerFunc, method, body string, claims *model.TokenClaims, pathVals map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, "/hrc", rd)
	if claims != nil {
		req = req.WithContext(middleware.ContextWithClaims(req.Context(), claims))
	}
	for k, v := range pathVals {
		req.SetPathValue(k, v)
	}
	rec := httptest.NewRecorder()
	h(rec, req)
	return rec
}

func hrunnerCovBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("response not JSON: %v — %q", err, rec.Body.String())
	}
	return m
}

func hrunnerCovWantStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d; body %s", rec.Code, want, rec.Body.String())
	}
}

// ------------------------------------------------------------------ Register

func TestHrunnerCovRegister(t *testing.T) {
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.runnerH.Register, http.MethodPost, "{bad", hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("missing runnerID", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.runnerH.Register, http.MethodPost, `{"host":"h"}`, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("heartbeat store failure", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.dir.putRunnerErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.runnerH.Register, http.MethodPost, `{"runnerID":"r1"}`, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("agent list failure", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.dir.listTemplatesErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.runnerH.Register, http.MethodPost, `{"runnerID":"r1"}`, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		body := `{"runnerID":"r1","host":"mac","os":"darwin","harnesses":[{"name":"claude","authed":true}]}`
		rec := hrunnerCovDo(t, fx.runnerH.Register, http.MethodPost, body, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if got["runnerID"] != "r1" {
			t.Errorf("runnerID = %v", got["runnerID"])
		}
		agents, _ := got["agents"].([]any)
		if len(agents) != 1 {
			t.Errorf("agents = %v, want one entry", got["agents"])
		}
	})
}

// --------------------------------------------------------------------- Claim

func TestHrunnerCovClaim(t *testing.T) {
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.runnerH.Claim, http.MethodPost, "{bad", hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("store failure", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.runs.listQueuedErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.runnerH.Claim, http.MethodPost, `{"runnerID":"r1","waitSec":5}`, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("client gone mid-poll", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		req := httptest.NewRequest(http.MethodPost, "/hrc", strings.NewReader(`{"runnerID":"r1","waitSec":0}`))
		ctx, cancel := context.WithCancel(middleware.ContextWithClaims(req.Context(), hrunnerCovRunnerClaims()))
		req = req.WithContext(ctx)
		go func() {
			time.Sleep(50 * time.Millisecond)
			cancel()
		}()
		rec := httptest.NewRecorder()
		fx.runnerH.Claim(rec, req)
		if rec.Body.Len() != 0 {
			t.Errorf("expected silent return, got body %q", rec.Body.String())
		}
	})
	t.Run("assignments", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		run := fx.addRun(&model.Run{State: model.RunStateQueued, Prompt: "do the thing"})
		fx.runs.mu.Lock()
		fx.runs.queue = append(fx.runs.queue, run.ID)
		fx.runs.mu.Unlock()
		body := `{"runnerID":"r-claim","harnesses":["claude"],"max":1,"waitSec":5}`
		rec := hrunnerCovDo(t, fx.runnerH.Claim, http.MethodPost, body, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		as, _ := got["assignments"].([]any)
		if len(as) != 1 {
			t.Fatalf("assignments = %v, want 1", got["assignments"])
		}
		a := as[0].(map[string]any)
		if a["runID"] != run.ID || a["mcpToken"] != "hrc-run-token" {
			t.Errorf("assignment = %v", a)
		}
	})
	t.Run("empty wait yields 204", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.runnerH.Claim, http.MethodPost, `{"runnerID":"r1","waitSec":1}`, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNoContent)
	})
}

// -------------------------------------------------------------------- Events

func TestHrunnerCovEvents(t *testing.T) {
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.runnerH.Events, http.MethodPost, "{bad", hrunnerCovRunnerClaims(), map[string]string{"id": "x"})
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		body := `{"runnerID":"` + hrunnerCovRunner + `","events":[]}`
		rec := hrunnerCovDo(t, fx.runnerH.Events, http.MethodPost, body, hrunnerCovRunnerClaims(), map[string]string{"id": "nope"})
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("terminal run aborts", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{State: model.RunStateCompleted})
		body := `{"runnerID":"` + hrunnerCovRunner + `","events":[]}`
		rec := hrunnerCovDo(t, fx.runnerH.Events, http.MethodPost, body, hrunnerCovRunnerClaims(), map[string]string{"id": hrunnerCovRunID})
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if got["abort"] != true || got["reason"] != "run_closed" {
			t.Errorf("got %v", got)
		}
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		body := `{"runnerID":"` + hrunnerCovRunner + `","events":[` +
			`{"seq":1,"type":"turn"},` +
			`{"seq":2,"type":"usage","payload":{"inputTokens":5,"outputTokens":7}},` +
			`{"seq":3,"type":"progress","payload":{"text":"working"}},` +
			`{"seq":4,"type":"state"},` +
			`{"seq":5,"type":"tool","payload":{"name":"post","detail":"x"}}]}`
		rec := hrunnerCovDo(t, fx.runnerH.Events, http.MethodPost, body, hrunnerCovRunnerClaims(), map[string]string{"id": hrunnerCovRunID})
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if got["abort"] != false {
			t.Errorf("abort = %v, want false", got["abort"])
		}
	})
}

// ------------------------------------------------------------------ Complete

func TestHrunnerCovComplete(t *testing.T) {
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.runnerH.Complete, http.MethodPost, "{bad", hrunnerCovRunnerClaims(), map[string]string{"id": "x"})
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("run closed", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{State: model.RunStateFailed})
		body := `{"runnerID":"` + hrunnerCovRunner + `","finalText":"x"}`
		rec := hrunnerCovDo(t, fx.runnerH.Complete, http.MethodPost, body, hrunnerCovRunnerClaims(), map[string]string{"id": hrunnerCovRunID})
		hrunnerCovWantStatus(t, rec, http.StatusConflict)
		if got := hrunnerCovBody(t, rec); got["error"].(map[string]any)["code"] != "run_closed" {
			t.Errorf("got %v", got)
		}
	})
	t.Run("wrong runner", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{RunnerID: "someone-else"})
		body := `{"runnerID":"` + hrunnerCovRunner + `","finalText":"x"}`
		rec := hrunnerCovDo(t, fx.runnerH.Complete, http.MethodPost, body, hrunnerCovRunnerClaims(), map[string]string{"id": hrunnerCovRunID})
		hrunnerCovWantStatus(t, rec, http.StatusConflict)
		if got := hrunnerCovBody(t, rec); got["error"].(map[string]any)["code"] != "wrong_runner" {
			t.Errorf("got %v", got)
		}
	})
	t.Run("internal", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.runs.updateErr = errors.New("boom")
		body := `{"runnerID":"` + hrunnerCovRunner + `","finalText":"x"}`
		rec := hrunnerCovDo(t, fx.runnerH.Complete, http.MethodPost, body, hrunnerCovRunnerClaims(), map[string]string{"id": hrunnerCovRunID})
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		body := `{"runnerID":"` + hrunnerCovRunner + `","finalText":"all done","usage":{"inputTokens":3}}`
		rec := hrunnerCovDo(t, fx.runnerH.Complete, http.MethodPost, body, hrunnerCovRunnerClaims(), map[string]string{"id": hrunnerCovRunID})
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		if got := hrunnerCovBody(t, rec); got["ok"] != true {
			t.Errorf("got %v", got)
		}
	})
}

// ---------------------------------------------------------------------- Fail

func TestHrunnerCovFail(t *testing.T) {
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.runnerH.Fail, http.MethodPost, "{bad", hrunnerCovRunnerClaims(), map[string]string{"id": "x"})
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		body := `{"runnerID":"` + hrunnerCovRunner + `","reason":"oops"}`
		rec := hrunnerCovDo(t, fx.runnerH.Fail, http.MethodPost, body, hrunnerCovRunnerClaims(), map[string]string{"id": "nope"})
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("success with default reason", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		body := `{"runnerID":"` + hrunnerCovRunner + `"}`
		rec := hrunnerCovDo(t, fx.runnerH.Fail, http.MethodPost, body, hrunnerCovRunnerClaims(), map[string]string{"id": hrunnerCovRunID})
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		fx.runs.mu.Lock()
		got := fx.runs.runs[hrunnerCovRunID].FailReason
		fx.runs.mu.Unlock()
		if got != "runner_error" {
			t.Errorf("FailReason = %q, want runner_error", got)
		}
	})
}

// ----------------------------------------------------------------- Heartbeat

func TestHrunnerCovHeartbeat(t *testing.T) {
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.runnerH.Heartbeat, http.MethodPost, `{"host":"h"}`, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("store failure", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.dir.putRunnerErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.runnerH.Heartbeat, http.MethodPost, `{"runnerID":"r1"}`, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("empty kill list marshals as array", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.runnerH.Heartbeat, http.MethodPost, `{"runnerID":"r1"}`, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		if !strings.Contains(rec.Body.String(), `"kill":[]`) {
			t.Errorf("body = %s, want kill:[]", rec.Body.String())
		}
	})
	t.Run("unknown active run is killed", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		body := `{"runnerID":"r1","activeRunIDs":["ghost"]}`
		rec := hrunnerCovDo(t, fx.runnerH.Heartbeat, http.MethodPost, body, hrunnerCovRunnerClaims(), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		kill, _ := got["kill"].([]any)
		if len(kill) != 1 || kill[0] != "ghost" {
			t.Errorf("kill = %v", got["kill"])
		}
	})
}

// --------------------------------------------------------------- PostMessage

func TestHrunnerCovPostMessage(t *testing.T) {
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"body":"hi"}`, hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("bad body", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"body":"  "}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("notify-only watcher", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{ActionMode: model.WatchActionNotify})
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"body":"hi"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusForbidden)
	})
	t.Run("reply watcher needs approval", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{ActionMode: model.WatchActionReply})
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"body":"hi"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusForbidden)
	})
	t.Run("post cap", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{Spend: model.RunSpend{Posts: model.DefaultAgentLimits().MaxPosts}})
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"body":"hi"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusTooManyRequests)
	})
	t.Run("send rejected", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{ParentID: "hrc-no-access", ParentType: service.ParentChannel})
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"body":"hi"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusForbidden)
	})
	t.Run("success and idempotent replay", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		body := `{"body":"hello there","idempotencyKey":"k1"}`
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, body, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		first := hrunnerCovBody(t, rec)
		msgID, _ := first["messageID"].(string)
		if msgID == "" {
			t.Fatalf("messageID missing: %v", first)
		}
		if first["remainingPosts"] != float64(model.DefaultAgentLimits().MaxPosts-1) {
			t.Errorf("remainingPosts = %v", first["remainingPosts"])
		}
		rec = hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, body, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		second := hrunnerCovBody(t, rec)
		if second["deduped"] != true || second["messageID"] != msgID {
			t.Errorf("replay = %v, want dedup of %s", second, msgID)
		}
	})
	t.Run("record-post failure zeroes remaining", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		run := fx.addRun(&model.Run{ThreadRootID: hrunnerCovRoot})
		_ = run
		fx.runs.mu.Lock()
		fx.runs.getRunErrAfter = 1 // GetLiveRun succeeds; RecordAgentPost's read fails
		fx.runs.mu.Unlock()
		rec := hrunnerCovDo(t, fx.toolH.PostMessage, http.MethodPost, `{"body":"hi again"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if got["remainingPosts"] != float64(0) {
			t.Errorf("remainingPosts = %v, want 0", got["remainingPosts"])
		}
	})
}

// ---------------------------------------------------- GetThread / GetContext

func TestHrunnerCovGetThreadAndContext(t *testing.T) {
	t.Run("thread run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.GetThread, http.MethodGet, "", hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("thread success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.GetThread, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
	})
	t.Run("context run closed", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{State: model.RunStateCanceled})
		rec := hrunnerCovDo(t, fx.toolH.GetContext, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusConflict)
	})
	t.Run("context success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{Prompt: "summarize"})
		rec := hrunnerCovDo(t, fx.toolH.GetContext, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if text, _ := got["text"].(string); !strings.Contains(text, "summarize") {
			t.Errorf("bundle text = %q, want task prompt", text)
		}
	})
}

// -------------------------------------------------------------- WriteContext

func TestHrunnerCovWriteContext(t *testing.T) {
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.WriteContext, http.MethodPost, `{"body":"x"}`, hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.WriteContext, http.MethodPost, "{bad", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("validation", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.WriteContext, http.MethodPost, `{"body":"   "}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("context full", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.ctxst.listN = model.ContextItemsPerScope
		rec := hrunnerCovDo(t, fx.toolH.WriteContext, http.MethodPost, `{"body":"fact"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusTooManyRequests)
	})
	t.Run("forbidden", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{ParentID: "hrc-no-access", ParentType: service.ParentChannel})
		rec := hrunnerCovDo(t, fx.toolH.WriteContext, http.MethodPost, `{"body":"fact"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusForbidden)
	})
	t.Run("internal", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.ctxst.putErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.toolH.WriteContext, http.MethodPost, `{"body":"fact"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.WriteContext, http.MethodPost, `{"body":"fact","pinned":true}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		if got := hrunnerCovBody(t, rec); got["itemID"] == "" {
			t.Errorf("got %v", got)
		}
	})
}

// ---------------------------------------------------------- RequestApproval

func TestHrunnerCovRequestApproval(t *testing.T) {
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.RequestApproval, http.MethodPost, `{"summary":"s"}`, hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.RequestApproval, http.MethodPost, "{bad", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("validation", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.RequestApproval, http.MethodPost, `{"summary":"  "}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("internal", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.runs.putApprovalErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.toolH.RequestApproval, http.MethodPost, `{"summary":"deploy?"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		body := `{"summary":"deploy?","risk":"high","options":["yes","no"],"toolKind":"shell"}`
		rec := hrunnerCovDo(t, fx.toolH.RequestApproval, http.MethodPost, body, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		if got := hrunnerCovBody(t, rec); got["approvalID"] == "" || got["deadline"] == nil {
			t.Errorf("got %v", got)
		}
	})
}

// -------------------------------------------------------------- GetApproval

func TestHrunnerCovGetApproval(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.GetApproval, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), map[string]string{"id": "nope"})
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.runs.mu.Lock()
		fx.runs.approvals[hrunnerCovRunID+"#ap1"] = &model.Approval{
			ID: "ap1", RunID: hrunnerCovRunID, State: model.ApprovalApproved,
			DecidedBy: hrunnerCovInvoker, Choice: "yes", Deadline: time.Now().Add(time.Hour),
		}
		fx.runs.mu.Unlock()
		rec := hrunnerCovDo(t, fx.toolH.GetApproval, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), map[string]string{"id": "ap1"})
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if got["state"] != model.ApprovalApproved || got["choice"] != "yes" {
			t.Errorf("got %v", got)
		}
	})
}

// ---------------------------------------------------------- PublishArtifact

func TestHrunnerCovPublishArtifact(t *testing.T) {
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.PublishArtifact, http.MethodPost, `{"title":"t","content":"c"}`, hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.PublishArtifact, http.MethodPost, "{bad", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("validation", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.PublishArtifact, http.MethodPost, `{"kind":"markdown","title":"","content":"c"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("cap", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.runs.mu.Lock()
		for i := 0; i < model.ArtifactsPerRun; i++ {
			fx.runs.artifacts = append(fx.runs.artifacts, &model.Artifact{
				ID: fmt.Sprintf("hrc-a%d", i), RunID: hrunnerCovRunID, Kind: "markdown",
			})
		}
		fx.runs.mu.Unlock()
		rec := hrunnerCovDo(t, fx.toolH.PublishArtifact, http.MethodPost, `{"kind":"markdown","title":"t","content":"c"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusTooManyRequests)
	})
	t.Run("internal", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.runs.listArtifactsErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.toolH.PublishArtifact, http.MethodPost, `{"kind":"markdown","title":"t","content":"c"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.PublishArtifact, http.MethodPost, `{"kind":"markdown","title":"Report","content":"body"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		if got := hrunnerCovBody(t, rec); got["artifactID"] == "" {
			t.Errorf("got %v", got)
		}
	})
}

// ------------------------------------------------- ListSkills / InvokeSkill

func TestHrunnerCovSkills(t *testing.T) {
	t.Run("list run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.ListSkills, http.MethodGet, "", hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("list store failure", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.dir.listSkillsErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.toolH.ListSkills, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("list success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.dir.skills["sk1"] = &model.Skill{ID: "sk1", Name: "review", Description: "review things"}
		rec := hrunnerCovDo(t, fx.toolH.ListSkills, http.MethodGet, "", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		skills, _ := got["skills"].([]any)
		if len(skills) != 1 {
			t.Errorf("skills = %v", got["skills"])
		}
	})
	t.Run("invoke run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.InvokeSkill, http.MethodPost, "", hrunnerCovToolClaims("nope"), map[string]string{"id": "sk1"})
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("invoke unknown skill", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.InvokeSkill, http.MethodPost, "", hrunnerCovToolClaims(hrunnerCovRunID), map[string]string{"id": "ghost"})
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("invoke success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.dir.skills["sk1"] = &model.Skill{ID: "sk1", Name: "review", Instructions: "look closely"}
		rec := hrunnerCovDo(t, fx.toolH.InvokeSkill, http.MethodPost, "", hrunnerCovToolClaims(hrunnerCovRunID), map[string]string{"id": "sk1"})
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if got["name"] != "review" || got["instructions"] != "look closely" {
			t.Errorf("got %v", got)
		}
	})
}

// -------------------------------------------------------------- UpdateMemory

func TestHrunnerCovUpdateMemory(t *testing.T) {
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.UpdateMemory, http.MethodPost, `{"content":"x"}`, hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.UpdateMemory, http.MethodPost, "{bad", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("validation", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		body := fmt.Sprintf(`{"content":%q}`, strings.Repeat("a", model.AgentMemoryMaxBytes+1))
		rec := hrunnerCovDo(t, fx.toolH.UpdateMemory, http.MethodPost, body, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("internal", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.dir.putMemoryErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.toolH.UpdateMemory, http.MethodPost, `{"content":"remember"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.UpdateMemory, http.MethodPost, `{"content":"remember"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if got["ok"] != true || got["bytes"] != float64(len("remember")) {
			t.Errorf("got %v", got)
		}
	})
}

// ----------------------------------------------------------------- ClaimTask

func TestHrunnerCovClaimTask(t *testing.T) {
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.ClaimTask, http.MethodPost, `{"label":"x"}`, hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.ClaimTask, http.MethodPost, "{bad", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("validation", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.ClaimTask, http.MethodPost, `{"label":"  "}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("internal", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.dir.putTaskClaimErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.toolH.ClaimTask, http.MethodPost, `{"label":"hindi"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.ClaimTask, http.MethodPost, `{"label":"Hindi Part"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if got["mine"] != true {
			t.Errorf("got %v", got)
		}
		claims, _ := got["claims"].([]any)
		if len(claims) != 1 || !strings.Contains(claims[0].(string), "hindi part") {
			t.Errorf("claims = %v", got["claims"])
		}
	})
}

// ------------------------------------------------------------------ SetState

func TestHrunnerCovSetState(t *testing.T) {
	t.Run("bad json", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.SetState, http.MethodPost, "{bad", hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.SetState, http.MethodPost, `{"state":"⚙️"}`, hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("run closed", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{State: model.RunStateCompleted})
		rec := hrunnerCovDo(t, fx.toolH.SetState, http.MethodPost, `{"state":"⚙️"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusConflict)
	})
	t.Run("invalid state", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.SetState, http.MethodPost, `{"state":"party"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.SetState, http.MethodPost, `{"state":"⚙️"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
	})
}

// -------------------------------------------------------------- ProposeReply

func TestHrunnerCovProposeReply(t *testing.T) {
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.ProposeReply, http.MethodPost, `{"text":"hi"}`, hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("empty text", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.ProposeReply, http.MethodPost, `{"text":"  "}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("validation from service", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.runs.putApprovalErr = fmt.Errorf("hrc: %w", service.ErrValidation)
		rec := hrunnerCovDo(t, fx.toolH.ProposeReply, http.MethodPost, `{"text":"draft"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("internal", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.runs.putApprovalErr = errors.New("boom")
		rec := hrunnerCovDo(t, fx.toolH.ProposeReply, http.MethodPost, `{"text":"draft"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusInternalServerError)
	})
	t.Run("success", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		body := `{"text":"draft reply","thread_root":"` + hrunnerCovRoot + `","reply_to":"` + hrunnerCovRoot + `"}`
		rec := hrunnerCovDo(t, fx.toolH.ProposeReply, http.MethodPost, body, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if text, _ := got["text"].(string); !strings.Contains(text, "approvalID=") {
			t.Errorf("got %v", got)
		}
	})
}

// --------------------------------------------------------------- LinkMessage

func TestHrunnerCovLinkMessage(t *testing.T) {
	t.Run("run missing", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		rec := hrunnerCovDo(t, fx.toolH.LinkMessage, http.MethodPost, `{"message_id":"m1"}`, hrunnerCovToolClaims("nope"), nil)
		hrunnerCovWantStatus(t, rec, http.StatusNotFound)
	})
	t.Run("missing message_id", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		rec := hrunnerCovDo(t, fx.toolH.LinkMessage, http.MethodPost, `{"message_id":"  "}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("no parent", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{ParentID: "-", ParentType: service.ParentChannel})
		// Overwrite with a truly empty parent (addRun would default it).
		fx.runs.mu.Lock()
		fx.runs.runs[hrunnerCovRunID].ParentID = ""
		fx.runs.mu.Unlock()
		rec := hrunnerCovDo(t, fx.toolH.LinkMessage, http.MethodPost, `{"message_id":"m1"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusBadRequest)
	})
	t.Run("forbidden", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		body := `{"message_id":"m1","channel_id":"hrc-no-access"}`
		rec := hrunnerCovDo(t, fx.toolH.LinkMessage, http.MethodPost, body, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusForbidden)
	})
	t.Run("no base url yields marker text", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		body := `{"message_id":"[m:abc]","conversation_id":"[c:` + hrunnerCovConv + `]"}`
		rec := hrunnerCovDo(t, fx.toolH.LinkMessage, http.MethodPost, body, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		if got["text"] != "[m:abc] in [co:"+hrunnerCovConv+"]" {
			t.Errorf("text = %v", got["text"])
		}
	})
	t.Run("explicit channel with thread", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.toolH.SetBaseURL("http://ex.test/")
		body := `{"message_id":"m:abc","channel_id":"ch:` + hrunnerCovChan + `","thread_root":"[m:tr9]"}`
		rec := hrunnerCovDo(t, fx.toolH.LinkMessage, http.MethodPost, body, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		want := "http://ex.test/channel/" + hrunnerCovChan + "?thread=tr9#msg-abc"
		if got["url"] != want {
			t.Errorf("url = %v, want %s", got["url"], want)
		}
	})
	t.Run("default channel parent", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{})
		fx.toolH.SetBaseURL("http://ex.test")
		rec := hrunnerCovDo(t, fx.toolH.LinkMessage, http.MethodPost, `{"message_id":"abc"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		want := "http://ex.test/channel/" + hrunnerCovChan + "#msg-abc"
		if got["url"] != want {
			t.Errorf("url = %v, want %s", got["url"], want)
		}
	})
	t.Run("default conversation parent", func(t *testing.T) {
		fx := hrunnerCovNewFix(t)
		fx.addRun(&model.Run{ParentID: hrunnerCovConv, ParentType: service.ParentConversation})
		fx.toolH.SetBaseURL("http://ex.test")
		rec := hrunnerCovDo(t, fx.toolH.LinkMessage, http.MethodPost, `{"message_id":"abc"}`, hrunnerCovToolClaims(hrunnerCovRunID), nil)
		hrunnerCovWantStatus(t, rec, http.StatusOK)
		got := hrunnerCovBody(t, rec)
		want := "http://ex.test/conversation/" + hrunnerCovConv + "#msg-abc"
		if got["url"] != want {
			t.Errorf("url = %v, want %s", got["url"], want)
		}
	})
}
