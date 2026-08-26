package service

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
)

// stubConnectorRegistry answers KnownSlugs/InstalledIndex from fixed sets.
type stubConnectorRegistry struct {
	slugs map[string]bool
	index []ConnectorIndexEntry
}

func (s *stubConnectorRegistry) KnownSlugs(context.Context) (map[string]bool, error) {
	return s.slugs, nil
}

func (s *stubConnectorRegistry) InstalledIndex(context.Context, string) ([]ConnectorIndexEntry, error) {
	return s.index, nil
}

func startPickRun(t *testing.T, fx *orchFixture, msg *model.Message) *model.Run {
	t.Helper()
	agent, _ := fx.users.GetUser(context.Background(), testGGID)
	invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
	resolved, err := fx.orch.agentSvc.Resolve(context.Background(), agent, invoker.ID)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	run, err := fx.orch.StartRun(context.Background(), agent, invoker, msg, ParentChannel, resolved, 0, nil)
	if err != nil {
		t.Fatalf("start run: %v", err)
	}
	return run
}

// An explicit /connector pick is validated against the registry, recorded on
// the run, and stripped from the prompt (a leading "/slug" reads as a CLI
// slash command). Unregistered tokens are neither recorded nor rewritten.
func TestOrchestrator_ConnectorPickExplicit(t *testing.T) {
	fx := newOrchFixture(t)
	fx.orch.SetConnectorRegistry(&stubConnectorRegistry{slugs: map[string]bool{"cliffhub": true}})

	run := startPickRun(t, fx, &model.Message{
		ID: "m-c1", ParentID: "chan1", AuthorID: "u-alice",
		Body: "/cliffhub find me details about habib and check /notaconnector too",
	})
	if !reflect.DeepEqual(run.ConnectorSlugs, []string{"cliffhub"}) {
		t.Fatalf("slugs = %v", run.ConnectorSlugs)
	}
	if strings.Contains(run.Prompt, "/cliffhub") {
		t.Fatalf("picked token not stripped from prompt: %q", run.Prompt)
	}
	if !strings.HasPrefix(run.Prompt, "cliffhub find me") {
		t.Fatalf("prompt = %q", run.Prompt)
	}
	if !strings.Contains(run.Prompt, "/notaconnector") {
		t.Fatalf("unregistered token must stay as typed: %q", run.Prompt)
	}
}

// A follow-up inside a thread inherits the thread's picks — nobody re-types
// /cliffhub mid-conversation, and a warm session that remembers the workflow
// must not lose its credentials on round two.
func TestOrchestrator_ConnectorPickThreadStickiness(t *testing.T) {
	fx := newOrchFixture(t)
	fx.orch.SetConnectorRegistry(&stubConnectorRegistry{slugs: map[string]bool{"cliffhub": true, "core": true}})
	fx.msgs.thread = []*model.Message{
		{ID: "root", ParentID: "chan1", AuthorID: "u-alice", Body: "/cliffhub find me details about habib"},
		{ID: "r1", ParentID: "chan1", ParentMessageID: "root", AuthorID: testGGID, Body: "found him"},
	}

	run := startPickRun(t, fx, &model.Message{
		ID: "m-c2", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice",
		Body: "can we update his name to Habibb Altaf?",
	})
	if !reflect.DeepEqual(run.ConnectorSlugs, []string{"cliffhub"}) {
		t.Fatalf("follow-up must inherit thread picks, got %v", run.ConnectorSlugs)
	}
	if run.Prompt != "can we update his name to Habibb Altaf?" {
		t.Fatalf("prompt = %q", run.Prompt)
	}

	// A top-level message (new thread) inherits nothing.
	run2 := startPickRun(t, fx, &model.Message{
		ID: "m-c3", ParentID: "chan1", AuthorID: "u-alice", Body: "unrelated new ask",
	})
	if len(run2.ConnectorSlugs) != 0 {
		t.Fatalf("new thread must not inherit picks, got %v", run2.ConnectorSlugs)
	}
}

// The bundle carries an ambient index of installed-but-unattached connectors
// (discovery for use_connector); attached and agent-use=never entries are
// excluded.
func TestOrchestrator_ConnectorAmbientIndexInBundle(t *testing.T) {
	fx := newOrchFixture(t)
	fx.orch.SetConnectorRegistry(&stubConnectorRegistry{
		slugs: map[string]bool{"cliffhub": true, "core": true, "secretsvc": true},
		index: []ConnectorIndexEntry{
			{Slug: "cliffhub", Title: "CliffHub", Description: "Team ops platform", AgentUse: "ask"},
			{Slug: "core", Title: "DT Core", Description: "Booking platform", AgentUse: "always"},
			{Slug: "secretsvc", Title: "Secret", Description: "Hands off", AgentUse: "never"},
		},
	})

	// Run WITH cliffhub attached: index lists only core (cliffhub attached,
	// secretsvc is never-use).
	run := startPickRun(t, fx, &model.Message{
		ID: "m-b1", ParentID: "chan1", AuthorID: "u-alice", Body: "/cliffhub who is habib?",
	})
	bundle, _ := fx.orch.buildBundle(context.Background(), run)
	if !strings.Contains(bundle, "# Installed connectors") {
		t.Fatalf("bundle missing ambient connector index:\n%s", bundle)
	}
	if !strings.Contains(bundle, "- core: DT Core") {
		t.Fatalf("index missing core")
	}
	if strings.Contains(bundle, "- cliffhub:") || strings.Contains(bundle, "secretsvc") {
		t.Fatalf("index must exclude attached + never-use connectors:\n%s", bundle)
	}
}

// AttachConnector records an agent-initiated attach on the live run,
// idempotently.
func TestOrchestrator_AttachConnector(t *testing.T) {
	fx := newOrchFixture(t)
	fx.orch.SetConnectorRegistry(&stubConnectorRegistry{slugs: map[string]bool{"cliffhub": true}})
	run := startPickRun(t, fx, &model.Message{
		ID: "m-a1", ParentID: "chan1", AuthorID: "u-alice", Body: "does hamza have pending leaves?",
	})
	if len(run.ConnectorSlugs) != 0 {
		t.Fatalf("run should start with no picks")
	}
	if err := fx.orch.AttachConnector(context.Background(), run.ID, "cliffhub", "leave data lives in CliffHub"); err != nil {
		t.Fatalf("attach: %v", err)
	}
	if err := fx.orch.AttachConnector(context.Background(), run.ID, "cliffhub", "again"); err != nil {
		t.Fatalf("re-attach: %v", err)
	}
	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if !reflect.DeepEqual(got.ConnectorSlugs, []string{"cliffhub"}) {
		t.Fatalf("slugs = %v", got.ConnectorSlugs)
	}
}
