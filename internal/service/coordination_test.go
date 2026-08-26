package service

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Co-invoked runs carry the roster in mention order and the bundle renders
// the "# Invoked together" section — the deterministic tiebreak for ordered
// task splits ("one do X, the other Y").
func TestOrchestrator_CoInvokedRosterInBundle(t *testing.T) {
	fx := newOrchFixture(t)
	msg := &model.Message{
		ID: "m20", ParentID: "chan1", AuthorID: "u-alice",
		Body: "@[" + testGGID + "|gg] & @[" + testQibID + "|qib] say hi, one in hindi and other in english",
	}
	fx.orch.OnMessage(context.Background(), msg, ParentChannel)

	ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
	if len(ids) != 2 {
		t.Fatalf("expected 2 queued runs, got %d", len(ids))
	}
	for _, id := range ids {
		run, _ := fx.runs.GetRun(context.Background(), id)
		if len(run.CoInvoked) != 2 || run.CoInvoked[0] != "gg" || run.CoInvoked[1] != "qib" {
			t.Fatalf("bad roster on %s: %v", run.AgentID, run.CoInvoked)
		}
	}
	as, err := fx.orch.Claim(context.Background(), "u-alice", "r1", []string{model.HarnessClaude}, 2, 0)
	if err != nil || len(as) != 2 {
		t.Fatalf("claim: %v (%d)", err, len(as))
	}
	if !strings.Contains(as[0].ContextBundle, "# Invoked together") ||
		!strings.Contains(as[0].ContextBundle, "1. gg, 2. qib") {
		t.Fatalf("roster section missing:\n%s", as[0].ContextBundle)
	}

	// A solo invocation gets no roster section.
	fx2 := newOrchFixture(t)
	fx2.startRun(t)
	solo := fx2.claim(t)
	if strings.Contains(solo.ContextBundle, "# Invoked together") {
		t.Fatal("solo run must not render a roster")
	}
}

// claim_task is first-write-wins: the second agent to claim the same label
// loses and sees who holds it. Labels normalize (case, whitespace).
func TestOrchestrator_ClaimTaskFirstWins(t *testing.T) {
	fx := newOrchFixture(t)
	ggRun := fx.startRun(t)

	msg := &model.Message{ID: "m1", ParentID: "chan1", AuthorID: "u-alice", Body: "split it"}
	qib, _ := fx.users.GetUser(context.Background(), testQibID)
	invoker, _ := fx.users.GetUser(context.Background(), "u-alice")
	resolved, _ := fx.orch.agentSvc.Resolve(context.Background(), qib, "u-alice")
	qibRun, err := fx.orch.StartRun(context.Background(), qib, invoker, msg, ParentChannel, resolved, 0, nil)
	if err != nil {
		t.Fatalf("qib run: %v", err)
	}

	mine, _, err := fx.orch.ClaimTask(context.Background(), ggRun, "  Hindi ")
	if err != nil || !mine {
		t.Fatalf("first claim should win: mine=%v err=%v", mine, err)
	}
	mine, lines, err := fx.orch.ClaimTask(context.Background(), qibRun, "HINDI")
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if mine {
		t.Fatal("second claim on the same label must lose")
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "hindi — claimed by gg") {
		t.Fatalf("loser must see who holds the label, got %q", joined)
	}
	// A different label is free.
	if mine, _, _ := fx.orch.ClaimTask(context.Background(), qibRun, "english"); !mine {
		t.Fatal("distinct label should claim fine")
	}
}

