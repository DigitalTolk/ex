package service

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Approval lifecycle: request parks the state on ⛔, the invoker's decision
// settles it exactly once, and the display unblocks.
func TestOrchestrator_ApprovalDecidedByInvoker(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	a, err := fx.orch.RequestApproval(context.Background(), run, "delete 3 stale branches", "low", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if fx.msgs.lastReaction() != StateEmojiBlocked {
		t.Fatalf("expected ⛔ while pending, got %q", fx.msgs.lastReaction())
	}

	// A bystander may not decide.
	if _, err := fx.orch.DecideApproval(context.Background(), "u-bob", run.ID, a.ID, true, "", ""); !errors.Is(err, ErrNotInvoker) {
		t.Fatalf("bystander decision: want ErrNotInvoker, got %v", err)
	}

	decided, err := fx.orch.DecideApproval(context.Background(), "u-alice", run.ID, a.ID, true, "", "")
	if err != nil {
		t.Fatalf("decide: %v", err)
	}
	if decided.State != model.ApprovalApproved || decided.DecidedBy != "u-alice" {
		t.Fatalf("bad decision record: %+v", decided)
	}
	if fx.msgs.lastReaction() != StateEmojiWorking {
		t.Fatalf("expected ⚙️ after decision, got %q", fx.msgs.lastReaction())
	}
	// Exactly once.
	if _, err := fx.orch.DecideApproval(context.Background(), "u-alice", run.ID, a.ID, false, "", ""); !errors.Is(err, ErrApprovalSettled) {
		t.Fatalf("second decision: want ErrApprovalSettled, got %v", err)
	}
	// The poll sees the verdict.
	got, err := fx.orch.ApprovalStatus(context.Background(), run.ID, a.ID)
	if err != nil || got.State != model.ApprovalApproved {
		t.Fatalf("status after decide: %+v, %v", got, err)
	}
}

// An undecided approval expires at its deadline — discovered lazily by the
// poll, resolving as denied{approval_timeout} inside the tool call.
func TestOrchestrator_ApprovalExpiresAtDeadline(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	a, err := fx.orch.RequestApproval(context.Background(), run, "post to #announcements", "", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	*fx.now = fx.now.Add(approvalMaxWait + time.Minute)
	got, err := fx.orch.ApprovalStatus(context.Background(), run.ID, a.ID)
	if err != nil {
		t.Fatalf("status: %v", err)
	}
	if got.State != model.ApprovalExpired {
		t.Fatalf("state = %q, want expired", got.State)
	}
	// A late decision loses cleanly.
	if _, err := fx.orch.DecideApproval(context.Background(), "u-alice", run.ID, a.ID, true, "", ""); !errors.Is(err, ErrApprovalSettled) {
		t.Fatalf("late decision: want ErrApprovalSettled, got %v", err)
	}
}

// The approval deadline is capped inside the run's own deadline, so the
// harness's MCP timeout never fires first (plan-v2 §7).
func TestOrchestrator_ApprovalDeadlineCappedByRun(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	a, err := fx.orch.RequestApproval(context.Background(), run, "risky thing", "high", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if latest := run.Deadline.Add(-10 * time.Second); a.Deadline.After(latest) {
		t.Fatalf("approval deadline %v exceeds run cap %v", a.Deadline, latest)
	}
}

// ask_user (multiple-choice gate): the invoker must pick one of the offered
// options; the pick lands in Choice; a non-option pick is rejected.
func TestOrchestrator_ChoiceApproval(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	// A single option is not a choice.
	if _, err := fx.orch.RequestApproval(context.Background(), run, "pick one", "", []string{"only"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("single option accepted: %v", err)
	}
	a, err := fx.orch.RequestApproval(context.Background(), run, "which backend?", "", []string{"claude", "codex"})
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	// A pick outside the options is rejected and the approval stays pending.
	if _, err := fx.orch.DecideApproval(context.Background(), "u-alice", run.ID, a.ID, true, "gemini", ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("off-menu choice accepted: %v", err)
	}
	decided, err := fx.orch.DecideApproval(context.Background(), "u-alice", run.ID, a.ID, true, "codex", "")
	if err != nil {
		t.Fatalf("decide: %v", err)
	}
	if decided.Choice != "codex" || decided.State != model.ApprovalApproved {
		t.Fatalf("bad decision: %+v", decided)
	}
	got, _ := fx.orch.ApprovalStatus(context.Background(), run.ID, a.ID)
	if got.Choice != "codex" {
		t.Fatalf("choice not persisted: %+v", got)
	}
}

// StopThread cancels every live run in the conversation and drops queued
// handoffs — and deliberately does NOT start deferred turns.
func TestOrchestrator_StopThreadCancelsConversation(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	// A deferred handoff is queued for this thread.
	key := "chan1#m1#" + testQibID
	fx.orch.deferredTurns.Store(key, &deferredTurn{agentID: testQibID, invokerID: "u-alice",
		msg: &model.Message{ID: "mx", ParentID: "chan1", ParentMessageID: "m1"}, parentType: ParentChannel, round: 1})

	stopped, err := fx.orch.StopThread(context.Background(), "u-alice", run.ID)
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if stopped != 1 {
		t.Fatalf("stopped = %d, want 1", stopped)
	}
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateCanceled || got.FailReason != "stopped_by_user" {
		t.Fatalf("run not canceled: %+v", got)
	}
	if _, still := fx.orch.deferredTurns.Load(key); still {
		t.Fatal("deferred handoff survived the stop")
	}
	// Nothing new queued — the conversation is over.
	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 0 {
		t.Fatalf("stop started new work: %v", ids)
	}
	// Runner events against the canceled run are rejected with abort.
	abort, reason, _ := fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{{Seq: 1, Type: "turn"}})
	if !abort || reason != "run_closed" {
		t.Fatalf("canceled run still accepts events: abort=%v reason=%q", abort, reason)
	}
}

// An approval is PRIVATE to the invoker: it posts NO in-thread notice (chat
// is visible to everyone), and only the invoker may decide it.
func TestOrchestrator_ApprovalIsInvokerPrivate(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	a, err := fx.orch.RequestApproval(context.Background(), run, "publish the summary", "low", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	// No public notice — nothing about the gate leaks into the channel.
	if fx.msgs.lastPost() != "" {
		t.Fatalf("approval leaked into chat: %q", fx.msgs.lastPost())
	}

	// A non-invoker cannot decide.
	if _, err := fx.orch.DecideApproval(context.Background(), "u-bob", run.ID, a.ID, true, "", ""); err == nil {
		t.Fatal("a bystander decided an approval that wasn't theirs")
	}
	got, _ := fx.orch.ApprovalStatus(context.Background(), run.ID, a.ID)
	if got.State != model.ApprovalPending {
		t.Fatalf("gate moved off pending after a rejected decide: %s", got.State)
	}

	// The invoker can.
	if _, err := fx.orch.DecideApproval(context.Background(), "u-alice", run.ID, a.ID, true, "", ""); err != nil {
		t.Fatalf("invoker decide: %v", err)
	}
	got, _ = fx.orch.ApprovalStatus(context.Background(), run.ID, a.ID)
	if got.State != model.ApprovalApproved {
		t.Fatalf("invoker approve didn't stick: %s", got.State)
	}
}

// A chain handoff deferred while the target is busy must not be clobbered by
// a later handoff from a DIFFERENT invoker — first wins (the deferred run
// re-reads the thread and sees later mentions anyway).
func TestOrchestrator_DeferredTurnFirstWins(t *testing.T) {
	fx := newOrchFixture(t)
	fx.users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	_ = fx.dir.PutRunner(context.Background(), &model.RunnerRegistration{
		RunnerID: "rb", OwnerID: "u-bob",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessClaude}},
		LeaseExpiresAt: time.Now().Add(time.Hour),
	})

	// qib is mid-turn in this thread.
	key := "chan1#m1#" + testQibID
	fx.orch.threadActive.Store(key, "qib-active-run")

	// Alice's chain hands to qib first; Bob's arrives second.
	mk := func(runID, invokerID string) *model.Run {
		return &model.Run{ID: runID, AgentID: testGGID, InvokerID: invokerID,
			ParentID: "chan1", ParentType: ParentChannel, ThreadRootID: "m1", MessageID: "m1",
			Limits: model.DefaultAgentLimits()}
	}
	post := &model.Message{ID: "mx", ParentID: "chan1", ParentMessageID: "m1", AuthorID: testGGID,
		Body: "@[" + testQibID + "|qib] your take?"}
	fx.orch.ChainFromAgentPost(context.Background(), mk("run-alice", "u-alice"), post)
	fx.orch.ChainFromAgentPost(context.Background(), mk("run-bob", "u-bob"), post)

	d, ok := fx.orch.deferredTurns.Load(key)
	if !ok {
		t.Fatal("no deferred turn queued")
	}
	if d.(*deferredTurn).invokerID != "u-alice" {
		t.Fatalf("first handoff clobbered: deferred invoker = %s", d.(*deferredTurn).invokerID)
	}
}

// Long threads compress: older lines clip to a headline, the newest window
// stays verbatim.
func TestOrchestrator_BundleCompressesOldThreadLines(t *testing.T) {
	fx := newOrchFixture(t)
	long := strings.Repeat("argument ", 60) // ~540 chars
	for i := 0; i < 20; i++ {
		fx.msgs.thread = append(fx.msgs.thread, &model.Message{
			ID: fmt.Sprintf("t%02d", i), AuthorID: "u-alice", Body: long, CreatedAt: *fx.now,
		})
	}
	// A THREADED run: the full thread window (and its clipping) only applies
	// inside a real thread — top-level mentions get a small background window.
	startPickRun(t, fx, &model.Message{
		ID: "m1", ParentID: "chan1", ParentMessageID: "t00", AuthorID: "u-alice",
		Body: "@[" + testGGID + "|gg] summarize",
	})
	a := fx.claim(t)

	lines := strings.Split(a.ContextBundle, "\n")
	var threadLines []string
	inThread := false
	for _, l := range lines {
		if strings.HasPrefix(l, "# Thread") {
			inThread = true
			continue
		}
		if inThread && strings.HasPrefix(l, "[m:t") {
			threadLines = append(threadLines, l)
		}
	}
	if len(threadLines) < 15 {
		t.Fatalf("expected the long thread in the bundle, got %d lines", len(threadLines))
	}
	first, last := threadLines[0], threadLines[len(threadLines)-1]
	if len(first) > bundleClippedLineLen+10 {
		t.Fatalf("old line not clipped: %d chars", len(first))
	}
	if len(last) < 400 {
		t.Fatalf("newest line should be verbatim, got %d chars", len(last))
	}
}

// Artifacts: size and count caps hold; the timeline records each publish.
func TestOrchestrator_ArtifactCaps(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	if _, err := fx.orch.PublishArtifact(context.Background(), run, "markdown", "too big", strings.Repeat("x", model.ArtifactMaxBytes+1)); !errors.Is(err, ErrValidation) {
		t.Fatalf("oversize: want ErrValidation, got %v", err)
	}
	for i := 0; i < model.ArtifactsPerRun; i++ {
		if _, err := fx.orch.PublishArtifact(context.Background(), run, "markdown", "doc", "content"); err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
	}
	if _, err := fx.orch.PublishArtifact(context.Background(), run, "markdown", "one too many", "content"); !errors.Is(err, ErrArtifactCap) {
		t.Fatalf("cap: want ErrArtifactCap, got %v", err)
	}
	arts, _ := fx.orch.Artifacts(context.Background(), run.ID)
	if len(arts) != model.ArtifactsPerRun {
		t.Fatalf("artifact count = %d", len(arts))
	}
}

// Offline + offlinePolicy=queue: the run queues with an extended deadline
// and a ⏳ notice instead of failing fast; claiming tightens the deadline
// back to the wall-clock limit.
func TestOrchestrator_OfflineQueuePolicy(t *testing.T) {
	fx := newOrchFixture(t)
	// Take alice's runner offline.
	fx.dir.runners = map[string][]*model.RunnerRegistration{}
	if _, err := fx.orch.agentSvc.UpdatePrefs(context.Background(), "u-alice", AgentSlugGG, AgentPrefsPatch{OfflinePolicy: ptr(model.OfflinePolicyQueue)}); err != nil {
		t.Fatalf("prefs: %v", err)
	}

	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] later please"}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)

	if !strings.Contains(fx.msgs.lastPost(), "queued") {
		t.Fatalf("expected ⏳ queue notice, got %q", fx.msgs.lastPost())
	}
	if fx.msgs.lastReaction() != StateEmojiQueued {
		t.Fatalf("expected ⏳ reaction, got %q", fx.msgs.lastReaction())
	}
	// The run exists, queued, with the extended deadline.
	runs, _ := fx.runs.ListActiveRuns(context.Background())
	if len(runs) != 1 || runs[0].State != model.RunStateQueued {
		t.Fatalf("expected one queued run, got %+v", runs)
	}
	if !runs[0].Deadline.After(fx.now.Add(30 * time.Minute)) {
		t.Fatalf("queued deadline not extended: %v", runs[0].Deadline)
	}

	// Runner comes online and claims → the deadline re-bases to claim time +
	// the mode's wall-clock budget (task cap for this direct mention).
	_ = fx.dir.PutRunner(context.Background(), &model.RunnerRegistration{
		RunnerID: "r1", OwnerID: "u-alice",
		Harnesses:      []model.RunnerHarness{{Name: model.HarnessClaude}},
		LeaseExpiresAt: time.Now().Add(time.Hour),
	})
	a := fx.claim(t)
	claimed, _ := fx.runs.GetRun(context.Background(), a.RunID)
	maxDL := fx.now.Add(claimed.Limits.WallClockFor(claimed.Mode) + time.Second)
	if claimed.Deadline.After(maxDL) {
		t.Fatalf("claimed deadline not re-based: %v > %v", claimed.Deadline, maxDL)
	}
}

// Without the queue policy, offline still fails fast (the default).
func TestOrchestrator_OfflineDefaultStillRejects(t *testing.T) {
	fx := newOrchFixture(t)
	fx.dir.runners = map[string][]*model.RunnerRegistration{}
	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "@[" + testGGID + "|gg] hello"}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)
	if !strings.Contains(fx.msgs.lastPost(), "⛔") {
		t.Fatalf("expected fast-fail notice, got %q", fx.msgs.lastPost())
	}
}

func ptr[T any](v T) *T { return &v }
