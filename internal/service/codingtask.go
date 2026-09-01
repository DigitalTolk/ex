package service

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"strings"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// Coding tasks (plan-coding-agent.md): the deterministic task layer around
// the dev agent. This service owns projects (a product = its repos + its
// channel), task creation (project channel + task card thread + row), the
// lifecycle state machine and its gates (nothing reaches mr_created without
// the requester's sign-off), the requester-facing test plan, and the
// deterministic thread notes that narrate lifecycle beats. The model writes
// diffs; this code decides what a task IS and when it may move.

// AgentSlugDev is the seeded coding agent. Like gg/qib it is a shared user;
// unlike them it is the ONLY agent that WORKS coding tasks (any agent may
// open one — a hand-off).
const AgentSlugDev = "dev"

// Task-layer errors.
var (
	ErrTaskActive     = errors.New("task: this project already has an active task")
	ErrNotRequester   = errors.New("task: only the requester may do that")
	ErrTaskTransition = errors.New("task: illegal state transition")
	ErrTaskNotReady   = errors.New("task: not ready for that step")
	ErrTaskAgent      = errors.New("task: the coding agent is not available")
	ErrNotTaskRun     = errors.New("task: this run is not bound to a coding task")
	// ErrProjectUnknown: a new project needs its repos — the agent must ask
	// the requester which GitLab repositories make up the product.
	ErrProjectUnknown = errors.New("task: unknown project — its repositories are needed")
)

// taskStore is the persistence surface (store.TaskStore).
type taskStore interface {
	CreateTask(ctx context.Context, t *model.CodingTask) error
	GetTask(ctx context.Context, id string) (*model.CodingTask, error)
	UpdateTask(ctx context.Context, t *model.CodingTask, expectState model.TaskState) error
	ListTasksByChannel(ctx context.Context, channelID string) ([]*model.CodingTask, error)
	GetTaskByThread(ctx context.Context, threadRootID string) (*model.CodingTask, error)
	CreateProject(ctx context.Context, p *model.CodingProject) error
	UpdateProject(ctx context.Context, p *model.CodingProject) error
	GetProject(ctx context.Context, key string) (*model.CodingProject, error)
	ListProjects(ctx context.Context) ([]*model.CodingProject, error)
}

// taskChannels is the channel surface: create-or-reuse the project channel
// by derived ID and manage its membership without a human actor.
type taskChannels interface {
	GetByID(ctx context.Context, id string) (*model.Channel, error)
	GetBySlug(ctx context.Context, slug string) (*model.Channel, error)
	CreateWithID(ctx context.Context, userID, id, name string, chanType model.ChannelType, description string) (*model.Channel, error)
	AutoJoinChannel(ctx context.Context, userID, channelID string, role model.ChannelRole) error
	IsMember(ctx context.Context, userID, channelID string) bool
}

// taskMessages is the message surface: agent-authored posts, the pinned
// task card and its in-place rewrites.
type taskMessages interface {
	SendAsAgentRun(ctx context.Context, agentID, invokerID, parentID, parentType, body, parentMessageID, runID string) (*model.Message, error)
	RewriteAgentMessage(ctx context.Context, agentID, parentID, parentType, msgID, body string) (*model.Message, error)
	SetPinned(ctx context.Context, userID, parentID, parentType, msgID string, pinned bool) (*model.Message, error)
	CheckAccess(ctx context.Context, userID, parentID, parentType string) error
}

// CodingTaskService is the task layer.
type CodingTaskService struct {
	tasks    taskStore
	channels taskChannels
	messages taskMessages
	users    orchestratorUsers
	agents   *AgentService
	orch     *Orchestrator
	baseURL  string
	now      func() time.Time
}

// NewCodingTaskService wires the task layer.
func NewCodingTaskService(tasks taskStore, channels taskChannels, messages taskMessages, users orchestratorUsers, agents *AgentService, orch *Orchestrator) *CodingTaskService {
	return &CodingTaskService{
		tasks:    tasks,
		channels: channels,
		messages: messages,
		users:    users,
		agents:   agents,
		orch:     orch,
		now:      time.Now,
	}
}

// SetBaseURL wires the public origin used for task-thread permalinks.
func (s *CodingTaskService) SetBaseURL(u string) { s.baseURL = strings.TrimRight(u, "/") }

// ProjectKey normalizes a product name into its key: "CliffHub" → "cliffhub",
// "Booking Portal" → "booking-portal". The key names the channel and derives
// its ID, so two spellings of one product land in one place.
func ProjectKey(name string) string {
	return strings.Trim(slugify(strings.TrimSpace(name)), "-")
}

// ProjectChannelID is the derived, coordination-free ID of a project's
// channel: the first task on a project creates it, every later task finds it.
func ProjectChannelID(projectKey string) string {
	return store.DeriveID("codechan#" + projectKey)
}

// TaskMarker renders the task card message body — machine syntax the SPA
// renders as a live card: [task:<id>|<title>|<state>|<kind>|<project>].
func TaskMarker(t *model.CodingTask) string {
	return fmt.Sprintf("[task:%s|%s|%s|%s|%s]", t.ID, markerSafe(t.Title), t.State, t.Kind, markerSafe(t.ProjectName))
}

// TaskURL is the permalink to a task's thread (the card message).
func (s *CodingTaskService) TaskURL(t *model.CodingTask) string {
	if s.baseURL == "" {
		return ""
	}
	return s.baseURL + "/channel/" + t.ChannelID + "#msg-" + t.ThreadRootID
}

// RepoInput names one repo of a task/project.
type RepoInput struct {
	Path       string
	Role       string
	BaseBranch string
}

