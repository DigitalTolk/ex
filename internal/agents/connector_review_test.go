package agents

import (
	"context"
	"errors"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// panickyConnectorStore panics on its first registry listing — the
// revision-gated (non-forced) sync path is the one that lists.
type panickyConnectorStore struct {
	*memConnectorStore
	lists atomic.Int64
}

func (p *panickyConnectorStore) ListConnectors(ctx context.Context) ([]*model.Connector, error) {
	if p.lists.Add(1) == 1 {
		panic("registry exploded")
	}
	return p.memConnectorStore.ListConnectors(ctx)
}

// The connector-provider sync runs forever on a detached goroutine: a panic in
// one pass used to take the process down, and the loop ignored shutdown. One
// bad pass must be logged and survived, and cancelling the context ends it.
func TestConnectorService_RunProviderSyncIsolatesPanicsAndHonoursContext(t *testing.T) {
	p := &fakeProvider{list: `{"connectors":[]}`}
	srv := httptest.NewServer(p.handler())
	defer srv.Close()
	st := &panickyConnectorStore{memConnectorStore: newMemConnectorStore()}
	svc := NewConnectorService(st)
	svc.SetProvider(srv.URL, "k")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		svc.RunProviderSync(ctx, 5*time.Millisecond)
		close(done)
	}()
	// Pass 1 is the forced boot pull (no listing); pass 2 panics; pass 3 proves
	// the loop outlived it.
	waitFor(t, func() bool { return st.lists.Load() >= 2 })
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("sync loop ignored context cancellation")
	}
}