// Follow-up dispatch: after an agent posts in a thread, the INVOKER's
// un-tagged reply re-invokes it — gated by the invoker's prefs (off by
// default, window-bounded, ask-first flag), and only for the invoker's own
// replies.
func TestOrchestrator_FollowUpDispatch(t *testing.T) {
	fx := newOrchFixture(t)
	fx.users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}

	run := fx.startRun(t) // gg for alice, thread root m1
	fx.claim(t)
	if _, err := fx.orch.RecordAgentPost(context.Background(), run.ID); err != nil {
		t.Fatalf("record post: %v", err)
	}
	fx.completeActive(t, run.ID)
	_ = fx.runs.DeleteQueueEntry(context.Background(), "u-alice", run.ID)

	reply := func(id, author string) *model.Message {
		return &model.Message{ID: id, ParentID: "chan1", ParentMessageID: "m1", AuthorID: author, Body: "make it shorter please"}
	}
	queued := func() []string {
		ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10)
		return ids
	}

	// Default prefs: follow-ups are OFF.
	fx.orch.OnMessage(context.Background(), reply("m2", "u-alice"), ParentChannel)
	if len(queued()) != 0 {
		t.Fatal("follow-up fired with prefs off")
	}

	// Window mode: the invoker's reply inside the window re-invokes gg.
	fx.dir.prefs["u-alice#"+AgentSlugGG] = &model.UserAgentPrefs{
		UserID: "u-alice", Slug: AgentSlugGG,
		FollowUpMode: model.FollowUpWindow, FollowUpMins: 10, FollowUpAsk: true,
	}
	// Someone ELSE's reply never re-invokes alice's agent.
	fx.orch.OnMessage(context.Background(), reply("m3", "u-bob"), ParentChannel)
	if len(queued()) != 0 {
		t.Fatal("another user's reply must not burn the invoker's quota")
	}
	fx.orch.OnMessage(context.Background(), reply("m4", "u-alice"), ParentChannel)
	ids := queued()
	if len(ids) != 1 {
		t.Fatalf("expected 1 follow-up run, got %d", len(ids))
	}
	fu, _ := fx.runs.GetRun(context.Background(), ids[0])
	if fu.Mode != model.RunModeFollowUp || fu.InvokerID != "u-alice" || !fu.AskFirst {
		t.Fatalf("bad follow-up run: mode=%s invoker=%s askFirst=%v", fu.Mode, fu.InvokerID, fu.AskFirst)
	}
	fx.orch.afterTerminal(context.Background(), fu)
	_ = fx.runs.DeleteQueueEntry(context.Background(), "u-alice", fu.ID)

	// Past the window: silent again.
	*fx.now = fx.now.Add(11 * time.Minute)
	fx.orch.OnMessage(context.Background(), reply("m5", "u-alice"), ParentChannel)
	if len(queued()) != 0 {
		t.Fatal("follow-up fired outside its window")
	}

	// Always mode: no window.
	fx.dir.prefs["u-alice#"+AgentSlugGG].FollowUpMode = model.FollowUpAlways
	*fx.now = fx.now.Add(48 * time.Hour)
	fx.orch.OnMessage(context.Background(), reply("m6", "u-alice"), ParentChannel)
	if len(queued()) != 1 {
		t.Fatal("always mode should re-invoke regardless of elapsed time")
	}
}

// A heartbeat extends a run's lease WITHOUT rewriting the whole row, so it can
// never revert a Spend.Posts bump that landed since the runner last read the
// run. Before RenewRunLease, the heartbeat's full-row write clobbered Posts
// back — which made CompleteRun re-post the final answer as a duplicate.
func TestOrchestrator_HeartbeatPreservesPosts(t *testing.T) {
	fx := newOrchFixture(t)
	run := fx.startRun(t)
	fx.claim(t) // run now acknowledged, runnerID "r1"

	if _, err := fx.orch.RecordAgentPost(context.Background(), run.ID); err != nil {
		t.Fatalf("record post: %v", err)
	}

	reg := &model.RunnerRegistration{
		RunnerID: "r1", OwnerID: "u-alice",
		Harnesses: []model.RunnerHarness{{Name: model.HarnessClaude}},
	}
	before, _ := fx.runs.GetRun(context.Background(), run.ID)
	*fx.now = fx.now.Add(time.Minute)
	if _, err := fx.orch.Heartbeat(context.Background(), reg, []string{run.ID}); err != nil {
		t.Fatalf("heartbeat: %v", err)
	}

	got, _ := fx.runs.GetRun(context.Background(), run.ID)
	if got.Spend.Posts != 1 {
		t.Fatalf("heartbeat reverted posts: got %d want 1", got.Spend.Posts)
	}
	if got.LeaseExpiresAt == nil || !got.LeaseExpiresAt.After(*before.LeaseExpiresAt) {
		t.Fatalf("heartbeat did not extend lease: before %v after %v", before.LeaseExpiresAt, got.LeaseExpiresAt)
	}
}

// fakeConvs is a minimal conversation reader for DM auto-invoke tests.
type fakeConvs struct {
	m map[string]*model.Conversation
}

func (f *fakeConvs) GetConversation(_ context.Context, id string) (*model.Conversation, error) {
	return f.m[id], nil // nil when absent — soleDMAgent treats that as "not a DM"
}

