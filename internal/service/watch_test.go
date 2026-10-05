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

// A subscription invokes the agent on a matching un-mentioned message — as
// the CREATOR (their machine/quota), in watch mode. Non-matching messages
// and messages that already mentioned the agent don't double-invoke.
// watchAllSubs is the single subscription listing the reconciler tick reads
// and hands to both sweeps.
func watchAllSubs(t *testing.T, fx *orchFixture) []*model.AgentSubscription {
	t.Helper()
	subs, err := fx.dir.ListAllSubscriptions(context.Background())
	if err != nil {
		t.Fatalf("list all subscriptions: %v", err)
	}
	return subs
}

func TestOrchestrator_SubscriptionDispatch(t *testing.T) {
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "sub1", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, Keywords: []string{"deploy"},
	})

	// Non-matching message: nothing starts.
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "w1", ParentID: "chan1", AuthorID: "u-alice", Body: "lunch anyone?",
	}, ParentChannel)
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatalf("non-matching message started runs: %v", ids)
	}

	// Matching message: one watch run for the creator.
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "w2", ParentID: "chan1", AuthorID: "u-alice", Body: "the deploy failed again",
	}, ParentChannel)
	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("expected 1 watch run, got %d", len(ids))
	}
	run, _ := fx.runs.GetRun(context.Background(), ids[0])
	if run.Mode != model.RunModeWatch || run.AgentID != testGGID || run.InvokerID != "u-alice" {
		t.Fatalf("bad watch run: %+v", run)
	}

	// A message that MENTIONS the agent gets the direct run only (no watch
	// duplicate) — new thread so the busy dedup doesn't interfere.
	fx.orch.afterTerminal(context.Background(), run) // release slot
	_ = fx.runs.DeleteQueueEntry(context.Background(), "u-alice", run.ID)
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "w3", ParentID: "chan1", AuthorID: "u-alice",
		Body: "@[" + testGGID + "|gg] deploy status?",
	}, ParentChannel)
	ids, _ = fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	direct := 0
	for _, id := range ids {
		r, _ := fx.runs.GetRun(context.Background(), id)
		if r.MessageID == "w3" {
			direct++
			if r.Mode != model.RunModeDirect {
				t.Fatalf("mentioned agent should run direct, got %s", r.Mode)
			}
		}
	}
	if direct != 1 {
		t.Fatalf("expected exactly 1 run for the mention message, got %d", direct)
	}
}

// A thread-scoped watcher fires ONLY for messages in its thread, and carries
// the creator's standing order + action mode onto the run it triggers.
func TestOrchestrator_ThreadWatcherCarriesStandingOrder(t *testing.T) {
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "subT", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		ThreadRootID: "root1", Instruction: "DM me if the budget comes up",
		ActionMode: model.WatchActionNotify, Keywords: []string{"budget"},
	})
	queued := func() []string { ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); return ids }

	// Matching keyword but a DIFFERENT thread → no fire.
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "t1", ParentID: "chan1", ParentMessageID: "other", AuthorID: "u-alice", Body: "budget stuff",
	}, ParentChannel)
	if len(queued()) != 0 {
		t.Fatal("thread watcher fired for another thread")
	}

	// Top-level message (not in any thread) → no fire.
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "t2", ParentID: "chan1", AuthorID: "u-alice", Body: "budget top-level",
	}, ParentChannel)
	if len(queued()) != 0 {
		t.Fatal("thread watcher fired for a top-level message")
	}

	// A matching message IN the thread → one watch run carrying the order+mode.
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "t3", ParentID: "chan1", ParentMessageID: "root1", AuthorID: "u-alice", Body: "the budget is tight",
	}, ParentChannel)
	ids := queued()
	if len(ids) != 1 {
		t.Fatalf("expected 1 thread-watch run, got %d", len(ids))
	}
	run, _ := fx.runs.GetRun(context.Background(), ids[0])
	if run.Mode != model.RunModeWatch || run.WatchInstruction != "DM me if the budget comes up" || run.ActionMode != model.WatchActionNotify {
		t.Fatalf("standing order not on run: mode=%s instr=%q action=%q", run.Mode, run.WatchInstruction, run.ActionMode)
	}
}

// A notify-mode watcher must NEVER post publicly — not even via CompleteRun's
// finalText fallback, which bypasses the tool-level notify_only gate.
func TestOrchestrator_NotifyWatcherNoPublicFallback(t *testing.T) {
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "subN", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		ThreadRootID: "r1", ActionMode: model.WatchActionNotify,
	})
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "n1", ParentID: "chan1", ParentMessageID: "r1", AuthorID: "u-alice", Body: "anything",
	}, ParentChannel)
	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("expected 1 notify-watch run, got %d", len(ids))
	}
	as := fx.claim(t) // claims the run, runnerID "r1"
	postsBefore := len(fx.msgs.posts)
	if err := fx.orch.CompleteRun(context.Background(), "u-alice", "r1", as.RunID, "here is a public summary", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if len(fx.msgs.posts) != postsBefore {
		t.Fatalf("notify watcher leaked a public post on completion: %v", fx.msgs.posts[postsBefore:])
	}
}

// fakeOwnerDM is a stand-in for the conversation service's GetOrCreateDM.
type fakeOwnerDM struct {
	convID     string
	gotA, gotB string
}

func (f *fakeOwnerDM) GetOrCreateDM(_ context.Context, userA, userB string) (*model.Conversation, error) {
	f.gotA, f.gotB = userA, userB
	return &model.Conversation{ID: f.convID}, nil
}

// A notify-mode watcher that finishes with final text but never called
// notify_owner must still reach its creator: the completion fallback is
// REDIRECTED into the creator↔agent DM, not dropped. (Regression: V/codex left
// the TLDR as plain text and the creator got nothing.)
func TestOrchestrator_NotifyWatcherPrivateFallback(t *testing.T) {
	fx := newOrchFixture(t)
	dm := &fakeOwnerDM{convID: "dm-alice-gg"}
	fx.orch.SetOwnerDMResolver(dm)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "subN2", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		ThreadRootID: "r1", ActionMode: model.WatchActionNotify,
	})
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "n2", ParentID: "chan1", ParentMessageID: "r1", AuthorID: "u-alice", Body: "anything",
	}, ParentChannel)
	as := fx.claim(t)

	if err := fx.orch.CompleteRun(context.Background(), "u-alice", "r1", as.RunID, "here is a private tldr", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	// Exactly one post, and it landed in the DM — never in the watched channel.
	if len(fx.msgs.posts) != 1 || fx.msgs.posts[0] != "here is a private tldr" {
		t.Fatalf("expected the tldr delivered once, got %v", fx.msgs.posts)
	}
	if fx.msgs.postDest[0] != ParentConversation+"|dm-alice-gg" {
		t.Fatalf("tldr should land in the owner DM, went to %q", fx.msgs.postDest[0])
	}
	if dm.gotA != "u-alice" || dm.gotB != testGGID {
		t.Fatalf("DM opened between wrong parties: %s / %s", dm.gotA, dm.gotB)
	}
}

