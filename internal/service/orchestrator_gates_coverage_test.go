package service

// Coverage tests for orchestrator_gates.go — validation rejects, store/message
// failure paths, settle races, and the read-only thread aggregates. All new
// identifiers are prefixed ogateCov; fixtures wrap the package's existing
// fakes (fakeRunStore, fakeAgentDir, fakeOrchMessages, fakeUsers, fakeNotifier).

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// ogateCovStore wraps fakeRunStore with per-method failure hooks.
type ogateCovStore struct {
	*fakeRunStore
	putApprovalErr   error
	getApprovalFn    func(runID, approvalID string) (*model.Approval, error)
	settleErr        error
	updateRunErrs    map[string]error // runID -> forced UpdateRun error
	listByParentErr  error
	listApprovalsErr error
	putArtifactErr   error
	listArtifactsErr error
	listEventsErr    error
}

func (s *ogateCovStore) PutApproval(ctx context.Context, a *model.Approval) error {
	if s.putApprovalErr != nil {
		return s.putApprovalErr
	}
	return s.fakeRunStore.PutApproval(ctx, a)
}

func (s *ogateCovStore) GetApproval(ctx context.Context, runID, approvalID string) (*model.Approval, error) {
	if s.getApprovalFn != nil {
		return s.getApprovalFn(runID, approvalID)
	}
	return s.fakeRunStore.GetApproval(ctx, runID, approvalID)
}

func (s *ogateCovStore) SettleApproval(ctx context.Context, runID, approvalID, state, decidedBy, choice, note string, decidedAt time.Time) error {
	if s.settleErr != nil {
		return s.settleErr
	}
	return s.fakeRunStore.SettleApproval(ctx, runID, approvalID, state, decidedBy, choice, note, decidedAt)
}

func (s *ogateCovStore) UpdateRun(ctx context.Context, run *model.Run, expect model.RunState) error {
	if err, ok := s.updateRunErrs[run.ID]; ok {
		return err
	}
	return s.fakeRunStore.UpdateRun(ctx, run, expect)
}

func (s *ogateCovStore) ListRunsByParent(ctx context.Context, parentID string, limit int) ([]*model.Run, error) {
	if s.listByParentErr != nil {
		return nil, s.listByParentErr
	}
	return s.fakeRunStore.ListRunsByParent(ctx, parentID, limit)
}

func (s *ogateCovStore) ListApprovals(ctx context.Context, runID string) ([]*model.Approval, error) {
	if s.listApprovalsErr != nil {
		return nil, s.listApprovalsErr
	}
	return s.fakeRunStore.ListApprovals(ctx, runID)
}

func (s *ogateCovStore) PutArtifact(ctx context.Context, a *model.Artifact) error {
	if s.putArtifactErr != nil {
		return s.putArtifactErr
	}
	return s.fakeRunStore.PutArtifact(ctx, a)
}

func (s *ogateCovStore) ListArtifacts(ctx context.Context, runID string) ([]*model.Artifact, error) {
	if s.listArtifactsErr != nil {
		return nil, s.listArtifactsErr
	}
	return s.fakeRunStore.ListArtifacts(ctx, runID)
}

func (s *ogateCovStore) ListRunEvents(ctx context.Context, runID string) ([]*model.RunEvent, error) {
	if s.listEventsErr != nil {
		return nil, s.listEventsErr
	}
	return s.fakeRunStore.ListRunEvents(ctx, runID)
}

// ogateCovMsgs wraps fakeOrchMessages so SendAsAgentRun can fail.
type ogateCovMsgs struct {
	*fakeOrchMessages
	sendErr error
}

func (m *ogateCovMsgs) SendAsAgentRun(ctx context.Context, agentID, invokerID, parentID, parentType, body, parentMessageID, runID string) (*model.Message, error) {
	if m.sendErr != nil {
		return nil, m.sendErr
	}
	return m.fakeOrchMessages.SendAsAgentRun(ctx, agentID, invokerID, parentID, parentType, body, parentMessageID, runID)
}

