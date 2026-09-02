package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/events"
	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/store"
)

// Approval / artifact / skill gates (plan-v2 §7, Phase 3).

// approvalMaxWait bounds how long a request_approval tool call may park. The
// effective deadline is additionally capped by the run's own deadline — the
// approval must resolve INSIDE the tool call, before the wall clock kills
// the run out from under it. Var so tests can shrink it.
var approvalMaxWait = 5 * time.Minute

// replyProposalTTL is how long a drafted reply waits for the invoker. Unlike a
// blocking approval (bounded by the run), a proposal outlives its run — the
// agent already finished; the human decides on their own time.
var replyProposalTTL = 24 * time.Hour

// offlineQueueTTL bounds how long a queued-offline run waits for the
// invoker's runner before the deadline sweep fails it (offlinePolicy:
// "queue").
var offlineQueueTTL = time.Hour

// Gate errors.
var (
	ErrNotInvoker      = errors.New("orchestrator: only the invoker decides approvals")
	ErrApprovalSettled = errors.New("orchestrator: approval already settled")
	ErrArtifactCap     = errors.New("orchestrator: per-run artifact cap reached")
)

// RequestApproval opens a pending approval and parks the run's state on ⛔.
// The MCP server polls ApprovalStatus until a decision or the deadline.
// options non-empty turns it into a multiple-choice question (ask_user): the
// invoker picks one instead of approving/denying.
func (o *Orchestrator) RequestApproval(ctx context.Context, run *model.Run, summary, risk string, options []string) (*model.Approval, error) {
	return o.RequestApprovalKind(ctx, run, summary, risk, options, "")
}

// RequestApprovalKind is RequestApproval with the harness tool class (read /
// edit / shell / web) for permission-gateway approvals — the card uses it to
// offer "always allow <class> for this agent". Empty kind = a plain gate.
func (o *Orchestrator) RequestApprovalKind(ctx context.Context, run *model.Run, summary, risk string, options []string, kind string) (*model.Approval, error) {
	summary = strings.TrimSpace(summary)
	if !model.ValidAutoAllow(kind) {
		kind = ""
	}
	if summary == "" {
		return nil, fmt.Errorf("orchestrator: approval summary required: %w", ErrValidation)
	}
	if len(summary) > 1024 {
		summary = clipText(summary, 1024)
	}
	if len(options) > 0 {
		if len(options) < 2 || len(options) > model.ApprovalMaxOptions {
			return nil, fmt.Errorf("orchestrator: 2–%d options required: %w", model.ApprovalMaxOptions, ErrValidation)
		}
		for i, opt := range options {
			opt = strings.TrimSpace(opt)
			if opt == "" {
				return nil, fmt.Errorf("orchestrator: empty option: %w", ErrValidation)
			}
			options[i] = clipText(opt, model.ApprovalOptionMaxLen)
		}
	}
	now := o.now()
	deadline := now.Add(approvalMaxWait)
	// The approval must resolve inside the run — leave room for the agent to
	// act on the answer before the run deadline.
	if latest := run.Deadline.Add(-10 * time.Second); deadline.After(latest) {
		deadline = latest
	}
	if !deadline.After(now) {
		return nil, fmt.Errorf("orchestrator: run too close to its deadline to wait for approval: %w", ErrValidation)
	}
	a := &model.Approval{
		ID:        store.NewID(),
		RunID:     run.ID,
		AgentID:   run.AgentID,
		InvokerID: run.InvokerID,
		Summary:   summary,
		Risk:      risk,
		Kind:      kind,
		Options:   options,
		State:     model.ApprovalPending,
		Deadline:  deadline,
		CreatedAt: now,
	}
	if err := o.runs.PutApproval(ctx, a); err != nil {
		return nil, err
	}
	o.appendEvent(ctx, run, now.UnixNano(), run.AgentID, "approval.requested", map[string]any{
		"approvalID": a.ID, "summary": summary, "risk": risk, "kind": kind, "deadline": deadline, "options": options,
	})
	o.setState(ctx, run, StateEmojiBlocked)
	// Published ONLY to the invoker's private inbox — an approval is a
	// decision that belongs to whoever's machine/permissions are at stake;
	// other channel members must never see (or be able to act on) it. There
	// is deliberately no in-thread notice: chat messages are visible to
	// everyone, so they can't carry a private gate.
	o.publishApproval(ctx, run, a)
	return a, nil
}