// A notify watcher whose final answer is the SKIP sentinel delivers NOTHING —
// the model's relevance call is honored, but routing stays deterministic.
func TestOrchestrator_NotifyWatcherSkipDeliversNothing(t *testing.T) {
	fx := newOrchFixture(t)
	dm := &fakeOwnerDM{convID: "dm-alice-gg"}
	fx.orch.SetOwnerDMResolver(dm)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "subSkip", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		ThreadRootID: "r1", ActionMode: model.WatchActionNotify,
	})
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "nk", ParentID: "chan1", ParentMessageID: "r1", AuthorID: "u-alice", Body: "off-topic",
	}, ParentChannel)
	as := fx.claim(t)
	if err := fx.orch.CompleteRun(context.Background(), "u-alice", "r1", as.RunID, "SKIP", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if len(fx.msgs.posts) != 0 {
		t.Fatalf("SKIP must deliver nothing, got %v", fx.msgs.posts)
	}
	if dm.gotA != "" {
		t.Fatalf("SKIP must not even open a DM, opened for %s", dm.gotA)
	}
}

// A reply-mode watcher never posts during the run (no tools). Its final text is
// deterministically wrapped as an editable draft-for-approval; approving it
// posts to the watched thread. No dependence on the agent calling propose_reply.
func TestOrchestrator_ReplyWatcherDeterministicDraft(t *testing.T) {
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "subRD", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		ThreadRootID: "r1", ActionMode: model.WatchActionReply,
	})
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "rd1", ParentID: "chan1", ParentMessageID: "r1", AuthorID: "u-alice", Body: "a question",
	}, ParentChannel)
	as := fx.claim(t)

	before := len(fx.msgs.posts)
	if err := fx.orch.CompleteRun(context.Background(), "u-alice", "r1", as.RunID, "Here is my reply.", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	// Nothing posted yet — it's a pending draft.
	if len(fx.msgs.posts) != before {
		t.Fatalf("reply watcher posted before approval: %v", fx.msgs.posts[before:])
	}
	// A pending reply proposal was created carrying the agent's text.
	aps, _ := fx.runs.ListApprovals(context.Background(), as.RunID)
	var draft *model.Approval
	for _, a := range aps {
		if a.ReplyText != "" {
			draft = a
		}
	}
	if draft == nil || draft.ReplyText != "Here is my reply." || draft.State != model.ApprovalPending {
		t.Fatalf("expected a pending reply draft, got %+v", draft)
	}
	// Approving posts the (unedited) reply to the thread.
	if _, err := fx.orch.DecideApproval(context.Background(), "u-alice", as.RunID, draft.ID, Decision{Approve: true}); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if len(fx.msgs.posts) != before+1 || fx.msgs.posts[before] != "Here is my reply." {
		t.Fatalf("approval should post the draft, got %v", fx.msgs.posts[before:])
	}
}

// A reply-mode watcher may NOT post publicly (even via the completion fallback)
// until an approval is granted — the hard server-side gate, not just the prompt.
func TestOrchestrator_ReplyWatcherNeedsApproval(t *testing.T) {
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "subR", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		ThreadRootID: "r1", ActionMode: model.WatchActionReply,
	})
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "rr1", ParentID: "chan1", ParentMessageID: "r1", AuthorID: "u-alice", Body: "a question",
	}, ParentChannel)
	as := fx.claim(t)

	// Complete with final text but NO approval → suppressed (no public post).
	before := len(fx.msgs.posts)
	if err := fx.orch.CompleteRun(context.Background(), "u-alice", "r1", as.RunID, "a public answer", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if len(fx.msgs.posts) != before {
		t.Fatalf("reply watcher posted publicly without approval: %v", fx.msgs.posts[before:])
	}

	// HasDeliberateApproval flips once an approval is granted.
	ok, _ := fx.orch.HasDeliberateApproval(context.Background(), as.RunID)
	if ok {
		t.Fatal("no approval should exist yet")
	}
	_ = fx.runs.PutApproval(context.Background(), &model.Approval{
		ID: "ap1", RunID: as.RunID, InvokerID: "u-alice", State: model.ApprovalApproved,
	})
	if ok, _ := fx.orch.HasDeliberateApproval(context.Background(), as.RunID); !ok {
		t.Fatal("HasDeliberateApproval should be true after an approval is granted")
	}
}

// propose_reply: the agent drafts a reply → editable approval → on approve the
// SERVER posts the (edited) text; on deny nothing is posted.
func TestOrchestrator_ProposeReplyEditAndPost(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)

	a, err := fx.orch.ProposeReply(context.Background(), run, "Original draft.", "", "")
	if err != nil {
		t.Fatalf("propose: %v", err)
	}
	if a.ReplyText != "Original draft." || a.State != model.ApprovalPending {
		t.Fatalf("bad proposal: %+v", a)
	}

	// Deny → nothing posted.
	before := len(fx.msgs.posts)
	deny, _ := fx.orch.DecideApproval(context.Background(), run.InvokerID, run.ID, a.ID, Decision{})
	if deny.State != model.ApprovalDenied || len(fx.msgs.posts) != before {
		t.Fatalf("deny should post nothing: state=%s posts=%d", deny.State, len(fx.msgs.posts))
	}

	// A second proposal, approved WITH an edit → the edited text is posted.
	a2, _ := fx.orch.ProposeReply(context.Background(), run, "Original draft.", "", "")
	before = len(fx.msgs.posts)
	if _, err := fx.orch.DecideApproval(context.Background(), run.InvokerID, run.ID, a2.ID, Decision{Approve: true, Text: "My edited reply."}); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if len(fx.msgs.posts) != before+1 || fx.msgs.posts[before] != "My edited reply." {
		t.Fatalf("approve should post the edit, got %v", fx.msgs.posts[before:])
	}
}

type fakeNotifier struct{ got []Notification }

func (f *fakeNotifier) NotifyDirect(_ context.Context, _ string, n Notification) {
	f.got = append(f.got, n)
}

// A freshly-requested approval fires a distinct "approval" alert to the invoker
// (desktop + mobile), on top of the live card. Settle updates don't re-alert.
func TestOrchestrator_ApprovalNotification(t *testing.T) {
	fx := newOrchFixture(t)
	fn := &fakeNotifier{}
	fx.orch.SetApprovalNotifier(fn)
	run := fx.startRun(t)

	pending := &model.Approval{ID: "a1", RunID: run.ID, InvokerID: run.InvokerID, Summary: "post this reply?", State: model.ApprovalPending}
	fx.orch.publishApproval(context.Background(), run, pending)
	if len(fn.got) != 1 {
		t.Fatalf("expected 1 approval alert, got %d", len(fn.got))
	}
	if fn.got[0].Kind != NotificationKindApproval || !strings.Contains(fn.got[0].Title, "approval") || fn.got[0].Body != "post this reply?" {
		t.Fatalf("bad approval notification: %+v", fn.got[0])
	}

	// A settle update (approved/denied) must NOT fire another alert.
	settled := *pending
	settled.State = model.ApprovalApproved
	fx.orch.publishApproval(context.Background(), run, &settled)
	if len(fn.got) != 1 {
		t.Fatalf("settle re-alerted: got %d", len(fn.got))
	}
}