// CreateTaskInput is what intake resolved from the ask.
type CreateTaskInput struct {
	// Project is the PRODUCT name ("CliffHub"), not a repo path.
	Project string
	// Repos the task touches. Required for a project Ex hasn't seen yet;
	// optional afterwards (defaults to every repo the project is known to
	// have — untouched repos simply get no MR).
	Repos      []RepoInput
	Title      string
	Goal       string
	Kind       string
	BaseBranch string // default base for repos that don't name one
	Ticket     *model.TaskTicket
}

// CreateTaskResult is what the creating agent learns back.
type CreateTaskResult struct {
	Task           *model.CodingTask
	Project        *model.CodingProject
	ProjectCreated bool
	Channel        *model.Channel
	ChannelCreated bool
	URL            string
	// KickoffErr is set when the task exists but its first run could not
	// start (the requester's runner vanished between intake and kickoff).
	KickoffErr error
}

// Create opens a coding task for the run's invoker (the requester): resolves
// or records the project (product + repos), ensures its channel + membership,
// posts the pinned task card (the thread root), writes the row, posts the
// pointer back where the ask happened, and starts the first task run.
//
// Any agent may OPEN a task (gg being asked "finish CS-7" must hand off
// cleanly instead of hacking on the invoker's disk) — but dev is the only
// agent that WORKS it: the card, the thread, the runs are all dev's.
//
// v0 rule: ONE active task per project — a second ask gets ErrTaskActive
// with a pointer to the running task.
func (s *CodingTaskService) Create(ctx context.Context, run *model.Run, in CreateTaskInput) (*CreateTaskResult, error) {
	agent, err := s.users.GetUser(ctx, AgentUserID(AgentSlugDev))
	if err != nil || !agent.IsAgent() {
		return nil, ErrTaskAgent
	}
	requester, err := s.users.GetUser(ctx, run.InvokerID)
	if err != nil {
		return nil, fmt.Errorf("task: requester lookup: %w", err)
	}

	name := strings.TrimSpace(in.Project)
	if name == "" || len(name) > model.TaskProjectNameMaxLen {
		return nil, fmt.Errorf("task: project (product) name required, ≤%d chars: %w", model.TaskProjectNameMaxLen, ErrValidation)
	}
	// A repo path passed as the project name is the classic mistake — the
	// product is "CliffHub", not "dtolk/internal-tools/cliffhub-2-backend".
	if strings.Contains(name, "/") {
		return nil, fmt.Errorf("task: project must be the PRODUCT name (e.g. \"CliffHub\"), not a repo path — pass repos separately: %w", ErrValidation)
	}
	key := ProjectKey(name)
	if !model.ValidProjectKey(key) {
		return nil, fmt.Errorf("task: project name %q does not make a usable key: %w", name, ErrValidation)
	}
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return nil, fmt.Errorf("task: title required: %w", ErrValidation)
	}
	// Ticket APIs hand back HTML entities ("Birthday &amp; Anniversary") —
	// decode so the card, branch name and MR title read as text.
	title = clipText(html.UnescapeString(title), model.TaskTitleMaxLen)
	goal := html.UnescapeString(strings.TrimSpace(in.Goal))
	if goal == "" {
		return nil, fmt.Errorf("task: goal required: %w", ErrValidation)
	}
	if len(goal) > model.TaskGoalMaxLen {
		return nil, fmt.Errorf("task: goal too long (max %d): %w", model.TaskGoalMaxLen, ErrValidation)
	}
	kind := strings.ToLower(strings.TrimSpace(in.Kind))
	if kind == "" {
		kind = model.TaskKindBug
	}
	if !model.ValidTaskKind(kind) {
		return nil, fmt.Errorf("task: kind must be bug, feature or chore: %w", ErrValidation)
	}
	if err := validBranchName(in.BaseBranch); err != nil {
		return nil, err
	}
	repos, err := normalizeRepos(in.Repos, in.BaseBranch)
	if err != nil {
		return nil, err
	}

	// Project: known → reuse (and learn any new repos); new → needs repos.
	proj, err := s.tasks.GetProject(ctx, key)
	projectCreated := false
	switch {
	case err == nil:
		if len(repos) == 0 {
			repos = projectTaskRepos(proj, in.BaseBranch)
		} else if s.mergeProjectRepos(proj, repos) {
			proj.UpdatedAt = s.now()
			if err := s.tasks.UpdateProject(ctx, proj); err != nil {
				slog.Warn("project repo merge failed", "project", key, "error", err)
			}
		}
	case errors.Is(err, store.ErrNotFound):
		if len(repos) == 0 {
			return nil, fmt.Errorf("%w: %q — ask the requester which GitLab repos (frontend, backend, …) make up it and pass them as repos", ErrProjectUnknown, name)
		}
		proj = &model.CodingProject{
			Key:       key,
			Name:      name,
			ChannelID: ProjectChannelID(key),
			CreatedBy: requester.ID,
			CreatedAt: s.now(),
			UpdatedAt: s.now(),
		}
		for _, r := range repos {
			proj.Repos = append(proj.Repos, model.ProjectRepo{Path: r.Path, Role: r.Role})
		}
		projectCreated = true
	default:
		return nil, fmt.Errorf("task: project lookup: %w", err)
	}
	if len(repos) == 0 {
		return nil, fmt.Errorf("%w: %q has no repos on record", ErrProjectUnknown, name)
	}

	channelID := proj.ChannelID
	// One active task per project (v0).
	existing, err := s.tasks.ListTasksByChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("task: list: %w", err)
	}
	// A task whose merge requests are already open (mr_created) is SHIPPED —
	// the merge watcher is v2, so it would otherwise block its project
	// forever. It is closed below, once the new task exists, with a note
	// saying what superseded it. Everything else non-terminal still blocks.
	var superseded []*model.CodingTask
	for _, t := range existing {
		switch {
		case t.State.Terminal():
		case t.State == model.TaskStateMRCreated:
			superseded = append(superseded, t)
		default:
			return nil, fmt.Errorf("%w: %q is %s — follow it at %s", ErrTaskActive, t.Title, t.State, s.TaskURL(t))
		}
	}

	ch, created, err := s.ensureChannel(ctx, requester, channelID, proj)
	if err != nil {
		return nil, err
	}
	if projectCreated {
		if err := s.tasks.CreateProject(ctx, proj); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
			return nil, fmt.Errorf("task: create project: %w", err)
		}
	}
	// Membership is server-managed: the requester (creator or later joiner)
	// and the coding agent are always in the project channel.
	if !s.channels.IsMember(ctx, requester.ID, ch.ID) {
		if err := s.channels.AutoJoinChannel(ctx, requester.ID, ch.ID, model.ChannelRoleMember); err != nil {
			return nil, fmt.Errorf("task: add requester to channel: %w", err)
		}
	}
	if !s.channels.IsMember(ctx, agent.ID, ch.ID) {
		if err := s.channels.AutoJoinChannel(ctx, agent.ID, ch.ID, model.ChannelRoleMember); err != nil {
			return nil, fmt.Errorf("task: add agent to channel: %w", err)
		}
	}

	now := s.now()
	task := &model.CodingTask{
		ID:          store.NewID(),
		ProjectKey:  proj.Key,
		ProjectName: proj.Name,
		Title:       title,
		Goal:        goal,
		Kind:        kind,
		State:       model.TaskStateCreated,
		Steering:    model.TaskSteeringRequester,
		ChannelID:   ch.ID,
		RequesterID: requester.ID,
		AgentID:     agent.ID,
		Repos:       repos,
		Ticket:      in.Ticket,
		RunIDs:      []string{run.ID},
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	branch := taskBranch(task)
	for i := range task.Repos {
		task.Repos[i].Branch = branch
	}

	// The task card is the thread root — posted by dev, for the requester,
	// before the row exists (the row needs the message ID).
	card, err := s.messages.SendAsAgentRun(ctx, agent.ID, requester.ID, ch.ID, ParentChannel, TaskMarker(task), "", run.ID)
	if err != nil {
		return nil, fmt.Errorf("task: post card: %w", err)
	}
	task.ThreadRootID = card.ID
	if err := s.tasks.CreateTask(ctx, task); err != nil {
		return nil, fmt.Errorf("task: create: %w", err)
	}
	if _, err := s.messages.SetPinned(ctx, requester.ID, ch.ID, ParentChannel, card.ID, true); err != nil {
		slog.Warn("task card pin failed", "taskID", task.ID, "error", err)
	}
	s.orch.RecordWorkspaceAction(ctx, run, "task_created", map[string]any{
		"taskID": task.ID, "channelID": ch.ID, "threadRootID": card.ID, "project": proj.Name, "repos": repoPaths(task.Repos), "kind": kind,
	})

	// Pointer back where the ask happened — deterministic, so the intake run
	// need not (and should not) narrate it. Counting it as the run's post
	// keeps CompleteRun from ALSO posting the model's final text.
	if run.ParentID != ch.ID || s.orch.replyThreadRoot(run) != card.ID {
		back := "🛠️ Taking this to ~" + ch.Slug + " → " + model.TaskKindFlair(kind) + " **" + title + "**" +
			" (" + strings.Join(repoNames(task.Repos), ", ") + ")"
		if u := s.TaskURL(task); u != "" {
			back += " — follow along: " + u
		}
		if _, err := s.messages.SendAsAgentRun(ctx, agent.ID, requester.ID, run.ParentID, run.ParentType, back, s.orch.replyThreadRoot(run), run.ID); err != nil {
			slog.Warn("task link-back post failed", "taskID", task.ID, "error", err)
		} else if _, err := s.orch.RecordAgentPost(ctx, run.ID); err != nil {
			slog.Debug("task link-back post count", "runID", run.ID, "error", err)
		}
	}

	res := &CreateTaskResult{Task: task, Project: proj, ProjectCreated: projectCreated, Channel: ch, ChannelCreated: created, URL: s.TaskURL(task)}
	for _, old := range superseded {
		prev := old.State
		old.State = model.TaskStateDone
		old.UpdatedAt = s.now()
		if err := s.tasks.UpdateTask(ctx, old, prev); err != nil {
			slog.Warn("superseded task close failed", "taskID", old.ID, "error", err)
			continue
		}
		verb := "stay"
		if len(old.MRURLs()) == 1 {
			verb = "stays"
		}
		note := "✅ Closing this task — its merge request" + plural(len(old.MRURLs())) + " " + verb + " open on GitLab (" +
			strings.Join(old.MRURLs(), " · ") + "). Superseded by a new task"
		if u := s.TaskURL(task); u != "" {
			note += ": " + u
		}
		s.postNote(ctx, old, "", note+".")
		s.refreshCard(ctx, old)
	}
	// Kick off the first task run in the task thread. Failing here leaves a
	// valid task the requester can resume by replying in its thread.
	if err := s.orch.StartTaskRun(ctx, task, requester, card, kickoffPrompt(task, requester.DisplayName)); err != nil {
		slog.Warn("task kickoff failed", "taskID", task.ID, "error", err)
		res.KickoffErr = err
		s.postNote(ctx, task, run.ID, "⛔ Couldn't start working yet — "+invokeFailureDetail(err)+" Reply in this thread to retry.")
	}
	return res, nil
}