// ProposeReply creates an editable REPLY PROPOSAL: the agent drafted `text` as
// a reply and the invoker gets a card to approve/edit/cancel it. threadRoot is
// where it will post (defaults to the run's thread); replyTo is the message it
// answers, shown for context. Non-blocking — the run can end; DecideApproval
// posts the (possibly edited) text when the invoker approves.
func (o *Orchestrator) ProposeReply(ctx context.Context, run *model.Run, text, threadRoot, replyTo string) (*model.Approval, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("orchestrator: reply text required: %w", ErrValidation)
	}
	if len(text) > 8*1024 {
		text = clipText(text, 8*1024)
	}
	if threadRoot == "" {
		threadRoot = o.replyThreadRoot(run)
	}
	if replyTo == "" {
		replyTo = run.MessageID
	}
	now := o.now()
	a := &model.Approval{
		ID:               store.NewID(),
		RunID:            run.ID,
		AgentID:          run.AgentID,
		InvokerID:        run.InvokerID,
		Summary:          "Draft reply — approve, edit, or cancel",
		ReplyText:        text,
		ReplyThreadRoot:  threadRoot,
		ReplyToMessageID: replyTo,
		State:            model.ApprovalPending,
		Deadline:         now.Add(replyProposalTTL),
		CreatedAt:        now,
	}
	if err := o.runs.PutApproval(ctx, a); err != nil {
		return nil, err
	}
	o.appendEvent(ctx, run, now.UnixNano(), run.AgentID, "reply.proposed", map[string]any{
		"approvalID": a.ID, "chars": len(text),
	})
	o.setState(ctx, run, StateEmojiBlocked)
	o.publishApproval(ctx, run, a)
	return a, nil
}

// ClaimTask atomically claims one part of a co-invoked task for this run's
// agent — first write wins, so parallel peers can split work ("hindi" /
// "english") without racing to post. Returns whether WE now hold the label,
// plus rendered lines for every claim on the thread (so a losing agent sees
// what's taken and by whom). Labels are normalized: lowercase, collapsed
// whitespace.
func (o *Orchestrator) ClaimTask(ctx context.Context, run *model.Run, label string) (mine bool, lines []string, err error) {
	norm := strings.Join(strings.Fields(strings.ToLower(label)), " ")
	if norm == "" {
		return false, nil, fmt.Errorf("orchestrator: claim label required: %w", ErrValidation)
	}
	norm = clipText(norm, model.TaskClaimLabelMaxLen)
	threadRoot := o.replyThreadRoot(run)
	claim := &model.TaskClaim{
		ParentID:     run.ParentID,
		ThreadRootID: threadRoot,
		Label:        norm,
		AgentID:      run.AgentID,
		InvokerID:    run.InvokerID,
		CreatedAt:    o.now(),
	}
	mine = true
	if err := o.agentSvc.agents.PutTaskClaim(ctx, claim); err != nil {
		if !errors.Is(err, store.ErrClaimTaken) {
			return false, nil, err
		}
		mine = false
	}
	if mine {
		o.appendEvent(ctx, run, o.now().UnixNano(), run.AgentID, "task.claimed", map[string]any{"label": norm})
	}
	claims, err := o.agentSvc.agents.ListTaskClaims(ctx, run.ParentID, threadRoot)
	if err != nil {
		return mine, nil, nil // the claim verdict stands even if the listing hiccups
	}
	ids := make([]string, 0, len(claims))
	for _, c := range claims {
		ids = append(ids, c.AgentID)
	}
	names := o.displayNames(ctx, ids)
	for _, c := range claims {
		who := names[c.AgentID]
		if who == "" {
			who = c.AgentID
		}
		if c.AgentID == run.AgentID {
			who += " (you)"
		}
		lines = append(lines, c.Label+" — claimed by "+who)
	}
	return mine, lines, nil
}