// A watcher with no explicit action mode defaults to the safest tier (notify),
// which the model marks as private-only.
func TestWatchActionModeDefaults(t *testing.T) {
	if !model.ValidWatchActionMode(model.WatchActionReply) || model.ValidWatchActionMode("bogus") {
		t.Fatal("ValidWatchActionMode wrong")
	}
	if !model.WatchModePostsPrivately(model.WatchActionNotify) || !model.WatchModePostsPrivately(model.WatchActionDraft) {
		t.Fatal("notify/draft must be private-only")
	}
	if model.WatchModePostsPrivately(model.WatchActionReply) || model.WatchModePostsPrivately(model.WatchActionAutonomous) {
		t.Fatal("reply/autonomous must be allowed to post")
	}
	sub := &model.AgentSubscription{} // no ActionMode set
	if watchSpecFromSub(sub).ActionMode != model.WatchActionNotify {
		t.Fatal("empty action mode must default to notify")
	}
}

// Heartbeat subscriptions start periodic check-in runs; LastRunAt advances
// so the next sweep inside the interval is a no-op.
func TestOrchestrator_HeartbeatSweep(t *testing.T) {
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "sub-h", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, HeartbeatMins: 30,
	})

	fx.orch.sweepHeartbeats(context.Background(), watchAllSubs(t, fx))
	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("expected 1 heartbeat run, got %d", len(ids))
	}
	run, _ := fx.runs.GetRun(context.Background(), ids[0])
	if run.Mode != model.RunModeHeartbeat || run.MessageID != "" {
		t.Fatalf("bad heartbeat run: mode=%s msgID=%q", run.Mode, run.MessageID)
	}
	if !strings.Contains(run.Prompt, "check-in") {
		t.Fatalf("heartbeat prompt missing: %q", run.Prompt)
	}

	// Within the interval: no second run even after the first terminates.
	fx.orch.afterTerminal(context.Background(), run)
	_ = fx.runs.DeleteQueueEntry(context.Background(), "u-alice", run.ID)
	run.State = model.RunStateCompleted
	fx.runs.runs[run.ID] = run
	*fx.now = fx.now.Add(5 * time.Minute)
	fx.orch.sweepHeartbeats(context.Background(), watchAllSubs(t, fx))
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatalf("heartbeat re-fired inside its interval: %v", ids)
	}

	// Past the interval: fires again.
	*fx.now = fx.now.Add(31 * time.Minute)
	fx.orch.sweepHeartbeats(context.Background(), watchAllSubs(t, fx))
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 1 {
		t.Fatalf("heartbeat did not re-fire after interval: %v", ids)
	}
}

// Wall-clock budgets are mode-aware: direct mentions (real work — coding,
// research) get the long task cap; ambient conversation runs (watch etc.)
// keep the short cap so a stuck reply dies fast. Zero-valued snapshots
// (pre-task-cap runs) fall back to platform defaults.
func TestAgentLimits_WallClockByMode(t *testing.T) {
	l := model.DefaultAgentLimits()
	if l.WallClockFor(model.RunModeDirect) != time.Duration(l.MaxTaskWallClockSec)*time.Second {
		t.Fatalf("direct should get the task cap, got %v", l.WallClockFor(model.RunModeDirect))
	}
	for _, mode := range []string{model.RunModeWatch, model.RunModeHeartbeat, model.RunModeFollowUp} {
		if l.WallClockFor(mode) != time.Duration(l.MaxWallClockSec)*time.Second {
			t.Fatalf("%s should get the conversation cap, got %v", mode, l.WallClockFor(mode))
		}
	}
	var zero model.AgentLimits // old run snapshot without the field
	if zero.WallClockFor(model.RunModeDirect) != time.Duration(model.DefaultAgentLimits().MaxTaskWallClockSec)*time.Second {
		t.Fatal("zero limits must fall back to the default task cap")
	}
	if l.TurnsFor(model.RunModeDirect) != l.MaxTaskTurns || l.TurnsFor(model.RunModeWatch) != l.MaxTurns {
		t.Fatal("turn budget must be mode-aware")
	}
}

// Every run starts on the short conversation window; harness ACTIVITY extends
// the rolling deadline (never past the mode's hard ceiling), silence lets it
// expire. So "@gg what's 2+2" that wedges dies in minutes even though it's a
// direct run, while a coding task that keeps producing events lives on.
func TestOrchestrator_RollingDeadlineExtendsWithActivity(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	claimed, _ := fx.runs.GetRun(context.Background(), run.ID)
	convWin := time.Duration(claimed.Limits.MaxWallClockSec) * time.Second
	if got := claimed.Deadline.Sub(*fx.now); got != convWin {
		t.Fatalf("claimed rolling deadline = %v, want conversation window %v", got, convWin)
	}
	if got := claimed.HardDeadline.Sub(*fx.now); got != claimed.Limits.WallClockFor(claimed.Mode) {
		t.Fatalf("hard ceiling = %v, want task cap %v", got, claimed.Limits.WallClockFor(claimed.Mode))
	}

	// Activity at T+4min (inside the window) extends the deadline well past
	// the original conversation cap.
	*fx.now = fx.now.Add(4 * time.Minute)
	abort, reason, err := fx.orch.ReportEvents(context.Background(), "u-alice", "r1", run.ID, []RunEventInput{{Seq: 1, Type: "turn"}})
	if err != nil || abort {
		t.Fatalf("active run aborted: %v %q %v", abort, reason, err)
	}
	extended, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got := extended.Deadline.Sub(*fx.now); got != taskIdleWindow {
		t.Fatalf("deadline not extended by idle window: %v, want %v", got, taskIdleWindow)
	}

	// Silence past the idle window → next report aborts on deadline.
	*fx.now = fx.now.Add(taskIdleWindow + time.Minute)
	abort, reason, _ = fx.orch.ReportEvents(context.Background(), "u-alice", "r1", run.ID, []RunEventInput{{Seq: 2, Type: "turn"}})
	if !abort || reason != "deadline" {
		t.Fatalf("idle run should die on deadline, got abort=%v reason=%q", abort, reason)
	}
}

// Extensions can never pass the hard ceiling: an eternally-busy run still dies
// at the task cap.
func TestOrchestrator_RollingDeadlineCappedAtHardCeiling(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t)

	// Keep reporting activity every 10 minutes — extensions keep it alive
	// until the clamped deadline (= the hard ceiling) passes, at which point a
	// report must abort with "deadline" despite constant activity.
	seq := int64(1)
	var abortReason string
	cap := run.Limits.WallClockFor(run.Mode)
	for elapsed := time.Duration(0); elapsed < cap+30*time.Minute; elapsed += 10 * time.Minute {
		*fx.now = fx.now.Add(10 * time.Minute)
		seq++
		abort, reason, _ := fx.orch.ReportEvents(context.Background(), "u-alice", "r1", run.ID, []RunEventInput{{Seq: seq, Type: "turn"}})
		if abort {
			abortReason = reason
			break
		}
	}
	if abortReason != "deadline" {
		t.Fatalf("busy run must still die at the hard ceiling with reason deadline, got %q", abortReason)
	}
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.State != model.RunStateFailed {
		t.Fatalf("ceiling-hit run should be failed, is %s", got.State)
	}
}