// validBranchName rejects branch names git would (spaces, control chars,
// ref-syntax) — enough to keep the runner's shell safe.
func validBranchName(b string) error {
	b = strings.TrimSpace(b)
	if len(b) > model.TaskBranchMaxLen || strings.ContainsAny(b, " \t\n~^:?*[\\") || strings.Contains(b, "..") {
		return fmt.Errorf("task: invalid branch name %q: %w", b, ErrValidation)
	}
	return nil
}

// normalizeRepos validates and dedupes repo inputs into task repos.
func normalizeRepos(in []RepoInput, defaultBase string) ([]model.TaskRepo, error) {
	var out []model.TaskRepo
	seen := map[string]bool{}
	for _, r := range in {
		p := strings.Trim(strings.TrimSpace(r.Path), "/")
		if p == "" {
			continue
		}
		if !model.ValidProjectPath(p) {
			return nil, fmt.Errorf("task: repo %q must be a GitLab path like group/repo: %w", p, ErrValidation)
		}
		if seen[p] {
			continue
		}
		seen[p] = true
		role := strings.ToLower(strings.TrimSpace(r.Role))
		if !model.ValidRepoRole(role) {
			return nil, fmt.Errorf("task: repo role %q must be backend, frontend, mobile, infra or other: %w", role, ErrValidation)
		}
		if role == "" {
			role = model.RepoRoleOther
		}
		base := strings.TrimSpace(r.BaseBranch)
		if base == "" {
			base = strings.TrimSpace(defaultBase)
		}
		if err := validBranchName(base); err != nil {
			return nil, err
		}
		out = append(out, model.TaskRepo{Path: p, Role: role, BaseBranch: base})
	}
	if len(out) > model.TaskMaxRepos {
		return nil, fmt.Errorf("task: at most %d repos per task: %w", model.TaskMaxRepos, ErrValidation)
	}
	return out, nil
}