// In a 1:1 DM whose other participant is an agent, a plain top-level message
// auto-invokes that agent — no @mention. Group DMs, agentless DMs, and thread
// replies do NOT auto-fire.
func TestOrchestrator_DMAutoInvoke(t *testing.T) {
	fx := newOrchFixture(t)
	fx.orch.SetConversationReader(&fakeConvs{m: map[string]*model.Conversation{
		"dm-gg":    {ID: "dm-gg", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-alice", testGGID}},
		"grp":      {ID: "grp", Type: model.ConversationTypeGroup, ParticipantIDs: []string{"u-alice", testGGID, "u-bob"}},
		"dm-human": {ID: "dm-human", Type: model.ConversationTypeDM, ParticipantIDs: []string{"u-alice", "u-bob"}},
	}})
	fx.users.users["u-bob"] = &model.User{ID: "u-bob", DisplayName: "Bob"}

	queued := func() []string { ids, _ := fx.runs.ListQueuedRuns(context.Background(), "u-alice", 10); return ids }
	drain := func() {
		for _, id := range queued() {
			_ = fx.runs.DeleteQueueEntry(context.Background(), "u-alice", id)
		}
	}

	// 1:1 DM with gg, plain top-level message, NO mention → gg invoked.
	fx.orch.OnMessage(context.Background(), &model.Message{ID: "m1", ParentID: "dm-gg", AuthorID: "u-alice", Body: "what is 2+2?"}, ParentConversation)
	ids := queued()
	if len(ids) != 1 {
		t.Fatalf("DM auto-invoke: expected 1 run, got %d", len(ids))
	}
	if run, _ := fx.runs.GetRun(context.Background(), ids[0]); run.AgentID != testGGID {
		t.Fatalf("DM auto-invoke: wrong agent %s", run.AgentID)
	}
	// Run it to completion so the (thread, agent) frees — mirrors real life,
	// where gg answers before the next message arrives.
	fx.claim(t)
	fx.completeActive(t, ids[0])
	drain()

	// Group DM → mention-gated, no auto-invoke.
	fx.orch.OnMessage(context.Background(), &model.Message{ID: "m2", ParentID: "grp", AuthorID: "u-alice", Body: "hello all"}, ParentConversation)
	if len(queued()) != 0 {
		t.Fatal("group DM must not auto-invoke")
	}

	// DM between two humans → nothing.
	fx.orch.OnMessage(context.Background(), &model.Message{ID: "m3", ParentID: "dm-human", AuthorID: "u-alice", Body: "hi bob"}, ParentConversation)
	if len(queued()) != 0 {
		t.Fatal("agentless DM must not auto-invoke")
	}

	// Thread reply in the DM → also auto-invokes: an agent reply lands in a
	// thread, so continuing that thread must still get a response.
	fx.orch.OnMessage(context.Background(), &model.Message{ID: "m4", ParentID: "dm-gg", ParentMessageID: "m1", AuthorID: "u-alice", Body: "follow up"}, ParentConversation)
	if len(queued()) != 1 {
		t.Fatalf("DM thread reply should auto-invoke: expected 1 run, got %d", len(queued()))
	}
	drain()

	// An AGENT's own message in the DM never auto-invokes (no self-trigger).
	fx.orch.OnMessage(context.Background(), &model.Message{ID: "m5", ParentID: "dm-gg", AuthorID: testGGID, Body: "anything else?"}, ParentConversation)
	if len(queued()) != 0 {
		t.Fatal("agent's own DM message must not auto-invoke")
	}
}

// CreateAgent defines a new shared agent: template + its singleton agent
// user, immediately resolvable. Slug and harness are validated.
func TestAgentService_CreateAgent(t *testing.T) {
	fx := newOrchFixture(t)
	svc := fx.orch.agentSvc

	// A bad slug is rejected.
	if _, err := svc.CreateAgent(context.Background(), CreateAgentInput{Slug: "Bad Slug!", Persona: "x"}); err == nil {
		t.Fatal("bad slug accepted")
	}
	// Persona is required.
	if _, err := svc.CreateAgent(context.Background(), CreateAgentInput{Slug: "zed"}); err == nil {
		t.Fatal("missing persona accepted")
	}

	tpl, err := svc.CreateAgent(context.Background(), CreateAgentInput{
		Slug: "zed", DisplayName: "Zed", Harness: model.HarnessBedrock, Persona: "You are Zed.",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if tpl.Model == "" || tpl.ExecutionMode != model.ExecutionRunner {
		t.Fatalf("bedrock agent should default model+execMode, got model=%q exec=%q", tpl.Model, tpl.ExecutionMode)
	}

	// The new agent resolves under its template (the agent user carries the
	// template slug; production stores the user row CreateAgentUser wrote).
	agent := &model.User{
		ID: AgentUserID("zed"), DisplayName: "Zed",
		Kind: model.UserKindAgent, AgentConfig: &model.AgentConfig{TemplateSlug: "zed"},
	}
	if r, err := svc.Resolve(context.Background(), agent, "u-alice"); err != nil || r.Harness != model.HarnessBedrock {
		t.Fatalf("resolve new agent: %v (harness %q)", err, r.Harness)
	}

	// Duplicate slug is refused.
	if _, err := svc.CreateAgent(context.Background(), CreateAgentInput{Slug: "zed", Persona: "y"}); err == nil {
		t.Fatal("duplicate slug accepted")
	}
}
