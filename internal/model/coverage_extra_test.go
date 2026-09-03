package model

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

// Coverage-focused unit tests for the pure model helpers in agent.go,
// codingtask.go, connector.go and user.go. All identifiers introduced here
// carry the modelCov prefix.

// --- agent.go ---

func TestModelCovHarnessIsAPI(t *testing.T) {
	cases := []struct {
		harness string
		want    bool
	}{
		{HarnessBedrock, true},
		{HarnessClaude, false},
		{HarnessCodex, false},
		{"", false},
	}
	for _, tc := range cases {
		if got := HarnessIsAPI(tc.harness); got != tc.want {
			t.Errorf("HarnessIsAPI(%q) = %v, want %v", tc.harness, got, tc.want)
		}
	}
}

func TestModelCovDefaultAgentLimits(t *testing.T) {
	want := AgentLimits{
		MaxTurns:            16,
		MaxWallClockSec:     300,
		MaxTokens:           200_000,
		MaxPosts:            10,
		MaxConsultDepth:     1,
		MaxChainRounds:      6,
		MaxTaskWallClockSec: 7200,
		MaxTaskTurns:        128,
	}
	if got := DefaultAgentLimits(); got != want {
		t.Errorf("DefaultAgentLimits() = %+v, want %+v", got, want)
	}
}

func TestModelCovWallClockFor(t *testing.T) {
	def := DefaultAgentLimits()
	cases := []struct {
		name   string
		limits AgentLimits
		mode   string
		want   time.Duration
	}{
		{"task mode ignores fields", AgentLimits{MaxTaskWallClockSec: 1}, RunModeTask, TaskModeHorizon()},
		{"direct uses task cap", AgentLimits{MaxTaskWallClockSec: 60}, RunModeDirect, 60 * time.Second},
		{"direct zero falls back", AgentLimits{}, RunModeDirect, time.Duration(def.MaxTaskWallClockSec) * time.Second},
		{"ambient uses conversation cap", AgentLimits{MaxWallClockSec: 45}, RunModeWatch, 45 * time.Second},
		{"ambient zero falls back", AgentLimits{}, RunModeHeartbeat, time.Duration(def.MaxWallClockSec) * time.Second},
		{"empty mode is ambient", AgentLimits{MaxWallClockSec: 30}, "", 30 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.limits.WallClockFor(tc.mode); got != tc.want {
				t.Errorf("WallClockFor(%q) = %v, want %v", tc.mode, got, tc.want)
			}
		})
	}
}

func TestModelCovTurnsFor(t *testing.T) {
	def := DefaultAgentLimits()
	cases := []struct {
		name   string
		limits AgentLimits
		mode   string
		want   int
	}{
		{"task mode is unlimited", AgentLimits{MaxTaskTurns: 3}, RunModeTask, TaskModeUnlimitedTurns},
		{"direct uses task turns", AgentLimits{MaxTaskTurns: 42}, RunModeDirect, 42},
		{"direct zero falls back", AgentLimits{}, RunModeDirect, def.MaxTaskTurns},
		{"ambient uses conversation turns", AgentLimits{MaxTurns: 9}, RunModeFollowUp, 9},
		{"ambient zero falls back", AgentLimits{}, RunModeWatch, def.MaxTurns},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.limits.TurnsFor(tc.mode); got != tc.want {
				t.Errorf("TurnsFor(%q) = %d, want %d", tc.mode, got, tc.want)
			}
		})
	}
}

func TestModelCovValidAutoAllow(t *testing.T) {
	for _, c := range []string{AutoAllowRead, AutoAllowEdit, AutoAllowShell, AutoAllowWeb} {
		if !ValidAutoAllow(c) {
			t.Errorf("ValidAutoAllow(%q) = false, want true", c)
		}
	}
	for _, c := range []string{"", "exec", "READ"} {
		if ValidAutoAllow(c) {
			t.Errorf("ValidAutoAllow(%q) = true, want false", c)
		}
	}
}

func TestModelCovRunStateTerminal(t *testing.T) {
	cases := []struct {
		state RunState
		want  bool
	}{
		{RunStateCompleted, true},
		{RunStateFailed, true},
		{RunStateCanceled, true},
		{RunStateQueued, false},
		{RunStateAcknowledged, false},
		{RunStateRunning, false},
	}
	for _, tc := range cases {
		if got := tc.state.Terminal(); got != tc.want {
			t.Errorf("RunState(%q).Terminal() = %v, want %v", tc.state, got, tc.want)
		}
	}
}

