package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
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

// ApprovalRequest describes one human-in-the-loop gate.
//
// Purpose is the field that makes a decision verifiable: a gate that later
// checks "was THIS authorized?" compares purposes for equality instead of
// searching the summary prose. It is settable only from server-side callers —
// the agent-facing endpoint always leaves it empty, so a purpose on an
// approval is proof the server raised that gate itself.
type ApprovalRequest struct {
	Summary string
	Risk    string
	// Options non-empty turns the gate into a multiple-choice question
	// (ask_user): the invoker picks one instead of approving/denying.
	Options []string
	// Kind is the harness tool class (read / edit / shell / web) for
	// permission-gateway approvals — the card uses it to offer "always allow
	// <class> for this agent". Empty = a plain gate.
	Kind    string
	Purpose string
}

// RequestApproval opens a pending approval and parks the run's state on ⛔.
// The MCP server polls ApprovalStatus until a decision or the deadline.
func (o *Orchestrator) RequestApproval(ctx context.Context, run *model.Run, req ApprovalRequest) (*model.Approval, error) {
	summary := strings.TrimSpace(req.Summary)
	// Risk is a short label the card renders ("low"/"high"/"tool"); it arrives
	// from the agent and was never bounded.
	risk, options, kind := clipText(strings.TrimSpace(req.Risk), 32), req.Options, req.Kind
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
		Purpose:   req.Purpose,
		Options:   options,
		State:     model.ApprovalPending,
		Deadline:  deadline,
		CreatedAt: now,
	}
	if err := o.runs.PutApproval(ctx, a); err != nil {
		return nil, err
	}
	o.appendEvent(ctx, run, now.UnixNano(), run.AgentID, "approval.requested", map[string]any{
		"approvalID": a.ID, "summary": summary, "risk": risk, "kind": kind,
		"purpose": req.Purpose, "deadline": deadline, "options": options,
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
	if err := o.agentSvc.PutTaskClaim(ctx, claim); err != nil {
		if !errors.Is(err, store.ErrClaimTaken) {
			return false, nil, err
		}
		mine = false
	}
	if mine {
		o.appendEvent(ctx, run, o.now().UnixNano(), run.AgentID, "task.claimed", map[string]any{"label": norm})
	}
	claims, err := o.agentSvc.TaskClaims(ctx, run.ParentID, threadRoot)
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
			run, rerr := o.runs.GetRun(ctx, runID)
			if rerr != nil {
				// The settle stuck but the run is unreadable: the invoker's card
				// would sit pending forever with nothing to clear it, so say so
				// instead of returning quietly.
				slog.Warn("approval expiry: run read failed; card not refreshed",
					"runID", runID, "approvalID", approvalID, "error", rerr)
				return a, nil
			}
			o.appendEvent(ctx, run, now.UnixNano(), run.AgentID, "approval.expired", map[string]any{"approvalID": a.ID})
			// Only a LIVE run goes back to ⚙️: re-marking a finished run as
			// working (which a late poll used to do) contradicts its ✅/❌.
			if !run.State.Terminal() {
				o.setState(ctx, run, StateEmojiWorking) // unblock the display
			}
			o.publishApproval(ctx, run, a)
		} else if !errors.Is(err, store.ErrStaleApproval) {
			return nil, err
		} else if fresh, err := o.runs.GetApproval(ctx, runID, approvalID); err == nil {
			a = fresh // a decision won the race — return it
		}
	}
	return a, nil
}

// Decision is one invoker's verdict on a gate.
//
// Text is mode-overloaded by design, and the naming used to hide it: on a
// REPLY PROPOSAL it is the edited reply that gets posted; on every other gate
// it is a note that rides the tool result back to the agent ("no — use the
// seed DB instead"). Two strings and a bool as positional arguments made that
// impossible to read at a call site.
type Decision struct {
	Approve bool
	// Choice names one of the gate's Options (ask_user); ignored otherwise.
	Choice string
	Text   string
}