// ApprovalStatus returns the approval, lazily expiring it past its deadline
// — expiry is discovered by the poll that crosses it, no timer needed. An
// expired approval reads as denied{approval_timeout} to the agent.
func (o *Orchestrator) ApprovalStatus(ctx context.Context, runID, approvalID string) (*model.Approval, error) {
	a, err := o.runs.GetApproval(ctx, runID, approvalID)
	if err != nil {
		return nil, err
	}
	if a.State == model.ApprovalPending && o.now().After(a.Deadline) {
		now := o.now()
		if err := o.runs.SettleApproval(ctx, runID, approvalID, model.ApprovalExpired, "", "", "", now); err == nil {
			a.State = model.ApprovalExpired
			a.DecidedAt = &now
			if run, err := o.runs.GetRun(ctx, runID); err == nil {
				o.appendEvent(ctx, run, now.UnixNano(), run.AgentID, "approval.expired", map[string]any{"approvalID": a.ID})
				o.setState(ctx, run, StateEmojiWorking) // unblock the display
				o.publishApproval(ctx, run, a)
			}
		} else if !errors.Is(err, store.ErrStaleApproval) {
			return nil, err
		} else if fresh, err := o.runs.GetApproval(ctx, runID, approvalID); err == nil {
			a = fresh // a decision won the race — return it
		}
	}
	return a, nil
}

// DecideApproval records the INVOKER's verdict. Nobody else may decide —
// the run acts with the invoker's permissions, so the risk is theirs. For a
// multiple-choice gate (Options set), choice must name one of the options
// and the settle records it.
func (o *Orchestrator) DecideApproval(ctx context.Context, deciderID, runID, approvalID string, approve bool, choice, editedText string) (*model.Approval, error) {
	a, err := o.runs.GetApproval(ctx, runID, approvalID)
	if err != nil {
		return nil, err
	}
	if a.InvokerID != deciderID {
		return nil, ErrNotInvoker
	}
	if a.State != model.ApprovalPending {
		return nil, ErrApprovalSettled
	}
	if len(a.Options) > 0 && approve {
		valid := false
		for _, opt := range a.Options {
			if opt == choice {
				valid = true
				break
			}
		}
		if !valid {
			return nil, fmt.Errorf("orchestrator: choice must be one of the options: %w", ErrValidation)
		}
	} else {
		choice = ""
	}
	state := model.ApprovalDenied
	if approve {
		state = model.ApprovalApproved
	}
	// For a reply proposal the text IS the (edited) reply; for every other
	// gate it is the invoker's note to the agent — direction that rides the
	// tool result ("no — use the seed DB instead").
	note := ""
	if a.ReplyText == "" {
		note = clipText(strings.TrimSpace(editedText), 2000)
	}
	now := o.now()
	if err := o.runs.SettleApproval(ctx, runID, approvalID, state, deciderID, choice, note, now); err != nil {
		if errors.Is(err, store.ErrStaleApproval) {
			return nil, ErrApprovalSettled
		}
		return nil, err
	}
	a.State = state
	a.DecidedBy = deciderID
	a.DecidedAt = &now
	a.Choice = choice
	a.Note = note
	if run, err := o.runs.GetRun(ctx, runID); err == nil {
		o.appendEvent(ctx, run, now.UnixNano(), deciderID, "approval.decided", map[string]any{
			"approvalID": a.ID, "state": state, "choice": choice, "note": note,
		})
		if !run.State.Terminal() {
			o.setState(ctx, run, StateEmojiWorking)
		}
		// Editable reply proposal: on approval, the SERVER posts the drafted
		// reply (or the invoker's edit) as the agent — the agent doesn't post,
		// so it works even after the run ended and regardless of harness. Deny
		// posts nothing (the human replies themselves).
		if approve && a.ReplyText != "" {
			text := a.ReplyText
			if strings.TrimSpace(editedText) != "" {
				text = strings.TrimSpace(editedText)
			}
			body := o.LinkifyMentions(ctx, run, text)
			if msg, perr := o.messages.SendAsAgentRun(ctx, run.AgentID, run.InvokerID, run.ParentID, run.ParentType, body, a.ReplyThreadRoot, run.ID); perr != nil {
				slog.Warn("approved reply post failed", "runID", run.ID, "error", perr)
			} else {
				o.appendEvent(ctx, run, o.now().UnixNano(), run.AgentID, "reply.posted", map[string]any{
					"approvalID": a.ID, "messageID": msg.ID, "edited": strings.TrimSpace(editedText) != "",
				})
				o.ChainFromAgentPost(ctx, run, msg)
			}
		}
		o.publishApproval(ctx, run, a)
	}
	return a, nil
}

