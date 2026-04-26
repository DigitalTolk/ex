package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResponseWriter_Flush(t *testing.T) {
	rec := httptest.NewRecorder()
	rw := &responseWriter{ResponseWriter: rec, statusCode: 200}
	rw.Flush()
	if !rec.Flushed {
		t.Error("expected underlying recorder to be flushed")
	}
}

func TestResponseWriter_Unwrap(t *testing.T) {
	rec := httptest.NewRecorder()
	rw := &responseWriter{ResponseWriter: rec, statusCode: 200}
	if rw.Unwrap() != rec {
		t.Error("Unwrap() should return underlying ResponseWriter")
	}
}

// nonFlusher implements http.ResponseWriter but not http.Flusher,
// so the Flush() type assertion in responseWriter.Flush falls through.
type nonFlusher struct {
	header http.Header
	status int
}

func (n *nonFlusher) Header() http.Header {
	if n.header == nil {
		n.header = http.Header{}
	}
	return n.header
}
func (n *nonFlusher) Write(b []byte) (int, error) { return len(b), nil }
func (n *nonFlusher) WriteHeader(s int)           { n.status = s }

func TestResponseWriter_FlushNoopOnNonFlusher(t *testing.T) {
	rw := &responseWriter{ResponseWriter: &nonFlusher{}, statusCode: 200}
	rw.Flush() // must not panic
}
