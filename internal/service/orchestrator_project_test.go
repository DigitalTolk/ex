package service

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// projectOrchFixture is an orchestrator fixture with a design agent user and a
// real ProjectService (in-memory store) holding "Acme Portal" (with a screen)
// and "Beta".
func projectOrchFixture(t *testing.T) (*orchFixture, *projectFixture) {
	t.Helper()
	fx := newOrchFixture(t)
	design := &model.User{ID: AgentUserID(AgentSlugDesign), DisplayName: "design", Kind: model.UserKindAgent,
		AgentConfig: &model.AgentConfig{TemplateSlug: AgentSlugDesign}}
	fx.users.users[design.ID] = design
	pf := newProjectFixture(t)
	pf.mustCreate(t, "Acme Portal")
	pf.mustScreen(t, "acme-portal", "Home", "img-home")
	pf.mustCreate(t, "Beta")
	fx.orch.SetProjects(pf.svc)
	return fx, pf
}

func startAgentRun(t *testing.T, fx *orchFixture, agentID string, msg *model.Message) *model.Run {
	t.Helper()
	ctx := context.Background()
	// One channel per message: the busy dedup allows one active run per
	// (agent, channel/thread), and these runs never finish.
	msg.ParentID = "chan-" + msg.ID
	agent, _ := fx.users.GetUser(ctx, agentID)
	invoker, _ := fx.users.GetUser(ctx, "u-alice")
	resolved, err := fx.orch.agentSvc.Resolve(ctx, agent, invoker.ID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	run, err := fx.orch.startRun(ctx, invocation{agent: agent, invoker: invoker, msg: msg, parentType: ParentChannel}, resolved)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	return run
}

var designID = AgentUserID(AgentSlugDesign)

// For the design agent a /token naming a project IS the project — even when a
// connector has the same name — and leaves the prompt like any pick.
func TestOrchestrator_DesignProjectToken(t *testing.T) {
	fx, _ := projectOrchFixture(t)
	fx.orch.SetConnectorRegistry(&stubConnectorRegistry{slugs: map[string]bool{"acme-portal": true, "core": true}})
	run := startAgentRun(t, fx, designID, &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice",
		Body: "/acme-portal /core add a cancel button"})
	if run.ProjectKey != "acme-portal" {
		t.Fatalf("project = %q", run.ProjectKey)
	}
	if !reflect.DeepEqual(run.ConnectorSlugs, []string{"core"}) {
		t.Fatalf("the project token must not also attach the same-named connector: %v", run.ConnectorSlugs)
	}
	if run.Prompt != "acme-portal core add a cancel button" {
		t.Fatalf("prompt = %q", run.Prompt)
	}
}