// Missed watch triggers COALESCE instead of piling up or vanishing: messages
// arriving while the creator is offline set one pending flag (no runs, no
// queue spam), and the reconcile sweep starts exactly ONE catch-up run when
// the runner returns.
func TestOrchestrator_WatchOfflineCoalesces(t *testing.T) {
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "subOff", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		ThreadRootID: "r1", ActionMode: model.WatchActionNotify,
		Instruction: "tldr me",
	})
	savedRunners := fx.dir.runners
	fx.dir.runners = map[string][]*model.RunnerRegistration{} // creator offline

	// A burst of messages while offline: zero runs, one pending flag.
	for i, id := range []string{"om1", "om2", "om3"} {
		fx.orch.OnMessage(context.Background(), &model.Message{
			ID: id, ParentID: "chan1", ParentMessageID: "r1", AuthorID: "u-alice", Body: "update " + string(rune('a'+i)),
		}, ParentChannel)
	}
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatalf("offline watch triggers must not queue runs, got %d", len(ids))
	}
	subs, _ := fx.dir.ListSubscriptionsByParent(context.Background(), "chan1")
	if len(subs) != 1 || !subs[0].PendingCatchUp {
		t.Fatalf("missed triggers should set PendingCatchUp, got %+v", subs[0])
	}

	if !subs[0].PendingOffline {
		t.Fatal("offline misses should set PendingOffline")
	}

	// Sweep while still offline: flag survives, still no runs, NO ask yet
	// (asking while the creator can't act would waste the one notification).
	fn := &fakeNotifier{}
	fx.orch.SetApprovalNotifier(fn)
	fx.orch.sweepWatchCatchUps(context.Background(), watchAllSubs(t, fx))
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatal("catch-up must not start while creator is offline")
	}
	if len(fn.got) != 0 {
		t.Fatal("must not ask while the creator is still offline")
	}

	// Runner returns → CLI harness backlog needs CONSENT: no auto-run, ONE
	// notification, flag survives.
	fx.dir.runners = savedRunners
	fx.orch.sweepWatchCatchUps(context.Background(), watchAllSubs(t, fx))
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatal("CLI offline backlog must not auto-run — it asks first")
	}
	if len(fn.got) != 1 || fn.got[0].Kind != NotificationKindCatchUp {
		t.Fatalf("expected exactly one catch-up ask notification, got %+v", fn.got)
	}
	// Re-sweep: no re-ask (notified stamp).
	fx.orch.sweepWatchCatchUps(context.Background(), watchAllSubs(t, fx))
	if len(fn.got) != 1 {
		t.Fatalf("re-asked on every sweep: %d notifications", len(fn.got))
	}

	// Creator consents → exactly ONE coalesced catch-up run, flags cleared.
	if err := fx.orch.DecideCatchUp(context.Background(), "u-alice", "chan1", "subOff", true); err != nil {
		t.Fatalf("decide process: %v", err)
	}
	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("expected exactly one coalesced catch-up run, got %d", len(ids))
	}
	run, _ := fx.runs.GetRun(context.Background(), ids[0])
	if run.Mode != model.RunModeWatch || !strings.Contains(run.Prompt, "Catch-up") || !strings.Contains(run.Prompt, "one consolidated response") {
		t.Fatalf("bad catch-up run: mode=%s prompt=%q", run.Mode, run.Prompt)
	}
	subs, _ = fx.dir.ListSubscriptionsByParent(context.Background(), "chan1")
	if subs[0].PendingCatchUp || subs[0].PendingOffline || subs[0].CatchUpNotifiedAt != nil {
		t.Fatalf("flags should clear once the catch-up run starts: %+v", subs[0])
	}

	// Idempotent: another sweep/decide starts nothing new.
	fx.orch.sweepWatchCatchUps(context.Background(), watchAllSubs(t, fx))
	_ = fx.orch.DecideCatchUp(context.Background(), "u-alice", "chan1", "subOff", true)
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 1 {
		t.Fatalf("re-fired without new triggers: %d runs", len(ids))
	}
}

// Dismissing a catch-up drops the backlog without running anything; only the
// creator may decide.
func TestOrchestrator_CatchUpDismissAndCreatorGate(t *testing.T) {
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "subD", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		ThreadRootID: "r1", ActionMode: model.WatchActionNotify,
	})
	savedRunners := fx.dir.runners
	fx.dir.runners = map[string][]*model.RunnerRegistration{}
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "dm1", ParentID: "chan1", ParentMessageID: "r1", AuthorID: "u-alice", Body: "missed",
	}, ParentChannel)
	fx.dir.runners = savedRunners

	// A stranger can't decide.
	if err := fx.orch.DecideCatchUp(context.Background(), "u-mallory", "chan1", "subD", true); !errors.Is(err, ErrNotInvoker) {
		t.Fatalf("non-creator decide should be forbidden, got %v", err)
	}
	// Dismiss: no run, flags cleared.
	if err := fx.orch.DecideCatchUp(context.Background(), "u-alice", "chan1", "subD", false); err != nil {
		t.Fatalf("dismiss: %v", err)
	}
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatalf("dismiss must not start runs, got %d", len(ids))
	}
	subs, _ := fx.dir.ListSubscriptionsByParent(context.Background(), "chan1")
	if subs[0].PendingCatchUp || subs[0].PendingOffline {
		t.Fatalf("dismiss should clear the backlog: %+v", subs[0])
	}
}

// Messages arriving while a watch run is already ACTIVE in the thread (agent
// busy) also coalesce — previously they were silently skipped and lost.
func TestOrchestrator_WatchBusyCoalesces(t *testing.T) {
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "subBusy", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		ThreadRootID: "r1", ActionMode: model.WatchActionNotify,
	})
	fx.orch.OnMessage(context.Background(), &model.Message{
		ID: "bm1", ParentID: "chan1", ParentMessageID: "r1", AuthorID: "u-alice", Body: "first",
	}, ParentChannel)
	as := fx.claim(t) // run 1 active in the thread

	// Two more messages land mid-run → busy → coalesced, not lost.
	for _, id := range []string{"bm2", "bm3"} {
		fx.orch.OnMessage(context.Background(), &model.Message{
			ID: id, ParentID: "chan1", ParentMessageID: "r1", AuthorID: "u-alice", Body: "more",
		}, ParentChannel)
	}
	subs, _ := fx.dir.ListSubscriptionsByParent(context.Background(), "chan1")
	if !subs[0].PendingCatchUp {
		t.Fatal("busy-thread triggers should set PendingCatchUp")
	}

	// Sweep while run 1 is still active: blocked, flag survives.
	fx.orch.sweepWatchCatchUps(context.Background(), watchAllSubs(t, fx))
	subs, _ = fx.dir.ListSubscriptionsByParent(context.Background(), "chan1")
	if !subs[0].PendingCatchUp {
		t.Fatal("flag must survive a blocked sweep")
	}

	// Run 1 finishes → next sweep starts the single catch-up run.
	if err := fx.orch.CompleteRun(context.Background(), "u-alice", "r1", as.RunID, "SKIP", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	fx.orch.sweepWatchCatchUps(context.Background(), watchAllSubs(t, fx))
	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("expected one catch-up run after the thread freed, got %d", len(ids))
	}
}

