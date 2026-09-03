package service

// Coverage tests for orchestrator.go: error arms, reconciler paths, claim
// edge cases, bundle budget clipping, watcher delivery failures. Every new
// identifier is prefixed orchCov; existing fixtures/fakes from
// orchestrator_test.go are reused via embedding.

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

var errOrchCov = errors.New("orchCov: boom")

// ------------------------------------------------------------ failable fakes

// orchCovRunStore wraps fakeRunStore with per-method error injection.
type orchCovRunStore struct {
	*fakeRunStore
	failCreateRun     error
	failGetRun        error
	failUpdateRun     error
	failUpdateExpect  *model.RunState // when non-nil, failUpdateRun applies only to this expect
	failListQueued    error
	failClaimRun      error
	failListActive    error
	failPastDeadline  error
	failAppendEvent   error
	failListEvents    error
	failDeleteEvents  error
	failPutDigest     error
	failListByParent  error
	failPutApproval   error
}

func (s *orchCovRunStore) CreateRun(ctx context.Context, run *model.Run) error {
	if s.failCreateRun != nil {
		return s.failCreateRun
	}
	return s.fakeRunStore.CreateRun(ctx, run)
}

func (s *orchCovRunStore) GetRun(ctx context.Context, runID string) (*model.Run, error) {
	if s.failGetRun != nil {
		return nil, s.failGetRun
	}
	return s.fakeRunStore.GetRun(ctx, runID)
}

func (s *orchCovRunStore) UpdateRun(ctx context.Context, run *model.Run, expect model.RunState) error {
	if s.failUpdateRun != nil && (s.failUpdateExpect == nil || *s.failUpdateExpect == expect) {
		return s.failUpdateRun
	}
	return s.fakeRunStore.UpdateRun(ctx, run, expect)
}

func (s *orchCovRunStore) ListQueuedRuns(ctx context.Context, ownerID string, limit int) ([]string, error) {
	if s.failListQueued != nil {
		return nil, s.failListQueued
	}
	return s.fakeRunStore.ListQueuedRuns(ctx, ownerID, limit)
}

func (s *orchCovRunStore) ClaimRun(ctx context.Context, run *model.Run, runnerID string, lease time.Time) error {
	if s.failClaimRun != nil {
		return s.failClaimRun
	}
	return s.fakeRunStore.ClaimRun(ctx, run, runnerID, lease)
}

func (s *orchCovRunStore) ListActiveRuns(ctx context.Context) ([]*model.Run, error) {
	if s.failListActive != nil {
		return nil, s.failListActive
	}
	return s.fakeRunStore.ListActiveRuns(ctx)
}

func (s *orchCovRunStore) ListActiveRunsPastDeadline(ctx context.Context, now time.Time, limit int) ([]*model.Run, error) {
	if s.failPastDeadline != nil {
		return nil, s.failPastDeadline
	}
	return s.fakeRunStore.ListActiveRunsPastDeadline(ctx, now, limit)
}

func (s *orchCovRunStore) AppendRunEvent(ctx context.Context, evt *model.RunEvent) error {
	if s.failAppendEvent != nil {
		return s.failAppendEvent
	}
	return s.fakeRunStore.AppendRunEvent(ctx, evt)
}

func (s *orchCovRunStore) ListRunEvents(ctx context.Context, runID string) ([]*model.RunEvent, error) {
	if s.failListEvents != nil {
		return nil, s.failListEvents
	}
	return s.fakeRunStore.ListRunEvents(ctx, runID)
}

func (s *orchCovRunStore) DeleteRunEvents(ctx context.Context, runID string) error {
	if s.failDeleteEvents != nil {
		return s.failDeleteEvents
	}
	return s.fakeRunStore.DeleteRunEvents(ctx, runID)
}

func (s *orchCovRunStore) PutDigest(ctx context.Context, d *model.RunDigest) error {
	if s.failPutDigest != nil {
		return s.failPutDigest
	}
	return s.fakeRunStore.PutDigest(ctx, d)
}

func (s *orchCovRunStore) ListRunsByParent(ctx context.Context, parentID string, limit int) ([]*model.Run, error) {
	if s.failListByParent != nil {
		return nil, s.failListByParent
	}
	return s.fakeRunStore.ListRunsByParent(ctx, parentID, limit)
}

func (s *orchCovRunStore) PutApproval(ctx context.Context, a *model.Approval) error {
	if s.failPutApproval != nil {
		return s.failPutApproval
	}
	return s.fakeRunStore.PutApproval(ctx, a)
}

// orchCovMsgs wraps fakeOrchMessages with error injection.
type orchCovMsgs struct {
	*fakeOrchMessages
	failSend       error
	failReaction   error
	failListThread error
	failList       error
}

func (m *orchCovMsgs) SendAsAgentRun(ctx context.Context, agentID, invokerID, parentID, parentType, body, parentMessageID, runID string) (*model.Message, error) {
	if m.failSend != nil {
		return nil, m.failSend
	}
	return m.fakeOrchMessages.SendAsAgentRun(ctx, agentID, invokerID, parentID, parentType, body, parentMessageID, runID)
}

func (m *orchCovMsgs) SetMachineReaction(ctx context.Context, actorID, parentID, parentType, msgID, state string) error {
	if m.failReaction != nil {
		return m.failReaction
	}
	return m.fakeOrchMessages.SetMachineReaction(ctx, actorID, parentID, parentType, msgID, state)
}

func (m *orchCovMsgs) ListThreadMessages(ctx context.Context, userID, parentID, parentType, threadRootID string) ([]*model.Message, error) {
	if m.failListThread != nil {
		return nil, m.failListThread
	}
	return m.fakeOrchMessages.ListThreadMessages(ctx, userID, parentID, parentType, threadRootID)
}

func (m *orchCovMsgs) List(ctx context.Context, userID, parentID, parentType, before string, limit int) ([]*model.Message, bool, error) {
	if m.failList != nil {
		return nil, false, m.failList
	}
	return m.fakeOrchMessages.List(ctx, userID, parentID, parentType, before, limit)
}

// orchCovUsers wraps fakeUsers with error injection.
type orchCovUsers struct {
	*fakeUsers
	failGetByIDs error
}

func (u *orchCovUsers) GetUsersByIDs(ctx context.Context, ids []string) ([]*model.User, error) {
	if u.failGetByIDs != nil {
		return nil, u.failGetByIDs
	}
	return u.fakeUsers.GetUsersByIDs(ctx, ids)
}

// orchCovDir wraps fakeAgentDir with error injection.
type orchCovDir struct {
	*fakeAgentDir
	failPutSub            error
	failListAllSubs       error
	failListSubsByParent  error
	failPutRunner         error
	failPutFollow         error
	failListRunners       error
	failListTemplates     error
}

func (d *orchCovDir) PutAgentSubscription(ctx context.Context, sub *model.AgentSubscription) error {
	if d.failPutSub != nil {
		return d.failPutSub
	}
	return d.fakeAgentDir.PutAgentSubscription(ctx, sub)
}

func (d *orchCovDir) ListAllSubscriptions(ctx context.Context) ([]*model.AgentSubscription, error) {
	if d.failListAllSubs != nil {
		return nil, d.failListAllSubs
	}
	return d.fakeAgentDir.ListAllSubscriptions(ctx)
}

func (d *orchCovDir) ListSubscriptionsByParent(ctx context.Context, parentID string) ([]*model.AgentSubscription, error) {
	if d.failListSubsByParent != nil {
		return nil, d.failListSubsByParent
	}
	return d.fakeAgentDir.ListSubscriptionsByParent(ctx, parentID)
}

func (d *orchCovDir) PutRunner(ctx context.Context, reg *model.RunnerRegistration) error {
	if d.failPutRunner != nil {
		return d.failPutRunner
	}
	return d.fakeAgentDir.PutRunner(ctx, reg)
}

func (d *orchCovDir) PutAgentFollow(ctx context.Context, af *model.AgentThreadFollow) error {
	if d.failPutFollow != nil {
		return d.failPutFollow
	}
	return d.fakeAgentDir.PutAgentFollow(ctx, af)
}

func (d *orchCovDir) ListRunners(ctx context.Context, ownerID string) ([]*model.RunnerRegistration, error) {
	if d.failListRunners != nil {
		return nil, d.failListRunners
	}
	return d.fakeAgentDir.ListRunners(ctx, ownerID)
}

func (d *orchCovDir) ListTemplates(ctx context.Context) ([]*model.AgentTemplate, error) {
	if d.failListTemplates != nil {
		return nil, d.failListTemplates
	}
	return d.fakeAgentDir.ListTemplates(ctx)
}

// orchCovMinter is a token minter with a failure toggle.
type orchCovMinter struct{ fail error }

func (m *orchCovMinter) GenerateRunToken(_, _, _ string, _ time.Time) (string, error) {
	if m.fail != nil {
		return "", m.fail
	}
	return "orchCov-token", nil
}

// orchCovArchive is an eventArchive with per-op failure toggles.
type orchCovArchive struct {
	mu          sync.Mutex
	blobs       map[string][]*model.RunEvent
	failArchive error
	failLoad    error
	failDelete  error
}

func (a *orchCovArchive) Archive(_ context.Context, runID string, events []*model.RunEvent) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failArchive != nil {
		return a.failArchive
	}
	if a.blobs == nil {
		a.blobs = map[string][]*model.RunEvent{}
	}
	a.blobs[runID] = append([]*model.RunEvent(nil), events...)
	return nil
}

func (a *orchCovArchive) Load(_ context.Context, runID string) ([]*model.RunEvent, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failLoad != nil {
		return nil, a.failLoad
	}
	evts, ok := a.blobs[runID]
	if !ok {
		return nil, store.ErrNotFound
	}
	return evts, nil
}

func (a *orchCovArchive) Delete(_ context.Context, runID string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.failDelete != nil {
		return a.failDelete
	}
	delete(a.blobs, runID)
	return nil
}

// orchCovRegistry is a connectorRegistry with failure toggles.
type orchCovRegistry struct {
	slugs     map[string]bool
	index     []ConnectorIndexEntry
	failKnown error
	failIndex error
}

func (r *orchCovRegistry) KnownSlugs(context.Context) (map[string]bool, error) {
	if r.failKnown != nil {
		return nil, r.failKnown
	}
	return r.slugs, nil
}

func (r *orchCovRegistry) InstalledIndex(context.Context, string) ([]ConnectorIndexEntry, error) {
	if r.failIndex != nil {
		return nil, r.failIndex
	}
	return r.index, nil
}

// orchCovConvs returns a fixed conversation for every lookup.
type orchCovConvs struct{ conv *model.Conversation }

func (c *orchCovConvs) GetConversation(context.Context, string) (*model.Conversation, error) {
	return c.conv, nil
}

// orchCovDM is an ownerDMResolver with a failure toggle.
type orchCovDM struct {
	convID string
	fail   error
}

func (d *orchCovDM) GetOrCreateDM(_ context.Context, _, _ string) (*model.Conversation, error) {
	if d.fail != nil {
		return nil, d.fail
	}
	return &model.Conversation{ID: d.convID}, nil
}

// ------------------------------------------------------------------- fixture

