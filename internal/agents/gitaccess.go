package agents

import (
	"strings"

	"github.com/DigitalTolk/ex/internal/model"
)

// SetGitHost names the team's GitLab (AGENT_GIT_HOST, e.g. gitlab.example.com;
// a URL works too). Runs with a shell are then told to use it with the git and
// glab already signed in on their machine. Empty leaves that out.
func (o *Orchestrator) SetGitHost(host string) {
	host = strings.TrimSpace(host)
	host = strings.TrimPrefix(strings.TrimPrefix(host, "https://"), "http://")
	o.gitHost = strings.TrimRight(host, "/")
}

// gitAccess tells a run with a shell how to reach the team's GitLab. Without
// it agents looked at gitlab.com, where glab points by default, and gave up
// for want of a connector while the machine had a working sign-in. Only
// Claude Code gets it: its shell is the machine's own (credential paths named
// in a command raise an approval card). Codex's chat shell is read-only with
// no network and the credential paths denied, a server-side run has no shell,
// and a coding task has its own git flow (the runner clones and request_mr
// ships), so none of those could act on it.
func (b *bundleBuilder) gitAccess() {
	host := b.o.gitHost
	claude := b.run.Harness == model.HarnessClaude || b.run.Harness == ""
	if host == "" || !claude || b.run.TaskID != "" {
		b.stats["gitAccess"] = false
		return
	}
	b.must("\n# Git and GitLab\n" +
		"The team's GitLab is " + host + ", not gitlab.com. A repo group/name is https://" + host + "/group/name.git " +
		"(or git@" + host + ":group/name.git over SSH).\n" +
		"- Use the git and glab already on this machine: whatever sign-in it has (an SSH key, a git credential helper, " +
		"a glab login) is yours to use, with or without a GitLab connector. Check before saying you can't: " +
		"`git ls-remote https://" + host + "/group/name.git` and `glab auth status --hostname " + host + "`.\n" +
		"- glab talks to gitlab.com unless told otherwise: pass --hostname " + host + " (e.g. `glab api --hostname " + host +
		" /user`) or set GITLAB_HOST=" + host + " on the command. Inside a clone glab follows its remote.\n" +
		"- If nothing is signed in, give the person the one command to run themselves on that machine: " +
		"`glab auth login --hostname " + host + "` (a token with read_api, and write_repository to push), then try again. " +
		"Never ask for a token in chat, and never read or print credential files.\n" +
		"- Clone into a fresh directory, never over existing work. Push, or open a merge request, only when the person asked for it.\n")
	b.stats["gitAccess"] = true
}