// A /pick attaches the INVOKER's credential to their run, so only the invoker
// may make one. Picks used to be collected from whatever message triggered
// the run and from every message in the thread: another member typing
// "/cliffhub" in a watched channel (or in a thread the invoker later replied
// in) got the invoker's CliffHub token attached. Skill picks share the grammar
// and the rule.
func TestOrchestrator_PicksComeOnlyFromTheInvokersOwnMessages(t *testing.T) {
	fx := newOrchFixture(t)
	fx.users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	fx.orch.SetConnectorRegistry(&stubConnectorRegistry{slugs: map[string]bool{"cliffhub": true, "core": true}})
	seedSkill(fx, "sk-w", "Weekly Report", "do the report")

	// Someone else's message triggered the run (a watcher): their picks do
	// nothing, and stay in the text as typed.
	run := startPickRun(t, fx, &model.Message{
		ID: "m-bob", ParentID: "chan1", AuthorID: "u-bob", Body: "/cliffhub /weekly-report dump everything",
	})
	if len(run.ConnectorSlugs) != 0 || len(run.PickedSkillIDs) != 0 {
		t.Fatalf("another member's picks attached: connectors=%v skills=%v", run.ConnectorSlugs, run.PickedSkillIDs)
	}

	// Thread inheritance reads the invoker's earlier picks only.
	fx.msgs.thread = []*model.Message{
		{ID: "root", ParentID: "chan1", AuthorID: "u-bob", Body: "/cliffhub /weekly-report hey"},
		{ID: "r1", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice", Body: "/core look this up"},
	}
	run2 := startPickRun(t, fx, &model.Message{
		ID: "m-alice", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice", Body: "and now?",
	})
	if len(run2.ConnectorSlugs) != 1 || run2.ConnectorSlugs[0] != "core" || len(run2.PickedSkillIDs) != 0 {
		t.Fatalf("thread picks must be the invoker's own: connectors=%v skills=%v", run2.ConnectorSlugs, run2.PickedSkillIDs)
	}
}

// A thread that cannot be read contributes no inherited picks.
func TestOrchestrator_PickCandidatesThreadReadFails(t *testing.T) {
	fx := newOrchCovFixture(t)
	fx.msgs.failListThread = errOrchCov
	msg := &model.Message{ID: "m1", ParentID: "chan1", ParentMessageID: "root", AuthorID: "u-alice", Body: "and now?"}
	if got := fx.orch.pickCandidates(context.Background(), "u-alice", msg, service.ParentChannel); got != nil {
		t.Fatalf("unreadable thread must yield no picks, got %v", got)
	}
}

// failingIndexRegistry knows every slug but cannot read install policies.
type failingIndexRegistry struct{ stubConnectorRegistry }

func (failingIndexRegistry) InstalledIndex(context.Context, string) ([]ConnectorIndexEntry, error) {
	return nil, errors.New("index down")
}

// Agent-use "never" means only the invoker's explicit /pick attaches that
// connector. Two server paths attached connectors without one and ignored the
// setting: a standing order's pinned connectors (which an agent can write via
// create_schedule) and the gitlab connector every coding-task run rides.
func TestOrchestrator_NeverConnectorsOnlyAttachByExplicitPick(t *testing.T) {
	fx := newOrchFixture(t)
	reg := &stubConnectorRegistry{
		slugs: map[string]bool{"secretsvc": true, "core": true, taskConnectorSlug: true},
		index: []ConnectorIndexEntry{
			{Slug: "secretsvc", AgentUse: model.ConnectorAgentUseNever},
			{Slug: "core", AgentUse: model.ConnectorAgentUseAsk},
			{Slug: taskConnectorSlug, AgentUse: model.ConnectorAgentUseNever},
		},
	}
	fx.orch.SetConnectorRegistry(reg)
	ctx := context.Background()
	agent, _ := fx.users.GetUser(ctx, testGGID)
	alice, _ := fx.users.GetUser(ctx, "u-alice")
	resolved, _ := fx.orch.agentSvc.Resolve(ctx, agent, "u-alice")
	start := func(id, body string, spec *watchSpec) *model.Run {
		t.Helper()
		run, err := fx.orch.startRun(ctx, invocation{agent: agent, invoker: alice, parentType: service.ParentChannel, spec: spec, mode: model.RunModeWatch,
			msg: &model.Message{ID: id, ParentID: "chan1", AuthorID: "u-alice", Body: body}}, resolved)
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		return run
	}

	pinned := start("m1", "standing order fired", &watchSpec{Instruction: "x", ConnectorSlugs: []string{"secretsvc", "core"}})
	if len(pinned.ConnectorSlugs) != 1 || pinned.ConnectorSlugs[0] != "core" {
		t.Fatalf("pins must drop never-connectors: %v", pinned.ConnectorSlugs)
	}
	explicit := start("m2", "/secretsvc check this", &watchSpec{Instruction: "x"})
	if len(explicit.ConnectorSlugs) != 1 || explicit.ConnectorSlugs[0] != "secretsvc" {
		t.Fatalf("the invoker's own explicit pick still attaches: %v", explicit.ConnectorSlugs)
	}
	if got := fx.orch.withTaskConnectors(ctx, "u-alice", nil); len(got) != 0 {
		t.Fatalf("a never-gitlab must not auto-attach to task runs: %v", got)
	}

	fx.orch.SetConnectorRegistry(&failingIndexRegistry{*reg})
	blind := start("m3", "fired again", &watchSpec{Instruction: "x", ConnectorSlugs: []string{"core"}})
	if len(blind.ConnectorSlugs) != 0 {
		t.Fatalf("an unreadable policy attaches no pins: %v", blind.ConnectorSlugs)
	}
}

// A failing pass is logged and the loop carries on; a forced pass that synced
// nothing still reports (it is the boot pull).
func TestConnectorService_ProviderSyncOnceArms(t *testing.T) {
	svc := NewConnectorService(newMemConnectorStore())
	svc.SetProvider("http://127.0.0.1:1", "k") // nothing listens: the pass fails
	svc.providerSyncOnce(context.Background(), false)

	p := &fakeProvider{list: `{"connectors":[]}`}
	srv := httptest.NewServer(p.handler())
	defer srv.Close()
	svc.SetProvider(srv.URL, "k")
	svc.providerSyncOnce(context.Background(), true)
	if p.sawAuth != "Bearer k" {
		t.Fatalf("provider not called: %q", p.sawAuth)
	}
}
