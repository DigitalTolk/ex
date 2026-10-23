package middleware

import (
	"net/http"
	"strings"
	"time"

	"github.com/klauspost/compress/gzhttp"
)

// ProgressDeadline replaces the server's fixed write timeout with a
// progress-based one for streaming responses (downloads, video): every write
// pushes the connection's write deadline idle into the future, so a body of
// any size streams for as long as the client keeps reading, while a client
// that stops reading is cut off idle after its last progress. Pair it with a
// RequestTimeout exemption for the same route — the request-context budget
// would otherwise still end the stream.
func ProgressDeadline(idle time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			pw := &progressWriter{ResponseWriter: w, rc: http.NewResponseController(w), idle: idle}
			pw.extend()
			next.ServeHTTP(pw, r)
		})
	}
}

type progressWriter struct {
	http.ResponseWriter
	rc   *http.ResponseController
	idle time.Duration
}

// extend moves the write deadline. A writer that can't take deadlines
// (http.ErrNotSupported, e.g. a test recorder) keeps the server's default —
// nothing to do about it here.
func (p *progressWriter) extend() {
	_ = p.rc.SetWriteDeadline(time.Now().Add(p.idle))
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.extend()
	return p.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the underlying connection.
func (p *progressWriter) Unwrap() http.ResponseWriter { return p.ResponseWriter }

// Compress gzip-encodes responses (API JSON, the SPA's static assets) for
// clients that accept it, via klauspost/compress's gzhttp — small bodies and
// already-compressed content types pass through untouched. Paths under one of
// skipPrefixes are never wrapped (media streams: already-compressed bytes,
// Range requests), nor is a WebSocket upgrade. Caching headers are the
// handlers' own and are left as they are.
func Compress(skipPrefixes ...string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		gz := gzhttp.GzipHandler(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") || hasAnyPrefix(r.URL.Path, skipPrefixes) {
				next.ServeHTTP(w, r)
				return
			}
			gz.ServeHTTP(w, r)
		})
	}
}

func hasAnyPrefix(path string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}