// ogateCovDir wraps fakeAgentDir so claim writes/reads can fail.
type ogateCovDir struct {
	*fakeAgentDir
	putClaimErr   error
	listClaimsErr error
}

func (d *ogateCovDir) PutTaskClaim(ctx context.Context, c *model.TaskClaim) error {
	if d.putClaimErr != nil {
		return d.putClaimErr
	}
	return d.fakeAgentDir.PutTaskClaim(ctx, c)
}

func (d *ogateCovDir) ListTaskClaims(ctx context.Context, parentID, threadRootID string) ([]*model.TaskClaim, error) {
	if d.listClaimsErr != nil {
		return nil, d.listClaimsErr
	}
	return d.fakeAgentDir.ListTaskClaims(ctx, parentID, threadRootID)
}

// ogateCovBlankID is a user that exists but has an empty display name, so
// ClaimTask's name fallback (who == "") is reachable.
const ogateCovBlankID = "u-ogc-blank"

type ogateCovFX struct {
	t     *testing.T
	orch  *Orchestrator
	store *ogateCovStore
	msgs  *ogateCovMsgs
	dir   *ogateCovDir
	users *fakeUsers
	now   time.Time
}

func newOgateCovFX(t *testing.T) *ogateCovFX {
	t.Helper()
	dir := &ogateCovDir{fakeAgentDir: newFakeAgentDir()}
	users := &fakeUsers{users: map[string]*model.User{
		"u-alice":       {ID: "u-alice", DisplayName: "Alice"},
		testGGID:        {ID: testGGID, DisplayName: "gg", Kind: model.UserKindAgent},
		ogateCovBlankID: {ID: ogateCovBlankID, DisplayName: ""},
	}}
	st := &ogateCovStore{fakeRunStore: newFakeRunStore()}
	msgs := &ogateCovMsgs{fakeOrchMessages: &fakeOrchMessages{}}
	orch := NewOrchestrator(st, NewAgentService(dir, users), users, msgs, fakePub{}, fakeMinter{})
	now := time.Now()
	orch.now = func() time.Time { return now }
	return &ogateCovFX{t: t, orch: orch, store: st, msgs: msgs, dir: dir, users: users, now: now}
}

// run creates and stores a live direct-mode run in thread msgID/threadRoot.
func (fx *ogateCovFX) run(id, msgID, threadRoot string) *model.Run {
	fx.t.Helper()
	r := &model.Run{
		ID: id, AgentID: testGGID, OwnerID: "u-alice", InvokerID: "u-alice",
		ParentID: "ogc-chan", ParentType: ParentChannel,
		MessageID: msgID, ThreadRootID: threadRoot,
		State: model.RunStateRunning, Mode: model.RunModeDirect,
		Deadline:  fx.now.Add(time.Hour),
		CreatedAt: fx.now, UpdatedAt: fx.now,
	}
	if err := fx.store.CreateRun(context.Background(), r); err != nil {
		fx.t.Fatalf("create run %s: %v", id, err)
	}
	return r
}

// RequestApproval input hygiene: empty summary, oversize summary clipping,
// empty options, a run too close to its deadline, and a failed approval write.
func TestOgateCovRequestApprovalValidation(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-r1", "mA", "")

	if _, err := fx.orch.RequestApproval(ctx, run, "   ", "low", nil); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty summary: want ErrValidation, got %v", err)
	}

	long := strings.Repeat("s", 1100)
	a, err := fx.orch.RequestApproval(ctx, run, long, "low", nil)
	if err != nil {
		t.Fatalf("long summary: %v", err)
	}
	if len(a.Summary) >= 1100 {
		t.Fatalf("summary not clipped: %d bytes", len(a.Summary))
	}

	if _, err := fx.orch.RequestApproval(ctx, run, "pick", "", []string{"a", "   "}); !errors.Is(err, ErrValidation) {
		t.Fatalf("blank option: want ErrValidation, got %v", err)
	}

	// A run within 10s of its deadline cannot park on an approval.
	tight := &model.Run{ID: "ogc-tight", AgentID: testGGID, InvokerID: "u-alice",
		ParentID: "ogc-chan", ParentType: ParentChannel, MessageID: "mA",
		Deadline: fx.now.Add(5 * time.Second)}
	if _, err := fx.orch.RequestApproval(ctx, tight, "too late", "", nil); !errors.Is(err, ErrValidation) {
		t.Fatalf("near-deadline run: want ErrValidation, got %v", err)
	}

	fx.store.putApprovalErr = errors.New("put approval boom")
	if _, err := fx.orch.RequestApproval(ctx, run, "will fail", "", nil); err == nil || errors.Is(err, ErrValidation) {
		t.Fatalf("put failure: want store error, got %v", err)
	}
	fx.store.putApprovalErr = nil
}