const orchCovGhostID = "agent-orchcov-ghost"

type orchCovFixture struct {
	orch  *Orchestrator
	runs  *orchCovRunStore
	msgs  *orchCovMsgs
	users *orchCovUsers
	dir   *orchCovDir
	now   *time.Time
}

// newOrchCovFixture mirrors newOrchFixture but wires the failable wrappers.
// Extra roster: bob (human) and a "ghost" agent whose template doesn't exist,
// so Resolve fails for it on demand.
func newOrchCovFixture(t *testing.T) *orchCovFixture {
	t.Helper()
	dir := &orchCovDir{fakeAgentDir: newFakeAgentDir()}
	human := &model.User{ID: "u-alice", DisplayName: "Alice"}
	bob := &model.User{ID: "u-bob", DisplayName: "Bob"}
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
	ghost := &model.User{
		ID:          orchCovGhostID,
		DisplayName: "ghost",
		Kind:        model.UserKindAgent,
		AgentConfig: &model.AgentConfig{TemplateSlug: "orchcov-no-such-template"},
	}
	users := &orchCovUsers{fakeUsers: &fakeUsers{users: map[string]*model.User{
		human.ID: human, bob.ID: bob, gg.ID: gg, qib.ID: qib, ghost.ID: ghost,
	}}}
	agentSvc := NewAgentService(dir, users)
	if err := agentSvc.SeedDefaults(context.Background()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_ = dir.fakeAgentDir.PutRunner(context.Background(), &model.RunnerRegistration{
		RunnerID: "r1", OwnerID: "u-alice",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessClaude}},
		LeaseExpiresAt: time.Now().Add(time.Hour),
	})
	runs := &orchCovRunStore{fakeRunStore: newFakeRunStore()}
	msgs := &orchCovMsgs{fakeOrchMessages: &fakeOrchMessages{}}
	orch := NewOrchestrator(runs, agentSvc, users, msgs, fakePub{}, &orchCovMinter{})
	now := time.Now()
	orch.now = func() time.Time { return now }
	return &orchCovFixture{orch: orch, runs: runs, msgs: msgs, users: users, dir: dir, now: &now}
}

// start starts a gg run for alice with a custom invoking message.
func (fx *orchCovFixture) start(t *testing.T, msgID, threadRoot string) *model.Run {
	t.Helper()
	msg := &model.Message{
		ID: msgID, ParentID: "chan1", ParentMessageID: threadRoot,
		AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] do the thing",
	}
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
	return run
}

func (fx *orchCovFixture) claim(t *testing.T) Assignment {
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

// orchCovWait polls cond every 2ms until true or the deadline lapses.
func orchCovWait(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// --------------------------------------------------------- dispatch error arms

func TestOrchCov_OnMessageUserLookupFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.users.failGetByIDs = errOrchCov
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] hi"}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatalf("run started despite user lookup failure: %v", ids)
	}
}

func TestOrchCov_OnMessageSkipsNonAgentUnknownAndDuplicateMentions(t *testing.T) {
	fx := newOrchCovFixture(t)
	// bob is human, u-nobody doesn't exist, gg is mentioned twice.
	msg := &model.Message{
		ID: "m1", ParentID: "chan1", AuthorID: "u-alice",
		Body: "@[u-bob|Bob] @[u-nobody|X] @[" + testGGID + "|gg] and again @[" + testGGID + "|gg]",
	}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)
	ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("expected exactly one run (gg), got %d", len(ids))
	}
}

func TestOrchCov_SoleDMAgentNilAndDegenerateConversations(t *testing.T) {
	fx := newOrchCovFixture(t)
	// convs not wired → nil.
	if got := fx.orch.soleDMAgent(context.Background(), "dm1", "u-alice"); got != nil {
		t.Fatalf("nil reader returned agent %v", got)
	}
	// DM whose both participant slots are the author → otherID stays "".
	fx.orch.SetConversationReader(&orchCovConvs{conv: &model.Conversation{
		ID: "dm1", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-alice", "u-alice"},
	}})
	if got := fx.orch.soleDMAgent(context.Background(), "dm1", "u-alice"); got != nil {
		t.Fatalf("degenerate DM returned agent %v", got)
	}
}

func TestOrchCov_DispatchFollowUpsSkipArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	// Prefs for alice: follow-ups always on for gg.
	if _, err := fx.orch.agentSvc.UpdatePrefs(ctx, "u-alice", AgentSlugGG, AgentPrefsPatch{FollowUpMode: orchCovPtr(model.FollowUpAlways)}); err != nil {
		t.Fatalf("prefs: %v", err)
	}
	seedFollow := func(agentID, invokerID string) {
		_ = fx.dir.fakeAgentDir.PutAgentFollow(ctx, &model.AgentThreadFollow{
			ParentID: "chan1", ParentType: ParentChannel, ThreadRootID: "root1",
			AgentID: agentID, InvokerID: invokerID, LastPostAt: *fx.now,
		})
	}
	msg := &model.Message{ID: "m9", ParentID: "chan1", ParentMessageID: "root1", AuthorID: "u-alice", Body: "continuing"}

	// alreadyInvoked skip.
	seedFollow(testGGID, "u-alice")
	fx.orch.dispatchFollowUps(ctx, msg, ParentChannel, map[string]bool{testGGID: true})
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("alreadyInvoked follow-up still started: %v", ids)
	}

	// Non-agent follow target.
	seedFollow("u-bob", "u-alice")
	// Agent whose Resolve fails (ghost template).
	seedFollow(orchCovGhostID, "u-alice")
	fx.orch.dispatchFollowUps(ctx, msg, ParentChannel, map[string]bool{testGGID: true})
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("skip arms leaked a run: %v", ids)
	}

	// Invoker lookup fails: prefs exist for a vanished user, whose reply this is.
	_ = fx.dir.PutAgentPrefs(ctx, &model.UserAgentPrefs{UserID: "u-gone", Slug: AgentSlugGG, FollowUpMode: model.FollowUpAlways})
	seedFollow(testGGID, "u-gone")
	goneMsg := &model.Message{ID: "m10", ParentID: "chan1", ParentMessageID: "root1", AuthorID: "u-gone", Body: "hello"}
	fx.orch.dispatchFollowUps(ctx, goneMsg, ParentChannel, map[string]bool{})
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-gone", 10); len(ids) != 0 {
		t.Fatalf("vanished invoker still started a run")
	}

	// invokeMode failure arm: alice offline.
	fx.dir.runners = map[string][]*model.RunnerRegistration{}
	fx.orch.dispatchFollowUps(ctx, msg, ParentChannel, map[string]bool{})
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("offline follow-up still queued: %v", ids)
	}
}

func TestOrchCov_DispatchSubscriptionsSkipArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	// Subscription whose agent is a human, and one whose creator vanished.
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-human", AgentID: "u-bob", CreatorID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
	})
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-gone", AgentID: testQibID, CreatorID: "u-gone", ParentID: "chan1", ParentType: ParentChannel,
	})
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "anything"}
	fx.orch.dispatchSubscriptions(ctx, msg, ParentChannel, map[string]bool{})
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("skip arms started runs: %v", ids)
	}
}

func TestOrchCov_MarkWatchPendingPutFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.dir.failPutSub = errOrchCov
	sub := &model.AgentSubscription{ID: "s1", AgentID: testGGID, CreatorID: "u-alice", ParentID: "chan1"}
	fx.orch.markWatchPending(context.Background(), sub, true) // must not panic
	if !sub.PendingCatchUp || !sub.PendingOffline {
		t.Fatalf("pending flags not set in-memory: %+v", sub)
	}
}

// ------------------------------------------------------------- invoke error arms

func TestOrchCov_InvokeResolveFailsPostsGenericNotice(t *testing.T) {
	fx := newOrchCovFixture(t)
	// Mention the ghost agent: Resolve fails (unknown template) → default ⛔.
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + orchCovGhostID + "|ghost] hi"}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)
	if !strings.Contains(fx.msgs.lastPost(), "couldn't start") {
		t.Fatalf("expected generic failure notice, got %q", fx.msgs.lastPost())
	}
}

func TestOrchCov_InvokeServerExecutionUnavailable(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	if _, err := fx.orch.agentSvc.UpdatePrefs(ctx, "u-alice", AgentSlugGG, AgentPrefsPatch{
		Harness: orchCovPtr(model.HarnessBedrock), ExecutionMode: orchCovPtr(model.ExecutionServer),
	}); err != nil {
		t.Fatalf("prefs: %v", err)
	}
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] hi"}
	fx.orch.OnMessage(ctx, msg, ParentChannel)
	post := fx.msgs.lastPost()
	if !strings.Contains(post, "server-side execution") {
		t.Fatalf("expected server-execution notice, got %q", post)
	}
}

func TestOrchCov_InvokeLiveRunnersLookupFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.dir.failListRunners = errOrchCov
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] hi"}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)
	// Generic failure notice (not the offline one).
	if !strings.Contains(fx.msgs.lastPost(), "couldn't start") {
		t.Fatalf("expected generic notice, got %q", fx.msgs.lastPost())
	}
}

func TestOrchCov_InvokeHarnessMissingSaysWhich(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	// Runner online but with codex only; gg resolves to claude.
	fx.dir.runners = map[string][]*model.RunnerRegistration{}
	_ = fx.dir.fakeAgentDir.PutRunner(ctx, &model.RunnerRegistration{
		RunnerID: "r1", OwnerID: "u-alice",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessCodex}},
		LeaseExpiresAt: time.Now().Add(time.Hour),
	})
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] hi"}
	fx.orch.OnMessage(ctx, msg, ParentChannel)
	post := fx.msgs.lastPost()
	if !strings.Contains(post, "not detected on your machine") {
		t.Fatalf("expected harness-missing notice, got %q", post)
	}
}

func TestOrchCov_PostInvokeFailureNoticePostFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.dir.runners = map[string][]*model.RunnerRegistration{}
	fx.msgs.failSend = errOrchCov
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] hi"}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel) // must not panic
}

