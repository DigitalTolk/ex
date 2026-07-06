package main

import (
	"io"
	"log/slog"
)

// productionLogger returns a JSON-emitting slog logger. Outside local dev the
// platform's log pipeline (CloudWatch/Loki/…) parses structured fields —
// key=value text lines from slog's default handler don't index. Dev keeps
// slog's default human-readable output untouched.
func productionLogger(w io.Writer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(w, nil))
}
