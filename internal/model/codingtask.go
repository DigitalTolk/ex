package model

import (
	"regexp"
	"strings"
	"time"
)

// Coding tasks (plan-coding-agent.md) — the deterministic spine around the
// dev agent. State transitions and gates live in server code; the model only
// writes diffs and narrative.
//
// Topology: one channel per PROJECT — a product such as "CliffHub", which is
// usually several repos (backend + frontend) — named after the project, with
// one thread per task rooted at the task-card message. A task lists the
// repos it touches; each repo gets its own branch and merge request.
//
// Everything rides the REQUESTER: the workspace lives on their machine
// (RunnerID pins it), runs spend their quota, MRs are authored by their
// GitLab token, approvals are theirs to decide.

// CodingProject is a product the team works on: a name, its repos with
// roles, and the project channel. Learned on first use (the intake agent
// resolves the repos with the requester) and reused by every later task.
type CodingProject struct {
	Key       string        `json:"key" dynamodbav:"key"`   // slug, e.g. "cliffhub"
	Name      string        `json:"name" dynamodbav:"name"` // display, e.g. "CliffHub"
	Repos     []ProjectRepo `json:"repos" dynamodbav:"repos"`
	ChannelID string        `json:"channelID" dynamodbav:"channelID"`
	CreatedBy string        `json:"createdBy" dynamodbav:"createdBy"`
	CreatedAt time.Time     `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt time.Time     `json:"updatedAt" dynamodbav:"updatedAt"`
}

// ProjectRepo is one GitLab repository of a project with its role in the
// product — the role is what tells the agent where UI work belongs.
type ProjectRepo struct {
	Path string `json:"path" dynamodbav:"path"` // GitLab "group/sub/repo"
	Role string `json:"role" dynamodbav:"role"` // RepoRole*
	// DefaultBranch, when known (learned by the runner from origin/HEAD).
	DefaultBranch string `json:"defaultBranch,omitempty" dynamodbav:"defaultBranch,omitempty"`
}

// Repo roles.
const (
	RepoRoleBackend  = "backend"
	RepoRoleFrontend = "frontend"
	RepoRoleMobile   = "mobile"
	RepoRoleInfra    = "infra"
	RepoRoleOther    = "other"
)

// ValidRepoRole reports whether r is a known role ("" is accepted and
// normalized to other by the service).
func ValidRepoRole(r string) bool {
	switch r {
	case RepoRoleBackend, RepoRoleFrontend, RepoRoleMobile, RepoRoleInfra, RepoRoleOther, "":
		return true
	}
	return false
}

// RepoName is the last path segment of a repo path.
func RepoName(path string) string {
	if i := strings.LastIndex(path, "/"); i >= 0 {
		return path[i+1:]
	}
	return path
}

// CodingTask is one unit of coding work the dev agent performs for a
// requester in one project, across one or more of its repos.
type CodingTask struct {
	ID          string    `json:"id" dynamodbav:"id"`
	ProjectKey  string    `json:"projectKey" dynamodbav:"projectKey"`
	ProjectName string    `json:"projectName" dynamodbav:"projectName"`
	Title       string    `json:"title" dynamodbav:"title"`
	Goal        string    `json:"goal" dynamodbav:"goal"`
	Kind        string    `json:"kind" dynamodbav:"kind"` // TaskKind* — drives the flair
	State       TaskState `json:"state" dynamodbav:"state"`
	// Steering: who may direct the task in chat — the requester only
	// (default) or anyone in the project channel. Authority (approvals, MR
	// sign-off) stays with the requester regardless.
	Steering string `json:"steering,omitempty" dynamodbav:"steering,omitempty"`

	ChannelID    string `json:"channelID" dynamodbav:"channelID"`       // the project channel
	ThreadRootID string `json:"threadRootID" dynamodbav:"threadRootID"` // the task card message
	RequesterID  string `json:"requesterID" dynamodbav:"requesterID"`
	AgentID      string `json:"agentID" dynamodbav:"agentID"` // the coding agent user (dev)
	// RunnerID is machine affinity: the checkouts live on the runner that
	// took the first task run, so later runs must land there too.
	RunnerID string `json:"runnerID,omitempty" dynamodbav:"runnerID,omitempty"`

	// Repos the task touches, each with its own branch/MR. The first entry
	// is the primary (naming, default cwd hints).
	Repos []TaskRepo `json:"repos" dynamodbav:"repos"`

	Ticket *TaskTicket `json:"ticket,omitempty" dynamodbav:"ticket,omitempty"`

	// TestPlan is the requester-facing "how to test" the agent published.
	TestPlan *TestPlan `json:"testPlan,omitempty" dynamodbav:"testPlan,omitempty"`
	// SignedOffAt records the requester's "ship it" — the MR gate.
	SignedOffAt *time.Time `json:"signedOffAt,omitempty" dynamodbav:"signedOffAt,omitempty"`

	RunIDs    []string   `json:"runIDs,omitempty" dynamodbav:"runIDs,omitempty"`
	LastRunAt *time.Time `json:"lastRunAt,omitempty" dynamodbav:"lastRunAt,omitempty"`
	CreatedAt time.Time  `json:"createdAt" dynamodbav:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt" dynamodbav:"updatedAt"`

	// Legacy single-repo fields (rows written before projects/repos existed).
	// Read-only compatibility: NormalizeLegacy folds them into Repos/Project
	// and clears them so the next write drops them. Never in API JSON.
	LegacyProjectPath  string `json:"-" dynamodbav:"projectPath,omitempty"`
	LegacyBranch       string `json:"-" dynamodbav:"branch,omitempty"`
	LegacyBaseBranch   string `json:"-" dynamodbav:"baseBranch,omitempty"`
	LegacyWorkspaceDir string `json:"-" dynamodbav:"workspaceDir,omitempty"`
	LegacyMRURL        string `json:"-" dynamodbav:"mrURL,omitempty"`
	LegacyTestURL      string `json:"-" dynamodbav:"testURL,omitempty"`
	LegacyTestNotes    string `json:"-" dynamodbav:"testNotes,omitempty"`
}

