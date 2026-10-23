package middleware

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DigitalTolk/ex/internal/model"
)

// Regression: the global 30s request budget also wrapped media streaming, so
// any download or video read longer than 30s was cut mid-body. Streaming
// prefixes run without a context deadline.
func TestRequestTimeoutExemptsStreamingPrefixes(t *testing.T) {
	var hadDeadline bool
	capture := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hadDeadline = r.Context().Deadline()
	})
	mw := RequestTimeout(time.Second, "/api/v1/media/")
	mw(capture).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/media/tok/movie.mp4", nil))
	if hadDeadline {
		t.Fatal("a media stream must not carry the request deadline")
	}
	mw(capture).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil))
	if !hadDeadline {
		t.Fatal("ordinary API requests keep the deadline")
	}
}

// deadlineRecorder is a ResponseWriter that accepts write deadlines, the way
// http.ResponseController finds them on a real connection.
type deadlineRecorder struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (d *deadlineRecorder) SetWriteDeadline(t time.Time) error {
	d.deadlines = append(d.deadlines, t)
	return nil
}

func TestProgressDeadlineExtendsOnEveryWrite(t *testing.T) {
	rec := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	h := ProgressDeadline(time.Minute)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("a"))
		_, _ = w.Write([]byte("b"))
		if u, ok := w.(interface{ Unwrap() http.ResponseWriter }); !ok || u.Unwrap() != http.ResponseWriter(rec) {
			t.Error("the wrapper must unwrap to the server's writer for ResponseController")
		}
	}))
	before := time.Now()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/media/t/f", nil))
	if rec.Body.String() != "ab" {
		t.Fatalf("body = %q, want ab", rec.Body.String())
	}
	// One deadline before the handler runs, one per write.
	if len(rec.deadlines) != 3 {
		t.Fatalf("write deadline set %d times, want 3", len(rec.deadlines))
	}
	for _, d := range rec.deadlines {
		if d.Before(before.Add(time.Minute)) {
			t.Fatalf("deadline %v is not idle (1m) past the write", d)
		}
	}
}

func TestCompressGzipsAPIResponses(t *testing.T) {
	body := strings.Repeat(`{"id":"x","name":"channel"},`, 200)
	h := Compress("/api/v1/media/")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.WriteString(w, body)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/channels", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", rec.Header().Get("Content-Encoding"))
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("caching header lost: %q", rec.Header().Get("Cache-Control"))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip reader: %v", err)
	}
	got, _ := io.ReadAll(zr)
	if string(got) != body {
		t.Fatal("decompressed body differs")
	}
}

func TestCompressSkipsMediaAndWebSocket(t *testing.T) {
	body := strings.Repeat("a", 4096)
	h := Compress("/api/v1/media/")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, body)
	}))
	for _, req := range []*http.Request{
		httptest.NewRequest(http.MethodGet, "/api/v1/media/tok/file.txt", nil),
		func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil)
			r.Header.Set("Upgrade", "websocket")
			return r
		}(),
	} {
		req.Header.Set("Accept-Encoding", "gzip")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Header().Get("Content-Encoding") != "" || rec.Body.String() != body {
			t.Fatalf("%s must pass through uncompressed", req.URL.Path)
		}
	}
}

// Regression: an incoming webhook's URL is its credential and it landed in
// every access-log line.
func TestLoggingRedactsSecretPaths(t *testing.T) {
	buf := captureLogs(t)
	Logging(true)(okHandler()).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/hooks/wh-secret-123", nil))
	if strings.Contains(buf.String(), "wh-secret-123") {
		t.Fatalf("access log leaked the webhook id: %q", buf.String())
	}
	if !strings.Contains(buf.String(), "path=/hooks/[redacted]") {
		t.Fatalf("access log lost the route: %q", buf.String())
	}
}

func TestRedactPath(t *testing.T) {
	for in, want := range map[string]string{
		"/hooks/abc":                              "/hooks/[redacted]",
		"/api/v1/media/tok123/clip.mp4":           "/api/v1/media/[redacted]/clip.mp4",
		"/api/v1/media/tok123":                    "/api/v1/media/[redacted]",
		"/api/v1/html-preview/tok123/mockup.html": "/api/v1/html-preview/[redacted]/mockup.html",
		"/api/v1/html-preview/tok123":             "/api/v1/html-preview/[redacted]",
		"/api/v1/channels":                        "/api/v1/channels",
	} {
		if got := RedactPath(in); got != want {
			t.Errorf("RedactPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSecretFingerprint(t *testing.T) {
	a, b := SecretFingerprint("wh-1"), SecretFingerprint("wh-2")
	if a == b || !strings.HasPrefix(a, "sha256:") || strings.Contains(a, "wh-1") || a != SecretFingerprint("wh-1") {
		t.Fatalf("fingerprints %q / %q must be stable, distinct and opaque", a, b)
	}
}

// The stored role replaces the token's claim for everything downstream.
func TestAuthWithUserStatusUsesTheStoredRole(t *testing.T) {
	mgr := newTestJWTManager()
	token := generateTestToken(mgr) // claims member
	var seen model.SystemRole
	h := AuthWithUserStatus(mgr, statusUserStore{user: &model.User{ID: "user-42", Status: "active", SystemRole: model.SystemRoleAdmin}})(
		RequireSystemRole(model.SystemRoleAdmin)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seen = ClaimsFromContext(r.Context()).SystemRole
		})))
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || seen != model.SystemRoleAdmin {
		t.Fatalf("promoted user: status %d role %q, want 200/admin", rec.Code, seen)
	}

	demoted := AuthWithUserStatus(mgr, statusUserStore{user: &model.User{ID: "user-42", Status: "active", SystemRole: model.SystemRoleGuest}})(
		RequireSystemRole(model.SystemRoleMember, model.SystemRoleAdmin)(okHandler()))
	rec = httptest.NewRecorder()
	demoted.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("demoted user: status %d, want 403", rec.Code)
	}
}