// projectTaskRepos turns a project's repos into a task's default repo list.
func projectTaskRepos(p *model.CodingProject, defaultBase string) []model.TaskRepo {
	out := make([]model.TaskRepo, 0, len(p.Repos))
	for _, r := range p.Repos {
		base := strings.TrimSpace(defaultBase)
		if base == "" {
			base = r.DefaultBranch
		}
		out = append(out, model.TaskRepo{Path: r.Path, Role: r.Role, BaseBranch: base})
	}
	return out
}

// mergeProjectRepos adds repos the project didn't know; true when changed.
func (s *CodingTaskService) mergeProjectRepos(p *model.CodingProject, repos []model.TaskRepo) bool {
	changed := false
	for _, r := range repos {
		found := false
		for i := range p.Repos {
			if p.Repos[i].Path == r.Path {
				found = true
				if p.Repos[i].Role == model.RepoRoleOther && r.Role != model.RepoRoleOther {
					p.Repos[i].Role = r.Role
					changed = true
				}
				break
			}
		}
		if !found && len(p.Repos) < model.TaskMaxRepos {
			p.Repos = append(p.Repos, model.ProjectRepo{Path: r.Path, Role: r.Role})
			changed = true
		}
	}
	return changed
}

func repoPaths(repos []model.TaskRepo) []string {
	out := make([]string, 0, len(repos))
	for _, r := range repos {
		out = append(out, r.Path)
	}
	return out
}

func repoNames(repos []model.TaskRepo) []string {
	out := make([]string, 0, len(repos))
	for _, r := range repos {
		out = append(out, model.RepoName(r.Path))
	}
	return out
}

// ensureChannel finds the project channel by derived ID or creates it, named
// after the PRODUCT (falling back to "<name> code", then a short hash, when a
// human channel already owns the slug).
func (s *CodingTaskService) ensureChannel(ctx context.Context, requester *model.User, channelID string, proj *model.CodingProject) (*model.Channel, bool, error) {
	if ch, err := s.channels.GetByID(ctx, channelID); err == nil && ch != nil {
		return ch, false, nil
	} else if err != nil && !errors.Is(err, store.ErrNotFound) {
		return nil, false, fmt.Errorf("task: channel lookup: %w", err)
	}
	// Channel names are slug-style (ValidateChannelName) — the pretty product
	// name lives in the description. proj.Key is a valid slug by construction;
	// clip the suffixed fallbacks back under the name cap.
	clip := func(s string) string {
		if len(s) > MaxChannelNameLen {
			s = strings.Trim(s[:MaxChannelNameLen], "-")
		}
		return s
	}
	candidates := []string{proj.Key, clip(proj.Key + "-code"), clip(proj.Key + "-" + strings.ToLower(channelID[len(channelID)-6:]))}
	desc := clipText("Coding tasks for "+proj.Name+" ("+strings.Join(projectRepoNames(proj), ", ")+") — one thread per task, run by dev.", MaxChannelDescriptionLen)
	var lastErr error
	for _, name := range candidates {
		if existing, err := s.channels.GetBySlug(ctx, slugify(name)); err == nil && existing != nil {
			continue // a human channel owns this name
		}
		ch, err := s.channels.CreateWithID(ctx, requester.ID, channelID, name, model.ChannelTypePrivate, desc)
		if err == nil {
			return ch, true, nil
		}
		lastErr = err
		if !errors.Is(err, ErrAlreadyExists) {
			break
		}
	}
	// Lost a create race? The derived ID is the truth — read it back.
	if ch, err := s.channels.GetByID(ctx, channelID); err == nil && ch != nil {
		return ch, false, nil
	}
	return nil, false, fmt.Errorf("task: create project channel: %w", lastErr)
}