// NormalizeLegacy upgrades a task row written by the single-repo model: the
// one repo becomes Repos[0] (role unknown → other), the project is named
// after that repo, and a published test link becomes a one-step test plan.
// Idempotent; a no-op for rows that already carry repos.
func (t *CodingTask) NormalizeLegacy() {
	if len(t.Repos) == 0 && t.LegacyProjectPath != "" {
		t.Repos = []TaskRepo{{
			Path:         t.LegacyProjectPath,
			Role:         RepoRoleOther,
			BaseBranch:   t.LegacyBaseBranch,
			Branch:       t.LegacyBranch,
			WorkspaceDir: t.LegacyWorkspaceDir,
			MRURL:        t.LegacyMRURL,
			Changed:      t.LegacyMRURL != "",
		}}
	}
	if t.ProjectName == "" && len(t.Repos) > 0 {
		t.ProjectName = RepoName(t.Repos[0].Path)
	}
	if t.ProjectKey == "" && t.ProjectName != "" {
		t.ProjectKey = legacyProjectKey(t.ProjectName)
	}
	if t.TestPlan == nil && t.LegacyTestURL != "" {
		steps := []string{"Open " + t.LegacyTestURL}
		if t.LegacyTestNotes != "" {
			steps = append(steps, t.LegacyTestNotes)
		}
		t.TestPlan = &TestPlan{URL: t.LegacyTestURL, Steps: steps}
	}
	t.LegacyProjectPath, t.LegacyBranch, t.LegacyBaseBranch, t.LegacyWorkspaceDir = "", "", "", ""
	t.LegacyMRURL, t.LegacyTestURL, t.LegacyTestNotes = "", "", ""
}

