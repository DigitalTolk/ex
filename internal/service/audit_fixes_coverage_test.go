package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// Coverage for the audit-driven fixes in the agents layer: purpose-bound
// approvals, the deadline gate, owner-bound runner calls, the atomic spend
// ledger, sequence validation, workspace-pin liveness and the access-checked
// run reads.

// ---------------------------------------------------------------- approvals

// ApprovalGranted is what every server-side gate asks before acting on "the
// invoker said yes". Purpose equality is the point; the legacy path (an
// approval raised by an older runner, with no purpose) is accepted only as a
// deliberate gate whose summary names the subject.
func TestOgateCov_ApprovalGrantedArms(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-granted", "mA", "")
	purpose := model.ApprovalPurposeConnector("core")

	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, "", purpose); ok {
		t.Fatal("no approval id must never authorize anything")
	}
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, "nope", purpose); ok {
		t.Fatal("an unknown approval must not authorize")
	}

	put := func(a *model.Approval) string {
		a.RunID, a.InvokerID, a.State = run.ID, "u-alice", model.ApprovalApproved
		a.Deadline = fx.now.Add(time.Hour)
		if a.ID == "" {
			t.Fatal("test approval needs an id")
		}
		if err := fx.store.PutApproval(ctx, a); err != nil {
			t.Fatalf("put approval: %v", err)
		}
		return a.ID
	}

	// Purpose present → equality decides, and nothing else matters.
	id := put(&model.Approval{ID: "ap-purpose", Summary: "anything at all", Purpose: purpose})
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, id, purpose); !ok {
		t.Fatal("matching purpose must authorize")
	}
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, id, model.ApprovalPurposeConnector("other")); ok {
		t.Fatal("a different purpose must not authorize")
	}

	// A PENDING approval authorizes nothing.
	pending := &model.Approval{ID: "ap-pending", RunID: run.ID, InvokerID: "u-alice",
		State: model.ApprovalPending, Purpose: purpose, Deadline: fx.now.Add(time.Hour)}
	if err := fx.store.PutApproval(ctx, pending); err != nil {
		t.Fatalf("put pending: %v", err)
	}
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, pending.ID, purpose); ok {
		t.Fatal("a pending approval must not authorize")
	}

	// Legacy (no purpose): a permission-gateway click and a reply proposal are
	// consent for something else entirely.
	toolKind := put(&model.Approval{ID: "ap-tool", Summary: "read core", Kind: model.AutoAllowRead})
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, toolKind, purpose); ok {
		t.Fatal("a tool-class approval must not authorize a connector")
	}
	toolRisk := put(&model.Approval{ID: "ap-toolrisk", Summary: "read core", Risk: "tool"})
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, toolRisk, purpose); ok {
		t.Fatal("a tool-risk approval must not authorize a connector")
	}
	draft := put(&model.Approval{ID: "ap-draft", Summary: "core", ReplyText: "hello"})
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, draft, purpose); ok {
		t.Fatal("a reply proposal must not authorize a connector")
	}

	// Legacy subject matching is token-exact: "core" is not authorized by a
	// card about "core-eu", and a subject-less purpose needs no subject.
	exact := put(&model.Approval{ID: "ap-exact", Summary: "Use the core connector for this task"})
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, exact, purpose); !ok {
		t.Fatal("a whole-token subject match must authorize")
	}
	prefix := put(&model.Approval{ID: "ap-prefix", Summary: "Use the core-eu connector for this task"})
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, prefix, purpose); ok {
		t.Fatal("core-eu must not authorize core")
	}
	noSubject := put(&model.Approval{ID: "ap-nosubject", Summary: "post the reply"})
	if _, ok := fx.orch.ApprovalGranted(ctx, run.ID, noSubject, model.ApprovalPurposeWatchReply); !ok {
		t.Fatal("a purpose with no subject needs only a deliberate gate")
	}
}

func TestOgateCov_ContainsTokenEdges(t *testing.T) {
	cases := []struct {
		s, token string
		want     bool
	}{
		{"core", "core", true},
		{"use core now", "core", true},
		{"core-eu", "core", false},
		{"precore", "core", false},
		{"a.core.b", "core", false}, // '.' continues a token
		{"(core)", "core", true},
		{"", "core", false},
		{"core", "", false},
		{"cor", "core", false},
	}
	for _, c := range cases {
		if got := containsToken(c.s, c.token); got != c.want {
			t.Fatalf("containsToken(%q, %q) = %v, want %v", c.s, c.token, got, c.want)
		}
	}
}

