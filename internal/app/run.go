package app

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"time"

	"github.com/DigitalTolk/ex/internal/agents"
	"github.com/DigitalTolk/ex/internal/safe"
)

// Run starts the background workers and serves HTTP until a signal arrives
// on quit, then shuts down in order and returns. It returns early with the
// error when the server cannot listen or stops serving.
func (a *App) Run(quit <-chan os.Signal) error {
	a.startBackground()
	slog.Info("server starting",
		"port", a.cfg.Port,
		"env", a.cfg.Env,
		"table", a.cfg.DynamoDBTable,
	)
	ln, err := net.Listen("tcp", a.http.server.Addr)
	if err != nil {
		return fmt.Errorf("server error: %w", err)
	}
	return a.serve(ln, quit)
}

// serve runs the HTTP server on ln until a signal arrives on quit (then shuts
// down) or the server fails.
func (a *App) serve(ln net.Listener, quit <-chan os.Signal) error {
	served := make(chan error, 1)
	go func() { served <- a.http.server.Serve(ln) }()
	select {
	case err := <-served:
		// Serve only returns before Shutdown when the listener fails.
		return fmt.Errorf("server error: %w", err)
	case sig := <-quit:
		slog.Info("shutting down", "signal", sig.String())
	}
	return a.shutdown()
}

// startBackground launches the process's background jobs on a context that
// shutdown cancels.
func (a *App) startBackground() {
	ctx, stop := context.WithCancel(context.Background())
	a.stopBackground = stop
	c, ag := &a.chat, &a.agents

	safe.Go(a.track(func() { c.users.RunExpiredStatusSweeper(ctx, time.Minute, 0) }))
	// Seed the gg/qib templates AND their shared agent users (idempotent;
	// never overwrites admin edits), then start the run reconciler: boot
	// recovery of active runs + the deadline/lease sweep that turns a closed
	// laptop into run.failed{runner_lost} instead of a stuck run.
	seedAgents(ctx, ag.svc)
	// Every instance shares the orchestrator's turn state through Redis: the
	// one-turn-per-thread slot, parked hand-offs, claim wakeups and the
	// typing lease (a run's calls are load balanced across instances).
	ag.orch.SetTurnCoordinator(ctx, agents.NewRedisTurnCoordinator(a.infra.pubsub.Client()))
	ag.orch.StartReconciler(ctx)
	// Connector catalog pull from the connector-provider: a forced pull at
	// boot, then a revision-gated pass every minute (panic-isolated, stops on
	// shutdown).
	if ag.connectors.ProviderConfigured() {
		go a.track(func() { ag.connectors.RunProviderSync(ctx, time.Minute) })()
	}
	// Directory re-sync (phone + manager from MS Graph): first sweep at boot
	// doubles as the workspace backfill.
	if c.directorySync != nil {
		go a.track(func() { c.directorySync.Run(ctx, a.cfg.MSProfileSyncInterval) })()
	}
	// Fire due reminders into their owners' activity streams + alerts.
	// Claiming is atomic in Redis, so running this on every instance never
	// double-fires.
	go a.track(func() { runDuePoller(ctx, "reminder", c.reminders, 20*time.Second) })()
	// Post scheduled messages whose time has come. Each is claimed by exactly
	// one instance (a conditional DynamoDB update), so every instance polls.
	go a.track(func() { runDuePoller(ctx, "scheduled message", c.scheduled, 10*time.Second) })()
	if a.search.mappingRebuilder != nil {
		go a.track(func() { autoMappingRebuild(ctx, a.search.mappingRebuilder) })()
	}
}

// shutdown stops the process in order: background jobs, HTTP, the WebSocket
// connections, in-flight notification fan-outs, then the durable-inbox
// appends they feed; finally it releases what the process owns.
func (a *App) shutdown() error {
	a.stopBackground()
	ctx, cancel := context.WithTimeout(context.Background(), a.httpShutdownTimeout)
	defer cancel()
	if err := a.http.server.Shutdown(ctx); err != nil {
		return fmt.Errorf("server forced to shutdown: %w", err)
	}

	// srv.Shutdown does not track hijacked WebSocket connections. Close the
	// broker's clients to unblock every connection loop, then wait (bounded)
	// for their teardown — presence entries are removed and offline
	// transitions published instead of every deploy leaving markers to lapse
	// by TTL with the transitions unannounced.
	_ = a.infra.broker.Close()
	if !a.drainWS(a.drainTimeout) {
		slog.Warn("timed out draining websocket teardown on shutdown")
	}
	// Drain in-flight notification fan-outs (bounded) before the inbox wait
	// below: their publishes feed the durable inbox. Anything cut off here is
	// re-run by its durable safety-net check on another instance.
	if !waitBounded(a.waitNotifyFanOut, a.drainTimeout) {
		slog.Warn("timed out draining notification fan-outs on shutdown; their safety-net checks will re-run them")
	}
	// HTTP is drained; now wait (bounded) for any in-flight durable-inbox
	// fan-out appends to finish so a reconnecting client can still replay the
	// last events. The appends run on a cancellation-free context, so a
	// wedged backing store must not hang shutdown indefinitely.
	if !waitBounded(a.waitInboxFanOut, a.drainTimeout) {
		slog.Warn("timed out draining durable-inbox fan-out on shutdown")
	}
	slog.Info("server stopped")
	a.close()
	return nil
}

// waitBounded runs wait on its own (panic-isolated) goroutine and reports
// whether it returned within d.
func waitBounded(wait func(), d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		defer safe.Recover()
		wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}

// agentSeeder seeds the default agent templates and their shared users.
type agentSeeder interface {
	SeedDefaults(ctx context.Context) error
}

func seedAgents(ctx context.Context, s agentSeeder) {
	if err := s.SeedDefaults(ctx); err != nil {
		slog.Error("agent seed failed", "error", err)
	}
}

// dueProcessor handles whatever has come due (reminders, scheduled messages).
type dueProcessor interface {
	ProcessDue(ctx context.Context) (int, error)
}

// runDuePoller runs ProcessDue on a fixed interval until the context is
// cancelled. Each ProcessDue claims items atomically, so multiple instances
// each running this loop never double-deliver. Panics are isolated so a
// single bad tick can't take the process down.
func runDuePoller(ctx context.Context, name string, svc dueProcessor, interval time.Duration) {
	defer safe.Recover()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := svc.ProcessDue(ctx); err != nil {
				slog.Warn(name+" poll failed", "error", err)
			}
		}
	}
}
