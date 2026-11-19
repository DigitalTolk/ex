package agents

import (
	"context"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

func gitRun(harness, mode, taskID string) *model.Run {
	return &model.Run{
		ID: "r1", AgentID: testGGID, InvokerID: "u-alice", OwnerID: "u-alice",
		ParentID: "chan1", ParentType: service.ParentChannel, MessageID: "m1",
		Prompt: "can you clone the ats repo?", Harness: harness, Mode: mode, TaskID: taskID,
	}
}

// An agent with a shell is told which GitLab the team uses and to use the
// machine's own git and glab sign-in, so it stops reaching for gitlab.com or
// saying it can't without a connector.
func TestBundle_GitAccessForRunsWithAShell(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.orch.SetGitHost("https://gitlab.example.com/")
	ctx := context.Background()

	for _, harness := range []string{model.HarnessClaude, ""} {
		got, stats := fx.orch.buildBundle(ctx, gitRun(harness, model.RunModeDirect, ""))
		for _, want := range []string{
			"# Git and GitLab",
			"gitlab.example.com",
			"--hostname gitlab.example.com",
			"glab auth login --hostname gitlab.example.com",
			"git ls-remote https://gitlab.example.com/",
			"Never ask for a token in chat",
		} {
			if !strings.Contains(got, want) {
				t.Fatalf("harness %q: bundle lacks %q:\n%s", harness, want, got)
			}
		}
		if strings.Contains(got, "https://gitlab.example.com//") || stats["gitAccess"] != true {
			t.Fatalf("harness %q: host not normalized or not reported: %v", harness, stats["gitAccess"])
		}
	}
}

func TestBundle_NoGitAccessWithoutAShellOrHost(t *testing.T) {
	ctx := context.Background()
	fx := newOrchCovFixture(t)

	// No host set: nothing to say.
	if got, _ := fx.orch.buildBundle(ctx, gitRun(model.HarnessClaude, model.RunModeDirect, "")); strings.Contains(got, "# Git and GitLab") {
		t.Fatal("no host configured, yet the section showed")
	}

	fx.orch.SetGitHost("gitlab.example.com")
	// A server-side run has no shell; Codex's chat shell is read-only with no
	// network and the credential paths denied.
	for _, harness := range []string{model.HarnessBedrock, model.HarnessCodex} {
		if got, stats := fx.orch.buildBundle(ctx, gitRun(harness, model.RunModeDirect, "")); strings.Contains(got, "# Git and GitLab") || stats["gitAccess"] != false {
			t.Fatalf("a %s run can't use git, so it must not be told to", harness)
		}
	}
	// A coding task has its own git flow (the runner clones; request_mr ships).
	if got, _ := fx.orch.buildBundle(ctx, gitRun(model.HarnessClaude, model.RunModeTask, "t1")); strings.Contains(got, "# Git and GitLab") {
		t.Fatal("a coding task run keeps its own git flow")
	}
}

func TestSetGitHost_Normalizes(t *testing.T) {
	for in, want := range map[string]string{
		"gitlab.example.com":           "gitlab.example.com",
		" https://gitlab.example.com/": "gitlab.example.com",
		"http://gitlab.example.com":    "gitlab.example.com",
		"":                             "",
	} {
		o := &Orchestrator{}
		o.SetGitHost(in)
		if o.gitHost != want {
			t.Fatalf("SetGitHost(%q) = %q, want %q", in, o.gitHost, want)
		}
	}
}