// A watcher's standing order can be edited in place (creator-only), and the
// viewer sees only their own watchers in a parent.
func TestAgentService_UpdateAndListWatchers(t *testing.T) {
	fx := newOrchFixture(t)
	svc := NewAgentService(fx.dir, fx.users)
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "w1", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, ThreadRootID: "r1",
		Instruction: "old order", ActionMode: model.WatchActionNotify,
	})
	_ = fx.dir.PutAgentSubscription(context.Background(), &model.AgentSubscription{
		ID: "w2", AgentID: testGGID, CreatorID: "u-bob",
		ParentID: "chan1", ParentType: ParentChannel, ThreadRootID: "r2",
		Instruction: "bob's", ActionMode: model.WatchActionNotify,
	})

	// Viewer sees only their own.
	mine, err := svc.ListWatchersInParent(context.Background(), "u-alice", "chan1")
	if err != nil || len(mine) != 1 || mine[0].ID != "w1" {
		t.Fatalf("expected only alice's watcher, got %+v (err %v)", mine, err)
	}

	// Edit instruction + mode.
	up, err := svc.UpdateSubscription(context.Background(), "u-alice", "chan1", "w1", WatchInput{Instruction: "new order", ActionMode: model.WatchActionReply})
	if err != nil || up.Instruction != "new order" || up.ActionMode != model.WatchActionReply {
		t.Fatalf("update failed: %+v (err %v)", up, err)
	}

	// Non-creator can't edit; bad mode rejected.
	if _, err := svc.UpdateSubscription(context.Background(), "u-bob", "chan1", "w1", WatchInput{Instruction: "hijack"}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got %v", err)
	}
	if _, err := svc.UpdateSubscription(context.Background(), "u-alice", "chan1", "w1", WatchInput{Instruction: "x", ActionMode: "bogus"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("expected ErrValidation, got %v", err)
	}
}

// Skills reach the model deterministically: ATTACHED skills (template
// SkillIDs) ride the bundle with FULL instructions; every other skill appears
// in a small ambient index (name+description) so the agent can route to
// invoke_skill without spending a turn on list_skills.
func TestOrchestrator_SkillsInBundle(t *testing.T) {
	fx := newOrchFixture(t)
	svc := NewAgentService(fx.dir, fx.users)

	sk1, err := svc.CreateSkill(context.Background(), "u-alice", "Release checklist", "How we ship", "1. tag 2. build 3. announce in #general", model.SkillVisibilityPublished)
	if err != nil {
		t.Fatalf("create skill: %v", err)
	}
	sk2, err := svc.CreateSkill(context.Background(), "u-alice", "Incident triage", "What to do when prod breaks", "page the on-call, open a thread", model.SkillVisibilityPublished)
	if err != nil {
		t.Fatalf("create skill: %v", err)
	}

	// Attach sk1 to gg; validation rejects unknown ids and over-cap lists.
	if _, err := svc.SetAgentSkills(context.Background(), "u-alice", AgentSlugGG, []string{sk1.ID}); err != nil {
		t.Fatalf("set skills: %v", err)
	}
	if _, err := svc.SetAgentSkills(context.Background(), "u-alice", AgentSlugGG, []string{"nope"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("unknown skill id should be rejected, got %v", err)
	}

	fx.startRun(t)
	a := fx.claim(t)

	// Attached: full instructions, in their own section.
	if !strings.Contains(a.ContextBundle, "# Attached skills") ||
		!strings.Contains(a.ContextBundle, "1. tag 2. build 3. announce in #general") {
		t.Fatalf("attached skill instructions missing from bundle:\n%s", a.ContextBundle)
	}
	// Ambient index: sk2's name+description, but NEVER its instructions.
	if !strings.Contains(a.ContextBundle, "# Workspace skills") ||
		!strings.Contains(a.ContextBundle, "[sk:"+sk2.ID+"] Incident triage: What to do when prod breaks") {
		t.Fatalf("ambient skill index missing:\n%s", a.ContextBundle)
	}
	if strings.Contains(a.ContextBundle, "page the on-call") {
		t.Fatal("index must not leak full instructions")
	}
	// The attached skill is not duplicated into the index.
	if strings.Contains(a.ContextBundle, "[sk:"+sk1.ID+"]") {
		t.Fatal("attached skill should not repeat in the ambient index")
	}
}

// The (agent, invoker) core memory is injected into the bundle; another
// invoker's bundle never sees it.
func TestOrchestrator_MemoryInjectedPerInvoker(t *testing.T) {
	fx := newOrchFixture(t)
	svc := NewAgentService(fx.dir, fx.users)
	if err := svc.UpdateMemory(context.Background(), "u-alice", testGGID, "Alice prefers bullet lists."); err != nil {
		t.Fatalf("update memory: %v", err)
	}

	fx.startRun(t)
	a := fx.claim(t)
	if !strings.Contains(a.ContextBundle, "# Your memory") ||
		!strings.Contains(a.ContextBundle, "Alice prefers bullet lists.") {
		t.Fatalf("memory not injected:\n%s", a.ContextBundle)
	}

	// Size cap enforced.
	if err := svc.UpdateMemory(context.Background(), "u-alice", testGGID, strings.Repeat("x", model.AgentMemoryMaxBytes+1)); err == nil {
		t.Fatal("oversized memory accepted")
	}
}

// Per-user curation: a skill the INVOKER hid disappears from their ambient
// index — but hiding is discovery-only, so an explicitly attached skill still
// rides the bundle with full instructions.
func TestOrchestrator_SkillIndexHonorsHiddenSkills(t *testing.T) {
	fx := newOrchFixture(t)
	svc := NewAgentService(fx.dir, fx.users)

	kept, err := svc.CreateSkill(context.Background(), "u-alice", "Release checklist", "How we ship", "1. tag 2. build", model.SkillVisibilityPublished)
	if err != nil {
		t.Fatalf("create kept: %v", err)
	}
	hidden, err := svc.CreateSkill(context.Background(), "u-alice", "Incident triage", "What to do when prod breaks", "page the on-call", model.SkillVisibilityPublished)
	if err != nil {
		t.Fatalf("create hidden: %v", err)
	}
	attachedHidden, err := svc.CreateSkill(context.Background(), "u-alice", "Retro notes", "How retros are written", "three columns, no blame", model.SkillVisibilityPublished)
	if err != nil {
		t.Fatalf("create attached: %v", err)
	}
	if _, err := svc.SetAgentSkills(context.Background(), "u-alice", AgentSlugGG, []string{attachedHidden.ID}); err != nil {
		t.Fatalf("attach: %v", err)
	}

	states := NewUserStateService(newMockUserStateStore(), nil)
	for _, id := range []string{hidden.ID, attachedHidden.ID} {
		if err := states.HideSkill(context.Background(), "u-alice", id); err != nil {
			t.Fatalf("hide: %v", err)
		}
	}
	fx.orch.SetSkillPrefs(states)

	fx.startRun(t)
	a := fx.claim(t)
	if !strings.Contains(a.ContextBundle, "[sk:"+kept.ID+"]") {
		t.Fatalf("kept skill missing from index:\n%s", a.ContextBundle)
	}
	if strings.Contains(a.ContextBundle, "[sk:"+hidden.ID+"]") {
		t.Fatalf("hidden skill leaked into the index:\n%s", a.ContextBundle)
	}
	// Hiding is not permission: the explicit attach still carries instructions.
	if !strings.Contains(a.ContextBundle, "three columns, no blame") {
		t.Fatalf("attached-but-hidden skill lost its instructions:\n%s", a.ContextBundle)
	}
}

type failingSkillPrefs struct{}

func (failingSkillPrefs) HiddenSkillSet(context.Context, string) (map[string]bool, error) {
	return nil, errors.New("prefs store down")
}

// A prefs lookup failure degrades to the uncurated index — skills must not
// vanish because a preferences read hiccuped.
func TestOrchestrator_SkillIndexPrefsErrorDegrades(t *testing.T) {
	fx := newOrchFixture(t)
	svc := NewAgentService(fx.dir, fx.users)
	sk, err := svc.CreateSkill(context.Background(), "u-alice", "Release checklist", "How we ship", "1. tag 2. build", model.SkillVisibilityPublished)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	fx.orch.SetSkillPrefs(failingSkillPrefs{})
	fx.startRun(t)
	a := fx.claim(t)
	if !strings.Contains(a.ContextBundle, "[sk:"+sk.ID+"]") {
		t.Fatalf("index dropped on prefs error:\n%s", a.ContextBundle)
	}
}

// A scheduled subscription is a standing order on a CLOCK: it fires when its
// cron spec comes due, never on chat traffic, and it carries the DIRECT turn
// budget because the creator asked for real work.
func TestOrchestrator_ScheduledOrderFiresOnSchedule(t *testing.T) {
	ctx := context.Background()
	fx := newOrchFixture(t)
	// 08:00 every weekday, in a fixed zone so the test doesn't depend on the
	// machine's locale.
	_ = fx.dir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "sub-s", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		Schedule: "0 8 * * 1-5", ScheduleTZ: "UTC",
		Instruction: "Post yesterday's revenue from metabase.",
		ActionMode:  model.WatchActionNotify,
		CreatedAt:   time.Date(2026, 9, 23, 9, 0, 0, 0, time.UTC), // Wed, after 08:00
	})

	// Same day at 20:00: today's 08:00 already passed before it existed.
	*fx.now = time.Date(2026, 9, 23, 20, 0, 0, 0, time.UTC)
	fx.orch.sweepSchedules(ctx, watchAllSubs(t, fx))
	if ids, _ := fx.runs.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("scheduled order fired retroactively: %d runs", len(ids))
	}

	// Next morning 08:00 — due.
	*fx.now = time.Date(2026, 9, 24, 8, 0, 30, 0, time.UTC)
	fx.orch.sweepSchedules(ctx, watchAllSubs(t, fx))
	ids, _ := fx.runs.ListQueuedRuns(ctx, "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("expected 1 scheduled run, got %d", len(ids))
	}
	run, _ := fx.runs.GetRun(ctx, ids[0])
	if run.Mode != model.RunModeScheduled || run.MessageID != "" {
		t.Fatalf("bad scheduled run: mode=%s msgID=%q", run.Mode, run.MessageID)
	}
	if !strings.Contains(run.Prompt, "scheduled order") || !strings.Contains(run.Prompt, "08:00") {
		t.Fatalf("scheduled prompt should name the schedule: %q", run.Prompt)
	}
	if run.WatchInstruction != "Post yesterday's revenue from metabase." {
		t.Fatalf("standing order lost: %q", run.WatchInstruction)
	}
	// Direct-tier budget, not the ambient one.
	if run.Limits.TurnsFor(run.Mode) != model.DefaultAgentLimits().MaxTaskTurns {
		t.Fatalf("scheduled run got the ambient turn budget: %d", run.Limits.TurnsFor(run.Mode))
	}

	// Ten minutes later the same morning: LastRunAt advanced, so no re-fire.
	*fx.now = time.Date(2026, 9, 24, 8, 10, 0, 0, time.UTC)
	fx.orch.sweepSchedules(ctx, watchAllSubs(t, fx))
	if ids, _ := fx.runs.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 1 {
		t.Fatalf("scheduled order re-fired within the same firing: %d runs", len(ids))
	}

	// The heartbeat sweep leaves scheduled rows alone: both sweeps advance
	// LastRunAt, so sharing a row would scramble the cron's timing.
	subs := watchAllSubs(t, fx)
	subs[0].HeartbeatMins = 15
	_ = fx.dir.PutAgentSubscription(ctx, subs[0])
	*fx.now = time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	fx.orch.sweepHeartbeats(ctx, watchAllSubs(t, fx))
	if ids, _ := fx.runs.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 1 {
		t.Fatalf("heartbeat sweep also fired a scheduled row: %d runs", len(ids))
	}
}

