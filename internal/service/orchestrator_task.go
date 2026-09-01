package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
)

// Coding-task hooks on the orchestrator (plan-coding-agent.md). Everything
// here is inert until SetTaskStore wires persistence.

// taskConnectorSlug is the connector every task run rides when the requester
// has it installed — the runner needs the GitLab credential for clone/push
// and the MR call.
const taskConnectorSlug = "gitlab"

// StartTaskRun starts a run bound to a task: the task's agent, executed for
// the REQUESTER (their machine, their quota) even when a steering message
// came from someone else, threaded under the task card, with an explicit
// prompt. Used for the kickoff after create_coding_task and the sign-off run.
func (o *Orchestrator) StartTaskRun(ctx context.Context, task *model.CodingTask, requester *model.User, msg *model.Message, prompt string) error {
	agent, err := o.users.GetUser(ctx, task.AgentID)
	if err != nil {
		return fmt.Errorf("orchestrator: task agent: %w", err)
	}
	if !agent.IsAgent() {
		return errors.New("orchestrator: task agent is not an agent")
	}
	return o.invokeWith(ctx, agent, requester, msg, ParentChannel, 0, nil, model.RunModeTask, nil, nil, &taskBind{task: task, prompt: prompt})
}

// dispatchTask resumes a task's agent for an UN-MENTIONED message: a reply
// inside a task thread, or a top-level message in a project channel from
// someone entitled to steer exactly one active task there. Steering is not
// bound to the thread — but the run always is (it threads under the card).
//
// Authority vs steering: a non-requester's message (steering=anyone) still
// runs on the REQUESTER's machine and quota — the invoker is the requester.
func (o *Orchestrator) dispatchTask(ctx context.Context, msg *model.Message, parentType string, author *model.User, invoked map[string]bool) {
	if o.tasks == nil || parentType != ParentChannel || author == nil {
		return
	}
	var task *model.CodingTask
	routed := false
	if msg.ParentMessageID != "" {
		t, err := o.tasks.GetTaskByThread(ctx, msg.ParentMessageID)
		if err != nil {
			return // not a task thread
		}
		task = t
	} else {
		tasks, err := o.tasks.ListTasksByChannel(ctx, msg.ParentID)
		if err != nil || len(tasks) == 0 {
			return
		}
		var candidates []*model.CodingTask
		for _, t := range tasks {
			if !t.State.Terminal() && t.SteerEntitled(author.ID) {
				candidates = append(candidates, t)
			}
		}
		if len(candidates) != 1 {
			if len(candidates) > 1 {
				slog.Debug("task routing: ambiguous top-level message", "channelID", msg.ParentID, "candidates", len(candidates))
			}
			return
		}
		task, routed = candidates[0], true
	}
	if task.State.Terminal() || !task.SteerEntitled(author.ID) || invoked[task.AgentID] {
		return
	}
	agent, err := o.users.GetUser(ctx, task.AgentID)
	if err != nil || !agent.IsAgent() {
		return
	}
	invoker := author
	if author.ID != task.RequesterID {
		if invoker, err = o.users.GetUser(ctx, task.RequesterID); err != nil {
			return
		}
	}
	invoked[agent.ID] = true
	bind := &taskBind{task: task}
	if routed {
		bind.prompt = fmt.Sprintf("[steering from ~%s, posted top-level by %s] %s", task.ProjectKey, author.DisplayName, stripMentionMarkup(msg.Body))
	} else if author.ID != task.RequesterID {
		bind.prompt = fmt.Sprintf("[steering by %s, a channel member — the requester allowed anyone to steer] %s", author.DisplayName, stripMentionMarkup(msg.Body))
	}
	err = o.invokeWith(ctx, agent, invoker, msg, parentType, 0, nil, model.RunModeTask, nil, nil, bind)
	if errors.Is(err, ErrAgentBusy) {
		// Steering that lands mid-run must not be lost: park it as the
		// thread's deferred turn (first wins) and start it when the current
		// run ends — the same mechanism chain mentions use.
		key := msg.ParentID + "#" + task.ThreadRootID + "#" + agent.ID
		o.deferredTurns.LoadOrStore(key, &deferredTurn{
			agentID: agent.ID, invokerID: invoker.ID, msg: msg, parentType: parentType, bind: bind,
		})
		return
	}
	if err != nil {
		o.postInvokeFailure(ctx, agent, invoker, msg, parentType, err)
	}
}