func TestModelCovValidWatchActionMode(t *testing.T) {
	for _, m := range []string{WatchActionNotify, WatchActionDraft, WatchActionReply, WatchActionAutonomous} {
		if !ValidWatchActionMode(m) {
			t.Errorf("ValidWatchActionMode(%q) = false, want true", m)
		}
	}
	for _, m := range []string{"", "shout"} {
		if ValidWatchActionMode(m) {
			t.Errorf("ValidWatchActionMode(%q) = true, want false", m)
		}
	}
}

func TestModelCovWatchModePostsPrivately(t *testing.T) {
	cases := []struct {
		mode string
		want bool
	}{
		{WatchActionNotify, true},
		{WatchActionDraft, true},
		{WatchActionReply, false},
		{WatchActionAutonomous, false},
		{"", false},
	}
	for _, tc := range cases {
		if got := WatchModePostsPrivately(tc.mode); got != tc.want {
			t.Errorf("WatchModePostsPrivately(%q) = %v, want %v", tc.mode, got, tc.want)
		}
	}
}

func TestModelCovTaskModeHorizon(t *testing.T) {
	if got, want := TaskModeHorizon(), 30*24*time.Hour; got != want {
		t.Errorf("TaskModeHorizon() = %v, want %v", got, want)
	}
}

func TestModelCovModeUncapped(t *testing.T) {
	if !ModeUncapped(RunModeTask) {
		t.Error("ModeUncapped(task) = false, want true")
	}
	for _, m := range []string{RunModeDirect, RunModeWatch, RunModeHeartbeat, RunModeFollowUp, ""} {
		if ModeUncapped(m) {
			t.Errorf("ModeUncapped(%q) = true, want false", m)
		}
	}
}

// --- codingtask.go ---

func TestModelCovValidRepoRole(t *testing.T) {
	for _, r := range []string{RepoRoleBackend, RepoRoleFrontend, RepoRoleMobile, RepoRoleInfra, RepoRoleOther, ""} {
		if !ValidRepoRole(r) {
			t.Errorf("ValidRepoRole(%q) = false, want true", r)
		}
	}
	for _, r := range []string{"fullstack", "BACKEND"} {
		if ValidRepoRole(r) {
			t.Errorf("ValidRepoRole(%q) = true, want false", r)
		}
	}
}

func TestModelCovRepoName(t *testing.T) {
	cases := []struct {
		path, want string
	}{
		{"group/sub/repo", "repo"},
		{"group/repo", "repo"},
		{"repo", "repo"},
		{"", ""},
		{"group/", ""},
	}
	for _, tc := range cases {
		if got := RepoName(tc.path); got != tc.want {
			t.Errorf("RepoName(%q) = %q, want %q", tc.path, got, tc.want)
		}
	}
}

func TestModelCovNormalizeLegacyFullRow(t *testing.T) {
	task := CodingTask{
		LegacyProjectPath:  "group/cliffhub-api",
		LegacyBranch:       "ex/fix-1",
		LegacyBaseBranch:   "main",
		LegacyWorkspaceDir: "/ws/cliffhub-api",
		LegacyMRURL:        "https://gitlab.example.com/mr/1",
		LegacyTestURL:      "https://staging.example.com",
		LegacyTestNotes:    "log in as a translator",
	}
	task.NormalizeLegacy()

	wantRepo := TaskRepo{
		Path:         "group/cliffhub-api",
		Role:         RepoRoleOther,
		BaseBranch:   "main",
		Branch:       "ex/fix-1",
		WorkspaceDir: "/ws/cliffhub-api",
		MRURL:        "https://gitlab.example.com/mr/1",
		Changed:      true,
	}
	if len(task.Repos) != 1 || task.Repos[0] != wantRepo {
		t.Errorf("Repos = %+v, want [%+v]", task.Repos, wantRepo)
	}
	if task.ProjectName != "cliffhub-api" {
		t.Errorf("ProjectName = %q, want %q", task.ProjectName, "cliffhub-api")
	}
	if task.ProjectKey != "cliffhub-api" {
		t.Errorf("ProjectKey = %q, want %q", task.ProjectKey, "cliffhub-api")
	}
	if task.TestPlan == nil {
		t.Fatal("TestPlan = nil, want populated from legacy test link")
	}
	if task.TestPlan.URL != "https://staging.example.com" {
		t.Errorf("TestPlan.URL = %q, want legacy test URL", task.TestPlan.URL)
	}
	wantSteps := []string{"Open https://staging.example.com", "log in as a translator"}
	if !reflect.DeepEqual(task.TestPlan.Steps, wantSteps) {
		t.Errorf("TestPlan.Steps = %v, want %v", task.TestPlan.Steps, wantSteps)
	}
	if task.LegacyProjectPath != "" || task.LegacyBranch != "" || task.LegacyBaseBranch != "" ||
		task.LegacyWorkspaceDir != "" || task.LegacyMRURL != "" || task.LegacyTestURL != "" ||
		task.LegacyTestNotes != "" {
		t.Errorf("legacy fields not cleared: %+v", task)
	}
}