func TestOrchCov_QueueOfflineRunArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	if _, err := fx.orch.agentSvc.UpdatePrefs(ctx, "u-alice", AgentSlugGG, AgentPrefsPatch{OfflinePolicy: orchCovPtr(model.OfflinePolicyQueue)}); err != nil {
		t.Fatalf("prefs: %v", err)
	}

	// Busy: gg already active in this thread → queueOfflineRun's startRun fails.
	fx.start(t, "m1", "")
	fx.dir.runners = map[string][]*model.RunnerRegistration{}
	postsBefore := len(fx.msgs.posts)
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] again"}
	fx.orch.OnMessage(ctx, msg, ParentChannel)
	if got := len(fx.msgs.posts); got != postsBefore {
		t.Fatalf("busy queue attempt posted notices: %d new", got-postsBefore)
	}

	// Deadline-extension write fails (UpdateRun expect=queued) — run still queues.
	fx2 := newOrchCovFixture(t)
	if _, err := fx2.orch.agentSvc.UpdatePrefs(ctx, "u-alice", AgentSlugGG, AgentPrefsPatch{OfflinePolicy: orchCovPtr(model.OfflinePolicyQueue)}); err != nil {
		t.Fatalf("prefs: %v", err)
	}
	fx2.dir.runners = map[string][]*model.RunnerRegistration{}
	queued := model.RunStateQueued
	fx2.runs.failUpdateRun = errOrchCov
	fx2.runs.failUpdateExpect = &queued
	fx2.orch.OnMessage(ctx, msg, ParentChannel)
	if !strings.Contains(fx2.msgs.lastPost(), "queued") {
		t.Fatalf("queue notice missing after failed deadline extension: %q", fx2.msgs.lastPost())
	}

	// Queue notice post fails — run still queues silently.
	fx3 := newOrchCovFixture(t)
	if _, err := fx3.orch.agentSvc.UpdatePrefs(ctx, "u-alice", AgentSlugGG, AgentPrefsPatch{OfflinePolicy: orchCovPtr(model.OfflinePolicyQueue)}); err != nil {
		t.Fatalf("prefs: %v", err)
	}
	fx3.dir.runners = map[string][]*model.RunnerRegistration{}
	fx3.msgs.failSend = errOrchCov
	fx3.orch.OnMessage(ctx, msg, ParentChannel)
	if ids, _ := fx3.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 1 {
		t.Fatalf("run not queued when notice post failed: %v", ids)
	}
}

// ------------------------------------------------- startRun / afterTerminal arms

func TestOrchCov_StartRunCreateFailsReleasesSlot(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	agent, _ := fx.users.GetUser(ctx, testGGID)
	invoker, _ := fx.users.GetUser(ctx, "u-alice")
	resolved, _ := fx.orch.agentSvc.Resolve(ctx, agent, invoker.ID)
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@gg go"}

	fx.runs.failCreateRun = errOrchCov
	if _, err := fx.orch.StartRun(ctx, agent, invoker, msg, ParentChannel, resolved, 0, nil); err == nil {
		t.Fatal("create failure not surfaced")
	}
	// The thread-turn slot must have been released: a retry succeeds.
	fx.runs.failCreateRun = nil
	if _, err := fx.orch.StartRun(ctx, agent, invoker, msg, ParentChannel, resolved, 0, nil); err != nil {
		t.Fatalf("slot leaked after create failure: %v", err)
	}
}

func TestOrchCov_DeferredTurnStartFailurePostsNotice(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	run := fx.start(t, "m1", "")
	fx.claim(t)

	// qib's post tags gg while gg is busy → deferred turn parked.
	qibRun := &model.Run{
		ID: "run-qib", AgentID: testQibID, InvokerID: "u-alice", OwnerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, ThreadRootID: "m1", MessageID: "m1", Round: 1,
	}
	post := &model.Message{ID: "m30", ParentID: "chan1", AuthorID: testQibID, ParentMessageID: "m1",
		Body: "@[" + testGGID + "|gg] your turn"}
	fx.orch.ChainFromAgentPost(ctx, qibRun, post)

	// Runner vanishes before gg finishes: the deferred start fails → ⛔ notice.
	fx.dir.runners = map[string][]*model.RunnerRegistration{}
	if err := fx.orch.CompleteRun(ctx, "r1", run.ID, "done", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if !strings.Contains(fx.msgs.lastPost(), "⛔") {
		t.Fatalf("deferred-start failure posted no notice: %q", fx.msgs.lastPost())
	}
}

func TestOrchCov_PendingRosterKicksNextAgent(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	agent, _ := fx.users.GetUser(ctx, testGGID)
	invoker, _ := fx.users.GetUser(ctx, "u-alice")
	resolved, _ := fx.orch.agentSvc.Resolve(ctx, agent, invoker.ID)
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@gg then @qib"}
	run, err := fx.orch.StartRun(ctx, agent, invoker, msg, ParentChannel, resolved, 0, []string{testQibID})
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	fx.claim(t)
	if err := fx.orch.CompleteRun(ctx, "r1", run.ID, "gg is done", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10)
	var qibStarted bool
	for _, id := range ids {
		r, _ := fx.runs.fakeRunStore.GetRun(ctx, id)
		if r.AgentID == testQibID {
			qibStarted = true
		}
	}
	if !qibStarted {
		t.Fatal("pending qib run not started after gg finished")
	}
}

func TestOrchCov_StartNextPendingArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	msg := &model.Message{ID: "m1", ParentID: "chan1", Body: "task"}

	// Invoker lookup fails.
	fx.orch.startNextPending(ctx, []string{testQibID}, "u-gone", msg, ParentChannel)
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-gone", 10); len(ids) != 0 {
		t.Fatalf("vanished invoker started runs: %v", ids)
	}

	// Roster of unknown id + human only: nothing startable, no panic.
	fx.orch.startNextPending(ctx, []string{"u-nobody", "u-bob"}, "u-alice", msg, ParentChannel)

	// First pending fails (ghost agent, Resolve error) → notice + move to qib.
	fx.orch.startNextPending(ctx, []string{orchCovGhostID, testQibID}, "u-alice", msg, ParentChannel)
	ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("expected exactly qib's run, got %v", ids)
	}
	r, _ := fx.runs.fakeRunStore.GetRun(ctx, ids[0])
	if r.AgentID != testQibID {
		t.Fatalf("wrong agent started: %s", r.AgentID)
	}
	if !strings.Contains(fx.msgs.lastPost(), "couldn't start") {
		t.Fatalf("ghost failure posted no notice: %q", fx.msgs.lastPost())
	}
}

func TestOrchCov_ChainInvokerLookupFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := &model.Run{ID: "r-x", AgentID: testGGID, InvokerID: "u-gone", ParentID: "chan1", ParentType: ParentChannel,
		Limits: model.DefaultAgentLimits()}
	post := &model.Message{ID: "m2", ParentID: "chan1", AuthorID: testGGID, Body: "@[" + testQibID + "|qib] go"}
	fx.orch.ChainFromAgentPost(context.Background(), run, post) // must not panic
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(context.Background(), "u-gone", 10); len(ids) != 0 {
		t.Fatalf("chain started runs for vanished invoker: %v", ids)
	}
}

func TestOrchCov_ChainSkipsHumansAndPostsOfflineNotice(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	run := &model.Run{ID: "r-x", AgentID: testGGID, InvokerID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
		Limits: model.DefaultAgentLimits()}
	// Human + unknown mentions are skipped silently.
	post := &model.Message{ID: "m2", ParentID: "chan1", AuthorID: testGGID, ParentMessageID: "m1",
		Body: "@[u-bob|Bob] @[u-nobody|X] hello"}
	fx.orch.ChainFromAgentPost(ctx, run, post)
	if got := fx.msgs.lastPost(); got != "" {
		t.Fatalf("human mention chain posted: %q", got)
	}
	// Offline target (runner gone): invoke fails → ⛔ notice via postInvokeFailure.
	fx.dir.runners = map[string][]*model.RunnerRegistration{}
	post2 := &model.Message{ID: "m3", ParentID: "chan1", AuthorID: testGGID, ParentMessageID: "m1",
		Body: "@[" + testQibID + "|qib] over to you"}
	fx.orch.ChainFromAgentPost(ctx, run, post2)
	if !strings.Contains(fx.msgs.lastPost(), "⛔") {
		t.Fatalf("offline chain target posted no notice: %q", fx.msgs.lastPost())
	}
}

func TestOrchCov_ChainBusyDeferralFromTopLevelPost(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	// qib busy in the m1 "thread" (top-level mention → slot keyed on msg id).
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testQibID + "|qib] work"}
	qib, _ := fx.users.GetUser(ctx, testQibID)
	alice, _ := fx.users.GetUser(ctx, "u-alice")
	resolved, _ := fx.orch.agentSvc.Resolve(ctx, qib, alice.ID)
	if _, err := fx.orch.StartRun(ctx, qib, alice, msg, ParentChannel, resolved, 0, nil); err != nil {
		t.Fatalf("start qib: %v", err)
	}
	// gg's TOP-LEVEL post (no ParentMessageID) tags qib → threadRootOf uses msg.ID.
	ggRun := &model.Run{ID: "r-gg", AgentID: testGGID, InvokerID: "u-alice", ParentID: "chan1",
		ParentType: ParentChannel, Limits: model.DefaultAgentLimits()}
	post := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: testGGID, Body: "@[" + testQibID + "|qib] ping"}
	fx.orch.ChainFromAgentPost(ctx, ggRun, post)
	if _, ok := fx.orch.deferredTurns.Load("chan1#m1#" + testQibID); !ok {
		t.Fatal("busy top-level chain handoff not deferred")
	}
}

// ----------------------------------------------- linkify / participants / roster

func TestOrchCov_LinkifyParticipantEdgeCases(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	fx.users.users["u-blank"] = &model.User{ID: "u-blank", DisplayName: ""}
	fx.users.users["u-carol"] = &model.User{ID: "u-carol", DisplayName: "Carol Jones"}
	fx.msgs.thread = []*model.Message{
		{ID: "t1", AuthorID: "u-blank", Body: "hi", CreatedAt: *fx.now},
		{ID: "t2", AuthorID: "u-carol", Body: "hello", CreatedAt: *fx.now},
	}
	run := fx.start(t, "m1", "root1")
	got := fx.orch.LinkifyMentions(ctx, run, "thanks @carol!")
	if !strings.Contains(got, "@[u-carol|Carol Jones]") {
		t.Fatalf("unique first name not linkified: %q", got)
	}
}

func TestOrchCov_ThreadParticipantsTopLevelWindowAndLookupFailure(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	fx.msgs.thread = []*model.Message{
		{ID: "t1", AuthorID: "u-bob", Body: "top-level chatter", CreatedAt: *fx.now},
	}
	// Top-level run (no thread root) → channel List path, authors collected.
	run := &model.Run{ID: "r1", AgentID: testGGID, InvokerID: "u-alice", ParentID: "chan1", ParentType: ParentChannel}
	people := fx.orch.threadParticipants(ctx, run)
	var sawBob bool
	for _, u := range people {
		if u.ID == "u-bob" {
			sawBob = true
		}
	}
	if !sawBob {
		t.Fatalf("channel-window author missing from participants: %+v", people)
	}
	// Users lookup failure → nil.
	fx.users.failGetByIDs = errOrchCov
	if got := fx.orch.threadParticipants(ctx, run); got != nil {
		t.Fatalf("expected nil on lookup failure, got %+v", got)
	}
}

func TestOrchCov_SharedAgentsListFailureReturnsStale(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.dir.failListTemplates = errOrchCov
	if got := fx.orch.sharedAgents(context.Background()); got != nil {
		t.Fatalf("expected nil roster on list failure, got %d agents", len(got))
	}
}

// ----------------------------------------------------------------- claim arms

func TestOrchCov_ClaimMaxDefaultsToOne(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.start(t, "m1", "")
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 0, 0)
	if err != nil || len(as) != 1 {
		t.Fatalf("claim with max=0: as=%d err=%v", len(as), err)
	}
}

func TestOrchCov_ClaimListQueuedFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.runs.failListQueued = errOrchCov
	if _, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 0); err == nil {
		t.Fatal("list failure not surfaced")
	}
}