// A decision that arrives after the gate's deadline is refused: the run has
// stopped polling (or ended), so recording it would tell the human they
// approved something no agent will ever read.
func TestOgateCov_DecideApprovalPastDeadline(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-late", "mA", "")
	a := &model.Approval{
		ID: "ap-late", RunID: run.ID, InvokerID: "u-alice",
		Summary: "do the thing", State: model.ApprovalPending,
		Deadline: fx.now.Add(-time.Minute),
	}
	if err := fx.store.PutApproval(ctx, a); err != nil {
		t.Fatalf("put: %v", err)
	}
	if _, err := fx.orch.DecideApproval(ctx, "u-alice", run.ID, a.ID, Decision{Approve: true}); !errors.Is(err, ErrApprovalSettled) {
		t.Fatalf("late decision: want ErrApprovalSettled, got %v", err)
	}
	// The poll it triggers marks the gate expired, so the card clears.
	got, err := fx.store.GetApproval(ctx, run.ID, a.ID)
	if err != nil || got.State != model.ApprovalExpired {
		t.Fatalf("gate should be expired: %+v %v", got, err)
	}

	// A settle failure on that expiry surfaces rather than reading as settled.
	b := &model.Approval{
		ID: "ap-late2", RunID: run.ID, InvokerID: "u-alice",
		Summary: "again", State: model.ApprovalPending,
		Deadline: fx.now.Add(-time.Minute),
	}
	if err := fx.store.PutApproval(ctx, b); err != nil {
		t.Fatalf("put 2: %v", err)
	}
	fx.store.settleErr = errors.New("ogc: settle down")
	if _, err := fx.orch.DecideApproval(ctx, "u-alice", run.ID, b.ID, Decision{Approve: true}); !errors.Is(err, fx.store.settleErr) {
		t.Fatalf("expiry failure should surface, got %v", err)
	}
	fx.store.settleErr = nil
}

// The lazy-expiry path: the settle sticks but the run is unreadable, so the
// invoker's card cannot be refreshed — say so instead of returning quietly,
// and never re-mark a TERMINAL run as working.
func TestOgateCov_ApprovalStatusExpiryEdges(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-expiry", "mA", "")

	stale := func(id string) *model.Approval {
		a := &model.Approval{ID: id, RunID: run.ID, InvokerID: "u-alice",
			Summary: "s", State: model.ApprovalPending, Deadline: fx.now.Add(-time.Minute)}
		if err := fx.store.PutApproval(ctx, a); err != nil {
			t.Fatalf("put %s: %v", id, err)
		}
		return a
	}

	// Run read fails after the settle.
	a := stale("ap-noread")
	fx.store.getRunErr = errors.New("ogc: run gone")
	got, err := fx.orch.ApprovalStatus(ctx, run.ID, a.ID)
	if err != nil || got.State != model.ApprovalExpired {
		t.Fatalf("expiry with unreadable run: %+v %v", got, err)
	}
	fx.store.getRunErr = nil

	// A TERMINAL run keeps its outcome: no ⚙️ re-mark from a late poll.
	done := *run
	done.State = model.RunStateCompleted
	if err := fx.store.fakeRunStore.UpdateRun(ctx, &done, model.RunStateRunning); err != nil {
		t.Fatalf("terminalize: %v", err)
	}
	fx.msgs.reactions = nil
	b := stale("ap-terminal")
	if got, err := fx.orch.ApprovalStatus(ctx, run.ID, b.ID); err != nil || got.State != model.ApprovalExpired {
		t.Fatalf("expiry on a terminal run: %+v %v", got, err)
	}
	for _, s := range fx.msgs.reactions {
		if s == StateEmojiWorking {
			t.Fatal("a terminal run must not be re-marked as working")
		}
	}
}

// ---------------------------------------------------------------- run reads

// Artifacts and thread timelines are access-checked in the ORCHESTRATOR, so
// every reader inherits the rule instead of each handler re-implementing it.
func TestOgateCov_AccessCheckedReads(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	run := fx.run("ogc-arts", "mA", "root-a")
	if err := fx.store.PutArtifact(ctx, &model.Artifact{ID: "art-1", RunID: run.ID, Title: "doc"}); err != nil {
		t.Fatalf("put artifact: %v", err)
	}

	// The invoker always.
	if _, arts, err := fx.orch.ArtifactsForCaller(ctx, "u-alice", run.ID); err != nil || len(arts) != 1 {
		t.Fatalf("invoker read: %d %v", len(arts), err)
	}
	// A member of the parent (CheckAccess passes) too.
	if _, arts, err := fx.orch.ArtifactsForCaller(ctx, "u-bob", run.ID); err != nil || len(arts) != 1 {
		t.Fatalf("member read: %d %v", len(arts), err)
	}
	// A non-member: refused.
	fx.msgs.checkAccessErr = errors.New("ogc: not a member")
	if _, _, err := fx.orch.ArtifactsForCaller(ctx, "u-bob", run.ID); !errors.Is(err, ErrNoRunAccess) {
		t.Fatalf("non-member read: want ErrNoRunAccess, got %v", err)
	}
	if _, _, _, err := fx.orch.ThreadTimeline(ctx, "u-bob", run.ParentID, "root-a"); !errors.Is(err, ErrNoRunAccess) {
		t.Fatalf("non-member thread read: want ErrNoRunAccess, got %v", err)
	}
	fx.msgs.checkAccessErr = nil

	// Unknown run, and an artifact-listing failure.
	if _, _, err := fx.orch.ArtifactsForCaller(ctx, "u-alice", "nope"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("unknown run: %v", err)
	}
	fx.store.listArtifactsErr = errors.New("ogc: artifacts down")
	if _, _, err := fx.orch.ArtifactsForCaller(ctx, "u-alice", run.ID); !errors.Is(err, fx.store.listArtifactsErr) {
		t.Fatalf("listing failure should surface: %v", err)
	}
	fx.store.listArtifactsErr = nil
}