// publishApproval fans the approval to the INVOKER'S PRIVATE INBOX only —
// never the channel topic. Only the person whose machine/permissions are at
// stake may see or decide it; other members receive nothing.
func (o *Orchestrator) publishApproval(ctx context.Context, run *model.Run, a *model.Approval) {
	// Resolve the agent's name once, for a freshly-requested gate only: the
	// client titles its desktop alert from this frame, and a settle/expiry
	// frame only clears a card so it needs no name.
	agentName := ""
	if a.State == model.ApprovalPending {
		if agent, err := o.users.GetUser(ctx, run.AgentID); err == nil && agent != nil {
			agentName = agent.DisplayName
		}
	}
	events.Publish(ctx, o.pub, pubsub.UserChannel(a.InvokerID), events.EventRunApproval, map[string]any{
		"approvalID": a.ID,
		"runID":      run.ID,
		"agentID":    run.AgentID,
		"agentName":  agentName,
		"invokerID":  a.InvokerID,
		"parentID":   run.ParentID,
		"parentType": run.ParentType,
		// The invoking message, so a client that surfaces a desktop alert off
		// this frame can ack it and stand the deferred mobile push down.
		"messageID": run.MessageID,
		"summary":   a.Summary,
		"risk":      a.Risk,
		"kind":      a.Kind,
		"options":   a.Options,
		"choice":    a.Choice,
		"state":     a.State,
		"deadline":  a.Deadline,
		// Editable reply proposal (propose_reply): the drafted reply + the
		// message it answers, so the card can render an editable draft.
		"replyText":        a.ReplyText,
		"replyToMessageID": a.ReplyToMessageID,
	})
	// A blocking decision the user must make — deliver a distinct alert (desktop
	// + mobile) so they notice even away from the thread, not just the live
	// card. Only for a freshly-requested approval (state pending), never on
	// settle/expiry updates.
	// Tool-permission gates arrive in bursts (a run reading five files asks
	// five times); one alert per run per minute is plenty — the cards still
	// appear individually, only the desktop/mobile ping is throttled.
	if o.notifier != nil && a.State == model.ApprovalPending && !o.throttleToolAlert(run.ID, a) {
		title := "Approval needed"
		if agentName != "" {
			verb := "needs your approval"
			if len(a.Options) > 0 {
				verb = "needs your input"
			}
			title = agentName + " " + verb
		}
		o.notifier.NotifyDirect(ctx, a.InvokerID, Notification{
			Kind:       NotificationKindApproval,
			Title:      title,
			Body:       a.Summary,
			ParentID:   run.ParentID,
			ParentType: run.ParentType,
			MessageID:  run.MessageID,
			AuthorID:   run.AgentID,
			CreatedAt:  o.now(),
		})
	}
}

// toolAlertWindow spaces the desktop/mobile alerts for permission-gateway
// approvals of one run.
const toolAlertWindow = 60 * time.Second

