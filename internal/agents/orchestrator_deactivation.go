package agents

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
)

// StopUserAutomations ends everything agents do on userID's behalf, for
// account deactivation (UserService's AutomationStopper):
//
//   - every standing order the user created — message watchers and
//     clock-driven schedules alike — is deleted, so no sweep or message can
//     start a run for them again (a reactivated account sets them up anew);
//   - queued handoffs they invoked are dropped;
//   - every live run they invoked is canceled through the same terminal path
//     as a human stop.
//
// Every step runs even when an earlier one fails; the failures come back
// joined so the caller can report the deactivation as incomplete.
func (o *Orchestrator) StopUserAutomations(ctx context.Context, userID string) error {
	var failed []error

	subs, err := o.agentSvc.AllSubscriptions(ctx)
	if err != nil {
		failed = append(failed, fmt.Errorf("list subscriptions: %w", err))
	}
	for _, sub := range subs {
		if sub.CreatorID != userID {
			continue
		}
		if err := o.agentSvc.agents.DeleteAgentSubscription(ctx, sub.ParentID, sub.ID); err != nil {
			failed = append(failed, fmt.Errorf("delete subscription %s: %w", sub.ID, err))
		}
	}

	// Drop deferred handoffs BEFORE canceling, so a cancellation can't start
	// one (the same order StopThread keeps).
	o.deferredTurns.Range(func(k, v any) bool {
		if v.(*deferredTurn).invokerID == userID {
			o.deferredTurns.Delete(k)
		}
		return true
	})

	runs, err := o.runs.ListActiveRuns(ctx)
	if err != nil {
		failed = append(failed, fmt.Errorf("list active runs: %w", err))
	}
	for _, run := range runs {
		if run.InvokerID != userID || run.State.Terminal() {
			continue
		}
		if err := o.cancelRun(ctx, run, userID); err != nil {
			failed = append(failed, fmt.Errorf("cancel run %s: %w", run.ID, err))
		}
	}

	if err := errors.Join(failed...); err != nil {
		slog.ErrorContext(ctx, "orchestrator: stopping a deactivated account's automations was incomplete", "userID", userID, "error", err)
		return err
	}
	return nil
}
