package agents

import (
	"context"
	"errors"
	"testing"

	"github.com/DigitalTolk/ex/internal/model"
	"github.com/DigitalTolk/ex/internal/service"
)

// deactDir fails DeleteAgentSubscription on demand.
type deactDir struct {
	AgentDirectoryStore
	failDelete error
}

func (d *deactDir) DeleteAgentSubscription(ctx context.Context, parentID, id string) error {
	if d.failDelete != nil {
		return d.failDelete
	}
	return d.AgentDirectoryStore.DeleteAgentSubscription(ctx, parentID, id)
}

func seedDeactivationFixture(t *testing.T) (*orchCovFixture, *model.Run) {
	t.Helper()
	fx := newOrchCovFixture(t)
	ctx := context.Background()
	for _, sub := range []*model.AgentSubscription{
		{ID: "sub-watch", AgentID: testGGID, CreatorID: "u-alice", ParentID: "chan1", ParentType: service.ParentChannel},
		{ID: "sub-schedule", AgentID: testGGID, CreatorID: "u-alice", ParentID: "chan1", ParentType: service.ParentChannel, Schedule: "0 8 * * 1-5"},
		{ID: "sub-bob", AgentID: testGGID, CreatorID: "u-bob", ParentID: "chan1", ParentType: service.ParentChannel},
	} {
		if err := fx.dir.fakeAgentDir.PutAgentSubscription(ctx, sub); err != nil {
			t.Fatalf("seed sub: %v", err)
		}
	}
	run := fx.start(t, "m-deact", "")
	if err := fx.runs.fakeRunStore.CreateRun(ctx, &model.Run{ID: "r-bob", InvokerID: "u-bob", OwnerID: "u-bob", State: model.RunStateQueued}); err != nil {
		t.Fatalf("seed bob's run: %v", err)
	}
	fx.orch.deferredTurns.Store("turn-alice", &deferredTurn{invokerID: "u-alice"})
	fx.orch.deferredTurns.Store("turn-bob", &deferredTurn{invokerID: "u-bob"})
	return fx, run
}

// Deactivating an account must stop its agents: its standing orders (watch
// and schedule) are removed, its queued handoffs dropped and its live runs
// canceled — someone else's automations are untouched.
func TestStopUserAutomations(t *testing.T) {
	fx, run := seedDeactivationFixture(t)
	if err := fx.orch.StopUserAutomations(context.Background(), "u-alice"); err != nil {
		t.Fatalf("StopUserAutomations: %v", err)
	}
	subs, _ := fx.dir.fakeAgentDir.ListAllSubscriptions(context.Background())
	if len(subs) != 1 || subs[0].ID != "sub-bob" {
		t.Fatalf("remaining subscriptions = %+v, want only bob's", subs)
	}
	got, err := fx.runs.GetRun(context.Background(), run.ID)
	if err != nil || got.State != model.RunStateCanceled {
		t.Fatalf("run state = %v (err %v), want canceled", got.State, err)
	}
	if bob, _ := fx.runs.GetRun(context.Background(), "r-bob"); bob.State != model.RunStateQueued {
		t.Fatalf("someone else's run = %v, want untouched", bob.State)
	}
	if _, ok := fx.orch.deferredTurns.Load("turn-alice"); ok {
		t.Fatal("the deactivated user's queued handoff must be dropped")
	}
	if _, ok := fx.orch.deferredTurns.Load("turn-bob"); !ok {
		t.Fatal("someone else's queued handoff must survive")
	}
	// A second pass finds nothing left to do.
	if err := fx.orch.StopUserAutomations(context.Background(), "u-alice"); err != nil {
		t.Fatalf("second pass: %v", err)
	}
}

// Each failing step is reported, and the remaining steps still run.
func TestStopUserAutomationsReportsEveryFailure(t *testing.T) {
	t.Run("listing subscriptions and runs", func(t *testing.T) {
		fx, _ := seedDeactivationFixture(t)
		fx.dir.failListAllSubs = errOrchCov
		fx.runs.failListActive = errOrchCov
		err := fx.orch.StopUserAutomations(context.Background(), "u-alice")
		if !errors.Is(err, errOrchCov) {
			t.Fatalf("err = %v, want the listing failures", err)
		}
		if _, ok := fx.orch.deferredTurns.Load("turn-alice"); ok {
			t.Fatal("handoffs must still be dropped when the listings fail")
		}
	})
	t.Run("deleting a subscription and canceling a run", func(t *testing.T) {
		fx, run := seedDeactivationFixture(t)
		fx.orch.agentSvc.agents = &deactDir{AgentDirectoryStore: fx.orch.agentSvc.agents, failDelete: errOrchCov}
		fx.runs.failUpdateRun = errOrchCov
		err := fx.orch.StopUserAutomations(context.Background(), "u-alice")
		if !errors.Is(err, errOrchCov) {
			t.Fatalf("err = %v, want the delete/cancel failures", err)
		}
		got, _ := fx.runs.GetRun(context.Background(), run.ID)
		if got.State.Terminal() {
			t.Fatalf("run state = %v, the failing cancel must not be reported as done", got.State)
		}
	})
}