func TestOrchCov_ClaimParksUntilWokenByStartRun(t *testing.T) {
	fx := newOrchCovFixture(t)
	done := make(chan int, 1)
	go func() {
		as, _ := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, time.Hour)
		done <- len(as)
	}()
	orchCovWait(t, "claim to park", func() bool {
		fx.orch.mu.Lock()
		defer fx.orch.mu.Unlock()
		_, ok := fx.orch.wakeups["u-alice"]
		return ok
	})
	fx.start(t, "m1", "") // wakes the parked poll
	select {
	case n := <-done:
		if n != 1 {
			t.Fatalf("woken claim returned %d assignments", n)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("parked claim never woke")
	}
}

func TestOrchCov_ClaimContextCanceled(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 1, time.Hour)
		done <- err
	}()
	orchCovWait(t, "claim to park", func() bool {
		fx.orch.mu.Lock()
		defer fx.orch.mu.Unlock()
		_, ok := fx.orch.wakeups["u-alice"]
		return ok
	})
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("expected context.Canceled, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("canceled claim never returned")
	}
}

func TestOrchCov_ClaimPollTickAndWaitBudget(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.orch.now = time.Now // real clock so the wait budget actually lapses
	old := claimPollInterval
	claimPollInterval = 2 * time.Millisecond
	defer func() { claimPollInterval = old }()
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 20*time.Millisecond)
	if err != nil || len(as) != 0 {
		t.Fatalf("empty poll: as=%d err=%v", len(as), err)
	}
}

func TestOrchCov_ClaimOnceSkipArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()

	// A queue entry whose run row is gone.
	fx.runs.mu.Lock()
	fx.runs.queue["u-alice"] = append(fx.runs.queue["u-alice"], "run-ghost")
	fx.runs.mu.Unlock()

	// A stale queue row: run exists but is already terminal.
	stale := fx.start(t, "m-stale", "")
	fx.runs.mu.Lock()
	fx.runs.fakeRunStore.runs[stale.ID].State = model.RunStateCompleted
	fx.runs.mu.Unlock()

	// A real claimable run.
	fx.start(t, "m-real", "")

	as, err := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 5, 0)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(as) != 1 {
		t.Fatalf("expected 1 assignment past ghost+stale rows, got %d", len(as))
	}
	// The stale queue row was cleaned up.
	ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10)
	for _, id := range ids {
		if id == stale.ID {
			t.Fatal("stale queue row not deleted")
		}
	}
}

func TestOrchCov_ClaimStopsAtMax(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.start(t, "m1", "")
	fx.start(t, "m2", "")
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil || len(as) != 1 {
		t.Fatalf("max=1 claim: as=%d err=%v", len(as), err)
	}
}

func TestOrchCov_ClaimRunConflictArms(t *testing.T) {
	// Stale claim (lost race) → skipped, empty result.
	fx := newOrchCovFixture(t)
	fx.start(t, "m1", "")
	fx.runs.failClaimRun = store.ErrStaleRun
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil || len(as) != 0 {
		t.Fatalf("stale claim: as=%d err=%v", len(as), err)
	}
	// Hard store error → surfaced.
	fx.runs.failClaimRun = errOrchCov
	if _, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 0); err == nil {
		t.Fatal("claim store error not surfaced")
	}
}

func TestOrchCov_ClaimTaskPinnedToOtherLiveRunnerSkipped(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	tasks := newFakeTaskStore()
	fx.orch.SetTaskStore(tasks)
	_ = tasks.CreateTask(ctx, &model.CodingTask{
		ID: "t1", State: model.TaskStateInProgress, ChannelID: "chan1", ThreadRootID: "card1",
		RequesterID: "u-alice", AgentID: testGGID, RunnerID: "r2",
	})
	// Second live runner r2 (the pin holder).
	_ = fx.dir.fakeAgentDir.PutRunner(ctx, &model.RunnerRegistration{
		RunnerID: "r2", OwnerID: "u-alice",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessClaude}},
		LeaseExpiresAt: time.Now().Add(time.Hour),
	})
	run := &model.Run{
		ID: "run-task", AgentID: testGGID, OwnerID: "u-alice", InvokerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "card1", ThreadRootID: "card1",
		State: model.RunStateQueued, Mode: model.RunModeTask, TaskID: "t1",
		Harness: model.HarnessClaude, Limits: model.DefaultAgentLimits(),
		Deadline: fx.now.Add(time.Hour), CreatedAt: *fx.now, UpdatedAt: *fx.now,
	}
	if err := fx.runs.fakeRunStore.CreateRun(ctx, run); err != nil {
		t.Fatalf("seed run: %v", err)
	}
	// r1 must NOT claim the pinned task run.
	as, err := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil || len(as) != 0 {
		t.Fatalf("pinned task run claimed by wrong machine: as=%d err=%v", len(as), err)
	}
}

func TestOrchCov_ClaimZeroLimitsAndDeadlineClamp(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	// Zero MaxWallClockSec → platform default; watch mode with a conversation
	// window LONGER than the hard ceiling → clamped to the ceiling.
	run := &model.Run{
		ID: "run-manual", AgentID: testGGID, OwnerID: "u-alice", InvokerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1",
		State: model.RunStateQueued, Mode: model.RunModeDirect,
		Harness: model.HarnessClaude,
		Limits:  model.AgentLimits{MaxWallClockSec: 9_999_999, MaxTaskWallClockSec: 10},
		Deadline: fx.now.Add(time.Hour), CreatedAt: *fx.now, UpdatedAt: *fx.now,
	}
	if err := fx.runs.fakeRunStore.CreateRun(ctx, run); err != nil {
		t.Fatalf("seed: %v", err)
	}
	run2 := &model.Run{
		ID: "run-manual2", AgentID: testQibID, OwnerID: "u-alice", InvokerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "m2",
		State: model.RunStateQueued, Mode: model.RunModeDirect,
		Harness: model.HarnessClaude, // zero limits entirely
		Deadline: fx.now.Add(time.Hour), CreatedAt: *fx.now, UpdatedAt: *fx.now,
	}
	if err := fx.runs.fakeRunStore.CreateRun(ctx, run2); err != nil {
		t.Fatalf("seed2: %v", err)
	}
	as, err := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 5, 0)
	if err != nil || len(as) != 2 {
		t.Fatalf("claims: %d err=%v", len(as), err)
	}
	got, _ := fx.runs.fakeRunStore.GetRun(ctx, "run-manual")
	if !got.Deadline.Equal(got.HardDeadline) {
		t.Fatalf("deadline not clamped to hard ceiling: %v vs %v", got.Deadline, got.HardDeadline)
	}
	got2, _ := fx.runs.fakeRunStore.GetRun(ctx, "run-manual2")
	wantConv := time.Duration(model.DefaultAgentLimits().MaxWallClockSec) * time.Second
	if !got2.Deadline.Equal(fx.now.Add(wantConv)) {
		t.Fatalf("zero-limit conv window not defaulted: %v", got2.Deadline)
	}
}

func TestOrchCov_ClaimDeadlineRebaseWriteFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.start(t, "m1", "")
	acked := model.RunStateAcknowledged
	fx.runs.failUpdateRun = errOrchCov
	fx.runs.failUpdateExpect = &acked
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil || len(as) != 1 {
		t.Fatalf("claim should survive re-base write failure: as=%d err=%v", len(as), err)
	}
}

func TestOrchCov_ClaimMintFailureAndFailRunAlsoFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.orch.tokens = &orchCovMinter{fail: errOrchCov}
	// Every acknowledged-state write fails: the deadline re-base logs, and the
	// fail-run after the mint failure errors too → the warn arm.
	acked := model.RunStateAcknowledged
	fx.runs.failUpdateRun = errOrchCov
	fx.runs.failUpdateExpect = &acked
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil || len(as) != 0 {
		t.Fatalf("expected no assignment: as=%d err=%v", len(as), err)
	}
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	if got.State.Terminal() {
		t.Fatalf("run terminalized despite failing store: %s", got.State)
	}
}

func TestOrchCov_LinkifyInvalidUTF8NameSkipped(t *testing.T) {
	fx := newOrchCovFixture(t)
	// A display name that is not valid UTF-8 makes regexp.Compile fail even
	// after QuoteMeta; linkify must skip it, not panic.
	fx.users.users["u-bad"] = &model.User{ID: "u-bad", DisplayName: "bad\xffname"}
	fx.msgs.thread = []*model.Message{
		{ID: "t1", AuthorID: "u-bad", Body: "hi", CreatedAt: *fx.now},
	}
	run := fx.start(t, "m1", "root1")
	in := "hello @bad\xffname and @alice"
	got := fx.orch.LinkifyMentions(context.Background(), run, in)
	if !strings.Contains(got, "@[u-alice|Alice]") {
		t.Fatalf("valid names must still linkify: %q", got)
	}
	if strings.Contains(got, "u-bad") {
		t.Fatalf("invalid-UTF-8 name was linkified: %q", got)
	}
}

func TestOrchCov_ClaimTokenMintFailureFailsRun(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.orch.tokens = &orchCovMinter{fail: errOrchCov}
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil || len(as) != 0 {
		t.Fatalf("mint failure should yield no assignment: as=%d err=%v", len(as), err)
	}
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed || got.FailReason != "token_mint_failed" {
		t.Fatalf("run not failed on mint error: %+v", got)
	}
}

// --------------------------------------------------------- report/complete arms

func TestOrchCov_ReportEventsRunMissing(t *testing.T) {
	fx := newOrchCovFixture(t)
	if _, _, err := fx.orch.ReportEvents(context.Background(), "r1", "nope", nil); err == nil {
		t.Fatal("missing run accepted")
	}
}

func TestOrchCov_ReportEventsProgressStateAndToolFanout(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "root1") // threaded → publishProgress carries threadRootID
	fx.claim(t)
	abort, _, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{
		{Seq: 1, Type: "progress", Payload: map[string]any{"text": strings.Repeat("p", 400)}},
		{Seq: 2, Type: "state"},
		{Seq: 3, Type: "tool", Payload: map[string]any{"name": "get_thread", "detail": "reading"}},
	})
	if err != nil || abort {
		t.Fatalf("report: abort=%v err=%v", abort, err)
	}
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateRunning {
		t.Fatalf("state event did not move run to running: %s", got.State)
	}
	// Progress events are ephemeral: not on the durable timeline.
	evts, _ := fx.runs.fakeRunStore.ListRunEvents(context.Background(), run.ID)
	for _, e := range evts {
		if e.Type == "progress" {
			t.Fatal("progress event persisted to timeline")
		}
	}
}