// A saturated per-parent page is LOGGED, never silently truncated — the
// drawer's display layers read a bounded page, and the one place that needs
// completeness (StopThread) reads the ACTIVE_RUNS index instead.
func TestOgateCov_ThreadRunsPageSaturation(t *testing.T) {
	fx := newOgateCovFX(t)
	ctx := context.Background()
	for i := 0; i < threadRunPage+2; i++ {
		fx.run("ogc-page-"+strings.Repeat("x", i%3)+string(rune('a'+i%26))+string(rune('0'+i/26)), "mS", "root-s")
	}
	got := fx.orch.threadRuns(ctx, "ogc-chan", "root-s")
	if len(got) > threadRunPage {
		t.Fatalf("bounded page returned %d runs", len(got))
	}
}

// ------------------------------------------------------------ runner API

// Events/Complete/Fail bind the run to the AUTHENTICATED owner: a
// body-supplied runnerID is not proof of anything on its own.
func TestOrchCov_RunnerCallsBindTheOwner(t *testing.T) {
	fx := newOrchFixture(t)
	ctx := context.Background()
	run := fx.startRun(t)
	fx.claim(t)

	// Someone else's token cannot touch this run, and the run's existence is
	// not confirmed either.
	if _, _, err := fx.orch.ReportEvents(ctx, "u-eve", "r1", run.ID, []RunEventInput{{Seq: 1, Type: "turn"}}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign owner events: want ErrNotFound, got %v", err)
	}
	if err := fx.orch.CompleteRun(ctx, "u-eve", "r1", run.ID, "mine now", nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign owner complete: want ErrNotFound, got %v", err)
	}
	if err := fx.orch.FailRun(ctx, "u-eve", "r1", run.ID, "boom"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("foreign owner fail: want ErrNotFound, got %v", err)
	}
	if err := fx.orch.FailRun(ctx, "", "r1", run.ID, "boom"); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("empty owner: want ErrNotFound, got %v", err)
	}
	// The run is untouched.
	got, _ := fx.runs.GetRun(ctx, run.ID)
	if got.State.Terminal() {
		t.Fatalf("a foreign call terminated the run: %s", got.State)
	}
	// The real owner still works.
	if err := fx.orch.CompleteRun(ctx, "u-alice", "r1", run.ID, "done", nil); err != nil {
		t.Fatalf("owner complete: %v", err)
	}
}

// Spend is counted ONCE per runner sequence, and out-of-range sequences are
// refused at ingest instead of colliding with the reserved lifecycle seqs
// (where AppendRunEvent reports the collision as idempotent success).
func TestOrchCov_SpendIdempotencyAndSeqValidation(t *testing.T) {
	fx := newOrchFixture(t)
	ctx := context.Background()
	run := fx.startRun(t)
	fx.claim(t)

	batch := []RunEventInput{{Seq: 1, Type: "turn"}, {Seq: 2, Type: "usage", Payload: map[string]any{"inputTokens": 10}}}
	if _, _, err := fx.orch.ReportEvents(ctx, "u-alice", "r1", run.ID, batch); err != nil {
		t.Fatalf("first batch: %v", err)
	}
	after, _ := fx.runs.GetRun(ctx, run.ID)
	if after.Spend.Turns != 1 || after.Spend.InputTokens != 10 || after.LastRunnerSeq != 2 {
		t.Fatalf("first batch ledger: %+v seq=%d", after.Spend, after.LastRunnerSeq)
	}

	// The SAME batch again (a retry after a lost response) adds nothing.
	if _, _, err := fx.orch.ReportEvents(ctx, "u-alice", "r1", run.ID, batch); err != nil {
		t.Fatalf("retried batch: %v", err)
	}
	retried, _ := fx.runs.GetRun(ctx, run.ID)
	if retried.Spend.Turns != 1 || retried.Spend.InputTokens != 10 {
		t.Fatalf("retry double-counted: %+v", retried.Spend)
	}

	// Out-of-range sequences are dropped, and count for nothing.
	bad := []RunEventInput{
		{Seq: 0, Type: "turn"},
		{Seq: -3, Type: "turn"},
		{Seq: maxRunnerSeq + 1, Type: "turn"},
	}
	if _, _, err := fx.orch.ReportEvents(ctx, "u-alice", "r1", run.ID, bad); err != nil {
		t.Fatalf("bad seqs: %v", err)
	}
	unchanged, _ := fx.runs.GetRun(ctx, run.ID)
	if unchanged.Spend.Turns != 1 {
		t.Fatalf("out-of-range sequences were counted: %+v", unchanged.Spend)
	}
	// The reserved lifecycle rows are intact (nothing overwrote seq 1-3).
	evts, err := fx.runs.ListRunEvents(ctx, run.ID)
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	for _, e := range evts {
		if e.Seq == 1 && e.Type != "run.invoked" {
			t.Fatalf("lifecycle seq 1 was overwritten by %q", e.Type)
		}
	}

	// A post bump and an event batch cannot revert each other.
	if _, err := fx.orch.RecordAgentPost(ctx, run.ID); err != nil {
		t.Fatalf("record post: %v", err)
	}
	if _, _, err := fx.orch.ReportEvents(ctx, "u-alice", "r1", run.ID, []RunEventInput{{Seq: 3, Type: "turn"}}); err != nil {
		t.Fatalf("third batch: %v", err)
	}
	both, _ := fx.runs.GetRun(ctx, run.ID)
	if both.Spend.Posts != 1 || both.Spend.Turns != 2 {
		t.Fatalf("counters clobbered each other: %+v", both.Spend)
	}
}

