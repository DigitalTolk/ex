package service

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/store"
)

// ---------------------------------------------------------------- fakes

type fakeCtxStore struct {
	mu    sync.Mutex
	items map[string][]*model.ContextItem // parentType#parentID -> items
}

func newFakeCtxStore() *fakeCtxStore {
	return &fakeCtxStore{items: map[string][]*model.ContextItem{}}
}

func ctxKey(parentType, parentID string) string { return parentType + "#" + parentID }

func (f *fakeCtxStore) PutContextItem(_ context.Context, it *model.ContextItem) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := ctxKey(it.ParentType, it.ParentID)
	for i, existing := range f.items[key] {
		if existing.ID == it.ID {
			cp := *it
			f.items[key][i] = &cp
			return nil
		}
	}
	cp := *it
	f.items[key] = append(f.items[key], &cp)
	return nil
}

func (f *fakeCtxStore) GetContextItem(_ context.Context, parentType, parentID, itemID string) (*model.ContextItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, it := range f.items[ctxKey(parentType, parentID)] {
		if it.ID == itemID {
			cp := *it
			return &cp, nil
		}
	}
	return nil, store.ErrNotFound
}

func (f *fakeCtxStore) ListContextItems(_ context.Context, parentType, parentID string) ([]*model.ContextItem, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	src := f.items[ctxKey(parentType, parentID)]
	out := make([]*model.ContextItem, 0, len(src))
	for _, it := range src {
		cp := *it
		out = append(out, &cp)
	}
	return out, nil
}

func (f *fakeCtxStore) DeleteContextItem(_ context.Context, parentType, parentID, itemID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := ctxKey(parentType, parentID)
	for i, it := range f.items[key] {
		if it.ID == itemID {
			f.items[key] = append(f.items[key][:i], f.items[key][i+1:]...)
			return nil
		}
	}
	return nil
}

// allowAll passes every access check — visibility is the message service's
// job and tested there.
type allowAll struct{}

func (allowAll) CheckAccess(context.Context, string, string, string) error { return nil }

// denyAll fails every access check.
type denyAll struct{}

func (denyAll) CheckAccess(context.Context, string, string, string) error { return ErrForbidden }

func newTestContextService(access contextAccessChecker) (*ContextService, *fakeCtxStore) {
	st := newFakeCtxStore()
	svc := NewContextService(st, access)
	n := 0
	svc.newID = func() string { n++; return fmt.Sprintf("ctx-%03d", n) }
	return svc, st
}

// ---------------------------------------------------------------- service

