package middleware

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/DataDog/dd-trace-go/v2/ddtrace/mocktracer"
	"github.com/DataDog/dd-trace-go/v2/ddtrace/tracer"
)

// decodeLogLines parses one JSON object per line.
func decodeLogLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var lines []map[string]any
	for _, raw := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		var line map[string]any
		if err := json.Unmarshal([]byte(raw), &line); err != nil {
			t.Fatalf("log line is not JSON: %v\nline: %s", err, raw)
		}
		lines = append(lines, line)
	}
	return lines
}

// A line logged with the request's context inside a handler carries the ID
// the RequestID middleware assigned — the same one the client gets back.
func TestLogHandler_RequestLogCarriesRequestID(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(LogHandler(slog.NewJSONHandler(&buf, nil)))
	h := RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		logger.With("component", "test").InfoContext(r.Context(), "inside the request", "k", "v")
	}))

	for _, sent := range []string{"req-from-client", ""} {
		buf.Reset()
		req := httptest.NewRequest(http.MethodGet, "/x", nil)
		if sent != "" {
			req.Header.Set("X-Request-ID", sent)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		want := rec.Header().Get("X-Request-ID")
		if want == "" || (sent != "" && want != sent) {
			t.Fatalf("X-Request-ID = %q (sent %q)", want, sent)
		}
		line := decodeLogLines(t, &buf)[0]
		if line["requestID"] != want {
			t.Errorf("requestID = %v, want %q", line["requestID"], want)
		}
		if line["msg"] != "inside the request" || line["k"] != "v" || line["component"] != "test" {
			t.Errorf("record attributes lost: %v", line)
		}
	}
}

// Outside a request there is no ID to add, and nothing is invented.
func TestLogHandler_NoRequestNoID(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(LogHandler(slog.NewJSONHandler(&buf, nil)))
	logger.WithGroup("g").InfoContext(context.Background(), "background work", "k", "v")
	line := decodeLogLines(t, &buf)[0]
	if _, ok := line["requestID"]; ok {
		t.Errorf("requestID present without a request: %v", line)
	}
	if g, _ := line["g"].(map[string]any); g["k"] != "v" {
		t.Errorf("group attributes lost: %v", line)
	}
}

// A context holding an APM span adds the Datadog correlation IDs.
func TestLogHandler_AddsTraceAndSpanIDs(t *testing.T) {
	mt := mocktracer.Start()
	defer mt.Stop()
	span, ctx := tracer.StartSpanFromContext(context.Background(), "http.request")
	defer span.Finish()

	var buf bytes.Buffer
	slog.New(LogHandler(slog.NewJSONHandler(&buf, nil))).WarnContext(ctx, "traced")
	line := decodeLogLines(t, &buf)[0]
	if line["dd.trace_id"] != span.Context().TraceID() {
		t.Errorf("dd.trace_id = %v, want %s", line["dd.trace_id"], span.Context().TraceID())
	}
	if want := strconv.FormatUint(span.Context().SpanID(), 10); line["dd.span_id"] != want {
		t.Errorf("dd.span_id = %v, want %s", line["dd.span_id"], want)
	}
}

// Levels below the wrapped handler's threshold are still filtered.
func TestLogHandler_KeepsLevelFilter(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(LogHandler(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelWarn})))
	logger.InfoContext(context.Background(), "dropped")
	if buf.Len() != 0 {
		t.Fatalf("info line passed a warn-level handler: %s", buf.String())
	}
}