// A runner event's payload is clipped so a multi-megabyte tool result can't
// ride the timeline into a failed 400KB item write.
func TestOrchCov_ClipPayload(t *testing.T) {
	if got := clipPayload(nil); got != nil {
		t.Fatalf("nil payload: %+v", got)
	}
	big := strings.Repeat("x", maxEventPayloadChars+500)
	out := clipPayload(map[string]any{"a": big, "b": big, "n": 7})
	if len([]rune(out["a"].(string))) > maxEventPayloadChars+1 {
		t.Fatalf("first value not clipped: %d runes", len([]rune(out["a"].(string))))
	}
	if out["b"].(string) != "" && len(out["b"].(string)) >= len(big) {
		t.Fatalf("budget not shared across values: %d", len(out["b"].(string)))
	}
	if out["n"] != 7 {
		t.Fatalf("non-string values must pass through: %+v", out["n"])
	}
}

// ------------------------------------------------------------------- tasks

// The workspace pin's liveness is judged against the PIN'S OWNER, not the
// claimer: checking only the claimer's runners reported every other owner's
// live pin as dead and stole the checkout.
func TestTaskCov_PinnedRunnerLiveness(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()

	task := &model.CodingTask{
		ID: "t-pin", ChannelID: "chan-general", RequesterID: "u-alice", AgentID: testDevID,
		State: model.TaskStateInProgress, RunnerID: "r1", RunnerOwnerID: "u-alice",
	}
	// u-alice's r1 is live in the fixture → the pin holds against another claimer.
	if !fx.orch.pinnedRunnerLive(ctx, task, "u-bob") {
		t.Fatal("a live pin owned by the requester must hold")
	}
	// A pin on a runner nobody has registered is dead.
	task.RunnerID = "r-ghost"
	if fx.orch.pinnedRunnerLive(ctx, task, "u-bob") {
		t.Fatal("an unregistered pin must read as dead")
	}
	// No recorded owner falls back to the requester.
	task.RunnerID, task.RunnerOwnerID = "r1", ""
	if !fx.orch.pinnedRunnerLive(ctx, task, "u-alice") {
		t.Fatal("the requester fallback must find their own runner")
	}
	// An owner-less, requester-less task cannot be judged: hold the pin.
	orphan := &model.CodingTask{ID: "t-orphan", RunnerID: "r1"}
	if fx.orch.pinnedRunnerLive(ctx, orphan, "") {
		t.Fatal("with no owner at all there is nothing to match")
	}
}

