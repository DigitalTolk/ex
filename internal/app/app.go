// Package app wires the server process: it builds every store, service and
// handler from the configuration (one builder per subsystem), refuses to boot
// while a dependency production needs is missing, runs the background workers
// and the HTTP server, and shuts everything down in order. cmd/server is only
// the process entry point around it.
package app

import (
	"context"
	"io/fs"
	"log/slog"
	"sync"
	"time"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/middleware"
)

// Shutdown budgets. srv.Shutdown waits for in-flight HTTP requests; each drain
// after it is bounded separately so one wedged stage cannot hold the others.
const (
	httpShutdownTimeout = 10 * time.Second
	drainTimeout        = 5 * time.Second
)

// App is one wired server process.
type App struct {
	cfg      *config.Config
	frontend fs.FS

	infra  infra
	chat   chat
	agents agentSystem
	notify notifications
	search searchSystem
	http   httpLayer

	// closers release what the process owns, run in reverse order at the end
	// of shutdown (and on a failed boot).
	closers []func()

	// Background work started by the app. Production never waits on jobs —
	// a process exit ends them — but tests do, so every job's work is
	// accounted for before a test ends.
	stopBackground context.CancelFunc
	jobs           sync.WaitGroup

	// Shutdown stages, kept as fields so the bounded waits can be exercised.
	httpShutdownTimeout time.Duration
	drainTimeout        time.Duration
	drainWS             func(time.Duration) bool
	waitNotifyFanOut    func()
	waitInboxFanOut     func()
}

// New builds the whole process from cfg. frontend is the embedded build
// output (its "dist" directory holds the SPA). Any failure — including a
// dependency left unwired — aborts the boot with an error naming it.
func New(ctx context.Context, cfg *config.Config, frontend fs.FS) (*App, error) {
	a := &App{
		cfg:                 cfg,
		frontend:            frontend,
		httpShutdownTimeout: httpShutdownTimeout,
		drainTimeout:        drainTimeout,
	}

	// Wire the deployment's reverse-proxy depth into the rate-limit IP
	// derivation (must match topology or the per-IP limit keys off a
	// spoofable/wrong hop).
	middleware.SetTrustedProxyCount(cfg.TrustedProxyCount)
	slog.Info("trusted proxy count for rate-limit client IP", "count", cfg.TrustedProxyCount)

	steps := []func(context.Context) error{
		a.buildInfra,
		a.buildChat,
		a.buildAgents,
		a.buildNotifications,
		a.buildSearch,
		a.buildHTTP,
		a.checkWiring,
	}
	for _, step := range steps {
		if err := step(ctx); err != nil {
			a.close()
			return nil, err
		}
	}
	return a, nil
}

// onClose registers fn to run at the end of shutdown, after everything
// registered later.
func (a *App) onClose(fn func()) { a.closers = append(a.closers, fn) }

// close runs the closers in reverse registration order, once.
func (a *App) close() {
	for i := len(a.closers) - 1; i >= 0; i-- {
		a.closers[i]()
	}
	a.closers = nil
}

// track counts fn as a background job of the app and returns it ready to run
// on its own goroutine.
func (a *App) track(fn func()) func() {
	a.jobs.Add(1)
	return func() {
		defer a.jobs.Done()
		fn()
	}
}