func TestContextService_Governance(t *testing.T) {
	svc, _ := newTestContextService(allowAll{})
	ctx := context.Background()

	// Size cap: one byte over is rejected.
	if _, err := svc.Write(ctx, "u1", "", "u1", "p1", ParentChannel, strings.Repeat("x", model.ContextItemMaxBytes+1), false); err == nil {
		t.Fatal("oversized item accepted")
	}
	// Empty body rejected.
	if _, err := svc.Write(ctx, "u1", "", "u1", "p1", ParentChannel, "  ", false); err == nil {
		t.Fatal("empty item accepted")
	}
	// Per-parent cap.
	for i := 0; i < model.ContextItemsPerScope; i++ {
		if _, err := svc.Write(ctx, "u1", "", "u1", "p1", ParentChannel, "fact", false); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	if _, err := svc.Write(ctx, "u1", "", "u1", "p1", ParentChannel, "one too many", false); err == nil || !strings.Contains(err.Error(), "full") {
		t.Fatalf("expected ErrContextFull, got %v", err)
	}
	// A different parent is unaffected by the cap.
	if _, err := svc.Write(ctx, "u1", "", "u1", "p2", ParentChannel, "fine", false); err != nil {
		t.Fatalf("other parent rejected: %v", err)
	}
}

func TestContextService_AccessGated(t *testing.T) {
	svc, _ := newTestContextService(denyAll{})
	if _, err := svc.Write(context.Background(), "u1", "", "u1", "p1", ParentChannel, "x", false); err == nil {
		t.Fatal("write allowed without access")
	}
	if _, err := svc.List(context.Background(), "u1", "p1", ParentChannel); err == nil {
		t.Fatal("list allowed without access")
	}
}

func TestContextService_EditRights(t *testing.T) {
	svc, _ := newTestContextService(allowAll{})
	ctx := context.Background()

	human, err := svc.Write(ctx, "u-alice", "", "u-alice", "p1", ParentChannel, "human fact", false)
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	agent, err := svc.Write(ctx, "agent-gg", "u-alice", "u-alice", "p1", ParentChannel, "agent fact", false)
	if err != nil {
		t.Fatalf("agent write: %v", err)
	}

	// A stranger cannot delete a human-authored item…
	if err := svc.Delete(ctx, "u-bob", "p1", ParentChannel, human.ID); err == nil {
		t.Fatal("stranger deleted a human-authored item")
	}
	// …but CAN curate an agent-authored one (humans curate what agents accumulate).
	if err := svc.Delete(ctx, "u-bob", "p1", ParentChannel, agent.ID); err != nil {
		t.Fatalf("member could not curate agent item: %v", err)
	}
	// The author deletes their own.
	if err := svc.Delete(ctx, "u-alice", "p1", ParentChannel, human.ID); err != nil {
		t.Fatalf("author delete: %v", err)
	}
}

// ---------------------------------------------------------------- assembler

// TestBundle_LayersAndAudit: the claim-time bundle carries shared context
// (pinned first), digests of other terminal runs in the thread with correct
// attribution, and the thread window — and the context.assembled event
// records per-layer counts (plan-v2 §8).
func TestOrchestrator_BundleLayersAndAudit(t *testing.T) {
	fx := newOrchFixture(t)

	ctxSvc, _ := newTestContextService(allowAll{})
	fx.orch.SetContextService(ctxSvc)
	if _, err := ctxSvc.Write(context.Background(), "u-alice", "", "u-alice", "chan1", ParentChannel, "unpinned decision", false); err != nil {
		t.Fatalf("ctx write: %v", err)
	}
	if _, err := ctxSvc.Write(context.Background(), "u-alice", "", "u-alice", "chan1", ParentChannel, "pinned constraint", true); err != nil {
		t.Fatalf("ctx write: %v", err)
	}

	// A prior completed run by qib in the SAME thread leaves a digest.
	prior := &model.Run{
		ID: "run-prior", AgentID: testQibID, OwnerID: "u-alice", InvokerID: "u-alice",
		ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1",
		State: model.RunStateCompleted, CreatedAt: fx.now.Add(-time.Minute),
	}
	fx.runs.runs[prior.ID] = prior
	delete(fx.runs.queue, "u-alice") // the direct map insert must not enqueue
	_ = fx.runs.PutDigest(context.Background(), &model.RunDigest{
		RunID: prior.ID, AgentID: testQibID, InvokerID: "u-alice",
		Summary: "qib checked the claims", State: model.RunStateCompleted,
	})

	run := fx.startRun(t)
	a := fx.claim(t)

	for _, want := range []string{
		"# Task",
		"# Shared context",
		"pinned constraint",
		"unpinned decision",
		"# What other agents concluded in this thread",
		"Alice's qib completed: qib checked the claims",
		// Top-level mention → the window is channel BACKGROUND, not a thread.
		"# Recent channel messages",
	} {
		if !strings.Contains(a.ContextBundle, want) {
			t.Fatalf("bundle missing %q:\n%s", want, a.ContextBundle)
		}
	}
	// Pinned renders before unpinned.
	if strings.Index(a.ContextBundle, "pinned constraint") > strings.Index(a.ContextBundle, "unpinned decision") {
		t.Fatalf("pinned item rendered after unpinned:\n%s", a.ContextBundle)
	}

	events, _ := fx.runs.ListRunEvents(context.Background(), run.ID)
	var audit *model.RunEvent
	for _, e := range events {
		if e.Type == "context.assembled" {
			audit = e
		}
	}
	if audit == nil {
		t.Fatal("no context.assembled event on the timeline")
	}
	if got := audit.Payload["digests"]; got != 1 {
		t.Fatalf("audit digests = %v, want 1", got)
	}
	if got := audit.Payload["contextPinned"]; got != 1 {
		t.Fatalf("audit contextPinned = %v, want 1", got)
	}
}

// The digest layer excludes the run itself, non-terminal peers, and other
// threads; newest-first capped at bundleMaxDigests.
func TestOrchestrator_ThreadDigestsFiltered(t *testing.T) {
	fx := newOrchFixture(t)
	base := *fx.now
	mk := func(id, thread string, state model.RunState, age time.Duration) {
		r := &model.Run{
			ID: id, AgentID: testQibID, InvokerID: "u-alice", OwnerID: "u-alice",
			ParentID: "chan1", ParentType: ParentChannel, MessageID: thread,
			State: state, CreatedAt: base.Add(-age),
		}
		fx.runs.runs[id] = r
		_ = fx.runs.PutDigest(context.Background(), &model.RunDigest{RunID: id, AgentID: testQibID, InvokerID: "u-alice", Summary: "s-" + id, State: state})
	}
	mk("same-thread", "m1", model.RunStateCompleted, time.Minute)
	mk("other-thread", "m-other", model.RunStateCompleted, time.Minute)
	mk("still-running", "m1", model.RunStateRunning, time.Minute)
	delete(fx.runs.queue, "u-alice")

	self := &model.Run{ID: "self", ParentID: "chan1", ParentType: ParentChannel, MessageID: "m1", InvokerID: "u-alice"}
	digests := fx.orch.threadDigests(context.Background(), self)
	if len(digests) != 1 || digests[0].RunID != "same-thread" {
		t.Fatalf("expected exactly the same-thread terminal digest, got %+v", digests)
	}
}

// Agent-authored thread lines are attributed to their INVOKER — the shared
// agent "gg" renders as "Bob's gg (agent)" so no reader (human or agent)
// ever sees an ambiguous bare agent name.
func TestOrchestrator_ThreadWindowAttributesAgentPosts(t *testing.T) {
	fx := newOrchFixture(t)
	fx.users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}
	fx.msgs.thread = []*model.Message{
		{ID: "t1", AuthorID: "u-alice", Body: "what do you think?", CreatedAt: *fx.now},
		{ID: "t2", AuthorID: testGGID, AgentInvokerID: "u-bob", Body: "looks good", CreatedAt: *fx.now},
	}
	run := &model.Run{ID: "r1", ParentID: "chan1", ParentType: ParentChannel, ThreadRootID: "t1", InvokerID: "u-alice"}
	window := fx.orch.ThreadWindow(context.Background(), run, 10)
	if !strings.Contains(window, "Alice (human)") {
		t.Fatalf("human line missing:\n%s", window)
	}
	if !strings.Contains(window, "Bob's gg (agent)") {
		t.Fatalf("agent line not attributed to its invoker:\n%s", window)
	}
}