// A mention inside a task thread only becomes a TASK run for someone entitled
// to steer: otherwise it is an ordinary chat run, with an ordinary budget and
// no workspace.
func TestTaskCov_ImplicitBindRequiresSteerEntitlement(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	dev, _ := fx.users.GetUser(ctx, testDevID)
	bob, _ := fx.users.GetUser(ctx, "u-bob")
	resolved, err := fx.orch.agentSvc.Resolve(ctx, dev, bob.ID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if err := fx.tasks.CreateTask(ctx, &model.CodingTask{
		ID: "t-steer", ChannelID: "chan-general", ThreadRootID: "card-1",
		RequesterID: "u-alice", AgentID: testDevID, State: model.TaskStateInProgress,
		Steering: model.TaskSteeringRequester,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	msg := &model.Message{ID: "m-bob", ParentID: "chan-general", ParentMessageID: "card-1",
		AuthorID: "u-bob", Body: "@dev push it"}

	// Bob is not the requester and steering is requester-only.
	run, err := fx.orch.startRun(ctx, invocation{agent: dev, invoker: bob, msg: msg, parentType: ParentChannel}, resolved)
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if run.Mode == model.RunModeTask || run.TaskID != "" {
		t.Fatalf("a non-steerer got a task run: mode=%s taskID=%s", run.Mode, run.TaskID)
	}

	// The requester's own mention DOES bind. Separate task + thread, because
	// the run above already holds this agent's turn slot in card-1's thread.
	if err := fx.tasks.CreateTask(ctx, &model.CodingTask{
		ID: "t-steer-2", ChannelID: "chan-general", ThreadRootID: "card-2",
		RequesterID: "u-alice", AgentID: testDevID, State: model.TaskStateInProgress,
		Steering: model.TaskSteeringRequester,
	}); err != nil {
		t.Fatalf("create task 2: %v", err)
	}
	alice, _ := fx.users.GetUser(ctx, "u-alice")
	aliceResolved, err := fx.orch.agentSvc.Resolve(ctx, dev, alice.ID)
	if err != nil {
		t.Fatalf("resolve alice: %v", err)
	}
	aliceMsg := &model.Message{ID: "m-alice", ParentID: "chan-general", ParentMessageID: "card-2",
		AuthorID: "u-alice", Body: "@dev push it"}
	bound, err := fx.orch.startRun(ctx, invocation{agent: dev, invoker: alice, msg: aliceMsg, parentType: ParentChannel}, aliceResolved)
	if err != nil {
		t.Fatalf("start bound: %v", err)
	}
	if bound.Mode != model.RunModeTask || bound.TaskID != "t-steer-2" {
		t.Fatalf("the requester's mention should bind: mode=%s taskID=%s", bound.Mode, bound.TaskID)
	}
}

// ------------------------------------------------------- linkify boundaries

// The single-pass mention scan honours the same boundaries the old per-target
// regex did: an "@" only starts a mention at the start of the body or after a
// non-word character, and a name must not run into more word characters.
func TestOrchCov_LinkifyBoundaries(t *testing.T) {
	fx := newOrchFixture(t)
	ctx := context.Background()
	run := fx.startRun(t)

	// At position 0.
	if got := fx.orch.LinkifyMentions(ctx, run, "@Alice ping"); !strings.HasPrefix(got, "@[u-alice|Alice]") {
		t.Fatalf("mention at the start of the body: %q", got)
	}
	// Name running into more word characters is NOT a mention.
	if got := fx.orch.LinkifyMentions(ctx, run, "hi @Alice2"); strings.Contains(got, "u-alice") {
		t.Fatalf("@Alice2 must not match Alice: %q", got)
	}
	// "@" preceded by a word character is not a mention start (an email).
	if got := fx.orch.LinkifyMentions(ctx, run, "mail me at bob@Alice"); strings.Contains(got, "u-alice") {
		t.Fatalf("an in-word @ must not start a mention: %q", got)
	}
	// The editor's own markup is left alone (no double-linkify).
	already := "@[u-alice|Alice] hi"
	if got := fx.orch.LinkifyMentions(ctx, run, already); got != already {
		t.Fatalf("existing markup rewritten: %q", got)
	}
	// A bare "@" survives untouched.
	if got := fx.orch.LinkifyMentions(ctx, run, "e@ and @"); got != "e@ and @" {
		t.Fatalf("bare @ rewritten: %q", got)
	}
}

// --------------------------------------------------------------- claim path

// A run that goes terminal between ClaimRun and the deadline re-base is NOT
// handed out, and its lease timer and typing ticker are never armed — that
// combination left a goroutine publishing "the agent is typing" for a dead run.
func TestOrchCov_ClaimDropsRunTerminalMidClaim(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	run := fx.start(t, "m1", "")

	ack := model.RunStateAcknowledged
	fx.runs.failUpdateRun = store.ErrStaleRun
	fx.runs.failUpdateExpect = &ack
	as, err := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 1, 0)
	fx.runs.failUpdateRun, fx.runs.failUpdateExpect = nil, nil
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if len(as) != 0 {
		t.Fatalf("a run that went terminal mid-claim was handed out: %+v", as)
	}
	if _, armed := fx.orch.typing.Load(run.ID); armed {
		t.Fatal("typing ticker armed for a dropped claim")
	}
	if _, armed := fx.orch.timers.Load(run.ID); armed {
		t.Fatal("lease timer armed for a dropped claim")
	}
}

// The long-poll parks on its own ticker (one timer, reset per tick) and
// returns empty when the wait budget lapses.
func TestOrchCov_ClaimPollTicks(t *testing.T) {
	fx := newOrchCovFixture(t)
	prev := claimPollInterval
	claimPollInterval = time.Millisecond
	t.Cleanup(func() { claimPollInterval = prev })

	// A real clock so the deadline actually passes while the ticker fires.
	fx.orch.now = time.Now
	as, err := fx.orch.Claim(context.Background(), "u-nobody", "r1", []string{model.HarnessClaude}, 1, 5*time.Millisecond)
	if err != nil || len(as) != 0 {
		t.Fatalf("empty poll: %d %v", len(as), err)
	}
}

// -------------------------------------------------------------- reconciler

// A transient run-read failure during a heartbeat is NOT a kill order: only a
// run that genuinely no longer exists is. One blip used to kill every run the
// runner had in flight.
func TestOrchCov_HeartbeatOnlyKillsMissingRuns(t *testing.T) {
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	run := fx.start(t, "m1", "")
	fx.claim(t)

	reg := &model.RunnerRegistration{RunnerID: "r1", OwnerID: "u-alice",
		Harnesses: []model.RunnerHarness{{Name: model.HarnessClaude}}}

	fx.runs.failGetRun = errors.New("orchCov: dynamo blip")
	kill, err := fx.orch.Heartbeat(ctx, reg, []string{run.ID})
	fx.runs.failGetRun = nil
	if err != nil {
		t.Fatalf("heartbeat: %v", err)
	}
	if len(kill) != 0 {
		t.Fatalf("a transient read failure produced kill orders: %v", kill)
	}

	// A run that really is gone IS killed.
	kill, err = fx.orch.Heartbeat(ctx, reg, []string{"run-that-never-existed"})
	if err != nil || len(kill) != 1 {
		t.Fatalf("missing run should be killed: %v %v", kill, err)
	}
}

// The reconcile tick reads the subscription partition ONCE and hands it to
// both sweeps; a listing failure skips the tick rather than sweeping with a
// half-answer.
func TestOrchCov_ReconcileTickListingFailure(t *testing.T) {
	fx := newOrchCovFixture(t)
	prev := reconcileInterval
	reconcileInterval = 2 * time.Millisecond
	t.Cleanup(func() { reconcileInterval = prev })

	fx.dir.failListAllSubs = errOrchCov
	ctx, cancel := context.WithCancel(context.Background())
	fx.orch.StartReconciler(ctx)
	// Let a few ticks run through the failure arm, then stop.
	time.Sleep(30 * time.Millisecond)
	cancel()
	time.Sleep(5 * time.Millisecond)
	fx.dir.failListAllSubs = nil
}

// ------------------------------------------------------------ agent service

// Creation is two writes; the second can fail. A template with no agent user
// is HALF-created, so creating again finishes it — the guard used to make
// every retry "already exists" while no mentionable agent existed.
func TestAgentCov_CreateAgentConvergenceEdges(t *testing.T) {
	ctx := context.Background()
	svc, _, users := agentCovNewSvc()
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "zz", Persona: "p"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	// A user-lookup failure while deciding half-created-ness surfaces rather
	// than being read as "not built yet".
	users.errGet = errors.New("agentCov: users down")
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "zz", Persona: "p"}); !errors.Is(err, users.errGet) {
		t.Fatalf("user lookup failure should surface, got %v", err)
	}
	users.errGet = nil
}