// ProposeReply input hygiene: empty draft, oversize draft clipping, and a
// failed approval write.
func TestOgateCovProposeReplyValidation(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-r2", "mA", "")

	if _, err := fx.orch.ProposeReply(ctx, run, "  ", "", ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty draft: want ErrValidation, got %v", err)
	}

	a, err := fx.orch.ProposeReply(ctx, run, strings.Repeat("x", 9000), "", "")
	if err != nil {
		t.Fatalf("long draft: %v", err)
	}
	if len(a.ReplyText) >= 9000 {
		t.Fatalf("draft not clipped: %d bytes", len(a.ReplyText))
	}
	if a.ReplyThreadRoot != "mA" || a.ReplyToMessageID != "mA" {
		t.Fatalf("defaults not applied: %+v", a)
	}

	fx.store.putApprovalErr = errors.New("put proposal boom")
	if _, err := fx.orch.ProposeReply(ctx, run, "draft", "", ""); err == nil || errors.Is(err, ErrValidation) {
		t.Fatalf("put failure: want store error, got %v", err)
	}
	fx.store.putApprovalErr = nil
}

// ClaimTask: empty label, store write/list failures, and the display-name
// fallback when a claimant resolves to a blank name.
func TestOgateCovClaimTask(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-r3", "mA", "")

	if _, _, err := fx.orch.ClaimTask(ctx, run, "   "); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty label: want ErrValidation, got %v", err)
	}

	fx.dir.putClaimErr = errors.New("claim write boom")
	if _, _, err := fx.orch.ClaimTask(ctx, run, "hindi"); err == nil || errors.Is(err, store.ErrClaimTaken) {
		t.Fatalf("claim write failure: want raw error, got %v", err)
	}
	fx.dir.putClaimErr = nil

	// Listing hiccup: the claim verdict stands, lines are dropped, no error.
	fx.dir.listClaimsErr = errors.New("list claims boom")
	mine, lines, err := fx.orch.ClaimTask(ctx, run, "english")
	if !mine || lines != nil || err != nil {
		t.Fatalf("list failure: want (true, nil, nil), got (%v, %v, %v)", mine, lines, err)
	}
	fx.dir.listClaimsErr = nil

	// A pre-existing claim by a user whose display name is empty renders by ID.
	if err := fx.dir.PutTaskClaim(ctx, &model.TaskClaim{
		ParentID: run.ParentID, ThreadRootID: "mA", Label: "blankname",
		AgentID: ogateCovBlankID, InvokerID: "u-alice", CreatedAt: fx.now,
	}); err != nil {
		t.Fatalf("seed claim: %v", err)
	}
	mine, lines, err = fx.orch.ClaimTask(ctx, run, "Spanish  Docs")
	if err != nil || !mine {
		t.Fatalf("claim: mine=%v err=%v", mine, err)
	}
	var sawBlank, sawMine bool
	for _, l := range lines {
		if strings.Contains(l, "claimed by "+ogateCovBlankID) {
			sawBlank = true
		}
		if strings.Contains(l, "spanish docs") && strings.Contains(l, "(you)") {
			sawMine = true
		}
	}
	if !sawBlank || !sawMine {
		t.Fatalf("claim lines missing fallback or own claim: %v", lines)
	}
}