// legacyProjectKey slugs a name the way the service's ProjectKey does (kept
// here so the model can normalize without importing the service).
func legacyProjectKey(name string) string {
	var b strings.Builder
	prev := false
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
			prev = false
		} else if !prev {
			b.WriteByte('-')
			prev = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// TaskRepo is one repo's slice of a task.
type TaskRepo struct {
	Path       string `json:"path" dynamodbav:"path"`
	Role       string `json:"role" dynamodbav:"role"`
	BaseBranch string `json:"baseBranch,omitempty" dynamodbav:"baseBranch,omitempty"`
	Branch     string `json:"branch" dynamodbav:"branch"`
	// WorkspaceDir is the runner-reported checkout path (informational — it
	// describes THAT machine's disk).
	WorkspaceDir string `json:"workspaceDir,omitempty" dynamodbav:"workspaceDir,omitempty"`
	MRURL        string `json:"mrURL,omitempty" dynamodbav:"mrURL,omitempty"`
	// Changed reports whether the branch carries commits beyond its base
	// (runner-reported at MR time); untouched repos get no MR.
	Changed bool `json:"changed,omitempty" dynamodbav:"changed,omitempty"`
}

// TestPlan is the requester-facing verification recipe: where to open the
// product, the steps that should work, and the counter-checks that should
// NOT (the other role's view, the regression you'd expect). API-only
// instructions are not a test plan when the product has a UI.
type TestPlan struct {
	// URL the requester opens — the product UI (or an API base when the
	// project genuinely has no UI).
	URL string `json:"url,omitempty" dynamodbav:"url,omitempty"`
	// Steps from the requester's perspective, in order.
	Steps []string `json:"steps" dynamodbav:"steps"`
	// CounterSteps are what must NOT happen / who must NOT see it.
	CounterSteps []string `json:"counterSteps,omitempty" dynamodbav:"counterSteps,omitempty"`
	// Accounts names the roles/test users to use (never secrets).
	Accounts string `json:"accounts,omitempty" dynamodbav:"accounts,omitempty"`
	Notes    string `json:"notes,omitempty" dynamodbav:"notes,omitempty"`
}

// TaskTicket links a task to a ticket in a ticketing connector (CliffHub…).
type TaskTicket struct {
	Connector string `json:"connector" dynamodbav:"connector"`
	ID        string `json:"id" dynamodbav:"id"`
	URL       string `json:"url,omitempty" dynamodbav:"url,omitempty"`
}

// TaskState is the task lifecycle. Transitions are validated server-side —
// notably nothing reaches mr_created without the sign-off gate.
type TaskState string

const (
	TaskStateCreated        TaskState = "created"
	TaskStateWorkspaceReady TaskState = "workspace_ready"
	TaskStateInProgress     TaskState = "in_progress"
	TaskStateAwaitingTest   TaskState = "awaiting_user_test"
	TaskStateMRCreated      TaskState = "mr_created"
	TaskStateDone           TaskState = "done"
	TaskStateSetupFailed    TaskState = "setup_failed"
	TaskStateAbandoned      TaskState = "abandoned"
)

// Terminal reports whether the task accepts no further work.
func (s TaskState) Terminal() bool {
	return s == TaskStateDone || s == TaskStateAbandoned
}

// ValidTaskState reports whether s names a known state.
func ValidTaskState(s string) bool {
	switch TaskState(s) {
	case TaskStateCreated, TaskStateWorkspaceReady, TaskStateInProgress, TaskStateAwaitingTest,
		TaskStateMRCreated, TaskStateDone, TaskStateSetupFailed, TaskStateAbandoned:
		return true
	}
	return false
}

// taskTransitions is the allowed edge set. Self-heal edges (setup_failed →
// workspace_ready/in_progress) and the "not fixed after all" bounce
// (mr_created → in_progress) are deliberate; terminal states have no exits.
var taskTransitions = map[TaskState][]TaskState{
	TaskStateCreated:        {TaskStateWorkspaceReady, TaskStateInProgress, TaskStateSetupFailed, TaskStateAbandoned},
	TaskStateWorkspaceReady: {TaskStateInProgress, TaskStateSetupFailed, TaskStateAwaitingTest, TaskStateAbandoned},
	TaskStateSetupFailed:    {TaskStateWorkspaceReady, TaskStateInProgress, TaskStateAbandoned},
	TaskStateInProgress:     {TaskStateAwaitingTest, TaskStateSetupFailed, TaskStateAbandoned},
	TaskStateAwaitingTest:   {TaskStateInProgress, TaskStateMRCreated, TaskStateAbandoned},
	TaskStateMRCreated:      {TaskStateInProgress, TaskStateDone, TaskStateAbandoned},
}

// CanTransition reports whether from → to is a legal task transition.
// Same-state is always allowed (idempotent re-reports).
func CanTransition(from, to TaskState) bool {
	if from == to {
		return true
	}
	for _, s := range taskTransitions[from] {
		if s == to {
			return true
		}
	}
	return false
}

// Task kinds — the flair the channel shows.
const (
	TaskKindBug     = "bug"
	TaskKindFeature = "feature"
	TaskKindChore   = "chore"
)

// ValidTaskKind reports whether k is a known kind.
func ValidTaskKind(k string) bool {
	return k == TaskKindBug || k == TaskKindFeature || k == TaskKindChore
}

// TaskKindFlair renders the kind as its chat flair.
func TaskKindFlair(k string) string {
	switch k {
	case TaskKindBug:
		return "🐛 bug"
	case TaskKindFeature:
		return "✨ feature"
	case TaskKindChore:
		return "🧹 chore"
	}
	return k
}

// Steering modes.
const (
	TaskSteeringRequester = "requester" // default: only the requester directs
	TaskSteeringAnyone    = "anyone"    // any project-channel member may steer
)

// ValidTaskSteering reports whether s is a known steering mode.
func ValidTaskSteering(s string) bool {
	return s == TaskSteeringRequester || s == TaskSteeringAnyone
}

// Task bounds.
const (
	TaskTitleMaxLen       = 120
	TaskGoalMaxLen        = 8 * 1024
	TaskProjectPathMaxLen = 200
	TaskProjectNameMaxLen = 64
	TaskNoteMaxLen        = 4 * 1024
	TaskBranchMaxLen      = 120
	TaskMaxRepos          = 6
	TestPlanMaxSteps      = 20
	TestPlanStepMaxLen    = 400
)

// projectPathPattern: GitLab full paths — at least "group/repo", segments of
// letters/digits/._- (GitLab's own namespace rules, simplified).
var projectPathPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$`)

// ValidProjectPath reports whether p is a plausible GitLab repo path.
func ValidProjectPath(p string) bool {
	if p == "" || len(p) > TaskProjectPathMaxLen || strings.Contains(p, "..") {
		return false
	}
	return projectPathPattern.MatchString(p)
}

// projectKeyPattern bounds a project key (the channel slug's source).
var projectKeyPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)

// ValidProjectKey reports whether k is a usable project key.
func ValidProjectKey(k string) bool { return projectKeyPattern.MatchString(k) }

// SteerEntitled reports whether userID may direct this task in chat.
func (t *CodingTask) SteerEntitled(userID string) bool {
	if userID == t.RequesterID {
		return true
	}
	return t.Steering == TaskSteeringAnyone
}

// Repo returns the task's slice of a repo by path (nil when absent).
func (t *CodingTask) Repo(path string) *TaskRepo {
	for i := range t.Repos {
		if t.Repos[i].Path == path {
			return &t.Repos[i]
		}
	}
	return nil
}

// HasRole reports whether any task repo has the given role.
func (t *CodingTask) HasRole(role string) bool {
	for _, r := range t.Repos {
		if r.Role == role {
			return true
		}
	}
	return false
}

// MRURLs lists the merge requests opened so far.
func (t *CodingTask) MRURLs() []string {
	var out []string
	for _, r := range t.Repos {
		if r.MRURL != "" {
			out = append(out, r.MRURL)
		}
	}
	return out
}

// TaskSpec is the task snapshot handed to the runner on an Assignment — what
// the workspace manager needs to prepare the checkouts and what the prompt
// preamble narrates. Never carries credentials (those ride the connector
// payload).
type TaskSpec struct {
	ID           string         `json:"id"`
	ProjectKey   string         `json:"projectKey"`
	ProjectName  string         `json:"projectName"`
	Title        string         `json:"title"`
	Goal         string         `json:"goal"`
	Kind         string         `json:"kind"`
	State        string         `json:"state"`
	Repos        []TaskSpecRepo `json:"repos"`
	ChannelID    string         `json:"channelID"`
	ThreadRootID string         `json:"threadRootID"`
	TestURL      string         `json:"testURL,omitempty"`
	SignedOff    bool           `json:"signedOff,omitempty"`
	// RunnerID is the machine the workspace is pinned to ("" until the first
	// task run is claimed). The runner compares it with its own ID: a
	// mismatch means the checkouts live elsewhere and it is inheriting.
	RunnerID string `json:"runnerID,omitempty"`
}

// TaskSpecRepo is one repo on the runner's spec.
type TaskSpecRepo struct {
	Path       string `json:"path"`
	Role       string `json:"role"`
	Branch     string `json:"branch"`
	BaseBranch string `json:"baseBranch,omitempty"`
	MRURL      string `json:"mrURL,omitempty"`
}