// The two triggers are exclusive: a scheduled row must never also react to
// messages in its channel, or a daily report would fire on every chat line.
func TestOrchestrator_ScheduledOrderIgnoresMessages(t *testing.T) {
	ctx := context.Background()
	fx := newOrchFixture(t)
	_ = fx.dir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "sub-s", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		Schedule: "0 8 * * *", ScheduleTZ: "UTC", Instruction: "daily report",
		CreatedAt: time.Now(),
	})
	fx.orch.OnMessage(ctx, &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-bob", Body: "morning all"}, ParentChannel)
	if ids, _ := fx.runs.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("scheduled order fired on a chat message: %d runs", len(ids))
	}
}

// A schedule that comes due while the creator is offline is not dropped: the
// row is marked pending and the catch-up sweep runs it ONCE when they return,
// with no consent card (they already consented by scheduling it).
func TestOrchestrator_ScheduledOrderCatchesUpAfterOffline(t *testing.T) {
	ctx := context.Background()
	fx := newOrchFixture(t)
	sub := &model.AgentSubscription{
		ID: "sub-s", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		Schedule: "0 8 * * *", ScheduleTZ: "UTC", Instruction: "daily report",
		ActionMode: model.WatchActionNotify,
		CreatedAt:  time.Date(2026, 9, 23, 9, 0, 0, 0, time.UTC),
	}
	_ = fx.dir.PutAgentSubscription(ctx, sub)

	// No live runner for alice → the fire is missed and flagged.
	fx.dir.mu.Lock()
	saved := fx.dir.runners["u-alice"]
	fx.dir.runners["u-alice"] = nil
	fx.dir.mu.Unlock()
	*fx.now = time.Date(2026, 9, 24, 8, 0, 30, 0, time.UTC)
	fx.orch.sweepSchedules(ctx, watchAllSubs(t, fx))
	if ids, _ := fx.runs.ListQueuedRuns(ctx, "u-alice", 10); len(ids) != 0 {
		t.Fatalf("offline creator still started a run: %d", len(ids))
	}
	after := watchAllSubs(t, fx)[0]
	if !after.PendingCatchUp {
		t.Fatal("missed scheduled order was dropped instead of flagged")
	}

	// Back online: the catch-up sweep runs it once, as a scheduled run that
	// says it is late — no consent ask.
	fx.dir.mu.Lock()
	fx.dir.runners["u-alice"] = saved
	fx.dir.mu.Unlock()
	fx.orch.sweepWatchCatchUps(ctx, watchAllSubs(t, fx))
	ids, _ := fx.runs.ListQueuedRuns(ctx, "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("catch-up expected 1 run, got %d", len(ids))
	}
	run, _ := fx.runs.GetRun(ctx, ids[0])
	if run.Mode != model.RunModeScheduled || !strings.Contains(run.Prompt, "late") {
		t.Fatalf("catch-up run should be a late scheduled order: mode=%s prompt=%q", run.Mode, run.Prompt)
	}
	if watchAllSubs(t, fx)[0].PendingCatchUp {
		t.Fatal("catch-up flag not cleared")
	}
}