// ApprovalStatus expiry races: the settle failing outright surfaces the
// error; the settle losing to a concurrent decision returns the fresh row.
func TestOgateCovApprovalStatusSettleRace(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-r4", "mA", "")

	// Pending and past deadline; the lazy-expiry settle write fails hard.
	a1 := &model.Approval{ID: "ap-err", RunID: run.ID, AgentID: run.AgentID, InvokerID: "u-alice",
		Summary: "s", State: model.ApprovalPending, Deadline: fx.now.Add(-time.Minute), CreatedAt: fx.now}
	if err := fx.store.fakeRunStore.PutApproval(ctx, a1); err != nil {
		t.Fatalf("seed: %v", err)
	}
	fx.store.settleErr = errors.New("settle boom")
	if _, err := fx.orch.ApprovalStatus(ctx, run.ID, "ap-err"); err == nil {
		t.Fatal("settle failure swallowed")
	}
	fx.store.settleErr = nil

	// A decision wins the race: the store row is already approved, but the
	// first read returns a stale pending copy — the poll must return the
	// fresh decided row, not an expiry.
	a2 := &model.Approval{ID: "ap-race", RunID: run.ID, AgentID: run.AgentID, InvokerID: "u-alice",
		Summary: "s", State: model.ApprovalApproved, DecidedBy: "u-alice",
		Deadline: fx.now.Add(-time.Minute), CreatedAt: fx.now}
	if err := fx.store.fakeRunStore.PutApproval(ctx, a2); err != nil {
		t.Fatalf("seed: %v", err)
	}
	reads := 0
	fx.store.getApprovalFn = func(runID, approvalID string) (*model.Approval, error) {
		reads++
		if reads == 1 {
			stale := *a2
			stale.State = model.ApprovalPending
			stale.DecidedBy = ""
			return &stale, nil
		}
		return fx.store.fakeRunStore.GetApproval(context.Background(), runID, approvalID)
	}
	got, err := fx.orch.ApprovalStatus(ctx, run.ID, "ap-race")
	if err != nil || got.State != model.ApprovalApproved {
		t.Fatalf("race: want fresh approved row, got %+v, %v", got, err)
	}
	fx.store.getApprovalFn = nil
}

// DecideApproval store failures: unknown approval, a settle that loses the
// race, and a settle that fails outright.
func TestOgateCovDecideApprovalErrors(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-r5", "mA", "")

	if _, err := fx.orch.DecideApproval(ctx, "u-alice", run.ID, "no-such", true, "", ""); err == nil {
		t.Fatal("unknown approval decided")
	}

	a := &model.Approval{ID: "ap-d", RunID: run.ID, AgentID: run.AgentID, InvokerID: "u-alice",
		Summary: "s", State: model.ApprovalPending, Deadline: fx.now.Add(time.Hour), CreatedAt: fx.now}
	if err := fx.store.fakeRunStore.PutApproval(ctx, a); err != nil {
		t.Fatalf("seed: %v", err)
	}

	fx.store.settleErr = store.ErrStaleApproval
	if _, err := fx.orch.DecideApproval(ctx, "u-alice", run.ID, "ap-d", true, "", ""); !errors.Is(err, ErrApprovalSettled) {
		t.Fatalf("stale settle: want ErrApprovalSettled, got %v", err)
	}

	fx.store.settleErr = errors.New("settle write boom")
	if _, err := fx.orch.DecideApproval(ctx, "u-alice", run.ID, "ap-d", true, "", ""); err == nil || errors.Is(err, ErrApprovalSettled) {
		t.Fatalf("settle failure: want raw error, got %v", err)
	}
	fx.store.settleErr = nil
}