func TestOrchCov_ReportEventsExtensionClampedAtHardDeadline(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	// Watch-mode run: hard ceiling == conversation window, so the very first
	// activity extension exceeds it and is clamped.
	run := &model.Run{
		ID: "run-watch", AgentID: testGGID, OwnerID: "u-alice", InvokerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1",
		State: model.RunStateQueued, Mode: model.RunModeWatch,
		Harness: model.HarnessClaude, Limits: model.DefaultAgentLimits(),
		Deadline: fx.now.Add(time.Hour), CreatedAt: *fx.now, UpdatedAt: *fx.now,
	}
	if err := fx.runs.fakeRunStore.CreateRun(ctx, run); err != nil {
		t.Fatalf("seed: %v", err)
	}
	as, err := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	if err != nil || len(as) != 1 {
		t.Fatalf("claim: %d %v", len(as), err)
	}
	*fx.now = fx.now.Add(10 * time.Second)
	if _, _, err := fx.orch.ReportEvents(ctx, "r1", run.ID, []RunEventInput{{Seq: 1, Type: "tool"}}); err != nil {
		t.Fatalf("report: %v", err)
	}
	got, _ := fx.runs.fakeRunStore.GetRun(ctx, run.ID)
	if !got.Deadline.Equal(got.HardDeadline) {
		t.Fatalf("extension not clamped: deadline %v hard %v", got.Deadline, got.HardDeadline)
	}
}

func TestOrchCov_ReportEventsPersistFailures(t *testing.T) {
	// Stale write → run_closed abort.
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	fx.runs.failUpdateRun = store.ErrStaleRun
	abort, reason, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{{Seq: 1, Type: "turn"}})
	if !abort || reason != "run_closed" || !errors.Is(err, ErrRunClosed) {
		t.Fatalf("stale persist: abort=%v reason=%q err=%v", abort, reason, err)
	}
	// Hard write error → surfaced without abort.
	fx.runs.failUpdateRun = errOrchCov
	abort, _, err = fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{{Seq: 2, Type: "turn"}})
	if abort || !errors.Is(err, errOrchCov) {
		t.Fatalf("hard persist: abort=%v err=%v", abort, err)
	}
}

func TestOrchCov_FinishLimitUpdateFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	fx.runs.failUpdateRun = errOrchCov
	turns := run.Limits.TurnsFor(run.Mode) + 1
	batch := make([]RunEventInput, 0, turns)
	for i := 0; i < turns; i++ {
		batch = append(batch, RunEventInput{Seq: int64(i + 1), Type: "turn"})
	}
	abort, reason, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, batch)
	if !abort || reason != "turn_limit" || err == nil {
		t.Fatalf("finishLimit write failure: abort=%v reason=%q err=%v", abort, reason, err)
	}
}

func TestOrchCov_FinishLimitNoticePostFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	fx.msgs.failSend = errOrchCov
	turns := run.Limits.TurnsFor(run.Mode) + 1
	batch := make([]RunEventInput, 0, turns)
	for i := 0; i < turns; i++ {
		batch = append(batch, RunEventInput{Seq: int64(i + 1), Type: "turn"})
	}
	abort, reason, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, batch)
	if !abort || reason != "turn_limit" || err != nil {
		t.Fatalf("limit with failed notice: abort=%v reason=%q err=%v", abort, reason, err)
	}
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed {
		t.Fatalf("run not failed: %s", got.State)
	}
}

func TestOrchCov_CompleteRunErrorArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)

	if err := fx.orch.CompleteRun(context.Background(), "r1", "nope", "x", nil); err == nil {
		t.Fatal("missing run completed")
	}
	if err := fx.orch.CompleteRun(context.Background(), "r-evil", run.ID, "x", nil); !errors.Is(err, ErrWrongRunner) {
		t.Fatalf("wrong runner: %v", err)
	}
	fx.runs.failUpdateRun = store.ErrStaleRun
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "x", nil); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("stale complete: %v", err)
	}
	fx.runs.failUpdateRun = errOrchCov
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "x", nil); !errors.Is(err, errOrchCov) {
		t.Fatalf("hard complete error: %v", err)
	}
}

func TestOrchCov_CompleteFinalPostFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	fx.msgs.failSend = errOrchCov
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "the answer", nil); err != nil {
		t.Fatalf("complete must survive post failure: %v", err)
	}
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateCompleted {
		t.Fatalf("run not completed: %s", got.State)
	}
}

func TestOrchCov_CompleteSilentRunLeavesMarker(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if !strings.Contains(fx.msgs.lastPost(), "finished without posting") {
		t.Fatalf("no silent-completion marker: %q", fx.msgs.lastPost())
	}

	// Same, with the marker post failing — completion still succeeds.
	fx2 := newOrchCovFixture(t)
	run2 := fx2.start(t, "m1", "")
	fx2.claim(t)
	fx2.msgs.failSend = errOrchCov
	if err := fx2.orch.CompleteRun(context.Background(), "r1", run2.ID, "", nil); err != nil {
		t.Fatalf("complete with failing marker: %v", err)
	}
}

// ------------------------------------------------------- watcher delivery arms

func TestOrchCov_WatchEmptyFinalTextSkips(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	got.ActionMode = model.WatchActionNotify
	if err := fx.runs.fakeRunStore.UpdateRun(context.Background(), got, got.State); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "   ", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	evts, _ := fx.runs.fakeRunStore.ListRunEvents(context.Background(), run.ID)
	var skipped bool
	for _, e := range evts {
		if e.Type == "watch.skipped" {
			skipped = true
		}
	}
	if !skipped {
		t.Fatal("empty watcher answer not recorded as skip")
	}
}

func TestOrchCov_WatchReplyDraftFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	got.ActionMode = model.WatchActionReply
	_ = fx.runs.fakeRunStore.UpdateRun(context.Background(), got, got.State)
	fx.runs.failPutApproval = errOrchCov
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "draft this", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	evts, _ := fx.runs.fakeRunStore.ListRunEvents(context.Background(), run.ID)
	var failed bool
	for _, e := range evts {
		if e.Type == "watch.delivery_failed" {
			failed = true
		}
	}
	if !failed {
		t.Fatal("failed reply draft not recorded")
	}
}

func TestOrchCov_WatchDMDeliveryFailures(t *testing.T) {
	// DM open fails.
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	got.ActionMode = model.WatchActionNotify
	_ = fx.runs.fakeRunStore.UpdateRun(context.Background(), got, got.State)
	fx.orch.SetOwnerDMResolver(&orchCovDM{fail: errOrchCov})
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "found something", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	evts, _ := fx.runs.fakeRunStore.ListRunEvents(context.Background(), run.ID)
	reasons := map[any]bool{}
	for _, e := range evts {
		if e.Type == "watch.delivery_failed" {
			reasons[e.Payload["reason"]] = true
		}
	}
	if !reasons["dm_open"] {
		t.Fatalf("dm_open failure not recorded: %v", reasons)
	}

	// DM opens but the post fails.
	fx2 := newOrchCovFixture(t)
	run2 := fx2.start(t, "m1", "")
	fx2.claim(t)
	got2, _ := fx2.runs.fakeRunStore.GetRun(context.Background(), run2.ID)
	got2.ActionMode = model.WatchActionDraft
	_ = fx2.runs.fakeRunStore.UpdateRun(context.Background(), got2, got2.State)
	fx2.orch.SetOwnerDMResolver(&orchCovDM{convID: "dm1"})
	fx2.msgs.failSend = errOrchCov
	if err := fx2.orch.CompleteRun(context.Background(), "r1", run2.ID, "draft text", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	evts2, _ := fx2.runs.fakeRunStore.ListRunEvents(context.Background(), run2.ID)
	var dmPost bool
	for _, e := range evts2 {
		if e.Type == "watch.delivery_failed" && e.Payload["reason"] == "dm_post" {
			dmPost = true
		}
	}
	if !dmPost {
		t.Fatal("dm_post failure not recorded")
	}
}

// ------------------------------------------------------------------- fail arms

func TestOrchCov_FailRunErrorArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)

	if err := fx.orch.FailRun(context.Background(), "r1", "nope", "x"); err == nil {
		t.Fatal("missing run failed silently")
	}
	if err := fx.orch.FailRun(context.Background(), "r-evil", run.ID, "x"); !errors.Is(err, ErrWrongRunner) {
		t.Fatalf("wrong runner: %v", err)
	}
	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "done", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if err := fx.orch.FailRun(context.Background(), "r1", run.ID, "x"); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("terminal fail: %v", err)
	}
}

func TestOrchCov_FailRunUpdateArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	fx.runs.failUpdateRun = store.ErrStaleRun
	if err := fx.orch.FailRun(context.Background(), "r1", run.ID, "runner_error"); err != nil {
		t.Fatalf("stale fail should be nil: %v", err)
	}
	fx.runs.failUpdateRun = errOrchCov
	if err := fx.orch.FailRun(context.Background(), "r1", run.ID, "runner_error"); !errors.Is(err, errOrchCov) {
		t.Fatalf("hard fail error: %v", err)
	}
}

func TestOrchCov_PostFailNoticePublicPostFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.msgs.failSend = errOrchCov
	if err := fx.orch.FailRun(context.Background(), "r1", run.ID, "runner_error: boom"); err != nil {
		t.Fatalf("fail: %v", err)
	}
}

func TestOrchCov_PostFailNoticeGatedDMArms(t *testing.T) {
	// DM open fails.
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	got.ActionMode = model.WatchActionNotify
	_ = fx.runs.fakeRunStore.UpdateRun(context.Background(), got, got.State)
	fx.orch.SetOwnerDMResolver(&orchCovDM{fail: errOrchCov})
	if err := fx.orch.FailRun(context.Background(), "r1", run.ID, "runner_lost"); err != nil {
		t.Fatalf("fail: %v", err)
	}

	// DM post succeeds → the notice lands in the DM, not the channel.
	fx2 := newOrchCovFixture(t)
	run2 := fx2.start(t, "m1", "")
	got2, _ := fx2.runs.fakeRunStore.GetRun(context.Background(), run2.ID)
	got2.ActionMode = model.WatchActionReply
	_ = fx2.runs.fakeRunStore.UpdateRun(context.Background(), got2, got2.State)
	fx2.orch.SetOwnerDMResolver(&orchCovDM{convID: "dm-priv"})
	if err := fx2.orch.FailRun(context.Background(), "r1", run2.ID, "runner_lost"); err != nil {
		t.Fatalf("fail: %v", err)
	}
	fx2.msgs.mu.Lock()
	lastDest := ""
	if n := len(fx2.msgs.postDest); n > 0 {
		lastDest = fx2.msgs.postDest[n-1]
	}
	fx2.msgs.mu.Unlock()
	if lastDest != ParentConversation+"|dm-priv" {
		t.Fatalf("gated failure notice not delivered to DM: %q", lastDest)
	}

	// DM post fails.
	fx3 := newOrchCovFixture(t)
	run3 := fx3.start(t, "m1", "")
	got3, _ := fx3.runs.fakeRunStore.GetRun(context.Background(), run3.ID)
	got3.ActionMode = model.WatchActionNotify
	_ = fx3.runs.fakeRunStore.UpdateRun(context.Background(), got3, got3.State)
	fx3.orch.SetOwnerDMResolver(&orchCovDM{convID: "dm1"})
	fx3.msgs.failSend = errOrchCov
	if err := fx3.orch.FailRun(context.Background(), "r1", run3.ID, "runner_lost"); err != nil {
		t.Fatalf("fail: %v", err)
	}
}

// -------------------------------------------------- small lifecycle API arms