func TestModelCovNormalizeLegacyWithoutMRAndNotes(t *testing.T) {
	task := CodingTask{
		LegacyProjectPath: "solo-repo",
		LegacyTestURL:     "https://test.example.com",
	}
	task.NormalizeLegacy()
	if len(task.Repos) != 1 || task.Repos[0].Changed {
		t.Errorf("Repos = %+v, want one unchanged repo (no legacy MR)", task.Repos)
	}
	if task.ProjectName != "solo-repo" || task.ProjectKey != "solo-repo" {
		t.Errorf("project = %q/%q, want solo-repo/solo-repo", task.ProjectName, task.ProjectKey)
	}
	if task.TestPlan == nil || len(task.TestPlan.Steps) != 1 || task.TestPlan.Steps[0] != "Open https://test.example.com" {
		t.Errorf("TestPlan = %+v, want single Open step without notes", task.TestPlan)
	}
}

func TestModelCovNormalizeLegacyModernRowNoOp(t *testing.T) {
	plan := &TestPlan{URL: "https://app.example.com", Steps: []string{"open it"}}
	task := CodingTask{
		ProjectKey:  "cliffhub",
		ProjectName: "CliffHub",
		Repos:       []TaskRepo{{Path: "group/backend", Role: RepoRoleBackend, Branch: "ex/x"}},
		TestPlan:    plan,
	}
	task.NormalizeLegacy()
	if len(task.Repos) != 1 || task.Repos[0].Path != "group/backend" {
		t.Errorf("Repos changed on modern row: %+v", task.Repos)
	}
	if task.ProjectKey != "cliffhub" || task.ProjectName != "CliffHub" {
		t.Errorf("project fields changed: %q/%q", task.ProjectKey, task.ProjectName)
	}
	if task.TestPlan != plan {
		t.Errorf("TestPlan replaced on modern row")
	}
}

func TestModelCovNormalizeLegacyDerivesNameFromRepos(t *testing.T) {
	task := CodingTask{Repos: []TaskRepo{{Path: "group/My_App", Role: RepoRoleFrontend}}}
	task.NormalizeLegacy()
	if task.ProjectName != "My_App" {
		t.Errorf("ProjectName = %q, want My_App", task.ProjectName)
	}
	if task.ProjectKey != "my-app" {
		t.Errorf("ProjectKey = %q, want my-app", task.ProjectKey)
	}
}