// throttleToolAlert reports whether a permission-gateway approval's alert
// should be suppressed because one already went out for this run recently.
// Plain approvals (request_approval / ask_user / proposals) are never throttled.
func (o *Orchestrator) throttleToolAlert(runID string, a *model.Approval) bool {
	if a.Risk != "tool" && a.Kind == "" {
		return false
	}
	now := o.now()
	if last, ok := o.toolAlertAt.Load(runID); ok && now.Sub(last.(time.Time)) < toolAlertWindow {
		return true
	}
	o.toolAlertAt.Store(runID, now)
	return false
}

// PublishArtifact stores one run-produced document (size- and count-capped)
// and audits it on the timeline.
func (o *Orchestrator) PublishArtifact(ctx context.Context, run *model.Run, kind, title, content string) (*model.Artifact, error) {
	title = strings.TrimSpace(title)
	if title == "" || strings.TrimSpace(content) == "" {
		return nil, fmt.Errorf("orchestrator: artifact title and content required: %w", ErrValidation)
	}
	if len(content) > model.ArtifactMaxBytes {
		return nil, fmt.Errorf("orchestrator: artifact exceeds %d bytes: %w", model.ArtifactMaxBytes, ErrValidation)
	}
	existing, err := o.runs.ListArtifacts(ctx, run.ID)
	if err != nil {
		return nil, err
	}
	// Kind-aware caps: agent-authored documents stay tight; auto-captured raw
	// API responses (audit trail) count against their own larger budget.
	same := 0
	for _, e := range existing {
		if (e.Kind == model.ArtifactKindAPIResponse) == (kind == model.ArtifactKindAPIResponse) {
			same++
		}
	}
	limit := model.ArtifactsPerRun
	if kind == model.ArtifactKindAPIResponse {
		limit = model.APIResponseArtifactsPerRun
	}
	if same >= limit {
		return nil, ErrArtifactCap
	}
	a := &model.Artifact{
		ID:        store.NewID(),
		RunID:     run.ID,
		AgentID:   run.AgentID,
		InvokerID: run.InvokerID,
		Kind:      kind,
		Title:     clipText(title, 200),
		Content:   content,
		CreatedAt: o.now(),
	}
	if err := o.runs.PutArtifact(ctx, a); err != nil {
		return nil, err
	}
	o.appendEvent(ctx, run, o.now().UnixNano(), run.AgentID, "artifact.created", map[string]any{
		"artifactID": a.ID, "title": a.Title, "kind": a.Kind, "bytes": len(content),
	})
	// Drop an artifact card in-thread: a marker message the SPA renders as a
	// compact expand/download card. Without it, artifacts only exist behind
	// the run drawer — invisible once the run scrolls out of recency.
	// EXCEPT auto-captured raw API responses: those are an audit trail for
	// the drawer, and a card per API call would flood the conversation.
	if kind != model.ArtifactKindAPIResponse {
		marker := "[artifact:" + run.ID + ":" + a.ID + "|" + markerSafe(a.Title) + "|" +
			markerSafe(kind) + "|" + fmt.Sprintf("%d", len(content)) + "]"
		if _, err := o.messages.SendAsAgentRun(ctx, run.AgentID, run.InvokerID, run.ParentID, run.ParentType, marker, o.replyThreadRoot(run), run.ID); err != nil {
			slog.Warn("artifact card post failed", "runID", run.ID, "artifactID", a.ID, "error", err)
		}
	}
	return a, nil
}

// markerSafe strips the characters that would break the [artifact:…|…] card
// marker; the authoritative title/kind live on the artifact row itself.
func markerSafe(s string) string {
	return strings.Map(func(r rune) rune {
		switch r {
		case '|', '[', ']', '\n', '\r':
			return ' '
		}
		return r
	}, s)
}

// Artifacts lists a run's artifacts for the drawer.
// HasApprovedApproval reports whether any approval for this run was granted —
// the hard server-side check behind reply-mode watchers (they may post publicly
// only after the invoker approves, not merely because the prompt told them to).
func (o *Orchestrator) HasApprovedApproval(ctx context.Context, runID string) (bool, error) {
	approvals, err := o.runs.ListApprovals(ctx, runID)
	if err != nil {
		return false, err
	}
	for _, a := range approvals {
		if a.State == model.ApprovalApproved {
			return true, nil
		}
	}
	return false, nil
}