func TestOrchCov_RecordAgentPostArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	if _, err := fx.orch.RecordAgentPost(context.Background(), "nope"); err == nil {
		t.Fatal("missing run accepted")
	}
	run := fx.start(t, "m1", "")
	fx.claim(t)

	fx.runs.failUpdateRun = errOrchCov
	if _, err := fx.orch.RecordAgentPost(context.Background(), run.ID); !errors.Is(err, errOrchCov) {
		t.Fatalf("update failure: %v", err)
	}
	fx.runs.failUpdateRun = nil

	// Follow-marker write failure is non-fatal.
	fx.dir.failPutFollow = errOrchCov
	if _, err := fx.orch.RecordAgentPost(context.Background(), run.ID); err != nil {
		t.Fatalf("post with failing follow marker: %v", err)
	}
	fx.dir.failPutFollow = nil

	if err := fx.orch.CompleteRun(context.Background(), "r1", run.ID, "done", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if _, err := fx.orch.RecordAgentPost(context.Background(), run.ID); !errors.Is(err, ErrRunClosed) {
		t.Fatalf("terminal post: %v", err)
	}
}

func TestOrchCov_RecordContextWrite(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.orch.RecordContextWrite(context.Background(), run, "ctx-1", true)
	evts, _ := fx.runs.fakeRunStore.ListRunEvents(context.Background(), run.ID)
	var saw bool
	for _, e := range evts {
		if e.Type == "context.written" && e.Payload["itemID"] == "ctx-1" && e.Payload["pinned"] == true {
			saw = true
		}
	}
	if !saw {
		t.Fatal("context.written event missing")
	}
}

func TestOrchCov_GetLiveRunMissing(t *testing.T) {
	fx := newOrchCovFixture(t)
	if _, err := fx.orch.GetLiveRun(context.Background(), "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing run: %v", err)
	}
}

func TestOrchCov_SetRunState(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	if err := fx.orch.SetRunState(context.Background(), run.ID, StateEmojiThinking); err != nil {
		t.Fatalf("set state: %v", err)
	}
	if fx.msgs.lastReaction() != StateEmojiThinking {
		t.Fatalf("reaction not set: %q", fx.msgs.lastReaction())
	}
	if err := fx.orch.SetRunState(context.Background(), run.ID, "🍕"); err == nil {
		t.Fatal("invalid emoji accepted")
	}
	if err := fx.orch.SetRunState(context.Background(), "nope", StateEmojiThinking); err == nil {
		t.Fatal("missing run accepted")
	}
}

func TestOrchCov_TimelineErrorArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	if _, _, err := fx.orch.Timeline(context.Background(), "nope"); err == nil {
		t.Fatal("missing run accepted")
	}
	run := fx.start(t, "m1", "")
	fx.runs.failListEvents = errOrchCov
	if _, _, err := fx.orch.Timeline(context.Background(), run.ID); !errors.Is(err, errOrchCov) {
		t.Fatalf("event list failure: %v", err)
	}
}

func TestOrchCov_HeartbeatArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	reg := &model.RunnerRegistration{RunnerID: "r1", OwnerID: "u-alice",
		Harnesses: []model.RunnerHarness{{Name: model.HarnessClaude}}}

	fx.dir.failPutRunner = errOrchCov
	if _, err := fx.orch.Heartbeat(ctx, reg, nil); !errors.Is(err, errOrchCov) {
		t.Fatalf("put runner failure: %v", err)
	}
	fx.dir.failPutRunner = nil

	// Kill list: missing run, terminal run, and another runner's run.
	mine := fx.start(t, "m1", "")
	fx.claim(t)
	done := fx.start(t, "m2", "")
	fx.claim(t)
	if err := fx.orch.CompleteRun(ctx, "r1", done.ID, "done", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	foreign := fx.start(t, "m3", "")
	fx.runs.mu.Lock()
	fx.runs.fakeRunStore.runs[foreign.ID].State = model.RunStateRunning
	fx.runs.fakeRunStore.runs[foreign.ID].RunnerID = "r-other"
	fx.runs.mu.Unlock()

	kill, err := fx.orch.Heartbeat(ctx, reg, []string{"nope", done.ID, foreign.ID, mine.ID})
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	want := map[string]bool{"nope": true, done.ID: true, foreign.ID: true}
	if len(kill) != 3 {
		t.Fatalf("kill list %v, want 3 entries", kill)
	}
	for _, id := range kill {
		if !want[id] {
			t.Fatalf("unexpected kill %q", id)
		}
	}
}

// --------------------------------------------------------------- reconciler

func TestOrchCov_StartReconcilerRunsSweeps(t *testing.T) {
	fx := newOrchCovFixture(t)
	old := reconcileInterval
	reconcileInterval = 5 * time.Millisecond
	defer func() { reconcileInterval = old }()

	run := fx.start(t, "m1", "") // queued, never claimed
	*fx.now = fx.now.Add(run.Limits.WallClockFor(run.Mode) + time.Hour)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fx.orch.StartReconciler(ctx)
	orchCovWait(t, "reconciler to sweep the expired run", func() bool {
		got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
		return got.State == model.RunStateFailed && got.FailReason == "unclaimed_expired"
	})
	cancel()
	time.Sleep(10 * time.Millisecond) // let the goroutine observe ctx.Done
}

func TestOrchCov_RecoverActiveArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()

	// List failure → no-op.
	fx.runs.failListActive = errOrchCov
	fx.orch.recoverActive(ctx)
	fx.runs.failListActive = nil

	// Queued run → slot restored; claimed live-lease run → timer+typing armed.
	queued := fx.start(t, "m1", "")
	claimed := fx.start(t, "m2", "")
	fx.claim(t) // claims the first queued (m1)... claim order follows queue order
	// Determine which got claimed; ensure one queued + one acked regardless.
	q, _ := fx.runs.fakeRunStore.GetRun(ctx, queued.ID)
	c, _ := fx.runs.fakeRunStore.GetRun(ctx, claimed.ID)
	if q.State != model.RunStateQueued && c.State != model.RunStateQueued {
		t.Fatalf("expected one queued run: %s/%s", q.State, c.State)
	}

	fresh := NewOrchestrator(fx.runs, fx.orch.agentSvc, fx.users, fx.msgs, fakePub{}, &orchCovMinter{})
	fresh.now = fx.orch.now
	fresh.recoverActive(ctx)
	// Thread slots restored for both runs.
	slots := 0
	fresh.threadActive.Range(func(_, _ any) bool { slots++; return true })
	if slots != 2 {
		t.Fatalf("expected 2 restored slots, got %d", slots)
	}
	fresh.disarmLeaseTimer(queued.ID)
	fresh.disarmLeaseTimer(claimed.ID)

	// Default arm: lapsed lease + failing update → recover fail warn path.
	fx2 := newOrchCovFixture(t)
	run2 := fx2.start(t, "m1", "")
	fx2.claim(t)
	*fx2.now = fx2.now.Add(runLeaseTTL + time.Minute)
	fx2.runs.failUpdateRun = errOrchCov
	fx2.orch.recoverActive(context.Background())
	got2, _ := fx2.runs.fakeRunStore.GetRun(context.Background(), run2.ID)
	if got2.State.Terminal() {
		t.Fatalf("run terminalized despite failing store: %s", got2.State)
	}
}

func TestOrchCov_SweepWatchCatchUpsSkipArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()

	fx.dir.failListAllSubs = errOrchCov
	fx.orch.sweepWatchCatchUps(ctx)
	fx.dir.failListAllSubs = nil

	now := *fx.now
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-human", AgentID: "u-bob", CreatorID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
		PendingCatchUp: true, PendingSince: &now,
	})
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-gone", AgentID: testGGID, CreatorID: "u-gone", ParentID: "chan1", ParentType: ParentChannel,
		PendingCatchUp: true, PendingSince: &now,
	})
	fx.orch.sweepWatchCatchUps(ctx)
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("skip arms started runs: %v", ids)
	}
}

func TestOrchCov_CatchUpNeedsConsentResolveFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	ghost, _ := fx.users.GetUser(context.Background(), orchCovGhostID)
	alice, _ := fx.users.GetUser(context.Background(), "u-alice")
	if !fx.orch.catchUpNeedsConsent(context.Background(), ghost, alice) {
		t.Fatal("unresolvable agent should err on the side of asking")
	}
}

func TestOrchCov_AskCatchUpMarkWriteFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	now := *fx.now
	sub := &model.AgentSubscription{
		ID: "s1", AgentID: testGGID, CreatorID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
		PendingCatchUp: true, PendingOffline: true, PendingSince: &now,
	}
	agent, _ := fx.users.GetUser(ctx, testGGID)
	creator, _ := fx.users.GetUser(ctx, "u-alice")
	fx.dir.failPutSub = errOrchCov
	fx.orch.askCatchUp(ctx, sub, agent, creator) // creator online → asks; write fails, no panic
	if sub.CatchUpNotifiedAt == nil {
		t.Fatal("notified-at not set in-memory")
	}
}

func TestOrchCov_ClearCatchUpWriteFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.dir.failPutSub = errOrchCov
	now := *fx.now
	sub := &model.AgentSubscription{ID: "s1", PendingCatchUp: true, PendingSince: &now, PendingOffline: true}
	fx.orch.clearCatchUp(context.Background(), sub, &now)
	if sub.PendingCatchUp || sub.LastRunAt == nil {
		t.Fatalf("clear did not reset in-memory: %+v", sub)
	}
}

func TestOrchCov_DecideCatchUpArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()

	fx.dir.failListSubsByParent = errOrchCov
	if err := fx.orch.DecideCatchUp(ctx, "u-alice", "chan1", "s1", true); !errors.Is(err, errOrchCov) {
		t.Fatalf("list failure: %v", err)
	}
	fx.dir.failListSubsByParent = nil

	// No matching sub id → ErrNotFound (also exercises the id-mismatch skip).
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-other", AgentID: testGGID, CreatorID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
	})
	if err := fx.orch.DecideCatchUp(ctx, "u-alice", "chan1", "s-missing", true); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("missing sub: %v", err)
	}

	// Agent lookup fails.
	now := *fx.now
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-ghost-agent", AgentID: "u-nobody", CreatorID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
		PendingCatchUp: true, PendingSince: &now,
	})
	if err := fx.orch.DecideCatchUp(ctx, "u-alice", "chan1", "s-ghost-agent", true); err == nil {
		t.Fatal("ghost agent accepted")
	}

	// Creator lookup fails (caller IS the vanished creator).
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-ghost-creator", AgentID: testGGID, CreatorID: "u-gone", ParentID: "chan1", ParentType: ParentChannel,
		PendingCatchUp: true, PendingSince: &now,
	})
	if err := fx.orch.DecideCatchUp(ctx, "u-gone", "chan1", "s-ghost-creator", true); err == nil {
		t.Fatal("ghost creator accepted")
	}
}