// DecideApproval records the INVOKER's verdict. Nobody else may decide — the
// run acts with the invoker's permissions, so the risk is theirs.
func (o *Orchestrator) DecideApproval(ctx context.Context, deciderID, runID, approvalID string, d Decision) (*model.Approval, error) {
	approve, choice, editedText := d.Approve, d.Choice, d.Text
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
	// Past its deadline the gate is over: the run has stopped polling (or has
	// ended), so recording a decision no agent will ever read would leave the
	// human believing they approved something. Expire it and say so.
	if o.now().After(a.Deadline) {
		if _, err := o.ApprovalStatus(ctx, runID, approvalID); err != nil {
			return nil, err
		}
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

// ApprovalGranted reports whether approvalID is an APPROVED decision that
// authorizes exactly `purpose` for this run — the check every server-side gate
// makes before acting on "the invoker said yes".
//
// Purpose equality is the whole point: the gates used to accept any approved
// approval whose summary happened to CONTAIN a slug or a task id, so a
// connector named "core" was authorized by a card about "core-eu" and a
// permission click on a file read authorized a public post. An approval with
// no purpose predates the server-raised gates (an older desktop build asks the
// agent to raise the card itself); it is accepted only as a plain deliberate
// gate — never a permission-gateway click, never a reply proposal — and the
// caller still checks its subject.
func (o *Orchestrator) ApprovalGranted(ctx context.Context, runID, approvalID, purpose string) (*model.Approval, bool) {
	if approvalID == "" {
		return nil, false
	}
	a, err := o.ApprovalStatus(ctx, runID, approvalID)
	if err != nil || a.State != model.ApprovalApproved {
		return nil, false
	}
	if a.Purpose != "" {
		return a, a.Purpose == purpose
	}
	// Legacy path. It must at least be a deliberate gate the human answered —
	// not a permission-gateway click, not a reply proposal — and, when the
	// purpose names a subject, that subject has to appear in the summary as a
	// WHOLE token, so "core" is no longer authorized by a card about "core-eu".
	if a.Kind != "" || a.Risk == "tool" || a.ReplyText != "" {
		return a, false
	}
	_, subject, hasSubject := strings.Cut(purpose, ":")
	return a, !hasSubject || containsToken(a.Summary, subject)
}

// containsToken reports whether s contains token delimited by non-word
// characters — the difference between authorizing "core" and authorizing
// "core-eu".
func containsToken(s, token string) bool {
	if token == "" {
		return false
	}
	for i := 0; i+len(token) <= len(s); i++ {
		if s[i:i+len(token)] != token {
			continue
		}
		if (i == 0 || !isTokenByte(s[i-1])) && (i+len(token) == len(s) || !isTokenByte(s[i+len(token)])) {
			return true
		}
	}
	return false
}

// isTokenByte reports whether b continues an identifier-like token (letters,
// digits, '-', '_', '.') — the characters a slug or an id is made of.
func isTokenByte(b byte) bool {
	switch {
	case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9':
		return true
	case b == '-', b == '_', b == '.':
		return true
	}
	return false
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
		agentName = o.agentDisplayName(ctx, run.AgentID)
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

// agentDisplayName resolves an agent's name from the cached shared-agent
// roster, falling back to a direct read.
//
// Tool-permission gates arrive in bursts (a run reading five files asks five
// times) and each one used to cost a fresh GetUser purely to title the alert.
// The roster is memoized for 30s and changes ~never, so it answers almost
// always; the fallback covers an agent that is not in it.
func (o *Orchestrator) agentDisplayName(ctx context.Context, agentID string) string {
	for _, agent := range o.sharedAgents(ctx) {
		if agent.ID == agentID {
			return agent.DisplayName
		}
	}
	agent, err := o.users.GetUser(ctx, agentID)
	if err != nil || agent == nil {
		return "" // unknown agent: the card falls back to a generic title
	}
	return agent.DisplayName
}

// toolAlertWindow spaces the desktop/mobile alerts for permission-gateway
// approvals of one run.
const toolAlertWindow = 60 * time.Second

// throttleToolAlert reports whether a permission-gateway approval's alert
// should be suppressed because one already went out for this run recently.
// Plain approvals (request_approval / ask_user / proposals) are never throttled.
// throttleToolAlert's map is dropped by disarmLeaseTimer, which every terminal
// path goes through — otherwise it grew one entry per gated run, forever.
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

// HasDeliberateApproval reports whether the invoker granted a DELIBERATE gate
// on this run — the hard server-side check behind reply-mode watchers, which
// may post publicly only after the invoker says yes, not merely because the
// prompt told them to.
//
// "Deliberate" excludes the two kinds of approval that mean something else: a
// permission-gateway click (Kind set, or Risk "tool") is consent for one
// harness tool call, and a reply proposal is consent for the SERVER to post
// that exact text. Counting either as blanket permission to post is how a
// notify-only watcher talked its way into a channel.
func (o *Orchestrator) HasDeliberateApproval(ctx context.Context, runID string) (bool, error) {
	approvals, err := o.runs.ListApprovals(ctx, runID)
	if err != nil {
		return false, err
	}
	for _, a := range approvals {
		if a.State == model.ApprovalApproved && a.Kind == "" && a.Risk != "tool" && a.ReplyText == "" {
			return true, nil
		}
	}
	return false, nil
}

func (o *Orchestrator) Artifacts(ctx context.Context, runID string) ([]*model.Artifact, error) {
	return o.runs.ListArtifacts(ctx, runID)
}

// ArtifactsForCaller lists a run's artifacts the caller is allowed to see.
// Artifacts keep the MEMBER rule the logs gave up: an agent publishes an
// artifact INTO a conversation (its card renders there for everyone), so
// anyone who can read that conversation can open it — unlike the timeline,
// which records the invoker's private tool activity.
func (o *Orchestrator) ArtifactsForCaller(ctx context.Context, callerID, runID string) (*model.Run, []*model.Artifact, error) {
	run, err := o.RunForParentMember(ctx, callerID, runID)
	if err != nil {
		return nil, nil, err
	}
	arts, err := o.runs.ListArtifacts(ctx, run.ID)
	if err != nil {
		return nil, nil, err
	}
	return run, arts, nil
}

// RecordSkillInvoked audits an invoke_skill call on the run's timeline.
func (o *Orchestrator) RecordSkillInvoked(ctx context.Context, run *model.Run, skill *model.Skill) {
	o.appendEvent(ctx, run, o.now().UnixNano(), run.AgentID, "skill.invoked", map[string]any{
		"skillID": skill.ID, "name": skill.Name,
	})
	// Remember the NAME for this run's message badges (see RunSkillBadges).
	// In-memory on purpose: a lost entry after a restart degrades one badge,
	// never the run — and the picked-skill badges are durable on the run row.
	names, _ := o.skillUses.LoadOrStore(run.ID, &skillUseSet{})
	names.(*skillUseSet).add(skill.ID, skill.Name)
}

// skillUseSet collects the skills one run invoked, deduped by id.
type skillUseSet struct {
	mu    sync.Mutex
	ids   map[string]bool
	names []string
}

func (s *skillUseSet) add(id, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ids == nil {
		s.ids = map[string]bool{}
	}
	if s.ids[id] {
		return
	}
	s.ids[id] = true
	s.names = append(s.names, name)
}

func (s *skillUseSet) list() ([]string, map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.names...), s.ids
}

// runSkillBadgeCap bounds the badge row on one message.
const runSkillBadgeCap = 4

// RunSkillBadges names the skills a run USED, for the badges on its posted
// messages: the invoking message's /skill picks plus every invoke_skill call
// so far — never the template's standing skills (they'd tag every reply).
// Wired into MessageService via SetRunSkillResolver.
func (o *Orchestrator) RunSkillBadges(ctx context.Context, runID string) []string {
	if runID == "" {
		return nil
	}
	var names []string
	invoked := map[string]bool{}
	if v, ok := o.skillUses.Load(runID); ok {
		names, invoked = v.(*skillUseSet).list()
	}
	run, err := o.runs.GetRun(ctx, runID)
	if err == nil {
		for _, id := range run.PickedSkillIDs {
			if invoked[id] {
				continue // invoked AND picked: one badge
			}
			if sk, err := o.agentSvc.GetSkill(ctx, id); err == nil && sk != nil {
				names = append(names, sk.Name)
			}
		}
	}
	if len(names) > runSkillBadgeCap {
		names = names[:runSkillBadgeCap]
	}
	return names
}

// Run returns a run by ID regardless of state. Unchecked — internal callers
// only (the reconciler, the purge sweep). Anything serving a request uses
// RunForCaller.
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
	prefix := turnKeyPrefix(run.ParentID, thread)
	o.deferredTurns.Range(func(k, _ any) bool {
		if strings.HasPrefix(k.(string), prefix) {
			o.deferredTurns.Delete(k)
		}
		return true
	})
	// The ACTIVE_RUNS index, not a bounded page of the parent's history: only a
	// NON-TERMINAL run can be canceled, that index holds exactly those (and
	// stays small by construction), while a 100-row page of a busy channel
	// could silently miss the very run the human is trying to stop.
	peers, err := o.runs.ListActiveRuns(ctx)
	if err != nil {
		return 0, err
	}
	stopped := 0
	for _, p := range peers {
		if p.ParentID != run.ParentID || p.State.Terminal() || o.replyThreadRoot(p) != thread {
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
	if err := o.beginTerminal(ctx, run, prevState, model.RunStateCanceled, "stopped_by_user"); err != nil {
		if errors.Is(err, store.ErrStaleRun) {
			return nil // finished in the meantime — fine
		}
		return err
	}
	// Release the thread slot without afterTerminal's continuation logic.
	if key, ok := o.runThreadKey.LoadAndDelete(run.ID); ok {
		o.threadActive.Delete(key.(string))
	}
	o.finishTerminal(ctx, run, stopperID, "run.canceled", map[string]any{"by": stopperID}, "")
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

// threadRunPage bounds the per-parent listing the drawer's display layers read
// (spend totals, peer digests, whole-thread timeline). A saturated page is
// logged, never silently truncated — and the one place where completeness is
// required (StopThread) reads the ACTIVE_RUNS index instead.
const threadRunPage = 100

// threadRuns returns the runs of one parent that belong to `thread`, from a
// bounded page of the parent's history.
func (o *Orchestrator) threadRuns(ctx context.Context, parentID, thread string) []*model.Run {
	peers, err := o.runs.ListRunsByParent(ctx, parentID, threadRunPage)
	if err != nil {
		slog.Warn("thread runs: listing failed", "parentID", parentID, "error", err)
		return nil
	}
	if len(peers) >= threadRunPage {
		slog.Warn("thread runs: page saturated; older runs are not included",
			"parentID", parentID, "page", threadRunPage)
	}
	out := make([]*model.Run, 0, len(peers))
	for _, p := range peers {
		if o.replyThreadRoot(p) == thread {
			out = append(out, p)
		}
	}
	return out
}

// ThreadSpend sums spend over the given run's thread.
func (o *Orchestrator) ThreadSpend(ctx context.Context, run *model.Run) ThreadSpendSummary {
	return SpendOf(o.threadRuns(ctx, run.ParentID, o.replyThreadRoot(run)))
}

// SpendOf totals spend across runs the caller ALREADY has — the whole-thread
// drawer view was re-running the same 100-run listing purely to add this line.
func SpendOf(runs []*model.Run) ThreadSpendSummary {
	var sum ThreadSpendSummary
	for _, p := range runs {
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
func (o *Orchestrator) ThreadTimeline(ctx context.Context, callerID, parentID, rootID string) ([]*model.Run, []*model.RunEvent, int, error) {
	peers, err := o.runs.ListRunsByParent(ctx, parentID, threadRunPage)
	if err != nil {
		return nil, nil, 0, err
	}
	var runs []*model.Run
	othersRuns := false
	for i := len(peers) - 1; i >= 0; i-- { // newest-first → oldest-first
		if o.replyThreadRoot(peers[i]) != rootID {
			continue
		}
		// Logs are INVOKER-only (see checkRunAccess): the thread view shows
		// the caller's own runs and silently omits everyone else's.
		if peers[i].InvokerID != callerID {
			othersRuns = true
			continue
		}
		runs = append(runs, peers[i])
	}
	// The thread has agent activity, none of it the caller's: say "not
	// yours" (403) rather than "nothing here" — the chips are already
	// visible in the thread, so a 404 would read as broken.
	if len(runs) == 0 && othersRuns {
		return nil, nil, 0, ErrNoRunAccess
	}
	var events []*model.RunEvent
	for _, r := range runs {
		evts, err := o.loadEvents(ctx, r)
		if err != nil {
			return nil, nil, 0, err
		}
		events = append(events, evts...)
	}
	// A whole THREAD of task runs is many runs' timelines concatenated, so the
	// same bound applies here.
	kept, dropped := clipTimeline(events)
	return runs, kept, dropped, nil
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