// ---------------------------------------------------------------- resolve

// A harness re-pin without a model pick must NOT inherit the template's
// model — model names are harness-specific (plan-v2 §6).
func TestResolve_CrossHarnessPinDropsTemplateModel(t *testing.T) {
	fx := newOrchFixture(t)
	agent, _ := fx.users.GetUser(context.Background(), testGGID)

	svc := fx.orch.agentSvc
	if _, err := svc.UpdatePrefs(context.Background(), "u-alice", AgentSlugGG, AgentPrefsPatch{Harness: strPtr(model.HarnessCodex)}); err != nil {
		t.Fatalf("update prefs: %v", err)
	}
	resolved, err := svc.Resolve(context.Background(), agent, "u-alice")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if resolved.Harness != model.HarnessCodex {
		t.Fatalf("harness = %q, want codex", resolved.Harness)
	}
	if resolved.Model != "" {
		t.Fatalf("model = %q — a codex pin must not inherit the claude template model", resolved.Model)
	}

	// An explicit model pick survives.
	if _, err := svc.UpdatePrefs(context.Background(), "u-alice", AgentSlugGG, AgentPrefsPatch{Model: strPtr("gpt-5-codex")}); err != nil {
		t.Fatalf("update prefs: %v", err)
	}
	resolved, _ = svc.Resolve(context.Background(), agent, "u-alice")
	if resolved.Model != "gpt-5-codex" {
		t.Fatalf("model = %q, want the explicit pick", resolved.Model)
	}
}

// An API-harness (bedrock) pin resolves an execution mode and a default
// model id, since there is no local CLI login to fall back to.
func TestResolve_APIHarnessGetsModelAndExecMode(t *testing.T) {
	fx := newOrchFixture(t)
	agent, _ := fx.users.GetUser(context.Background(), testGGID)
	svc := fx.orch.agentSvc

	if _, err := svc.UpdatePrefs(context.Background(), "u-alice", AgentSlugGG, AgentPrefsPatch{Harness: strPtr(model.HarnessBedrock)}); err != nil {
		t.Fatalf("update prefs: %v", err)
	}
	r, err := svc.Resolve(context.Background(), agent, "u-alice")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if r.Harness != model.HarnessBedrock {
		t.Fatalf("harness = %q, want bedrock", r.Harness)
	}
	if r.Model == "" {
		t.Fatal("API harness must resolve a default model id")
	}
	if r.ExecutionMode != model.ExecutionRunner {
		t.Fatalf("execMode = %q, want runner default", r.ExecutionMode)
	}

	// An explicit server-mode pin is preserved (execution itself is guarded
	// at invoke time until the server worker lands).
	if _, err := svc.UpdatePrefs(context.Background(), "u-alice", AgentSlugGG, AgentPrefsPatch{ExecutionMode: strPtr(model.ExecutionServer)}); err != nil {
		t.Fatalf("update prefs: %v", err)
	}
	r, _ = svc.Resolve(context.Background(), agent, "u-alice")
	if r.ExecutionMode != model.ExecutionServer {
		t.Fatalf("execMode = %q, want server", r.ExecutionMode)
	}

	// CLI harnesses carry no execution mode.
	if _, err := svc.UpdatePrefs(context.Background(), "u-alice", AgentSlugGG, AgentPrefsPatch{Harness: strPtr(model.HarnessClaude), ExecutionMode: strPtr("")}); err != nil {
		t.Fatalf("update prefs: %v", err)
	}
	r, _ = svc.Resolve(context.Background(), agent, "u-alice")
	if r.ExecutionMode != "" {
		t.Fatalf("CLI harness execMode = %q, want empty", r.ExecutionMode)
	}
}