func TestOrchCov_SweepHeartbeatsSkipArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()

	fx.dir.failListAllSubs = errOrchCov
	fx.orch.sweepHeartbeats(ctx)
	fx.dir.failListAllSubs = nil

	// No heartbeat configured → skipped.
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-watch", AgentID: testGGID, CreatorID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
	})
	// Heartbeat sub whose agent is human.
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-human", AgentID: "u-bob", CreatorID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
		HeartbeatMins: 1,
	})
	// Heartbeat sub whose creator vanished.
	_ = fx.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-gone", AgentID: testQibID, CreatorID: "u-gone", ParentID: "chan1", ParentType: ParentChannel,
		HeartbeatMins: 1,
	})
	fx.orch.sweepHeartbeats(ctx)
	if ids, _ := fx.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("skip arms started runs: %v", ids)
	}

	// LastRunAt write failure → skipped before invoking.
	fx2 := newOrchCovFixture(t)
	_ = fx2.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-hb", AgentID: testGGID, CreatorID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
		HeartbeatMins: 1,
	})
	fx2.dir.failPutSub = errOrchCov
	fx2.orch.sweepHeartbeats(ctx)
	if ids, _ := fx2.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("failed mark still invoked: %v", ids)
	}

	// invokeMode failure (creator offline) → debug arm.
	fx3 := newOrchCovFixture(t)
	_ = fx3.dir.fakeAgentDir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "s-hb", AgentID: testGGID, CreatorID: "u-alice", ParentID: "chan1", ParentType: ParentChannel,
		HeartbeatMins: 1,
	})
	fx3.dir.runners = map[string][]*model.RunnerRegistration{}
	fx3.orch.sweepHeartbeats(ctx)
	if ids, _ := fx3.runs.fakeRunStore.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("offline heartbeat queued a run: %v", ids)
	}
}

func TestOrchCov_SweepDeadlinesArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.runs.failPastDeadline = errOrchCov
	fx.orch.sweepDeadlines(context.Background()) // list failure → no-op
	fx.runs.failPastDeadline = nil

	// failRun error inside the sweep → warn arm.
	run := fx.start(t, "m1", "")
	*fx.now = fx.now.Add(run.Limits.WallClockFor(run.Mode) + time.Hour)
	fx.runs.failUpdateRun = errOrchCov
	fx.orch.sweepDeadlines(context.Background())
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
	if got.State.Terminal() {
		t.Fatalf("run terminalized despite failing store: %s", got.State)
	}
}

func TestOrchCov_OnLeaseExpiredArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	// Missing run → return.
	fx.orch.onLeaseExpired("nope")

	// Queued (never claimed) run → deadline sweep owns it.
	queued := fx.start(t, "m1", "")
	fx.orch.onLeaseExpired(queued.ID)
	got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), queued.ID)
	if got.State != model.RunStateQueued {
		t.Fatalf("queued run touched by lease expiry: %s", got.State)
	}

	// Claimed run, lease lapsed, store write failing → warn arm. Fresh fixture
	// so the claim takes THIS run (claims pop the queue in order).
	fx2 := newOrchCovFixture(t)
	claimed := fx2.start(t, "m2", "")
	fx2.claim(t)
	*fx2.now = fx2.now.Add(runLeaseTTL + time.Minute)
	fx2.runs.failUpdateRun = errOrchCov
	fx2.orch.onLeaseExpired(claimed.ID)
	got2, _ := fx2.runs.fakeRunStore.GetRun(context.Background(), claimed.ID)
	if got2.State.Terminal() {
		t.Fatalf("run terminalized despite failing store: %s", got2.State)
	}
}

func TestOrchCov_LeaseTimerFiresAndFailsRun(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	fx.claim(t)
	// Lapse the lease in orchestrator time, then re-arm the timer with a
	// wall-clock lease already in the past so AfterFunc fires immediately.
	*fx.now = fx.now.Add(runLeaseTTL + time.Minute)
	fx.orch.armLeaseTimer(run.ID, time.Now().Add(-5*time.Second))
	orchCovWait(t, "lease timer to fail the run", func() bool {
		got, _ := fx.runs.fakeRunStore.GetRun(context.Background(), run.ID)
		return got.State == model.RunStateFailed && got.FailReason == "runner_lost"
	})
}

func TestOrchCov_TypingTickerDedupAndRace(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := fx.start(t, "m1", "")
	// Pre-existing ticker → second start returns immediately.
	fx.orch.startTypingTicker(run)
	fx.orch.startTypingTicker(run)
	fx.orch.stopTypingTicker(run.ID)

	// Best-effort attempt at the LoadOrStore race arm: hammer concurrent starts.
	for i := 0; i < 300; i++ {
		r := &model.Run{ID: run.ID, ParentID: "chan1", ParentType: ParentChannel, AgentID: testGGID, MessageID: "m1"}
		var wg sync.WaitGroup
		for j := 0; j < 2; j++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				fx.orch.startTypingTicker(r)
			}()
		}
		wg.Wait()
		fx.orch.stopTypingTicker(run.ID)
	}
}

// -------------------------------------------------------------- bundle arms

func TestOrchCov_BundleBudgetExhaustionDropsLayers(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()

	// Shared context (one item), a digest peer, a connector index, skills.
	ctxSvc, _ := newTestContextService(allowAll{})
	fx.orch.SetContextService(ctxSvc)
	if _, err := ctxSvc.Write(ctx, "u-alice", "", "u-alice", "chan1", ParentChannel, "a decision", false); err != nil {
		t.Fatalf("ctx write: %v", err)
	}
	fx.orch.SetConnectorRegistry(&orchCovRegistry{
		slugs: map[string]bool{"gitlab": true},
		index: []ConnectorIndexEntry{{Slug: "gitlab", Title: "GitLab", Description: "repos"}},
	})
	_ = fx.dir.PutSkill(ctx, &model.Skill{ID: "sk1", Name: "Deploy", Description: "how to deploy", Instructions: "do it"})
	// A second skill NOT attached to the run, so the ambient index builds and
	// then gets dropped whole by the blown budget.
	_ = fx.dir.PutSkill(ctx, &model.Skill{ID: "sk2", Name: "Review", Description: "how to review", Instructions: "look hard"})
	peer := &model.Run{
		ID: "run-peer", AgentID: testQibID, InvokerID: "u-alice", OwnerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1",
		State: model.RunStateCompleted, CreatedAt: fx.now.Add(-time.Minute),
	}
	fx.runs.mu.Lock()
	fx.runs.runs[peer.ID] = peer
	fx.runs.mu.Unlock()
	_ = fx.runs.fakeRunStore.PutDigest(ctx, &model.RunDigest{RunID: peer.ID, AgentID: testQibID, InvokerID: "u-alice", Summary: "peer summary", State: model.RunStateCompleted})

	fx.msgs.thread = []*model.Message{
		{ID: "t1", AuthorID: "u-alice", Body: "thread line", CreatedAt: *fx.now},
	}

	// A prompt that eats the whole budget: every later layer must drop whole.
	run := &model.Run{
		ID: "run-big", AgentID: testGGID, InvokerID: "u-alice", OwnerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1", ThreadRootID: "m1",
		Prompt:   strings.Repeat("x", bundleBudgetChars+100),
		SkillIDs: []string{"sk1", "sk-ghost"},
	}
	_, stats := fx.orch.buildBundle(ctx, run)
	if stats["skillsAttached"] != 0 {
		t.Fatalf("attached skills survived a blown budget: %v", stats["skillsAttached"])
	}
	if stats["skillsIndexed"] != 0 {
		t.Fatalf("skill index survived a blown budget: %v", stats["skillsIndexed"])
	}
	if stats["connectorsIndexed"] != 0 {
		t.Fatalf("connector index survived a blown budget: %v", stats["connectorsIndexed"])
	}
	if stats["contextItemsDropped"].(int) < 1 {
		t.Fatalf("context item not dropped: %v", stats)
	}
	if stats["digestsDropped"].(int) < 1 {
		t.Fatalf("digest not dropped: %v", stats)
	}
	if stats["threadMessagesDropped"].(int) < 1 {
		t.Fatalf("thread lines not dropped: %v", stats)
	}
}

func TestOrchCov_BundleSkillIndexCapAndSharedContextReadFailure(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	// One enormous skill description: the first index line already exceeds the
	// index cap → break, empty index.
	_ = fx.dir.PutSkill(ctx, &model.Skill{ID: "sk-huge", Name: "Huge", Description: strings.Repeat("d", bundleSkillIndexMax+500)})

	// Shared-context layer whose access checker denies → List error arm.
	denySvc, _ := newTestContextService(denyAll{})
	fx.orch.SetContextService(denySvc)

	run := &model.Run{
		ID: "r1", AgentID: testGGID, InvokerID: "u-alice", OwnerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1", Prompt: "small",
	}
	_, stats := fx.orch.buildBundle(ctx, run)
	if stats["skillsIndexed"] != 0 {
		t.Fatalf("oversized index line still indexed: %v", stats["skillsIndexed"])
	}
	if stats["contextItems"] != 0 || stats["contextPinned"] != 0 {
		t.Fatalf("denied context still rendered: %v", stats)
	}
}

func TestOrchCov_BundleAgentAuthoredContextAttribution(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	ctxSvc, _ := newTestContextService(allowAll{})
	fx.orch.SetContextService(ctxSvc)
	// Agent-authored item: attributed possessively to the invoker.
	if _, err := ctxSvc.Write(ctx, testGGID, "u-alice", "u-alice", "chan1", ParentChannel, "agent finding", false); err != nil {
		t.Fatalf("ctx write: %v", err)
	}
	run := &model.Run{
		ID: "r1", AgentID: testGGID, InvokerID: "u-alice", OwnerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1", Prompt: "task",
	}
	text, _ := fx.orch.buildBundle(ctx, run)
	if !strings.Contains(text, "Alice's gg: agent finding") {
		t.Fatalf("agent-authored item not attributed to invoker:\n%s", text)
	}
}

func TestOrchCov_BundleForRun(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := &model.Run{
		ID: "r1", AgentID: testGGID, InvokerID: "u-alice", OwnerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1", Prompt: "fresh task",
	}
	if got := fx.orch.BundleForRun(context.Background(), run); !strings.Contains(got, "fresh task") {
		t.Fatalf("bundle missing task: %q", got)
	}
}

func TestOrchCov_ThreadDigestsArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()

	run := &model.Run{ID: "r-self", ParentID: "chan1", MessageID: "m1", InvokerID: "u-alice"}

	fx.runs.failListByParent = errOrchCov
	if got := fx.orch.threadDigests(ctx, run); got != nil {
		t.Fatalf("expected nil on list failure, got %d", len(got))
	}
	fx.runs.failListByParent = nil

	// Seven terminal peers in the same thread: one without a digest, six with —
	// exercises the sort, the digest-miss skip, and the max-5 break.
	for i := 0; i < 7; i++ {
		id := "peer-" + string(rune('a'+i))
		p := &model.Run{
			ID: id, AgentID: testQibID, InvokerID: "u-alice", OwnerID: "u-alice",
			ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1",
			State: model.RunStateCompleted, CreatedAt: fx.now.Add(-time.Duration(i) * time.Minute),
		}
		fx.runs.mu.Lock()
		fx.runs.runs[id] = p
		fx.runs.mu.Unlock()
		if i != 0 { // peer-a has no digest
			_ = fx.runs.fakeRunStore.PutDigest(ctx, &model.RunDigest{RunID: id, AgentID: testQibID, InvokerID: "u-alice", Summary: id, State: model.RunStateCompleted})
		}
	}
	got := fx.orch.threadDigests(ctx, run)
	if len(got) != 5 {
		t.Fatalf("expected 5 digests (cap), got %d", len(got))
	}
}