// Approving a reply proposal whose post fails: the decision still settles,
// nothing is posted, and the failure is only logged.
func TestOgateCovApprovedReplyPostFails(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-r6", "mA", "")

	a := &model.Approval{ID: "ap-reply", RunID: run.ID, AgentID: run.AgentID, InvokerID: "u-alice",
		Summary: "Draft reply — approve, edit, or cancel", ReplyText: "Here you go.",
		ReplyThreadRoot: "mA", ReplyToMessageID: "mA",
		State: model.ApprovalPending, Deadline: fx.now.Add(time.Hour), CreatedAt: fx.now}
	if err := fx.store.fakeRunStore.PutApproval(ctx, a); err != nil {
		t.Fatalf("seed: %v", err)
	}
	fx.msgs.sendErr = errors.New("post boom")
	decided, err := fx.orch.DecideApproval(ctx, "u-alice", run.ID, "ap-reply", true, "", "")
	if err != nil || decided.State != model.ApprovalApproved {
		t.Fatalf("decide: %+v, %v", decided, err)
	}
	if got := fx.msgs.lastPost(); got != "" {
		t.Fatalf("failed post recorded a message: %q", got)
	}
	fx.msgs.sendErr = nil
}

// A multiple-choice gate's alert says "needs your input" (not "approval").
func TestOgateCovChoiceApprovalNotificationVerb(t *testing.T) {
	fx := newOgateCovFX(t)
	fn := &fakeNotifier{}
	fx.orch.SetApprovalNotifier(fn)
	run := fx.run("ogc-r7", "mA", "")

	if _, err := fx.orch.RequestApproval(context.Background(), run, "which one?", "", []string{"a", "b"}); err != nil {
		t.Fatalf("request: %v", err)
	}
	if len(fn.got) != 1 || !strings.Contains(fn.got[0].Title, "gg needs your input") {
		t.Fatalf("want a 'needs your input' alert, got %+v", fn.got)
	}
}

// Permission-gateway approvals throttle their desktop/mobile alert to one per
// run per window; the cards themselves still go out individually.
func TestOgateCovToolAlertThrottle(t *testing.T) {
	fx := newOgateCovFX(t)
	fn := &fakeNotifier{}
	fx.orch.SetApprovalNotifier(fn)
	run := fx.run("ogc-r8", "mA", "")
	ctx := context.Background()

	if _, err := fx.orch.RequestApprovalKind(ctx, run, "read main.go", "tool", nil, "read"); err != nil {
		t.Fatalf("request 1: %v", err)
	}
	if _, err := fx.orch.RequestApprovalKind(ctx, run, "read util.go", "tool", nil, "read"); err != nil {
		t.Fatalf("request 2: %v", err)
	}
	if len(fn.got) != 1 {
		t.Fatalf("tool alerts not throttled: %d alerts", len(fn.got))
	}
	if !strings.Contains(fn.got[0].Title, "gg needs your approval") {
		t.Fatalf("bad alert title: %q", fn.got[0].Title)
	}
}

// PublishArtifact: required fields, list/write failures, the api_response
// budget branch, and a failed in-thread card post that must not fail the call.
func TestOgateCovPublishArtifact(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-r9", "mA", "")

	if _, err := fx.orch.PublishArtifact(ctx, run, "markdown", "  ", "body"); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty title: want ErrValidation, got %v", err)
	}
	if _, err := fx.orch.PublishArtifact(ctx, run, "markdown", "t", "   "); !errors.Is(err, ErrValidation) {
		t.Fatalf("empty content: want ErrValidation, got %v", err)
	}

	fx.store.listArtifactsErr = errors.New("list artifacts boom")
	if _, err := fx.orch.PublishArtifact(ctx, run, "markdown", "t", "body"); err == nil {
		t.Fatal("list failure swallowed")
	}
	fx.store.listArtifactsErr = nil

	fx.store.putArtifactErr = errors.New("put artifact boom")
	if _, err := fx.orch.PublishArtifact(ctx, run, "markdown", "t", "body"); err == nil {
		t.Fatal("put failure swallowed")
	}
	fx.store.putArtifactErr = nil

	// Raw API responses use their own larger budget and post no card.
	before := len(fx.msgs.posts)
	if _, err := fx.orch.PublishArtifact(ctx, run, model.ArtifactKindAPIResponse, "GET /users", `{"ok":true}`); err != nil {
		t.Fatalf("api_response publish: %v", err)
	}
	if len(fx.msgs.posts) != before {
		t.Fatalf("api_response artifact posted a card")
	}

	// A failed card post is logged, not returned — the artifact stands.
	fx.msgs.sendErr = errors.New("card post boom")
	a, err := fx.orch.PublishArtifact(ctx, run, "markdown", "doc", "body")
	if err != nil || a == nil {
		t.Fatalf("publish with failing card: %v", err)
	}
	fx.msgs.sendErr = nil
	arts, err := fx.orch.Artifacts(ctx, run.ID)
	if err != nil || len(arts) != 2 {
		t.Fatalf("artifacts = %d, %v", len(arts), err)
	}
}

