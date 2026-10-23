package app

import (
	"io"
	"log/slog"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/middleware"
)

// SetupLogging installs the process logger: structured JSON on w everywhere
// except local dev, so the deployment's log pipeline can parse
// level/msg/fields instead of scraping text lines. Dev keeps slog's default
// human-readable output untouched.
func SetupLogging(cfg *config.Config, w io.Writer) {
	if !cfg.IsDev() {
		slog.SetDefault(productionLogger(w))
	}
}

// productionLogger returns a JSON-emitting slog logger. Lines logged with a
// request's context (the slog *Context functions) also carry its request ID
// and Datadog trace/span IDs.
func productionLogger(w io.Writer) *slog.Logger {
	return slog.New(middleware.LogHandler(slog.NewJSONHandler(w, nil)))
}