// withTaskConnectors appends the gitlab connector to a task run's picks when
// the requester has it installed and it isn't already there.
func (o *Orchestrator) withTaskConnectors(ctx context.Context, invokerID string, slugs []string) []string {
	if o.connectors == nil {
		return slugs
	}
	for _, s := range slugs {
		if s == taskConnectorSlug {
			return slugs
		}
	}
	idx, err := o.connectors.InstalledIndex(ctx, invokerID)
	if err != nil {
		return slugs
	}
	for _, c := range idx {
		if c.Slug == taskConnectorSlug {
			return append(append([]string(nil), slugs...), taskConnectorSlug)
		}
	}
	return slugs
}

// taskForClaim resolves a run's task for the claim path and enforces
// machine affinity: a task pinned to another of the owner's runners that is
// still LIVE belongs to that machine (skip). A dead pinned runner releases
// the pin — the claiming machine inherits the task and re-clones.
func (o *Orchestrator) taskForClaim(ctx context.Context, run *model.Run, ownerID, runnerID string) (*model.CodingTask, error) {
	if run.TaskID == "" || o.tasks == nil {
		return nil, nil
	}
	task, err := o.tasks.GetTask(ctx, run.TaskID)
	if err != nil {
		slog.Warn("claim: task lookup failed", "runID", run.ID, "taskID", run.TaskID, "error", err)
		return nil, nil // the run still executes; it just has no spec
	}
	if task.RunnerID != "" && task.RunnerID != runnerID {
		if runners, err := o.agentSvc.LiveRunners(ctx, ownerID); err == nil {
			for _, r := range runners {
				if r.RunnerID == task.RunnerID {
					return nil, errors.New("task pinned to another live runner")
				}
			}
		}
	}
	return task, nil
}

// pinTaskRun records the claim on the task: workspace machine affinity (first
// claim wins; a released pin re-pins), the run id, and the last-run time.
func (o *Orchestrator) pinTaskRun(ctx context.Context, task *model.CodingTask, run *model.Run, runnerID string) {
	changed := false
	if task.RunnerID != runnerID {
		task.RunnerID = runnerID
		changed = true
	}
	seen := false
	for _, id := range task.RunIDs {
		if id == run.ID {
			seen = true
			break
		}
	}
	if !seen {
		task.RunIDs = append(task.RunIDs, run.ID)
		if len(task.RunIDs) > 50 {
			task.RunIDs = task.RunIDs[len(task.RunIDs)-50:]
		}
		changed = true
	}
	if !changed {
		return
	}
	now := o.now()
	task.LastRunAt = &now
	task.UpdatedAt = now
	if err := o.tasks.UpdateTask(ctx, task, task.State); err != nil {
		slog.Warn("claim: task pin failed", "taskID", task.ID, "error", err)
	}
}

// taskSpecOf snapshots the task for the runner.
func taskSpecOf(t *model.CodingTask) *model.TaskSpec {
	spec := &model.TaskSpec{
		ID:           t.ID,
		ProjectKey:   t.ProjectKey,
		ProjectName:  t.ProjectName,
		Title:        t.Title,
		Goal:         t.Goal,
		Kind:         t.Kind,
		State:        string(t.State),
		ChannelID:    t.ChannelID,
		ThreadRootID: t.ThreadRootID,
		SignedOff:    t.SignedOffAt != nil,
		RunnerID:     t.RunnerID,
	}
	if t.TestPlan != nil {
		spec.TestURL = t.TestPlan.URL
	}
	for _, r := range t.Repos {
		spec.Repos = append(spec.Repos, model.TaskSpecRepo{Path: r.Path, Role: r.Role, Branch: r.Branch, BaseBranch: r.BaseBranch, MRURL: r.MRURL})
	}
	return spec
}