// HasApprovedApproval surfaces a listing failure.
func TestOgateCovHasApprovedApprovalListErr(t *testing.T) {
	fx := newOgateCovFX(t)
	fx.store.listApprovalsErr = errors.New("list approvals boom")
	if _, err := fx.orch.HasApprovedApproval(context.Background(), "any"); err == nil {
		t.Fatal("list failure swallowed")
	}
}

// Timeline audit helpers: skill invocation, memory update, plain Run reads,
// and the access-checked thread message list.
func TestOgateCovAuditsAndAccessors(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()

	rSkill := fx.run("ogc-skill", "mA", "")
	fx.orch.RecordSkillInvoked(ctx, rSkill, &model.Skill{ID: "sk1", Name: "code-review"})
	evts, err := fx.store.fakeRunStore.ListRunEvents(ctx, rSkill.ID)
	if err != nil || len(evts) != 1 || evts[0].Type != "skill.invoked" {
		t.Fatalf("skill event missing: %v, %v", evts, err)
	}

	rMem := fx.run("ogc-mem", "mB", "")
	fx.orch.RecordMemoryUpdate(ctx, rMem, 42)
	evts, err = fx.store.fakeRunStore.ListRunEvents(ctx, rMem.ID)
	if err != nil || len(evts) != 1 || evts[0].Type != "memory.updated" {
		t.Fatalf("memory event missing: %v, %v", evts, err)
	}

	got, err := fx.orch.Run(ctx, rSkill.ID)
	if err != nil || got.ID != rSkill.ID {
		t.Fatalf("Run: %+v, %v", got, err)
	}

	fx.msgs.thread = append(fx.msgs.thread, &model.Message{ID: "tm1", Body: "hello"})
	msgs, err := fx.orch.ThreadMessages(ctx, "u-alice", "ogc-chan", ParentChannel, "mA")
	if err != nil || len(msgs) != 1 {
		t.Fatalf("ThreadMessages: %d, %v", len(msgs), err)
	}
}

// StopThread error paths and peer filtering: unknown run, a failed peer
// listing, terminal/other-thread peers skipped, a cancel losing the race
// counting as stopped, a cancel failing hard being skipped, and the stopped
// run's fallback notice failing without harm.
func TestOgateCovStopThread(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()

	if _, err := fx.orch.StopThread(ctx, "u-alice", "no-such-run"); err == nil {
		t.Fatal("unknown run stopped")
	}

	main := fx.run("ogc-main", "mA", "")
	fx.store.listByParentErr = errors.New("list peers boom")
	if _, err := fx.orch.StopThread(ctx, "u-alice", main.ID); err == nil {
		t.Fatal("peer listing failure swallowed")
	}
	fx.store.listByParentErr = nil

	// Peers: one terminal, one in another thread, one whose cancel loses the
	// race (stale = already finished), one whose cancel fails hard.
	term := fx.run("ogc-term", "mA2", "mA")
	term.State = model.RunStateCompleted
	if err := fx.store.fakeRunStore.UpdateRun(ctx, term, model.RunStateRunning); err != nil {
		t.Fatalf("terminalize: %v", err)
	}
	fx.run("ogc-other", "mB", "")
	fx.run("ogc-stale", "mA3", "mA")
	fx.run("ogc-err", "mA4", "mA")
	fx.store.updateRunErrs = map[string]error{
		"ogc-stale": store.ErrStaleRun,
		"ogc-err":   errors.New("update boom"),
	}
	// The canceled main run never posted → it posts a stop notice, which fails.
	fx.msgs.sendErr = errors.New("notice boom")

	stopped, err := fx.orch.StopThread(ctx, "u-alice", main.ID)
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	// main cancels for real; ogc-stale's race loss still counts; ogc-err,
	// the terminal peer and the other thread don't.
	if stopped != 2 {
		t.Fatalf("stopped = %d, want 2", stopped)
	}
	fx.msgs.sendErr = nil
	got, _ := fx.store.GetRun(ctx, main.ID)
	if got.State != model.RunStateCanceled || got.FailReason != "stopped_by_user" {
		t.Fatalf("main not canceled: %+v", got)
	}
	if other, _ := fx.store.GetRun(ctx, "ogc-other"); other.State != model.RunStateRunning {
		t.Fatalf("other-thread run touched: %+v", other)
	}
}