func (o *Orchestrator) Artifacts(ctx context.Context, runID string) ([]*model.Artifact, error) {
	return o.runs.ListArtifacts(ctx, runID)
}

// RecordSkillInvoked audits an invoke_skill call on the run's timeline.
func (o *Orchestrator) RecordSkillInvoked(ctx context.Context, run *model.Run, skill *model.Skill) {
	o.appendEvent(ctx, run, o.now().UnixNano(), run.AgentID, "skill.invoked", map[string]any{
		"skillID": skill.ID, "name": skill.Name,
	})
}

// Run returns a run by ID regardless of state (drawer/stop access checks).
func (o *Orchestrator) Run(ctx context.Context, runID string) (*model.Run, error) {
	return o.runs.GetRun(ctx, runID)
}

// StopThread is the human brake on a runaway conversation: it cancels every
// live run in the given run's thread and drops queued handoffs, so nothing
// restarts the chain. Returns how many runs were canceled.
func (o *Orchestrator) StopThread(ctx context.Context, stopperID, runID string) (int, error) {
	run, err := o.runs.GetRun(ctx, runID)
	if err != nil {
		return 0, err
	}
	thread := o.replyThreadRoot(run)
	// Drop deferred handoffs FIRST so a cancellation can't start one.
	prefix := run.ParentID + "#" + thread + "#"
	o.deferredTurns.Range(func(k, _ any) bool {
		if strings.HasPrefix(k.(string), prefix) {
			o.deferredTurns.Delete(k)
		}
		return true
	})
	peers, err := o.runs.ListRunsByParent(ctx, run.ParentID, 100)
	if err != nil {
		return 0, err
	}
	stopped := 0
	for _, p := range peers {
		if p.State.Terminal() || o.replyThreadRoot(p) != thread {
			continue
		}
		if err := o.cancelRun(ctx, p, stopperID); err != nil {
			slog.Warn("stop thread: cancel failed", "runID", p.ID, "error", err)
			continue
		}
		stopped++
	}
	return stopped, nil
}

// cancelRun is the terminal path for a human stop: unlike fail/complete it
// deliberately SKIPS afterTerminal — no deferred turn, no pending kick —
// because the whole point is that the conversation ends here.
func (o *Orchestrator) cancelRun(ctx context.Context, run *model.Run, stopperID string) error {
	prevState := run.State
	run.State = model.RunStateCanceled
	run.FailReason = "stopped_by_user"
	run.PendingAgentIDs = nil
	run.UpdatedAt = o.now()
	if err := o.runs.UpdateRun(ctx, run, prevState); err != nil {
		if errors.Is(err, store.ErrStaleRun) {
			return nil // finished in the meantime — fine
		}
		return err
	}
	if prevState == model.RunStateQueued {
		_ = o.runs.DeleteQueueEntry(ctx, run.OwnerID, run.ID)
	}
	o.disarmLeaseTimer(run.ID)
	// Release the thread slot without afterTerminal's continuation logic.
	if key, ok := o.runThreadKey.LoadAndDelete(run.ID); ok {
		o.threadActive.Delete(key.(string))
	}
	o.appendEvent(ctx, run, o.now().UnixNano(), stopperID, "run.canceled", map[string]any{"by": stopperID})
	o.setState(ctx, run, StateEmojiBlocked)
	o.publishRun(ctx, run)
	o.writeDigest(ctx, run, "")
	// A stopped run that never posted would leave nothing to click: the live
	// chip is gone and no message carries its run id. Post a marker AS the
	// agent so "Show activity" keeps the log reachable.
	if run.Spend.Posts == 0 && (run.Mode == model.RunModeDirect || run.Mode == model.RunModeTask) {
		note := fmt.Sprintf("⏹️ stopped after %d turns — open Show activity for the log.", run.Spend.Turns)
		if _, err := o.messages.SendAsAgentRun(ctx, run.AgentID, run.InvokerID, run.ParentID, run.ParentType, note, o.replyThreadRoot(run), run.ID); err != nil {
			slog.Debug("stop notice failed", "runID", run.ID, "error", err)
		}
	}
	// Cancel doesn't run afterTerminal (it skips the continuation logic), so
	// tier the stopped run's timeline to object storage here.
	o.archiveEvents(ctx, run)
	return nil
}