// Scheduling validation and the timezone default: "8am" must mean the
// CREATOR's 8am, so an order saved without an explicit zone adopts their
// profile timezone rather than the server's.
func TestAgentService_ScheduleValidationAndTimezone(t *testing.T) {
	ctx := context.Background()
	fx := newOrchFixture(t)
	svc := NewAgentService(fx.dir, fx.users)

	// Alice's profile says Stockholm; she saves an order without naming a zone.
	alice := fx.users.users["u-alice"]
	alice.TimeZone = "Europe/Stockholm"

	sub, err := svc.CreateSubscription(ctx, "u-alice", AgentSlugGG, "chan1", ParentChannel, nil, 0, WatchInput{
		Instruction: "Post yesterday's revenue.",
		Schedule:    "0 8 * * 1-5",
	})
	if err != nil {
		t.Fatalf("create scheduled: %v", err)
	}
	if sub.Schedule != "0 8 * * 1-5" || sub.ScheduleTZ != "Europe/Stockholm" {
		t.Fatalf("schedule/tz = %q/%q, want the creator's zone", sub.Schedule, sub.ScheduleTZ)
	}

	// An explicit zone wins over the profile.
	sub2, err := svc.CreateSubscription(ctx, "u-alice", AgentSlugGG, "chan1", ParentChannel, nil, 0, WatchInput{
		Instruction: "Nightly digest.", Schedule: "0 22 * * *", ScheduleTZ: "UTC",
	})
	if err != nil || sub2.ScheduleTZ != "UTC" {
		t.Fatalf("explicit tz not kept: %q (err %v)", sub2.ScheduleTZ, err)
	}

	// A creator with no profile timezone leaves it empty — read as UTC later.
	bob := &model.User{ID: "u-carol", DisplayName: "Carol"}
	fx.users.users["u-carol"] = bob
	sub3, err := svc.CreateSubscription(ctx, "u-carol", AgentSlugGG, "chan1", ParentChannel, nil, 0, WatchInput{
		Instruction: "Weekly wrap.", Schedule: "0 16 * * 5",
	})
	if err != nil || sub3.ScheduleTZ != "" {
		t.Fatalf("zone-less creator: tz=%q err=%v", sub3.ScheduleTZ, err)
	}

	// Rejections: unparseable spec, unknown zone, and a schedule with nothing
	// to do (an order that wakes the agent to accomplish nothing).
	for _, tc := range []struct {
		name string
		in   WatchInput
	}{
		{"bad spec", WatchInput{Instruction: "x", Schedule: "every morning"}},
		{"out of range", WatchInput{Instruction: "x", Schedule: "0 99 * * *"}},
		{"unknown zone", WatchInput{Instruction: "x", Schedule: "0 8 * * *", ScheduleTZ: "Mars/Olympus"}},
		{"no instruction", WatchInput{Schedule: "0 8 * * *"}},
	} {
		if _, err := svc.CreateSubscription(ctx, "u-alice", AgentSlugGG, "chan1", ParentChannel, nil, 0, tc.in); !errors.Is(err, ErrValidation) {
			t.Fatalf("%s: want ErrValidation, got %v", tc.name, err)
		}
	}

	// Editing carries the same rules, and clearing the spec turns a scheduled
	// order back into a plain watcher.
	if _, err := svc.UpdateSubscription(ctx, "u-alice", "chan1", sub.ID, WatchInput{Instruction: "x", Schedule: "nope"}); !errors.Is(err, ErrValidation) {
		t.Fatalf("update with a bad spec: %v", err)
	}
	cleared, err := svc.UpdateSubscription(ctx, "u-alice", "chan1", sub.ID, WatchInput{Instruction: "watch instead"})
	if err != nil || cleared.Schedule != "" || cleared.ScheduleTZ != "" {
		t.Fatalf("clearing the schedule: %+v (err %v)", cleared, err)
	}
}

// A scheduled order with no channel belongs in the creator's own DM with the
// agent — "where does this run" is bookkeeping, and asking people to nominate
// a channel for "DM me the numbers each morning" is a leaked detail.
func TestAgentService_ScheduleDefaultsToCreatorDM(t *testing.T) {
	ctx := context.Background()
	fx := newOrchFixture(t)
	svc := NewAgentService(fx.dir, fx.users)
	dm := &fakeOwnerDM{convID: "conv-dm-1"}
	svc.SetDMResolver(dm)

	sub, err := svc.CreateSubscription(ctx, "u-alice", AgentSlugGG, "", "", nil, 0, WatchInput{
		Instruction: "Post yesterday's revenue.",
		Schedule:    "0 8 * * 1-5",
		ScheduleTZ:  "UTC",
	})
	if err != nil {
		t.Fatalf("create without a channel: %v", err)
	}
	if sub.ParentID != "conv-dm-1" || sub.ParentType != ParentConversation {
		t.Fatalf("parent = %s/%s, want the creator↔agent DM", sub.ParentID, sub.ParentType)
	}
	// Resolved for THIS creator and THIS agent, not some other pair.
	if dm.gotA != "u-alice" || dm.gotB != testGGID {
		t.Fatalf("DM resolved for %s/%s", dm.gotA, dm.gotB)
	}
	// A named channel still wins.
	sub2, err := svc.CreateSubscription(ctx, "u-alice", AgentSlugGG, "chan1", ParentChannel, nil, 0, WatchInput{
		Instruction: "Post it publicly.", Schedule: "0 9 * * *",
	})
	if err != nil || sub2.ParentID != "chan1" || sub2.ParentType != ParentChannel {
		t.Fatalf("explicit channel lost: %+v (err %v)", sub2, err)
	}
	// A resolver that fails surfaces its error instead of silently writing a
	// parentless row the sweeps could never deliver.
	broken := NewAgentService(fx.dir, fx.users)
	broken.SetDMResolver(failingDM{})
	if _, err := broken.CreateSubscription(ctx, "u-alice", AgentSlugGG, "", "", nil, 0, WatchInput{
		Instruction: "x", Schedule: "0 8 * * *",
	}); err == nil {
		t.Fatal("DM resolution failure should surface")
	}
	// With no resolver wired, a parent-less create is a validation error
	// rather than a row nobody can find.
	bare := NewAgentService(fx.dir, fx.users)
	if _, err := bare.CreateSubscription(ctx, "u-alice", AgentSlugGG, "", "", nil, 0, WatchInput{
		Instruction: "x", Schedule: "0 8 * * *",
	}); !errors.Is(err, ErrValidation) {
		t.Fatalf("no resolver: want ErrValidation, got %v", err)
	}
}

// failingDM stands in for a conversation service that can't open the DM.
type failingDM struct{}