// ThreadSpend sums only the run's own thread and tolerates a listing failure.
func TestOgateCovThreadSpend(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()

	r1 := fx.run("ogc-s1", "mA", "")
	r1.Spend = model.RunSpend{Turns: 2, InputTokens: 100, OutputTokens: 40, Posts: 1}
	if err := fx.store.fakeRunStore.UpdateRun(ctx, r1, model.RunStateRunning); err != nil {
		t.Fatalf("spend r1: %v", err)
	}
	r2 := fx.run("ogc-s2", "mA2", "mA")
	r2.Spend = model.RunSpend{Turns: 3, InputTokens: 50, OutputTokens: 10, Posts: 2}
	r2.State = model.RunStateCompleted
	if err := fx.store.fakeRunStore.UpdateRun(ctx, r2, model.RunStateRunning); err != nil {
		t.Fatalf("spend r2: %v", err)
	}
	fx.run("ogc-s3", "mB", "") // another thread — excluded

	sum := fx.orch.ThreadSpend(ctx, r1)
	if sum.Runs != 2 || sum.Active != 1 || sum.Turns != 5 ||
		sum.InputTokens != 150 || sum.OutputTokens != 50 || sum.Posts != 3 {
		t.Fatalf("bad thread spend: %+v", sum)
	}

	fx.store.listByParentErr = errors.New("list boom")
	if sum := fx.orch.ThreadSpend(ctx, r1); sum.Runs != 0 {
		t.Fatalf("listing failure should zero the summary: %+v", sum)
	}
	fx.store.listByParentErr = nil
}

// ThreadTimeline concatenates every thread run's events and surfaces store
// failures from both the run listing and the event loads.
func TestOgateCovThreadTimeline(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()

	r1 := fx.run("ogc-t1", "mA", "")
	r2 := fx.run("ogc-t2", "mA2", "mA")
	fx.run("ogc-t3", "mB", "") // another thread — excluded
	for i, r := range []*model.Run{r1, r2} {
		if err := fx.store.AppendRunEvent(ctx, &model.RunEvent{
			RunID: r.ID, Seq: int64(i + 1), Type: "turn", CreatedAt: fx.now,
		}); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}

	runs, evts, err := fx.orch.ThreadTimeline(ctx, "ogc-chan", "mA")
	if err != nil || len(runs) != 2 || len(evts) != 2 {
		t.Fatalf("timeline: runs=%d events=%d err=%v", len(runs), len(evts), err)
	}

	fx.store.listEventsErr = errors.New("events boom")
	if _, _, err := fx.orch.ThreadTimeline(ctx, "ogc-chan", "mA"); err == nil {
		t.Fatal("event load failure swallowed")
	}
	fx.store.listEventsErr = nil

	fx.store.listByParentErr = errors.New("list boom")
	if _, _, err := fx.orch.ThreadTimeline(ctx, "ogc-chan", "mA"); err == nil {
		t.Fatal("run listing failure swallowed")
	}
	fx.store.listByParentErr = nil
}