// ThreadSpendSummary aggregates spend across every run in one conversation
// thread — the drawer's "whole conversation" line (a chained debate is many
// runs; per-run spend alone reads as zeros on a fresh round).
type ThreadSpendSummary struct {
	Runs         int   `json:"runs"`
	Active       int   `json:"active"`
	Turns        int   `json:"turns"`
	InputTokens  int64 `json:"inputTokens"`
	OutputTokens int64 `json:"outputTokens"`
	Posts        int   `json:"posts"`
}

// ThreadSpend sums spend over the given run's thread.
func (o *Orchestrator) ThreadSpend(ctx context.Context, run *model.Run) ThreadSpendSummary {
	var sum ThreadSpendSummary
	peers, err := o.runs.ListRunsByParent(ctx, run.ParentID, 100)
	if err != nil {
		return sum
	}
	thread := o.replyThreadRoot(run)
	for _, p := range peers {
		if o.replyThreadRoot(p) != thread {
			continue
		}
		sum.Runs++
		if !p.State.Terminal() {
			sum.Active++
		}
		sum.Turns += p.Spend.Turns
		sum.InputTokens += p.Spend.InputTokens
		sum.OutputTokens += p.Spend.OutputTokens
		sum.Posts += p.Spend.Posts
	}
	return sum
}

// ThreadTimeline is every run threaded under one root message (a coding
// task's card, a debate's opening post), oldest first, with all their events
// concatenated in time order. "Show activity" on a thread root shows the
// whole thread's work, not just the run that posted the root.
func (o *Orchestrator) ThreadTimeline(ctx context.Context, parentID, rootID string) ([]*model.Run, []*model.RunEvent, error) {
	peers, err := o.runs.ListRunsByParent(ctx, parentID, 100)
	if err != nil {
		return nil, nil, err
	}
	var runs []*model.Run
	for i := len(peers) - 1; i >= 0; i-- { // newest-first → oldest-first
		if o.replyThreadRoot(peers[i]) == rootID {
			runs = append(runs, peers[i])
		}
	}
	var events []*model.RunEvent
	for _, r := range runs {
		evts, err := o.loadEvents(ctx, r)
		if err != nil {
			return nil, nil, err
		}
		events = append(events, evts...)
	}
	return runs, events, nil
}

// ThreadMessages lists a thread's messages (root + replies) for the caller,
// access-checked by the message service — the whole-thread activity view
// shows dev's posts and the requester's steering inline with the tool work.
func (o *Orchestrator) ThreadMessages(ctx context.Context, userID, parentID, parentType, rootID string) ([]*model.Message, error) {
	return o.messages.ListThreadMessages(ctx, userID, parentID, parentType, rootID)
}

// RecordMemoryUpdate audits an update_memory tool call.
func (o *Orchestrator) RecordMemoryUpdate(ctx context.Context, run *model.Run, bytes int) {
	o.appendEvent(ctx, run, o.now().UnixNano(), run.AgentID, "memory.updated", map[string]any{"bytes": bytes})
}

// RecordWorkspaceAction audits one workspace tool call (create_channel,
// join_channel, send_dm, …) on the run's timeline — every cross-workspace
// action an agent takes is attributable from the drawer.
func (o *Orchestrator) RecordWorkspaceAction(ctx context.Context, run *model.Run, action string, payload map[string]any) {
	o.appendEvent(ctx, run, o.now().UnixNano(), run.AgentID, "workspace."+action, payload)
}
