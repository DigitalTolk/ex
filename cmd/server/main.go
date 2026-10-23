// Command server is the ex process entry point. The wiring, background workers
// and ordered shutdown live in internal/app.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	ex "github.com/DigitalTolk/ex"
	"github.com/DigitalTolk/ex/internal/app"
	"github.com/DigitalTolk/ex/internal/config"
)

func main() {
	// `ex healthcheck` is a self-probe used by the container HEALTHCHECK:
	// the distroless runtime has no shell or wget, so the binary checks its
	// own /healthz endpoint and exits 0 (healthy) or 1.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(app.HealthCheck())
	}

	cfg, err := config.Load()
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}
	app.SetupLogging(cfg, os.Stderr)

	a, err := app.New(context.Background(), cfg, ex.FrontendFS)
	if err != nil {
		slog.Error("boot failed", "error", err)
		os.Exit(1)
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	if err := a.Run(quit); err != nil {
		slog.Error("server stopped with an error", "error", err)
		os.Exit(1)
	}
}
