package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// A subscription invokes the agent on a matching un-mentioned message — as
// the CREATOR (their machine/quota), in watch mode. Non-matching messages
// and messages that already mentioned the agent don't double-invoke.
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
	if err := fx.orch.CompleteRun(context.Background(), "r1", as.RunID, "here is a public summary", nil); err != nil {
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

	if err := fx.orch.CompleteRun(context.Background(), "r1", as.RunID, "here is a private tldr", nil); err != nil {
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
	if err := fx.orch.CompleteRun(context.Background(), "r1", as.RunID, "SKIP", nil); err != nil {
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
	if err := fx.orch.CompleteRun(context.Background(), "r1", as.RunID, "Here is my reply.", nil); err != nil {
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
	if _, err := fx.orch.DecideApproval(context.Background(), "u-alice", as.RunID, draft.ID, true, "", ""); err != nil {
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
	if err := fx.orch.CompleteRun(context.Background(), "r1", as.RunID, "a public answer", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if len(fx.msgs.posts) != before {
		t.Fatalf("reply watcher posted publicly without approval: %v", fx.msgs.posts[before:])
	}

	// HasApprovedApproval flips once an approval is granted.
	ok, _ := fx.orch.HasApprovedApproval(context.Background(), as.RunID)
	if ok {
		t.Fatal("no approval should exist yet")
	}
	_ = fx.runs.PutApproval(context.Background(), &model.Approval{
		ID: "ap1", RunID: as.RunID, InvokerID: "u-alice", State: model.ApprovalApproved,
	})
	if ok, _ := fx.orch.HasApprovedApproval(context.Background(), as.RunID); !ok {
		t.Fatal("HasApprovedApproval should be true after an approval is granted")
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
	deny, _ := fx.orch.DecideApproval(context.Background(), run.InvokerID, run.ID, a.ID, false, "", "")
	if deny.State != model.ApprovalDenied || len(fx.msgs.posts) != before {
		t.Fatalf("deny should post nothing: state=%s posts=%d", deny.State, len(fx.msgs.posts))
	}

	// A second proposal, approved WITH an edit → the edited text is posted.
	a2, _ := fx.orch.ProposeReply(context.Background(), run, "Original draft.", "", "")
	before = len(fx.msgs.posts)
	if _, err := fx.orch.DecideApproval(context.Background(), run.InvokerID, run.ID, a2.ID, true, "", "My edited reply."); err != nil {
		t.Fatalf("approve: %v", err)
	}
	if len(fx.msgs.posts) != before+1 || fx.msgs.posts[before] != "My edited reply." {
		t.Fatalf("approve should post the edit, got %v", fx.msgs.posts[before:])
	}
}

type fakeNotifier struct{ got []Notification }

func (f *fakeNotifier) NotifyDirect(_ context.Context, _ string, n Notification) { f.got = append(f.got, n) }

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

	fx.orch.sweepHeartbeats(context.Background())
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
	fx.orch.sweepHeartbeats(context.Background())
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatalf("heartbeat re-fired inside its interval: %v", ids)
	}

	// Past the interval: fires again.
	*fx.now = fx.now.Add(31 * time.Minute)
	fx.orch.sweepHeartbeats(context.Background())
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
	abort, reason, err := fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{{Seq: 1, Type: "turn"}})
	if err != nil || abort {
		t.Fatalf("active run aborted: %v %q %v", abort, reason, err)
	}
	extended, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got := extended.Deadline.Sub(*fx.now); got != taskIdleWindow {
		t.Fatalf("deadline not extended by idle window: %v, want %v", got, taskIdleWindow)
	}

	// Silence past the idle window → next report aborts on deadline.
	*fx.now = fx.now.Add(taskIdleWindow + time.Minute)
	abort, reason, _ = fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{{Seq: 2, Type: "turn"}})
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
		abort, reason, _ := fx.orch.ReportEvents(context.Background(), "r1", run.ID, []RunEventInput{{Seq: seq, Type: "turn"}})
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
	fx.orch.sweepWatchCatchUps(context.Background())
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatal("catch-up must not start while creator is offline")
	}
	if len(fn.got) != 0 {
		t.Fatal("must not ask while the creator is still offline")
	}

	// Runner returns → CLI harness backlog needs CONSENT: no auto-run, ONE
	// notification, flag survives.
	fx.dir.runners = savedRunners
	fx.orch.sweepWatchCatchUps(context.Background())
	if ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); len(ids) != 0 {
		t.Fatal("CLI offline backlog must not auto-run — it asks first")
	}
	if len(fn.got) != 1 || fn.got[0].Kind != NotificationKindCatchUp {
		t.Fatalf("expected exactly one catch-up ask notification, got %+v", fn.got)
	}
	// Re-sweep: no re-ask (notified stamp).
	fx.orch.sweepWatchCatchUps(context.Background())
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
	fx.orch.sweepWatchCatchUps(context.Background())
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
	fx.orch.sweepWatchCatchUps(context.Background())
	subs, _ = fx.dir.ListSubscriptionsByParent(context.Background(), "chan1")
	if !subs[0].PendingCatchUp {
		t.Fatal("flag must survive a blocked sweep")
	}

	// Run 1 finishes → next sweep starts the single catch-up run.
	if err := fx.orch.CompleteRun(context.Background(), "r1", as.RunID, "SKIP", nil); err != nil {
		t.Fatalf("complete: %v", err)
	}
	fx.orch.sweepWatchCatchUps(context.Background())
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
	up, err := svc.UpdateSubscription(context.Background(), "u-alice", "chan1", "w1", "new order", model.WatchActionReply)
	if err != nil || up.Instruction != "new order" || up.ActionMode != model.WatchActionReply {
		t.Fatalf("update failed: %+v (err %v)", up, err)
	}

	// Non-creator can't edit; bad mode rejected.
	if _, err := svc.UpdateSubscription(context.Background(), "u-bob", "chan1", "w1", "hijack", ""); !errors.Is(err, ErrForbidden) {
		t.Fatalf("expected ErrForbidden, got %v", err)
	}
	if _, err := svc.UpdateSubscription(context.Background(), "u-alice", "chan1", "w1", "x", "bogus"); !errors.Is(err, ErrValidation) {
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

	sk1, err := svc.CreateSkill(context.Background(), "u-alice", "Release checklist", "How we ship", "1. tag 2. build 3. announce in #general")
	if err != nil {
		t.Fatalf("create skill: %v", err)
	}
	sk2, err := svc.CreateSkill(context.Background(), "u-alice", "Incident triage", "What to do when prod breaks", "page the on-call, open a thread")
	if err != nil {
		t.Fatalf("create skill: %v", err)
	}

	// Attach sk1 to gg; validation rejects unknown ids and over-cap lists.
	if _, err := svc.SetAgentSkills(context.Background(), AgentSlugGG, []string{sk1.ID}); err != nil {
		t.Fatalf("set skills: %v", err)
	}
	if _, err := svc.SetAgentSkills(context.Background(), AgentSlugGG, []string{"nope"}); !errors.Is(err, ErrValidation) {
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