func projectRepoNames(p *model.CodingProject) []string {
	out := make([]string, 0, len(p.Repos))
	for _, r := range p.Repos {
		out = append(out, model.RepoName(r.Path))
	}
	return out
}

// taskBranch names the task branch (same name in every repo of the task):
// ex/task-<short id>-<title slug>.
func taskBranch(t *model.CodingTask) string {
	id := strings.ToLower(t.ID)
	if len(id) > 6 {
		id = id[len(id)-6:]
	}
	slug := strings.Trim(slugify(t.Title), "-")
	b := "ex/task-" + id
	if slug != "" {
		b += "-" + slug
	}
	if len(b) > model.TaskBranchMaxLen {
		b = strings.TrimRight(b[:model.TaskBranchMaxLen], "-")
	}
	return b
}

// kickoffPrompt is the first task run's # Task.
func kickoffPrompt(t *model.CodingTask, requesterName string) string {
	return fmt.Sprintf("Coding task (%s) for %s — %s\n\n%s\n\n"+
		"The runner has prepared the project checkouts (see the workspace section). Understand how the product "+
		"works end to end, implement the change across the repos it needs on branch %s with small focused commits, "+
		"run the tests, then start the product (UI included when it has one) and call publish_test_plan so %s can "+
		"verify from the product's perspective. End your turn after publishing the plan — %s will reply in this thread.",
		model.TaskKindFlair(t.Kind), t.ProjectName, t.Title, t.Goal, taskBranch(t), requesterName, requesterName)
}

// primaryBranch is the task branch (shared by every repo) — "" for a task
// recorded before repos existed.
func primaryBranch(t *model.CodingTask) string {
	if len(t.Repos) == 0 {
		return ""
	}
	return t.Repos[0].Branch
}

// invokeFailureDetail phrases an invocation error for a thread note.
func invokeFailureDetail(err error) string {
	switch {
	case errors.Is(err, ErrAgentOffline):
		if tail, ok := strings.CutPrefix(err.Error(), ErrAgentOffline.Error()+": "); ok {
			return tail + "."
		}
		return "your ex desktop app isn't online."
	case errors.Is(err, ErrAgentBusy):
		return "dev is already busy in this thread."
	}
	return "the run couldn't start."
}

// Get fetches a task.
func (s *CodingTaskService) Get(ctx context.Context, id string) (*model.CodingTask, error) {
	return s.tasks.GetTask(ctx, id)
}