// The design agent also finds the project by name, in the message first and
// then anywhere in the thread (tweaks never repeat the product's name).
func TestOrchestrator_DesignProjectByName(t *testing.T) {
	fx, _ := projectOrchFixture(t)
	run := startAgentRun(t, fx, designID, &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice",
		Body: "mock the Acme Portal home page with a banner"})
	if run.ProjectKey != "acme-portal" || !strings.Contains(run.Prompt, "Acme Portal") {
		t.Fatalf("by name: %q / %q", run.ProjectKey, run.Prompt)
	}

	fx.msgs.thread = []*model.Message{{ID: "root", ParentID: "chan1", AuthorID: "u-alice", Body: "@[x|design] a Beta settings page"}}
	run = startAgentRun(t, fx, designID, &model.Message{ID: "m2", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice",
		Body: "make the title bigger"})
	if run.ProjectKey != "beta" {
		t.Fatalf("thread name match: %q", run.ProjectKey)
	}

	fx.msgs.thread = []*model.Message{{ID: "root", ParentID: "chan1", AuthorID: "u-alice", Body: "/acme-portal a page"}}
	run = startAgentRun(t, fx, designID, &model.Message{ID: "m3", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice",
		Body: "now in Beta colors"})
	if run.ProjectKey != "beta" {
		t.Fatalf("a name in the message beats the thread's token: %q", run.ProjectKey)
	}
	run = startAgentRun(t, fx, designID, &model.Message{ID: "m4", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice",
		Body: "make it darker"})
	if run.ProjectKey != "acme-portal" || run.Prompt != "make it darker" {
		t.Fatalf("thread token inherited, nothing to strip: %q / %q", run.ProjectKey, run.Prompt)
	}

	fx.msgs.thread = []*model.Message{{ID: "root", ParentID: "chan1", AuthorID: "u-alice", Body: "a page"}}
	run = startAgentRun(t, fx, designID, &model.Message{ID: "m5", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice", Body: "bigger"})
	if run.ProjectKey != "" {
		t.Fatalf("nothing anywhere: %q", run.ProjectKey)
	}
	run = startAgentRun(t, fx, designID, &model.Message{ID: "m6", ParentID: "chan1", AuthorID: "u-alice", Body: "a login page"})
	if run.ProjectKey != "" {
		t.Fatalf("top-level, no project: %q", run.ProjectKey)
	}
}

// Every other agent keeps "/cliffhub" meaning the connector, never matches
// names, and still honors an explicit project pick that is not a connector.
func TestOrchestrator_OtherAgentsProjectPicks(t *testing.T) {
	fx, _ := projectOrchFixture(t)
	fx.orch.SetConnectorRegistry(&stubConnectorRegistry{slugs: map[string]bool{"acme-portal": true}})

	run := startAgentRun(t, fx, testGGID, &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "/acme-portal list bookings"})
	if run.ProjectKey != "" || !reflect.DeepEqual(run.ConnectorSlugs, []string{"acme-portal"}) {
		t.Fatalf("gg + connector token: project %q connectors %v", run.ProjectKey, run.ConnectorSlugs)
	}
	run = startAgentRun(t, fx, testGGID, &model.Message{ID: "m2", ParentID: "chan1", AuthorID: "u-alice", Body: "/beta what does it look like"})
	if run.ProjectKey != "beta" || run.Prompt != "beta what does it look like" {
		t.Fatalf("gg + project-only token: %q / %q", run.ProjectKey, run.Prompt)
	}
	run = startAgentRun(t, fx, testGGID, &model.Message{ID: "m3", ParentID: "chan1", AuthorID: "u-alice", Body: "how is Beta doing"})
	if run.ProjectKey != "" {
		t.Fatalf("gg never name-matches: %q", run.ProjectKey)
	}
	fx.msgs.thread = []*model.Message{{ID: "root", ParentID: "chan1", AuthorID: "u-alice", Body: "/beta and Acme Portal"}}
	run = startAgentRun(t, fx, testGGID, &model.Message{ID: "m4", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice", Body: "more"})
	if run.ProjectKey != "beta" {
		t.Fatalf("gg inherits a thread project token: %q", run.ProjectKey)
	}
	fx.msgs.thread = []*model.Message{{ID: "root", ParentID: "chan1", AuthorID: "u-alice", Body: "Acme Portal"}}
	run = startAgentRun(t, fx, testGGID, &model.Message{ID: "m5", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice", Body: "more"})
	if run.ProjectKey != "" {
		t.Fatalf("gg never name-matches the thread: %q", run.ProjectKey)
	}
}

type failingConnectorRegistry struct{}

func (failingConnectorRegistry) KnownSlugs(context.Context) (map[string]bool, error) {
	return nil, errors.New("registry down")
}
func (failingConnectorRegistry) InstalledIndex(context.Context, string) ([]ConnectorIndexEntry, error) {
	return nil, nil
}

type failingThreadMessages struct{ *fakeOrchMessages }

func (failingThreadMessages) ListThreadMessages(context.Context, string, string, string, string) ([]*model.Message, error) {
	return nil, errors.New("thread read failed")
}

func TestOrchestrator_ProjectPickFailures(t *testing.T) {
	fx, _ := projectOrchFixture(t)
	ctx := context.Background()
	gg, _ := fx.users.GetUser(ctx, testGGID)
	design, _ := fx.users.GetUser(ctx, designID)

	// A connector registry that can't answer: other agents can't tell a
	// connector from a project, so they attach no project.
	fx.orch.SetConnectorRegistry(failingConnectorRegistry{})
	if key, tok := fx.orch.resolveProjectPick(ctx, "u-alice", gg, &model.Message{Body: "/beta x"}, ParentChannel); key != "" || tok != "" {
		t.Fatalf("registry failure: %q %q", key, tok)
	}
	if key, _ := fx.orch.resolveProjectPick(ctx, "u-alice", design, &model.Message{Body: "/beta x"}, ParentChannel); key != "beta" {
		t.Fatalf("design ignores the registry: %q", key)
	}

	fx.orch.messages = failingThreadMessages{fx.msgs}
	if key, _ := fx.orch.resolveProjectPick(ctx, "u-alice", design, &model.Message{Body: "x", ParentMessageID: "root"}, ParentChannel); key != "" {
		t.Fatalf("thread read failure: %q", key)
	}

	fx.orch.SetProjects(nil)
	if key, tok := fx.orch.resolveProjectPick(ctx, "u-alice", design, &model.Message{Body: "/beta"}, ParentChannel); key != "" || tok != "" {
		t.Fatalf("no project service: %q %q", key, tok)
	}
}

func TestWithoutSlug(t *testing.T) {
	if got := withoutSlug([]string{"a", "b", "a"}, "a"); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("got %v", got)
	}
	in := []string{"a"}
	if got := withoutSlug(in, ""); !reflect.DeepEqual(got, in) {
		t.Fatalf("empty slug keeps the list: %v", got)
	}
}

func TestOrchestrator_RunMayReadScreen(t *testing.T) {
	fx, _ := projectOrchFixture(t)
	ctx := context.Background()
	if !fx.orch.RunMayReadScreen(ctx, &model.Run{ProjectKey: "acme-portal"}, "img-home") {
		t.Fatal("a run may read its project's screens")
	}
	for _, run := range []*model.Run{nil, {}, {ProjectKey: "beta"}} {
		if fx.orch.RunMayReadScreen(ctx, run, "img-home") {
			t.Fatalf("run %+v must not read it", run)
		}
	}
	fx.orch.SetProjects(nil)
	if fx.orch.RunMayReadScreen(ctx, &model.Run{ProjectKey: "acme-portal"}, "img-home") {
		t.Fatal("no project service: no screen reads")
	}
}

func TestBundle_DesignReferencesLayer(t *testing.T) {
	fx, _ := projectOrchFixture(t)
	ctx := context.Background()

	run := startAgentRun(t, fx, designID, &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "/acme-portal a banner"})
	doc, stats := fx.orch.buildBundle(ctx, run)
	if !strings.Contains(doc, "# Design references: Acme Portal") || stats["designReferences"] != true || stats["designProject"] != "acme-portal" {
		t.Fatalf("design run with project: stats %v\n%s", stats, doc)
	}

	run = startAgentRun(t, fx, designID, &model.Message{ID: "m2", ParentID: "chan1", AuthorID: "u-alice", Body: "a login page"})
	doc, _ = fx.orch.buildBundle(ctx, run)
	if !strings.Contains(doc, "No project was named") {
		t.Fatalf("design run without project gets the project list:\n%s", doc)
	}

	run = startAgentRun(t, fx, testGGID, &model.Message{ID: "m3", ParentID: "chan1", AuthorID: "u-alice", Body: "summarize"})
	doc, stats = fx.orch.buildBundle(ctx, run)
	if strings.Contains(doc, "# Design references") || stats["designReferences"] != false {
		t.Fatalf("plain gg run carries no design layer: %v", stats)
	}

	fx.orch.SetProjects(nil)
	run.ProjectKey = "acme-portal"
	if _, stats = fx.orch.buildBundle(ctx, run); stats["designReferences"] != false {
		t.Fatal("no project service: no layer")
	}
}

// Guests can't open Projects, so no agent reads a project's references for one.
func TestOrchestrator_GuestInvokerGetsNoProject(t *testing.T) {
	fx, _ := projectOrchFixture(t)
	fx.users.users["u-alice"].SystemRole = model.SystemRoleGuest
	run := startAgentRun(t, fx, designID, &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "/acme-portal a banner"})
	if run.ProjectKey != "" || run.Prompt != "/acme-portal a banner" {
		t.Fatalf("guest run: project %q prompt %q", run.ProjectKey, run.Prompt)
	}
}

// Design runs need a runner with file tools: an old built-in runner (no
// advertised features) leaves them queued, one advertising "files" claims.
func TestOrchestrator_DesignRunsNeedFileRunner(t *testing.T) {
	fx, _ := projectOrchFixture(t)
	ctx := context.Background()
	run := startAgentRun(t, fx, designID, &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "/acme-portal a banner"})
	if !reflect.DeepEqual(run.RequiresFeatures, []string{model.RunnerFeatureFiles}) {
		t.Fatalf("design run must require files: %v", run.RequiresFeatures)
	}
	if got, err := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 1, 0); err != nil || len(got) != 0 {
		t.Fatalf("featureless runner must not claim a design run: %v %v", got, err)
	}
	got, err := fx.orch.ClaimWithFeatures(ctx, "u-alice", "r1", []string{model.HarnessClaude}, []string{model.RunnerFeatureFiles}, 1, 0)
	if err != nil || len(got) != 1 || got[0].RunID != run.ID {
		t.Fatalf("files runner claims it: %+v %v", got, err)
	}
	gg := startAgentRun(t, fx, testGGID, &model.Message{ID: "m2", ParentID: "chan2", AuthorID: "u-alice", Body: "hi"})
	if len(gg.RequiresFeatures) != 0 {
		t.Fatalf("other agents need nothing extra: %v", gg.RequiresFeatures)
	}
	if got, _ := fx.orch.Claim(ctx, "u-alice", "r1", []string{model.HarnessClaude}, 1, 0); len(got) != 1 {
		t.Fatalf("featureless runner still claims ordinary runs: %+v", got)
	}
}