func (failingDM) GetOrCreateDM(context.Context, string, string) (*model.Conversation, error) {
	return nil, errors.New("dm store down")
}

// Pinned tools ride a scheduled order into its run, so a standing instruction
// never has to guess which connected service or instruction pack it meant.
// Stale pins (a removed connector, a skill the invoker can no longer see) are
// filtered rather than failing the run.
func TestOrchestrator_ScheduledOrderCarriesPinnedTools(t *testing.T) {
	ctx := context.Background()
	fx := newOrchFixture(t)
	svc := NewAgentService(fx.dir, fx.users)
	sk, err := svc.CreateSkill(ctx, "u-alice", "Release checklist", "How we ship", "1. tag", model.SkillVisibilityPublished)
	if err != nil {
		t.Fatalf("create skill: %v", err)
	}
	fx.orch.SetConnectorRegistry(fakeConnectorRegistry{known: map[string]bool{"metabase": true}})

	_ = fx.dir.PutAgentSubscription(ctx, &model.AgentSubscription{
		ID: "sub-tools", AgentID: testGGID, CreatorID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel,
		Schedule: "0 8 * * *", ScheduleTZ: "UTC", Instruction: "Numbers please.",
		ActionMode: model.WatchActionNotify,
		// "gone" is not in the registry; "sk-missing" is not a visible skill.
		ConnectorSlugs: []string{"metabase", "gone"},
		SkillIDs:       []string{sk.ID, "sk-missing"},
		CreatedAt:      time.Date(2026, 9, 23, 9, 0, 0, 0, time.UTC),
	})

	*fx.now = time.Date(2026, 9, 24, 8, 0, 30, 0, time.UTC)
	fx.orch.sweepSchedules(ctx, watchAllSubs(t, fx))
	ids, _ := fx.runs.ListQueuedRuns(ctx, "u-alice", 10)
	if len(ids) != 1 {
		t.Fatalf("expected 1 scheduled run, got %d", len(ids))
	}
	run, _ := fx.runs.GetRun(ctx, ids[0])
	if len(run.ConnectorSlugs) != 1 || run.ConnectorSlugs[0] != "metabase" {
		t.Fatalf("connector pins = %v, want just the known one", run.ConnectorSlugs)
	}
	if len(run.PickedSkillIDs) != 1 || run.PickedSkillIDs[0] != sk.ID {
		t.Fatalf("skill pins = %v, want just the visible one", run.PickedSkillIDs)
	}
}

// fakeConnectorRegistry answers KnownSlugs for pin filtering.
type fakeConnectorRegistry struct {
	known   map[string]bool
	expired []string
}

func (f fakeConnectorRegistry) KnownSlugs(context.Context) (map[string]bool, error) {
	return f.known, nil
}

func (f fakeConnectorRegistry) InstalledIndex(context.Context, string) ([]ConnectorIndexEntry, error) {
	return nil, nil
}

func (f fakeConnectorRegistry) ExpiredFor(context.Context, string, []string) []string {
	return f.expired
}

// Pin hygiene: lists are trimmed, lowercased, deduped and bounded, and a
// skill the creator cannot see is dropped rather than silently widening what
// the order may reach.
func TestAgentService_CleanPins(t *testing.T) {
	ctx := context.Background()
	fx := newOrchFixture(t)
	svc := NewAgentService(fx.dir, fx.users)
	sk, err := svc.CreateSkill(ctx, "u-alice", "Release checklist", "How we ship", "1. tag", model.SkillVisibilityPublished)
	if err != nil {
		t.Fatalf("create skill: %v", err)
	}
	priv, err := svc.CreateSkill(ctx, "u-bob", "Bob's private", "his", "secret", model.SkillVisibilityPrivate)
	if err != nil {
		t.Fatalf("create private skill: %v", err)
	}

	many := make([]string, 0, 14)
	for i := 0; i < 14; i++ {
		many = append(many, fmt.Sprintf("conn-%02d", i))
	}
	slugs, skills := svc.cleanPins(ctx, "u-alice", WatchInput{
		ConnectorSlugs: append([]string{" Metabase ", "metabase", ""}, many...),
		SkillIDs:       []string{" " + sk.ID + " ", sk.ID, "", priv.ID, "sk-ghost"},
	})
	if len(slugs) != 10 || slugs[0] != "metabase" {
		t.Fatalf("connector pins = %v, want lowercased+deduped and capped at 10", slugs)
	}
	if len(skills) != 1 || skills[0] != sk.ID {
		t.Fatalf("skill pins = %v, want only the visible one", skills)
	}

	// A skill list over the cap stops at 10 too.
	ids := make([]string, 0, 12)
	for i := 0; i < 12; i++ {
		s, cerr := svc.CreateSkill(ctx, "u-alice", fmt.Sprintf("Pack %d", i), "d", "i", model.SkillVisibilityPublished)
		if cerr != nil {
			t.Fatalf("create pack: %v", cerr)
		}
		ids = append(ids, s.ID)
	}
	if _, capped := svc.cleanPins(ctx, "u-alice", WatchInput{SkillIDs: ids}); len(capped) != 10 {
		t.Fatalf("skill cap = %d, want 10", len(capped))
	}
}

// Pin filtering at run time degrades safely: no registry, a failing registry,
// and empty lists all yield no pins rather than an error.
func TestOrchestrator_PinFilteringDegrades(t *testing.T) {
	ctx := context.Background()
	fx := newOrchFixture(t)
	if got := fx.orch.knownConnectorSlugs(ctx, []string{"a"}); got != nil {
		t.Fatalf("no registry wired should yield no pins, got %v", got)
	}
	if got := fx.orch.knownConnectorSlugs(ctx, nil); got != nil {
		t.Fatalf("empty list = no pins, got %v", got)
	}
	fx.orch.SetConnectorRegistry(failingRegistry{})
	if got := fx.orch.knownConnectorSlugs(ctx, []string{"a"}); got != nil {
		t.Fatalf("registry failure should yield no pins, got %v", got)
	}
	// Duplicates collapse.
	fx.orch.SetConnectorRegistry(fakeConnectorRegistry{known: map[string]bool{"a": true}})
	if got := fx.orch.knownConnectorSlugs(ctx, []string{"a", "a", "b"}); len(got) != 1 || got[0] != "a" {
		t.Fatalf("dedup/filter = %v", got)
	}
	if got := fx.orch.visibleSkillIDs(ctx, "u-alice", nil); got != nil {
		t.Fatalf("empty skill list = no pins, got %v", got)
	}
	svc := NewAgentService(fx.dir, fx.users)
	sk, _ := svc.CreateSkill(ctx, "u-alice", "Pack", "d", "i", model.SkillVisibilityPublished)
	if got := fx.orch.visibleSkillIDs(ctx, "u-alice", []string{sk.ID, sk.ID}); len(got) != 1 {
		t.Fatalf("skill dedup = %v", got)
	}
}

type failingRegistry struct{}

func (failingRegistry) KnownSlugs(context.Context) (map[string]bool, error) {
	return nil, errors.New("registry down")
}
func (failingRegistry) InstalledIndex(context.Context, string) ([]ConnectorIndexEntry, error) {
	return nil, nil
}

func (failingRegistry) ExpiredFor(context.Context, string, []string) []string { return nil }