func TestOrchCov_DisplayNamesLookupFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.users.failGetByIDs = errOrchCov
	out := fx.orch.displayNames(context.Background(), []string{"u-x", "u-y"})
	if out["u-x"] != "u-x" || out["u-y"] != "u-y" {
		t.Fatalf("fallback names wrong: %v", out)
	}
}

func TestOrchCov_ThreadWindowReadFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.msgs.failListThread = errOrchCov
	run := &model.Run{ID: "r1", InvokerID: "u-alice", ParentID: "chan1", ParentType: ParentChannel, ThreadRootID: "root1"}
	if got := fx.orch.ThreadWindow(context.Background(), run, 10); got != "" {
		t.Fatalf("expected empty window on error, got %q", got)
	}
}

func TestOrchCov_WindowRenderingArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	base := *fx.now
	fx.msgs.thread = []*model.Message{
		{ID: "w1", AuthorID: "u-alice", Body: "oldest", CreatedAt: base.Add(-3 * time.Minute), ReplyCount: 2},
		{ID: "w2", AuthorID: "u-bob", Body: "", CreatedAt: base.Add(-2 * time.Minute)},          // empty → skipped
		{ID: "w3", AuthorID: "u-bob", Body: "gone", Deleted: true, CreatedAt: base.Add(-time.Minute)}, // deleted → skipped
		{ID: "w4", AuthorID: "u-bob", Body: "newest", CreatedAt: base},
	}
	// Top-level (channel) window: newest-first reversed, trimmed to limit.
	got, err := fx.orch.Window(ctx, "u-alice", "chan1", ParentChannel, "", 2)
	if err != nil {
		t.Fatalf("window: %v", err)
	}
	if strings.Contains(got, "oldest") {
		t.Fatalf("limit trim failed:\n%s", got)
	}
	if !strings.Contains(got, "newest") {
		t.Fatalf("newest message missing:\n%s", got)
	}
	// Wide window: reply-count suffix present, skips hold.
	got, err = fx.orch.Window(ctx, "u-alice", "chan1", ParentChannel, "", 10)
	if err != nil {
		t.Fatalf("window: %v", err)
	}
	if !strings.Contains(got, "[thread: 2 replies]") {
		t.Fatalf("reply suffix missing:\n%s", got)
	}
	if strings.Contains(got, "w2") || strings.Contains(got, "gone") {
		t.Fatalf("skipped messages rendered:\n%s", got)
	}
	// List failure surfaces.
	fx.msgs.failList = errOrchCov
	if _, err := fx.orch.Window(ctx, "u-alice", "chan1", ParentChannel, "", 10); !errors.Is(err, errOrchCov) {
		t.Fatalf("list failure: %v", err)
	}
}

func TestOrchCov_ActorNamesArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	msgs := []*model.Message{
		{ID: "m1", AuthorID: "u-alice"},
		{ID: "m2", AuthorID: "u-unknown", AgentInvokerID: "u-alice"},
	}
	// Lookup failure → IDs echo back.
	fx.users.failGetByIDs = errOrchCov
	out := fx.orch.actorNames(context.Background(), msgs)
	if out["u-alice"] != "u-alice" {
		t.Fatalf("failure fallback wrong: %v", out)
	}
	// Partial resolution: unknown IDs fall back to the raw id.
	fx.users.failGetByIDs = nil
	out = fx.orch.actorNames(context.Background(), msgs)
	if out["u-unknown"] != "u-unknown" {
		t.Fatalf("missing user fallback wrong: %v", out)
	}
	if out["u-alice"] != "Alice (human)" {
		t.Fatalf("human marker wrong: %v", out)
	}
}

// --------------------------------------------------------------- helper arms

func TestOrchCov_PublishProgressWithThreadRoot(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := &model.Run{ID: "r1", AgentID: testGGID, InvokerID: "u-alice", ParentID: "chan1",
		ParentType: ParentChannel, ThreadRootID: "root1"}
	fx.orch.publishProgress(context.Background(), run, "text", map[string]any{"text": "hi"})
}

func TestOrchCov_ClipTextMultibyte(t *testing.T) {
	s := "ééé" // 6 bytes, 3 runes
	if got := clipText(s, 4); got != s {
		t.Fatalf("multibyte clip mangled: %q", got)
	}
	if got := clipText("abcdef", 3); got != "abc…" {
		t.Fatalf("clip wrong: %q", got)
	}
}

func TestOrchCov_SetStateReactionFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.msgs.failReaction = errOrchCov
	run := &model.Run{ID: "r1", AgentID: testGGID, ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1"}
	fx.orch.setState(context.Background(), run, StateEmojiRead) // must not panic
}

func TestOrchCov_AppendEventWriteFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.runs.failAppendEvent = errOrchCov
	run := &model.Run{ID: "r1", AgentID: testGGID}
	fx.orch.appendEvent(context.Background(), run, 1, testGGID, "x", nil) // must not panic
}

func TestOrchCov_WriteDigestArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	run := &model.Run{ID: "r1", AgentID: testGGID, InvokerID: "u-alice", State: model.RunStateCompleted}
	// Long summary is clipped to 700 chars.
	fx.orch.writeDigest(context.Background(), run, strings.Repeat("s", 900))
	d, err := fx.runs.GetDigest(context.Background(), "r1")
	if err != nil || len(d.Summary) > 710 {
		t.Fatalf("digest clip: len=%d err=%v", len(d.Summary), err)
	}
	// Write failure → warn arm.
	fx.runs.failPutDigest = errOrchCov
	fx.orch.writeDigest(context.Background(), run, "short")
}

func TestOrchCov_WakeAndWaiter(t *testing.T) {
	fx := newOrchCovFixture(t)
	ch := fx.orch.waiter("u-w")
	fx.orch.wake("u-w")
	select {
	case <-ch:
	case <-time.After(time.Second):
		t.Fatal("waiter channel not closed by wake")
	}
	// Waking with no waiter registered is a no-op.
	fx.orch.wake("u-nobody")
}

func TestOrchCov_ClampAndPayloadHelpers(t *testing.T) {
	if got := clampUsage(-5); got != 0 {
		t.Fatalf("negative clamp: %d", got)
	}
	if got := payloadInt64(map[string]any{"v": int64(7)}, "v"); got != 7 {
		t.Fatalf("int64 payload: %d", got)
	}
	if got := payloadInt64(map[string]any{"v": int(9)}, "v"); got != 9 {
		t.Fatalf("int payload: %d", got)
	}
	if got := payloadInt64(map[string]any{"v": "x"}, "v"); got != 0 {
		t.Fatalf("bogus payload: %d", got)
	}
	if got := limitLabel("something_else"); got != "something_else" {
		t.Fatalf("limit label passthrough: %q", got)
	}
}

// ------------------------------------------------------- purge / archive arms

func TestOrchCov_PurgeThreadLogsArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	fx.orch.PurgeThreadLogs(ctx, "chan1", "") // empty msg id → no-op

	fx.runs.failListByParent = errOrchCov
	fx.orch.PurgeThreadLogs(ctx, "chan1", "m1") // list failure → warn
	fx.runs.failListByParent = nil

	// Archive delete failure + hot delete failure inside purgeRunLog.
	arch := &orchCovArchive{failDelete: errOrchCov}
	fx.orch.SetEventArchive(arch)
	run := &model.Run{ID: "r-arch", EventsArchived: true}
	fx.runs.failDeleteEvents = errOrchCov
	fx.orch.purgeRunLog(ctx, run) // both failures logged, no panic
}

func TestOrchCov_ArchiveEventsArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	arch := &orchCovArchive{}
	fx.orch.SetEventArchive(arch)

	// Event list failure → skip.
	run := &model.Run{ID: "r1", AgentID: testGGID, State: model.RunStateCompleted}
	fx.runs.mu.Lock()
	fx.runs.runs[run.ID] = run
	fx.runs.mu.Unlock()
	fx.runs.failListEvents = errOrchCov
	fx.orch.archiveEvents(ctx, run)
	fx.runs.failListEvents = nil

	// Marker save failure → archived blob exists but hot rows stay.
	_ = fx.runs.fakeRunStore.AppendRunEvent(ctx, &model.RunEvent{RunID: run.ID, Seq: 1, Type: "tool"})
	fx.runs.failUpdateRun = errOrchCov
	fx.orch.archiveEvents(ctx, run)
	fx.runs.failUpdateRun = nil
	if hot, _ := fx.runs.fakeRunStore.ListRunEvents(ctx, run.ID); len(hot) == 0 {
		t.Fatal("hot rows pruned despite marker failure")
	}

	// Prune failure after successful archive+marker → warn only.
	run2 := &model.Run{ID: "r2", AgentID: testGGID, State: model.RunStateCompleted}
	fx.runs.mu.Lock()
	fx.runs.runs[run2.ID] = run2
	fx.runs.mu.Unlock()
	_ = fx.runs.fakeRunStore.AppendRunEvent(ctx, &model.RunEvent{RunID: run2.ID, Seq: 1, Type: "tool"})
	fx.runs.failDeleteEvents = errOrchCov
	fx.orch.archiveEvents(ctx, run2)
	got, _ := fx.runs.fakeRunStore.GetRun(ctx, run2.ID)
	if !got.EventsArchived {
		t.Fatal("marker not set on prune failure")
	}
}

func TestOrchCov_LoadEventsArchiveFallback(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	fx.orch.SetEventArchive(&orchCovArchive{failLoad: errOrchCov})
	run := &model.Run{ID: "r1", EventsArchived: true}
	_ = fx.runs.fakeRunStore.AppendRunEvent(ctx, &model.RunEvent{RunID: "r1", Seq: 1, Type: "tool"})
	evts, err := fx.orch.loadEvents(ctx, run)
	if err != nil || len(evts) != 1 {
		t.Fatalf("hot fallback failed: %d err=%v", len(evts), err)
	}
}

// ------------------------------------------------------------ connector arms

func TestOrchCov_AttachConnectorArms(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	if err := fx.orch.AttachConnector(ctx, "nope", "gitlab", "because"); err == nil {
		t.Fatal("missing run attached")
	}
	run := fx.start(t, "m1", "")
	fx.runs.failUpdateRun = errOrchCov
	if err := fx.orch.AttachConnector(ctx, run.ID, "gitlab", "because"); !errors.Is(err, errOrchCov) {
		t.Fatalf("update failure: %v", err)
	}
}

func TestOrchCov_ResolveConnectorPicksSlugLookupFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.orch.SetConnectorRegistry(&orchCovRegistry{failKnown: errOrchCov})
	msg := &model.Message{ID: "m1", ParentID: "chan1", Body: "/gitlab check the MR"}
	if got := fx.orch.resolveConnectorPicks(context.Background(), "u-alice", msg, ParentChannel); got != nil {
		t.Fatalf("expected no picks on registry failure, got %v", got)
	}
}

func orchCovPtr[T any](v T) *T { return &v }