// A rename that cannot read the agent user leaves the @name people see out of
// sync with the template, so it reports instead of returning success.
func TestAgentCov_RenameAgentUserLookupFailure(t *testing.T) {
	ctx := context.Background()
	svc, _, users := agentCovNewSvc()
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "rn", Persona: "p"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	users.errGet = errors.New("agentCov: users down")
	if _, err := svc.RenameAgent(ctx, "rn", "Renamed"); err == nil || !strings.Contains(err.Error(), "rename user lookup") {
		t.Fatalf("want a rename-user-lookup error, got %v", err)
	}
	users.errGet = nil
}

// Watcher rows written before the creator index existed answer nothing on the
// indexed query, so the first read falls back to the full listing ONCE and
// rewrites what it finds — the index answers every later call.
func TestAgentCov_SubscriptionCreatorIndexBackfill(t *testing.T) {
	ctx := context.Background()
	svc, dir, users := agentCovNewSvc()
	users.users[AgentUserID("bf")] = &model.User{
		ID: AgentUserID("bf"), Kind: model.UserKindAgent,
		AgentConfig: &model.AgentConfig{TemplateSlug: "bf"},
	}
	if _, err := svc.CreateAgent(ctx, CreateAgentInput{Slug: "bf", Persona: "p"}); err != nil {
		t.Fatalf("create agent: %v", err)
	}

	// The fake's indexed listing is filtered, so simulate the legacy state by
	// making it answer nothing once.
	dir.hideCreatorIndex = true
	sub := &model.AgentSubscription{
		ID: "sub-legacy", AgentID: AgentUserID("bf"), CreatorID: "u-1",
		ParentID: "ch-1", ParentType: ParentChannel, CreatedAt: time.Now(),
	}
	if err := dir.fakeAgentDir.PutAgentSubscription(ctx, sub); err != nil {
		t.Fatalf("seed sub: %v", err)
	}
	// Someone else's watcher, and one of ours for a different agent: the
	// fallback scan must skip both.
	for _, other := range []*model.AgentSubscription{
		{ID: "sub-theirs", AgentID: AgentUserID("bf"), CreatorID: "u-2", ParentID: "ch-1", ParentType: ParentChannel},
		{ID: "sub-other-agent", AgentID: "ag-else", CreatorID: "u-1", ParentID: "ch-1", ParentType: ParentChannel},
	} {
		if err := dir.fakeAgentDir.PutAgentSubscription(ctx, other); err != nil {
			t.Fatalf("seed other sub: %v", err)
		}
	}
	got, err := svc.ListSubscriptionsFor(ctx, "u-1", "bf")
	if err != nil || len(got) != 1 {
		t.Fatalf("fallback listing: %d %v", len(got), err)
	}

	// The backfill write failing is logged, not fatal.
	dir.errs["PutAgentSubscription"] = errors.New("agentCov: write down")
	if got, err := svc.ListSubscriptionsFor(ctx, "u-1", "bf"); err != nil || len(got) != 1 {
		t.Fatalf("fallback with a failing backfill: %d %v", len(got), err)
	}
	delete(dir.errs, "PutAgentSubscription")

	// A failing full listing surfaces.
	dir.errs["ListAllSubscriptions"] = errors.New("agentCov: list down")
	if _, err := svc.ListSubscriptionsFor(ctx, "u-1", "bf"); !errors.Is(err, dir.errs["ListAllSubscriptions"]) {
		t.Fatalf("listing failure should surface, got %v", err)
	}
	delete(dir.errs, "ListAllSubscriptions")
	dir.hideCreatorIndex = false
}

// A real store error on the task-thread lookup is LOGGED (it silently dropped
// steering); "no task on this thread" stays quiet.
func TestTaskCov_DispatchTaskThreadLookupError(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	author, _ := fx.users.GetUser(ctx, "u-alice")

	fx.tasks.getByThreadErr = errors.New("taskCov: dynamo down")
	invoked := map[string]bool{}
	fx.orch.dispatchTask(ctx, &model.Message{ID: "m1", ParentID: "chan-general",
		ParentMessageID: "root-1", AuthorID: "u-alice", Body: "steer"}, ParentChannel, author, invoked)
	fx.tasks.getByThreadErr = nil
	if len(invoked) != 0 {
		t.Fatalf("a store error must not dispatch: %v", invoked)
	}
}

// A live-runner lookup failure counts the pin as LIVE: an outage must not be
// grounds for stealing a workspace.
func TestTaskCov_PinLivenessLookupFailureHoldsThePin(t *testing.T) {
	fx := newTaskFixture(t)
	ctx := context.Background()
	fx.dir.failListRunners = errors.New("taskCov: runners down")
	task := &model.CodingTask{ID: "t-x", RequesterID: "u-alice", RunnerID: "r1", RunnerOwnerID: "u-alice"}
	if !fx.orch.pinnedRunnerLive(ctx, task, "u-bob") {
		t.Fatal("an unreadable runner list must hold the pin")
	}
	fx.dir.failListRunners = nil
}