// GetVisible fetches a task the caller may see (member of its channel).
func (s *CodingTaskService) GetVisible(ctx context.Context, callerID, id string) (*model.CodingTask, error) {
	t, err := s.tasks.GetTask(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := s.messages.CheckAccess(ctx, callerID, t.ChannelID, ParentChannel); err != nil {
		return nil, ErrForbidden
	}
	return t, nil
}

// ListByChannel lists a project channel's tasks for a member.
func (s *CodingTaskService) ListByChannel(ctx context.Context, callerID, channelID string) ([]*model.CodingTask, error) {
	if err := s.messages.CheckAccess(ctx, callerID, channelID, ParentChannel); err != nil {
		return nil, ErrForbidden
	}
	return s.tasks.ListTasksByChannel(ctx, channelID)
}

// ListProjects lists the known projects (products + repos).
func (s *CodingTaskService) ListProjects(ctx context.Context) ([]*model.CodingProject, error) {
	return s.tasks.ListProjects(ctx)
}

// RepoUpdate is one repo's slice of a lifecycle report.
type RepoUpdate struct {
	Path         string
	Branch       string
	BaseBranch   string
	WorkspaceDir string
	MRURL        string
	Changed      *bool
}

// TaskUpdate is one lifecycle report from a task run (runner or agent).
type TaskUpdate struct {
	State model.TaskState
	Note  string
	Repos []RepoUpdate
}

// Report applies a lifecycle update from a task run: validates the
// transition, persists, posts the deterministic thread note, refreshes the
// card. The MR gate is enforced here too (defense in depth): mr_created needs
// a sign-off on record and at least one MR URL.
func (s *CodingTaskService) Report(ctx context.Context, run *model.Run, up TaskUpdate) (*model.CodingTask, error) {
	if run.TaskID == "" {
		return nil, ErrNotTaskRun
	}
	t, err := s.tasks.GetTask(ctx, run.TaskID)
	if err != nil {
		return nil, err
	}
	prev := t.State
	for _, ru := range up.Repos {
		r := t.Repo(strings.TrimSpace(ru.Path))
		if r == nil {
			continue // not a repo of this task — ignore, never fail the report
		}
		if v := strings.TrimSpace(ru.Branch); v != "" && validBranchName(v) == nil {
			r.Branch = v
		}
		if v := strings.TrimSpace(ru.BaseBranch); v != "" && validBranchName(v) == nil {
			r.BaseBranch = v
			s.learnDefaultBranch(ctx, t.ProjectKey, r.Path, v)
		}
		if v := strings.TrimSpace(ru.WorkspaceDir); v != "" {
			r.WorkspaceDir = clipText(v, 512)
		}
		if v := strings.TrimSpace(ru.MRURL); v != "" {
			r.MRURL = clipText(v, 512)
		}
		if ru.Changed != nil {
			r.Changed = *ru.Changed
		}
	}
	if up.State != "" {
		if !model.ValidTaskState(string(up.State)) {
			return nil, fmt.Errorf("task: unknown state %q: %w", up.State, ErrValidation)
		}
		if !model.CanTransition(prev, up.State) {
			return nil, fmt.Errorf("%w: %s → %s", ErrTaskTransition, prev, up.State)
		}
		if up.State == model.TaskStateMRCreated && (t.SignedOffAt == nil || len(t.MRURLs()) == 0) {
			return nil, fmt.Errorf("%w: mr_created needs the requester's sign-off and at least one MR URL", ErrTaskTransition)
		}
		t.State = up.State
	}
	if up.Note != "" && len(up.Note) > model.TaskNoteMaxLen {
		up.Note = clipText(up.Note, model.TaskNoteMaxLen)
	}
	now := s.now()
	t.UpdatedAt = now
	t.LastRunAt = &now
	if err := s.tasks.UpdateTask(ctx, t, prev); err != nil {
		return nil, err
	}
	s.orch.RecordWorkspaceAction(ctx, run, "task_state", map[string]any{
		"taskID": t.ID, "from": prev, "to": t.State, "note": clipText(up.Note, 300),
	})
	if note := s.lifecycleNote(t, prev, up); note != "" {
		s.postNote(ctx, t, run.ID, note)
	}
	if t.State != prev {
		s.refreshCard(ctx, t)
	}
	return t, nil
}

// learnDefaultBranch records a repo's resolved base on the project so the
// next task needn't rediscover it. Best-effort.
func (s *CodingTaskService) learnDefaultBranch(ctx context.Context, projectKey, repoPath, base string) {
	p, err := s.tasks.GetProject(ctx, projectKey)
	if err != nil {
		return
	}
	for i := range p.Repos {
		if p.Repos[i].Path == repoPath && p.Repos[i].DefaultBranch != base {
			p.Repos[i].DefaultBranch = base
			p.UpdatedAt = s.now()
			if err := s.tasks.UpdateProject(ctx, p); err != nil {
				slog.Debug("project default-branch learn failed", "project", projectKey, "error", err)
			}
			return
		}
	}
}

// lifecycleNote is the deterministic thread line for an update: the
// reporter's own note when it gave one, else a standard line per transition.
func (s *CodingTaskService) lifecycleNote(t *model.CodingTask, prev model.TaskState, up TaskUpdate) string {
	if strings.TrimSpace(up.Note) != "" {
		return strings.TrimSpace(up.Note)
	}
	if t.State == prev {
		return ""
	}
	switch t.State {
	case model.TaskStateWorkspaceReady:
		return "📁 Workspace ready — " + strings.Join(repoNames(t.Repos), ", ") + " on branch `" + primaryBranch(t) + "`."
	case model.TaskStateInProgress:
		return "⚙️ Working on it."
	case model.TaskStateAwaitingTest:
		return s.testPlanNote(t)
	case model.TaskStateSetupFailed:
		return "⚠️ Setup failed — see the run activity for details."
	case model.TaskStateMRCreated:
		return "🔀 Merge request" + plural(len(t.MRURLs())) + " created: " + strings.Join(t.MRURLs(), " · ")
	case model.TaskStateDone:
		return "✅ Done — merged. Thanks!"
	case model.TaskStateAbandoned:
		return "🗑️ Task abandoned."
	}
	return ""
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// testPlanNote renders the requester-facing "how to test" — the product
// entry point, numbered steps from the requester's perspective, and the
// counter-checks that must NOT work. Honest about where the link works.
func (s *CodingTaskService) testPlanNote(t *model.CodingTask) string {
	name := "the requester"
	if u, err := s.users.GetUser(context.Background(), t.RequesterID); err == nil && u != nil {
		name = u.DisplayName
	}
	var b strings.Builder
	b.WriteString("🧪 **Ready to test**")
	if t.TestPlan != nil && t.TestPlan.URL != "" {
		b.WriteString(" — open **" + t.TestPlan.URL + "**")
	}
	b.WriteString("\n")
	if t.TestPlan != nil {
		if t.TestPlan.Accounts != "" {
			b.WriteString("Use: " + t.TestPlan.Accounts + "\n")
		}
		if len(t.TestPlan.Steps) > 0 {
			b.WriteString("\n**Should work**\n")
			for i, st := range t.TestPlan.Steps {
				fmt.Fprintf(&b, "%d. %s\n", i+1, st)
			}
		}
		if len(t.TestPlan.CounterSteps) > 0 {
			b.WriteString("\n**Should NOT work / must stay as before**\n")
			for _, st := range t.TestPlan.CounterSteps {
				b.WriteString("- " + st + "\n")
			}
		}
		if t.TestPlan.Notes != "" {
			b.WriteString("\n" + t.TestPlan.Notes + "\n")
		}
	}
	b.WriteString("\n_(Runs on " + name + "'s machine — the link is theirs; others in this channel can't open it yet.)_ ")
	b.WriteString("Reply here with feedback, or sign off on the task card to open the merge request" + plural(len(t.Repos)) + ".")
	return b.String()
}

// PublishTestPlan records the requester-facing test plan and moves the task
// to awaiting_user_test. Gates: at least one step and one counter-check; a
// project with a UI (a frontend repo on the task) must be tested through it,
// so an API-only handoff is refused there.
func (s *CodingTaskService) PublishTestPlan(ctx context.Context, run *model.Run, plan model.TestPlan) (*model.CodingTask, error) {
	if run.TaskID == "" {
		return nil, ErrNotTaskRun
	}
	t, err := s.tasks.GetTask(ctx, run.TaskID)
	if err != nil {
		return nil, err
	}
	plan.URL = strings.TrimSpace(plan.URL)
	if plan.URL != "" && !strings.HasPrefix(plan.URL, "http://") && !strings.HasPrefix(plan.URL, "https://") {
		return nil, fmt.Errorf("task: test URL must be http(s): %w", ErrValidation)
	}
	plan.Steps = cleanSteps(plan.Steps)
	plan.CounterSteps = cleanSteps(plan.CounterSteps)
	if len(plan.Steps) == 0 {
		return nil, fmt.Errorf("task: a test plan needs at least one step the requester can follow: %w", ErrValidation)
	}
	if len(plan.CounterSteps) == 0 {
		return nil, fmt.Errorf("task: a test plan needs at least one counter-check (what must NOT happen / who must NOT see it / what must still work as before): %w", ErrValidation)
	}
	if len(plan.Steps)+len(plan.CounterSteps) > model.TestPlanMaxSteps {
		return nil, fmt.Errorf("task: at most %d steps in total: %w", model.TestPlanMaxSteps, ErrValidation)
	}
	if t.HasRole(model.RepoRoleFrontend) && plan.URL == "" {
		return nil, fmt.Errorf("task: this project has a UI — start it and give its URL so the requester tests through the product, not an API: %w", ErrValidation)
	}
	if looksLikeAPIOnly(plan) && t.HasRole(model.RepoRoleFrontend) {
		return nil, fmt.Errorf("task: the steps read like API calls (curl/endpoints); this project has a UI — describe what the requester clicks and sees: %w", ErrValidation)
	}
	plan.Accounts = clipText(strings.TrimSpace(plan.Accounts), 400)
	plan.Notes = clipText(strings.TrimSpace(plan.Notes), 1000)
	t.TestPlan = &plan
	if err := s.tasks.UpdateTask(ctx, t, t.State); err != nil {
		return nil, err
	}
	return s.Report(ctx, run, TaskUpdate{State: model.TaskStateAwaitingTest})
}

func cleanSteps(in []string) []string {
	var out []string
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		out = append(out, clipText(s, model.TestPlanStepMaxLen))
	}
	return out
}

// looksLikeAPIOnly flags plans whose steps are all curl/endpoint talk — the
// "here is the API, go test it" handoff a non-developer can't use.
func looksLikeAPIOnly(p model.TestPlan) bool {
	if len(p.Steps) == 0 {
		return false
	}
	api := 0
	for _, s := range p.Steps {
		l := strings.ToLower(s)
		if strings.Contains(l, "curl ") || strings.Contains(l, "http ") || strings.Contains(l, "/api/") ||
			strings.HasPrefix(l, "get ") || strings.HasPrefix(l, "post ") || strings.Contains(l, "endpoint") || strings.Contains(l, "postman") {
			api++
		}
	}
	return api == len(p.Steps)
}

// MR request statuses (the request_mr tool contract).
const (
	MRStatusApproved = "approved"
	MRStatusAsk      = "ask"
	MRStatusNotReady = "not_ready"
	MRStatusDenied   = "denied"
)

// RequestMR is the hard gate before push + MR. Approved when the requester
// signed off (card button, or an approval card raised by this very tool);
// "ask" tells the tool to raise that approval; anything before the requester
// has tested is not_ready.
func (s *CodingTaskService) RequestMR(ctx context.Context, run *model.Run, approvalID string) (status string, t *model.CodingTask, err error) {
	if run.TaskID == "" {
		return "", nil, ErrNotTaskRun
	}
	t, err = s.tasks.GetTask(ctx, run.TaskID)
	if err != nil {
		return "", nil, err
	}
	if t.State != model.TaskStateAwaitingTest && t.State != model.TaskStateMRCreated {
		return MRStatusNotReady, t, nil
	}
	if t.SignedOffAt != nil {
		return MRStatusApproved, t, nil
	}
	if approvalID == "" {
		return MRStatusAsk, t, nil
	}
	a, err := s.orch.ApprovalStatus(ctx, run.ID, approvalID)
	if err != nil || a.State != model.ApprovalApproved || !strings.Contains(a.Summary, t.ID) {
		return MRStatusDenied, t, nil
	}
	if _, err := s.signOff(ctx, t, run.InvokerID, run.ID); err != nil {
		return "", nil, err
	}
	return MRStatusApproved, t, nil
}

// MRApprovalSummary is the approval-card text request_mr raises; RequestMR
// verifies the decided approval by this exact task id.
func MRApprovalSummary(t *model.CodingTask) string {
	return fmt.Sprintf("Create the merge request%s for %s — %s (task %s): push branch %s in %s and open MRs against the default branches",
		plural(len(t.Repos)), t.ProjectName, t.Title, t.ID, primaryBranch(t), strings.Join(repoNames(t.Repos), ", "))
}

// SignOff records the requester's "ship it" from the task card and starts
// the run that pushes + opens the MRs. Requester-only; the task must be
// awaiting the requester's test.
func (s *CodingTaskService) SignOff(ctx context.Context, callerID, taskID string) (*model.CodingTask, error) {
	t, err := s.tasks.GetTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if callerID != t.RequesterID {
		return nil, ErrNotRequester
	}
	if t.State != model.TaskStateAwaitingTest {
		return nil, fmt.Errorf("%w: task is %s", ErrTaskNotReady, t.State)
	}
	if t.SignedOffAt == nil {
		t, err = s.signOff(ctx, t, callerID, "")
		if err != nil {
			return nil, err
		}
	} else {
		// Already signed off but still awaiting: the MR run died (runner
		// offline, workspace failure). Clicking again retries the MR step
		// instead of silently doing nothing.
		s.postNote(ctx, t, "", "🔁 Retrying the merge-request step.")
	}
	requester, err := s.users.GetUser(ctx, t.RequesterID)
	if err != nil {
		return t, nil
	}
	// Synthetic trigger in the task thread — no reactions land anywhere.
	msg := &model.Message{ParentID: t.ChannelID, ParentMessageID: t.ThreadRootID, AuthorID: requester.ID, Body: "ship it"}
	prompt := fmt.Sprintf("%s signed off on %q. Make sure every change is committed on branch %s in each repo you "+
		"touched (commit any leftovers with a clear message), then call request_mr and follow its instructions to "+
		"push and open the merge request(s). Post the MR link(s) when done; do not touch the code further unless asked.",
		requester.DisplayName, t.Title, primaryBranch(t))
	if err := s.orch.StartTaskRun(ctx, t, requester, msg, prompt); err != nil {
		s.postNote(ctx, t, "", "⛔ Couldn't start the MR run — "+invokeFailureDetail(err)+" Reply here to retry.")
	}
	return t, nil
}

func (s *CodingTaskService) signOff(ctx context.Context, t *model.CodingTask, byID, runID string) (*model.CodingTask, error) {
	now := s.now()
	t.SignedOffAt = &now
	t.UpdatedAt = now
	if err := s.tasks.UpdateTask(ctx, t, t.State); err != nil {
		return nil, err
	}
	name := "The requester"
	if u, err := s.users.GetUser(ctx, byID); err == nil && u != nil {
		name = u.DisplayName
	}
	s.postNote(ctx, t, runID, "✅ "+name+" signed off — pushing and opening the merge request"+plural(len(t.Repos))+".")
	return t, nil
}

// SetSteering flips who may direct the task in chat. Requester-only.
func (s *CodingTaskService) SetSteering(ctx context.Context, callerID, taskID, mode string) (*model.CodingTask, error) {
	if !model.ValidTaskSteering(mode) {
		return nil, fmt.Errorf("task: steering must be requester or anyone: %w", ErrValidation)
	}
	t, err := s.tasks.GetTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if callerID != t.RequesterID {
		return nil, ErrNotRequester
	}
	if t.Steering == mode {
		return t, nil
	}
	t.Steering = mode
	t.UpdatedAt = s.now()
	if err := s.tasks.UpdateTask(ctx, t, t.State); err != nil {
		return nil, err
	}
	if mode == model.TaskSteeringAnyone {
		s.postNote(ctx, t, "", "🧭 Anyone in this channel may now steer this task (approvals and the MR sign-off stay with the requester).")
	} else {
		s.postNote(ctx, t, "", "🧭 Steering is back to the requester only.")
	}
	return t, nil
}

// Close ends a task by hand from the card: done (its merge requests are
// open — Ex's part is finished) or abandoned (drop the work; the branch
// stays on the requester's machine). Requester-only. Until this existed
// nothing moved a task off mr_created — the merge watcher is v2 — so one
// shipped task blocked its project's next task indefinitely.
func (s *CodingTaskService) Close(ctx context.Context, callerID, taskID, state string) (*model.CodingTask, error) {
	to := model.TaskState(strings.TrimSpace(state))
	if to != model.TaskStateDone && to != model.TaskStateAbandoned {
		return nil, fmt.Errorf("task: close state must be done or abandoned: %w", ErrValidation)
	}
	t, err := s.tasks.GetTask(ctx, taskID)
	if err != nil {
		return nil, err
	}
	if callerID != t.RequesterID {
		return nil, ErrNotRequester
	}
	if t.State.Terminal() {
		return t, nil
	}
	if !model.CanTransition(t.State, to) {
		return nil, fmt.Errorf("%w: %s → %s (done is only for a task whose merge requests are open — abandon it instead)", ErrTaskTransition, t.State, to)
	}
	prev := t.State
	t.State = to
	t.UpdatedAt = s.now()
	if err := s.tasks.UpdateTask(ctx, t, prev); err != nil {
		return nil, err
	}
	who := "The requester"
	if u, err := s.users.GetUser(ctx, callerID); err == nil && u != nil && u.DisplayName != "" {
		who = u.DisplayName
	}
	if to == model.TaskStateDone {
		s.postNote(ctx, t, "", "✅ "+who+" closed this task — the merge request"+plural(len(t.MRURLs()))+" stay open on GitLab: "+strings.Join(t.MRURLs(), " · "))
	} else {
		s.postNote(ctx, t, "", "🗑️ "+who+" abandoned this task. The branch stays on the requester's machine; nothing was pushed.")
	}
	s.refreshCard(ctx, t)
	return t, nil
}

// postNote posts a deterministic lifecycle line into the task thread as the
// agent, for the requester. Best-effort: a failed note never fails the task.
func (s *CodingTaskService) postNote(ctx context.Context, t *model.CodingTask, runID, body string) {
	if _, err := s.messages.SendAsAgentRun(ctx, t.AgentID, t.RequesterID, t.ChannelID, ParentChannel, body, t.ThreadRootID, runID); err != nil {
		slog.Warn("task note post failed", "taskID", t.ID, "error", err)
	}
}

// refreshCard rewrites the pinned card so its state/kind read live.
func (s *CodingTaskService) refreshCard(ctx context.Context, t *model.CodingTask) {
	if _, err := s.messages.RewriteAgentMessage(ctx, t.AgentID, t.ChannelID, ParentChannel, t.ThreadRootID, TaskMarker(t)); err != nil {
		slog.Warn("task card refresh failed", "taskID", t.ID, "error", err)
	}
}