// renderTaskSection is the bundle's "# Coding task" layer — the deterministic
// spec and the rules of engagement the model must not improvise around.
func renderTaskSection(t *model.CodingTask) string {
	var b strings.Builder
	b.WriteString("\n# Coding task\n")
	fmt.Fprintf(&b, "- Task: %s — %s (id %s)\n", model.TaskKindFlair(t.Kind), t.Title, t.ID)
	fmt.Fprintf(&b, "- Project: %s\n", t.ProjectName)
	for _, r := range t.Repos {
		fmt.Fprintf(&b, "- Repo (%s): %s — branch %s (base: %s)%s\n", r.Role, r.Path, r.Branch,
			firstNonEmpty(r.BaseBranch, "the repo's default branch"), mrSuffix(r))
	}
	fmt.Fprintf(&b, "- State: %s\n", t.State)
	if t.TestPlan != nil && t.TestPlan.URL != "" {
		fmt.Fprintf(&b, "- Test plan published for: %s\n", t.TestPlan.URL)
	}
	if t.SignedOffAt != nil {
		b.WriteString("- The requester has SIGNED OFF: request_mr will be approved.\n")
	} else {
		b.WriteString("- Not signed off yet: never push or open an MR — request_mr asks the requester.\n")
	}
	if t.Ticket != nil {
		fmt.Fprintf(&b, "- Ticket: %s %s %s\n", t.Ticket.Connector, t.Ticket.ID, t.Ticket.URL)
	}
	b.WriteString("Rules:\n" +
		"- Scope: work only inside the checkouts listed above. The product's UI lives in the frontend repo — extend " +
		"IT, never build a new UI/app from scratch. If the change needs a repo the task doesn't list, say so in the " +
		"thread and ask (task_state + ask_user) instead of improvising.\n" +
		"- Commits: commit as you go with clear messages (trailer `Co-authored-by: dev (Ex coding agent) " +
		"<dev@ex.local>`). Anything unrelated to the ticket (a bug you tripped over, demo data, tooling) goes in its " +
		"OWN commit and gets named in the MR note.\n" +
		"- Chat: SHORT milestone updates with post_message — root cause, plan, result; a few bullets, under ~120 " +
		"words. The thread is a status feed the requester skims on their phone, not a design doc — depth belongs in " +
		"commits and code. Never end a turn silently after an unexpected tool ERROR: retry once, then post what " +
		"failed and where you stopped.\n" +
		"- Testing: run the project's own suites before claiming anything works, AND verify through the product's " +
		"real surface — real HTTP requests / the UI, signed in as the account the requester will use. Internal-layer " +
		"checks (service calls, unauthenticated paths) miss what real users hit: serializers, middleware, permissions.\n" +
		"- Test plan (publish_test_plan): before publishing, WALK the plan yourself against the running product. " +
		"Every account you name must be one you verified logs in (exact email + password). The view/month/filter the " +
		"plan opens on must already show the relevant data — seed visible demo data first if it doesn't. Steps are " +
		"from the requester's perspective (open, click, see), plus counter-checks (what must NOT happen, who must " +
		"NOT see it, what must still work) — never just an API endpoint. Then END your turn; replies here resume you.\n" +
		"- MR (request_mr, only after sign-off): pass repo_notes — per repo, 3-8 reviewer-facing bullets: what " +
		"changed and why, notable decisions, anything a reviewer might want split out. NEVER put local setup, " +
		"localhost URLs, seeded accounts, passwords, debug notes or test-plan steps in an MR — Ex appends the task " +
		"link and signature itself.\n" +
		"- Ticket: after mr_created, if the task has a ticket and its connector is attached, post ONE comment on it " +
		"and move its status if the API allows; say in the thread if you can't. Write for the ticket's readers — " +
		"the reporter, PM, QA, whoever deploys — not for code reviewers, and as long as the content needs (no " +
		"padding, no word games). Structure it in labelled blocks, each its own paragraph or list, never one " +
		"run-on paragraph: **Status** — Fixed / In review + one MR link per repo · **What changed** — what users " +
		"now see or can do, bullets · **Caveats** — REQUIRED whenever any exist: behavior that differs by role or " +
		"permission, anything intentionally left out or deferred, config/setting/migration/flag steps someone must " +
		"do, known limitations, assumptions you made · **How to verify** — the steps QA takes · sign-off line " +
		"`— posted by Ex (dev) for <requester>`. Root cause belongs here only when it changes what readers should " +
		"do or expect; code-level detail stays in the MR. Match the ticket system's markup: if its descriptions " +
		"come back as HTML, send HTML (<p>, <strong>, <ul><li>, <a>); otherwise plain text with a blank line " +
		"between blocks.\n" +
		"Replies in this thread are steering: acknowledge and act on them.\n")
	return b.String()
}

func mrSuffix(r model.TaskRepo) string {
	if r.MRURL != "" {
		return " — MR " + r.MRURL
	}
	return ""
}

// renderProjectsIndex is the bundle's ambient list of KNOWN projects (products
// and their repos) so an intake run can hand a "finish CS-7 in CliffHub" ask
// straight to create_coding_task with the right project, and knows when to
// ask the requester instead.
func renderProjectsIndex(projects []*model.CodingProject) string {
	if len(projects) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n# Known coding projects (products → repos)\n")
	b.WriteString("Use the PRODUCT name as create_coding_task's project. A product not listed here needs its " +
		"repos (frontend/backend/…) from the requester — ask, never guess a single repo for a full-stack change.\n")
	for _, p := range projects {
		var repos []string
		for _, r := range p.Repos {
			repos = append(repos, r.Path+" ("+r.Role+")")
		}
		fmt.Fprintf(&b, "- %s: %s\n", p.Name, strings.Join(repos, ", "))
	}
	return b.String()
}