// ------------------------------------------------------- coding-task service

// The one-active-task rule is a SCAN, so two concurrent creates both pass it.
// The loser is decided by ULID order once the rows are durable, and it
// retracts itself completely — the project no longer ends up with two active
// tasks and nothing to repair it.
func TestCtaskCov_ConcurrentCreateYieldsToTheOlderTask(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	run := fx.intakeRun(t, testDevID, "cc-race")
	chID := ProjectChannelID("portal")
	if err := fx.tasks.CreateProject(ctx, &model.CodingProject{
		Key: "portal", Name: "Portal", ChannelID: chID,
		Repos: []model.ProjectRepo{{Path: "g/r", Role: model.RepoRoleBackend}},
	}); err != nil {
		t.Fatal(err)
	}
	// A rival task with a LOWER id appears between our scan and our write —
	// modelled by seeding it directly (the scan already ran when Create reads
	// the channel a second time).
	fx.store.afterCreate = func() {
		_ = fx.tasks.CreateTask(ctx, &model.CodingTask{
			ID: "0-rival", ProjectKey: "portal", ProjectName: "Portal", Title: "Rival", Goal: "g",
			Kind: model.TaskKindBug, State: model.TaskStateInProgress, ChannelID: chID,
			ThreadRootID: "card-rival", RequesterID: "u-alice", AgentID: testDevID,
			Repos: []model.TaskRepo{{Path: "g/r", Role: model.RepoRoleBackend}},
		})
		fx.store.afterCreate = nil
	}
	_, err := fx.svc.Create(ctx, run, CreateTaskInput{Project: "Portal", Title: "Mine", Goal: "g"})
	if !errors.Is(err, ErrTaskActive) {
		t.Fatalf("the losing racer must yield: %v", err)
	}
	// It left nothing behind: only the rival is active.
	tasks, err := fx.tasks.ListTasksByChannel(ctx, chID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	active := 0
	for _, tk := range tasks {
		if !tk.State.Terminal() {
			active++
		}
	}
	if active != 1 {
		t.Fatalf("want exactly the rival active, got %d of %d", active, len(tasks))
	}
	// And the card it had already posted says what happened.
	retracted := false
	for _, body := range fx.tmsgs.rewrites {
		if strings.Contains(body, "Another task is already active") {
			retracted = true
		}
	}
	if !retracted {
		t.Fatalf("card not retracted: %+v", fx.tmsgs.rewrites)
	}
}

// The losing racer still yields even when its own row cannot be removed.
func TestCtaskCov_SettleTaskRaceDeleteFailureStillYields(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	mine := fx.seedTask(model.TaskStateInProgress)
	rival := *mine
	rival.ID = "0-older"
	rival.ThreadRootID = "card-older"
	if err := fx.tasks.CreateTask(ctx, &rival); err != nil {
		t.Fatalf("seed rival: %v", err)
	}
	fx.store.deleteTaskErr = errors.New("ctaskCov: delete down")
	err := fx.svc.settleTaskRace(ctx, mine)
	fx.store.deleteTaskErr = nil
	if !errors.Is(err, ErrTaskActive) {
		t.Fatalf("the loser must still yield: %v", err)
	}
}

// A listing blip during the race settle is not a reason to fail a create that
// already passed the pre-write scan.
func TestCtaskCov_SettleTaskRaceListingFailureIsTolerated(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	task := fx.seedTask(model.TaskStateInProgress)
	fx.store.listByChannelErr = errors.New("ctaskCov: list down")
	if err := fx.svc.settleTaskRace(ctx, task); err != nil {
		t.Fatalf("a read blip must not fail the create: %v", err)
	}
	fx.store.listByChannelErr = nil
}

// retractCard is a no-op without a thread root, and a rewrite failure is
// logged rather than fatal.
func TestCtaskCov_RetractCardArms(t *testing.T) {
	fx := newCtaskCovFixture(t)
	ctx := context.Background()
	fx.svc.retractCard(ctx, &model.CodingTask{ID: "t-nocard"}, "note")

	task := fx.seedTask(model.TaskStateInProgress)
	fx.msgs2.rewriteErr = errors.New("ctaskCov: rewrite down")
	fx.svc.retractCard(ctx, task, "note")
	fx.msgs2.rewriteErr = nil
}

// ----------------------------------------------------------- outbound URLs

// The dev relaxation is a package-level switch wired from config at boot.
func TestConnCov_AllowPrivateConnectorTargetsSwitch(t *testing.T) {
	prev := allowPrivateConnectorTargets
	t.Cleanup(func() { allowPrivateConnectorTargets = prev })
	AllowPrivateConnectorTargets(false)
	if err := validateOutboundURL("http://127.0.0.1/x"); err == nil {
		t.Fatal("strict mode should refuse loopback http")
	}
	AllowPrivateConnectorTargets(true)
	if err := validateOutboundURL("http://127.0.0.1/x"); err != nil {
		t.Fatalf("dev mode should allow it: %v", err)
	}
}

// Ingest refuses an over-long slug and any endpoint the server would later
// fetch WITH a user credential attached.
func TestConnCov_IngestRejectsBadTargets(t *testing.T) {
	ctx := context.Background()
	svc := NewConnectorService(newMemConnectorStore())
	prev := allowPrivateConnectorTargets
	allowPrivateConnectorTargets = false
	t.Cleanup(func() { allowPrivateConnectorTargets = prev })

	base := IngestInput{
		Slug: "svc", Title: "T", BaseURL: "https://api.example.com",
		AuthKind: model.ConnectorAuthPaste,
		Files:    []model.ConnectorFile{{Name: "a.yaml", Content: "x"}},
	}
	bad := base
	bad.VerifyURL = "http://10.0.0.1/me"
	if _, err := svc.Ingest(ctx, "admin", bad); !errors.Is(err, ErrConnectorInvalid) ||
		!strings.Contains(err.Error(), "verifyURL") {
		t.Fatalf("private verifyURL should be refused: %v", err)
	}

	backslash := base
	backslash.Files = []model.ConnectorFile{{Name: `dir\file.yaml`, Content: "x"}}
	if _, err := svc.Ingest(ctx, "admin", backslash); !errors.Is(err, ErrConnectorInvalid) ||
		!strings.Contains(err.Error(), "bad file name") {
		t.Fatalf("a backslash path should be refused: %v", err)
	}

	longName := base
	longName.Files = []model.ConnectorFile{{Name: strings.Repeat("n", model.ConnectorFileNameMaxLen+1), Content: "x"}}
	if _, err := svc.Ingest(ctx, "admin", longName); !errors.Is(err, ErrConnectorInvalid) {
		t.Fatalf("an over-long file name should be refused: %v", err)
	}
}

// The fallback catalog emitter follows the provider's rules: id is the only
// required field, so an endpoint without one contributes no row (and no route
// prefix) rather than a malformed line.
func TestConnCov_CatalogSkipsEndpointsWithoutAnID(t *testing.T) {
	ctx := context.Background()
	prev := allowPrivateConnectorTargets
	allowPrivateConnectorTargets = true
	t.Cleanup(func() { allowPrivateConnectorTargets = prev })

	ms := newMemConnectorStore()
	svc := NewConnectorService(ms)
	in := IngestInput{
		Slug: "cat", Title: "T", BaseURL: "https://api.example.com",
		AuthKind: model.ConnectorAuthPaste,
		Files: []model.ConnectorFile{
			{Name: "index.yml", Content: "services:\n  - file: svc.yaml\n    service: svc\n    endpoints: 2\n"},
			{Name: "svc.yaml", Content: "endpoints:\n" +
				"  - method: GET\n    path: /v1/nameless\n    summary: no id\n" +
				"  - id: svc.list\n    method: GET\n    path: /v1/list\n    summary: List\n"},
		},
	}
	c, err := svc.Ingest(ctx, "admin", in)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	files, err := ms.GetConnectorFiles(ctx, "cat")
	if err != nil {
		t.Fatalf("files: %v", err)
	}
	var catalog string
	for _, f := range files {
		if f.Name == "_catalog.tsv" {
			catalog = f.Content
		}
	}
	lines := strings.Split(strings.TrimSpace(catalog), "\n")
	if len(lines) != 1 || !strings.HasPrefix(lines[0], "svc.list\t") {
		t.Fatalf("catalog = %q, want just the identified endpoint", catalog)
	}
	if len(c.Services) != 1 || len(c.Services[0].RoutePrefixes) != 1 || c.Services[0].RoutePrefixes[0] != "svc" {
		t.Fatalf("route prefixes = %+v", c.Services)
	}
}

// InstalledIndex reads the registry ONCE instead of a GetConnector per
// install, and reports a registry failure rather than a partial index.
func TestConnCov_InstalledIndexBatchedRegistryRead(t *testing.T) {
	ctx := context.Background()
	prev := allowPrivateConnectorTargets
	allowPrivateConnectorTargets = true
	t.Cleanup(func() { allowPrivateConnectorTargets = prev })

	ms := newMemConnectorStore()
	svc := NewConnectorService(ms)
	if got, err := svc.InstalledIndex(ctx, "u-none"); err != nil || got != nil {
		t.Fatalf("no installs: %+v %v", got, err)
	}
	seedConnector(t, svc, "svc-a", model.ConnectorAuthPaste, "", "")
	if _, err := svc.Install(ctx, "u-1", "svc-a", InstallInput{Token: "t"}); err != nil {
		t.Fatalf("install: %v", err)
	}
	if err := ms.PutInstall(ctx, &model.ConnectorInstall{UserID: "u-1", ConnectorSlug: "ghost", Token: "t"}); err != nil {
		t.Fatalf("dangling install: %v", err)
	}
	es := newConnCovErrStore()
	if err := es.PutInstall(ctx, &model.ConnectorInstall{UserID: "u-1", ConnectorSlug: "svc-a", Token: "t"}); err != nil {
		t.Fatalf("seed install: %v", err)
	}
	es.listConnectorsErr = errors.New("connCov: registry down")
	if _, err := NewConnectorService(es).InstalledIndex(ctx, "u-1"); !errors.Is(err, es.listConnectorsErr) {
		t.Fatalf("a registry failure must surface: %v", err)
	}

	idx, err := svc.InstalledIndex(ctx, "u-1")
	if err != nil || len(idx) != 1 || idx[0].Slug != "svc-a" {
		t.Fatalf("index = %+v err=%v (dangling install must be skipped)", idx, err)
	}
	if idx[0].AgentUse != model.ConnectorAgentUseAsk {
		t.Fatalf("empty policy should default to ask: %+v", idx[0])
	}
}