func TestModelCovLegacyProjectKey(t *testing.T) {
	cases := []struct {
		name, want string
	}{
		{"CliffHub", "cliffhub"},
		{"My Cool App 2", "my-cool-app-2"},
		{"  Hello!!World  ", "hello-world"},
		{"---", ""},
		{"", ""},
	}
	for _, tc := range cases {
		if got := legacyProjectKey(tc.name); got != tc.want {
			t.Errorf("legacyProjectKey(%q) = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestModelCovTaskStateTerminal(t *testing.T) {
	cases := []struct {
		state TaskState
		want  bool
	}{
		{TaskStateDone, true},
		{TaskStateAbandoned, true},
		{TaskStateCreated, false},
		{TaskStateWorkspaceReady, false},
		{TaskStateInProgress, false},
		{TaskStateAwaitingTest, false},
		{TaskStateMRCreated, false},
		{TaskStateSetupFailed, false},
	}
	for _, tc := range cases {
		if got := tc.state.Terminal(); got != tc.want {
			t.Errorf("TaskState(%q).Terminal() = %v, want %v", tc.state, got, tc.want)
		}
	}
}

func TestModelCovValidTaskState(t *testing.T) {
	valid := []TaskState{
		TaskStateCreated, TaskStateWorkspaceReady, TaskStateInProgress, TaskStateAwaitingTest,
		TaskStateMRCreated, TaskStateDone, TaskStateSetupFailed, TaskStateAbandoned,
	}
	for _, s := range valid {
		if !ValidTaskState(string(s)) {
			t.Errorf("ValidTaskState(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "paused", "DONE"} {
		if ValidTaskState(s) {
			t.Errorf("ValidTaskState(%q) = true, want false", s)
		}
	}
}

func TestModelCovCanTransition(t *testing.T) {
	cases := []struct {
		name     string
		from, to TaskState
		want     bool
	}{
		{"same state is idempotent", TaskStateInProgress, TaskStateInProgress, true},
		{"created to workspace_ready", TaskStateCreated, TaskStateWorkspaceReady, true},
		{"workspace_ready to in_progress", TaskStateWorkspaceReady, TaskStateInProgress, true},
		{"setup_failed self-heals", TaskStateSetupFailed, TaskStateWorkspaceReady, true},
		{"awaiting_test to mr_created", TaskStateAwaitingTest, TaskStateMRCreated, true},
		{"mr_created bounces back", TaskStateMRCreated, TaskStateInProgress, true},
		{"mr_created to done", TaskStateMRCreated, TaskStateDone, true},
		{"no sign-off shortcut", TaskStateCreated, TaskStateMRCreated, false},
		{"created cannot jump to done", TaskStateCreated, TaskStateDone, false},
		{"done is terminal", TaskStateDone, TaskStateInProgress, false},
		{"abandoned is terminal", TaskStateAbandoned, TaskStateCreated, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := CanTransition(tc.from, tc.to); got != tc.want {
				t.Errorf("CanTransition(%q, %q) = %v, want %v", tc.from, tc.to, got, tc.want)
			}
		})
	}
}

func TestModelCovValidTaskKind(t *testing.T) {
	for _, k := range []string{TaskKindBug, TaskKindFeature, TaskKindChore} {
		if !ValidTaskKind(k) {
			t.Errorf("ValidTaskKind(%q) = false, want true", k)
		}
	}
	for _, k := range []string{"", "epic"} {
		if ValidTaskKind(k) {
			t.Errorf("ValidTaskKind(%q) = true, want false", k)
		}
	}
}

func TestModelCovTaskKindFlair(t *testing.T) {
	cases := []struct {
		kind, want string
	}{
		{TaskKindBug, "🐛 bug"},
		{TaskKindFeature, "✨ feature"},
		{TaskKindChore, "🧹 chore"},
		{"spike", "spike"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := TaskKindFlair(tc.kind); got != tc.want {
			t.Errorf("TaskKindFlair(%q) = %q, want %q", tc.kind, got, tc.want)
		}
	}
}

func TestModelCovValidTaskSteering(t *testing.T) {
	for _, s := range []string{TaskSteeringRequester, TaskSteeringAnyone} {
		if !ValidTaskSteering(s) {
			t.Errorf("ValidTaskSteering(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "admins"} {
		if ValidTaskSteering(s) {
			t.Errorf("ValidTaskSteering(%q) = true, want false", s)
		}
	}
}

func TestModelCovValidProjectPath(t *testing.T) {
	cases := []struct {
		name, path string
		want       bool
	}{
		{"group/repo", "group/repo", true},
		{"nested path", "group/sub/repo", true},
		{"dots dashes underscores", "my.group/sub-1/repo_2", true},
		{"empty", "", false},
		{"no slash", "repo", false},
		{"dot-dot traversal", "group/../repo", false},
		{"too long", strings.Repeat("a", TaskProjectPathMaxLen) + "/repo", false},
		{"space breaks pattern", "group/re po", false},
		{"trailing slash", "group/repo/", false},
	}
	for _, tc := range cases {
		if got := ValidProjectPath(tc.path); got != tc.want {
			t.Errorf("%s: ValidProjectPath(%q) = %v, want %v", tc.name, tc.path, got, tc.want)
		}
	}
}

func TestModelCovValidProjectKey(t *testing.T) {
	cases := []struct {
		key  string
		want bool
	}{
		{"cliffhub", true},
		{"a", true},
		{"9lives", true},
		{"my-app-2", true},
		{"a" + strings.Repeat("b", 47), true},  // 48 chars: the max
		{"a" + strings.Repeat("b", 48), false}, // 49 chars: too long
		{"", false},
		{"-leading-dash", false},
		{"Upper", false},
		{"space key", false},
	}
	for _, tc := range cases {
		if got := ValidProjectKey(tc.key); got != tc.want {
			t.Errorf("ValidProjectKey(%q) = %v, want %v", tc.key, got, tc.want)
		}
	}
}

func TestModelCovSteerEntitled(t *testing.T) {
	cases := []struct {
		name   string
		task   CodingTask
		userID string
		want   bool
	}{
		{"requester always steers", CodingTask{RequesterID: "u1"}, "u1", true},
		{"other blocked by default", CodingTask{RequesterID: "u1"}, "u2", false},
		{"other blocked when requester-only", CodingTask{RequesterID: "u1", Steering: TaskSteeringRequester}, "u2", false},
		{"anyone opens steering", CodingTask{RequesterID: "u1", Steering: TaskSteeringAnyone}, "u2", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.task.SteerEntitled(tc.userID); got != tc.want {
				t.Errorf("SteerEntitled(%q) = %v, want %v", tc.userID, got, tc.want)
			}
		})
	}
}

func TestModelCovTaskRepoLookup(t *testing.T) {
	task := CodingTask{Repos: []TaskRepo{
		{Path: "group/backend", Role: RepoRoleBackend},
		{Path: "group/frontend", Role: RepoRoleFrontend},
	}}
	r := task.Repo("group/frontend")
	if r == nil || r.Role != RepoRoleFrontend {
		t.Fatalf("Repo(group/frontend) = %+v, want the frontend entry", r)
	}
	// The pointer aliases the task's slice so callers can mutate in place.
	r.MRURL = "https://mr/2"
	if task.Repos[1].MRURL != "https://mr/2" {
		t.Error("Repo() did not return a pointer into task.Repos")
	}
	if got := task.Repo("group/missing"); got != nil {
		t.Errorf("Repo(missing) = %+v, want nil", got)
	}
}

func TestModelCovHasRole(t *testing.T) {
	task := CodingTask{Repos: []TaskRepo{
		{Path: "group/backend", Role: RepoRoleBackend},
		{Path: "group/frontend", Role: RepoRoleFrontend},
	}}
	if !task.HasRole(RepoRoleFrontend) {
		t.Error("HasRole(frontend) = false, want true")
	}
	if task.HasRole(RepoRoleMobile) {
		t.Error("HasRole(mobile) = true, want false")
	}
	empty := CodingTask{}
	if empty.HasRole(RepoRoleBackend) {
		t.Error("empty task HasRole(backend) = true, want false")
	}
}

func TestModelCovMRURLs(t *testing.T) {
	task := CodingTask{Repos: []TaskRepo{
		{Path: "group/backend", MRURL: "https://mr/1"},
		{Path: "group/frontend"},
		{Path: "group/infra", MRURL: "https://mr/3"},
	}}
	want := []string{"https://mr/1", "https://mr/3"}
	if got := task.MRURLs(); !reflect.DeepEqual(got, want) {
		t.Errorf("MRURLs() = %v, want %v", got, want)
	}
	none := CodingTask{Repos: []TaskRepo{{Path: "group/backend"}}}
	if got := none.MRURLs(); len(got) != 0 {
		t.Errorf("MRURLs() with no MRs = %v, want empty", got)
	}
}

// --- connector.go ---

func TestModelCovConnectorEnvPrefix(t *testing.T) {
	cases := []struct {
		slug, want string
	}{
		{"cliffhub", "CLIFFHUB"},
		{"my-app.2", "MY_APP_2"},
		{"a b", "A_B"},
		{"", ""},
	}
	for _, tc := range cases {
		c := &Connector{Slug: tc.slug}
		if got := c.EnvPrefix(); got != tc.want {
			t.Errorf("EnvPrefix() for slug %q = %q, want %q", tc.slug, got, tc.want)
		}
	}
}

// --- user.go ---

func TestModelCovUserIsAgent(t *testing.T) {
	var nilUser *User
	if nilUser.IsAgent() {
		t.Error("nil user IsAgent() = true, want false")
	}
	human := &User{Kind: UserKindHuman}
	if human.IsAgent() {
		t.Error("human IsAgent() = true, want false")
	}
	agent := &User{Kind: UserKindAgent, AgentConfig: &AgentConfig{TemplateSlug: "gg"}}
	if !agent.IsAgent() {
		t.Error("agent IsAgent() = false, want true")
	}
}
