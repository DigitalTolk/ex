package middleware

import (
	"context"
	"log/slog"

	slogtrace "github.com/DataDog/dd-trace-go/contrib/log/slog/v2"
)

// LogHandler wraps h so a record logged with a request's context (the slog
// *Context functions) carries that request's ID under "requestID" — the
// access log's key — plus the Datadog trace and span IDs (dd.trace_id,
// dd.span_id) when the context holds a span, which ties the line to its APM
// trace. Records logged without such a context pass through unchanged.
func LogHandler(h slog.Handler) slog.Handler {
	return requestIDHandler{slogtrace.WrapHandler(h)}
}

type requestIDHandler struct{ next slog.Handler }

func (h requestIDHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h requestIDHandler) Handle(ctx context.Context, r slog.Record) error {
	if id := RequestIDFromContext(ctx); id != "" {
		r = r.Clone() // the caller's Record may share attribute storage
		r.AddAttrs(slog.String("requestID", id))
	}
	return h.next.Handle(ctx, r)
}

func (h requestIDHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return requestIDHandler{h.next.WithAttrs(attrs)}
}

func (h requestIDHandler) WithGroup(name string) slog.Handler {
	return requestIDHandler{h.next.WithGroup(name)}
}
