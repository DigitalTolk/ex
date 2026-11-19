package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// cspDirectives splits a served Content-Security-Policy into name → value.
func cspDirectives(t *testing.T, csp string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, part := range strings.Split(csp, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, value, _ := strings.Cut(part, " ")
		if _, dup := out[name]; dup {
			t.Fatalf("directive %q appears twice in %q", name, csp)
		}
		out[name] = value
	}
	return out
}

func servedCSP(t *testing.T, mw func(http.Handler) http.Handler) map[string]string {
	t.Helper()
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	return cspDirectives(t, rec.Header().Get("Content-Security-Policy"))
}

// Without a preview route to allow (CSPOptions.FramePath), nothing may be
// framed, not even by the page's own origin.
func TestSecurityHeadersFrameSrcNone(t *testing.T) {
	for name, mw := range map[string]func(http.Handler) http.Handler{
		"base":        SecurityHeaders,
		"with upload": SecurityHeadersWith("http://localhost:29000"),
	} {
		t.Run(name, func(t *testing.T) {
			d := servedCSP(t, mw)
			if got := d["frame-src"]; got != "'none'" {
				t.Errorf("frame-src = %q, want 'none'", got)
			}
			for directive, want := range map[string]string{
				"frame-ancestors": "'none'",
				"object-src":      "'none'",
				"base-uri":        "'self'",
				"default-src":     "'self'",
			} {
				if got := d[directive]; got != want {
					t.Errorf("%s = %q, want %q", directive, got, want)
				}
			}
		})
	}
}

// script-src never carries 'unsafe-inline': the page's own inline scripts
// are allowed by hash (CSPOptions.ScriptSrc, computed from the served
// index.html), and the HTML-attachment preview is a network-loaded document
// with its own policy, so nothing inherits this one.
func TestSecurityHeadersScriptSrcHasNoUnsafeInline(t *testing.T) {
	d := servedCSP(t, SecurityHeaders)
	if got := d["script-src"]; got != "'self'" {
		t.Fatalf("script-src = %q, want 'self'", got)
	}
}

func TestSecurityHeadersWithOptionsScriptHashes(t *testing.T) {
	d := servedCSP(t, SecurityHeadersWithOptions(CSPOptions{
		ScriptSrc: []string{"'sha256-AAAA'", "'sha256-BBBB'", "https://browser.sentry-cdn.com"},
	}))
	if got, want := d["script-src"], "'self' 'sha256-AAAA' 'sha256-BBBB' https://browser.sentry-cdn.com"; got != want {
		t.Errorf("script-src = %q, want %q", got, want)
	}
}

// requestCSP serves one request with the given Host through mw.
func requestCSP(t *testing.T, mw func(http.Handler) http.Handler, host string) map[string]string {
	t.Helper()
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Host = host
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return cspDirectives(t, rec.Header().Get("Content-Security-Policy"))
}

// The page may frame exactly one thing: the HTML-attachment preview route on
// its own server. A source with a path needs a host, so frame-src names the
// path under the deployment's public host (a proxy may rewrite Host) and
// under the host the browser asked for — never 'self', which would allow
// every same-origin URL.
func TestSecurityHeadersFrameSrcAllowsOnlyThePreviewPath(t *testing.T) {
	mw := SecurityHeadersWithOptions(CSPOptions{
		FramePath:  "/api/v1/html-preview/",
		FrameHosts: []string{"chat.example.com", "bad host;", "[::1]:8080"},
	})
	const public = "chat.example.com/api/v1/html-preview/"
	for host, want := range map[string]string{
		"localhost:8080":   public + " localhost:8080/api/v1/html-preview/",
		"10.0.0.5:8080":    public + " 10.0.0.5:8080/api/v1/html-preview/",
		"CHAT.example.com": public,
		// A Host that is no CSP host-part is never spliced in: it could carry
		// `;` and a directive of its own.
		"evil.test; script-src *": public,
		"[::1]:8080":              public,
		"":                        public,
		"a..b":                    public,
		"host:123456":             public,
	} {
		d := requestCSP(t, mw, host)
		if got := d["frame-src"]; got != want {
			t.Errorf("Host %q: frame-src = %q, want %q", host, got, want)
		}
		if got := d["script-src"]; got != "'self'" {
			t.Errorf("Host %q: script-src = %q, want 'self'", host, got)
		}
	}

	// Without a usable host, nothing may be framed.
	noHosts := SecurityHeadersWithOptions(CSPOptions{FramePath: "/api/v1/html-preview/"})
	if got := requestCSP(t, noHosts, "bad host")["frame-src"]; got != "'none'" {
		t.Errorf("frame-src = %q, want 'none'", got)
	}
	if got := requestCSP(t, noHosts, "localhost:8080")["frame-src"]; got != "localhost:8080/api/v1/html-preview/" {
		t.Errorf("frame-src = %q, want the request host's preview path", got)
	}
}

// SharePoint previews: the page may frame the configured SharePoint hosts,
// over https, and nothing that isn't a plain host source.
func TestSecurityHeadersFrameSrcAllowsSharePointHosts(t *testing.T) {
	mw := SecurityHeadersWithOptions(CSPOptions{
		FramePath:  "/api/v1/html-preview/",
		FrameHosts: []string{"chat.example.com"},
		FrameSrc: []string{
			"https://contoso.sharepoint.com", "https://*.SharePoint.com", "https://contoso.sharepoint.com",
			"http://insecure.example.com", "https://*", "https://a.example.com; script-src *", "https://x.example.com/path",
		},
	})
	want := "chat.example.com/api/v1/html-preview/ https://contoso.sharepoint.com https://*.sharepoint.com"
	if got := requestCSP(t, mw, "chat.example.com")["frame-src"]; got != want {
		t.Errorf("frame-src = %q, want %q", got, want)
	}
	// Without the HTML preview route, only SharePoint.
	only := SecurityHeadersWithOptions(CSPOptions{FrameSrc: []string{"https://*.sharepoint.com"}})
	if got := requestCSP(t, only, "chat.example.com")["frame-src"]; got != "https://*.sharepoint.com" {
		t.Errorf("frame-src = %q", got)
	}
}

// Trusted Types, report-only: no first-party code writes a string into an
// HTML or script sink, so the browser can flag one that appears (a library,
// a regression) without breaking the page.
func TestSecurityHeadersReportOnlyTrustedTypes(t *testing.T) {
	h := SecurityHeaders(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if got, want := rec.Header().Get("Content-Security-Policy-Report-Only"), "require-trusted-types-for 'script'"; got != want {
		t.Fatalf("Content-Security-Policy-Report-Only = %q, want %q", got, want)
	}
}

func TestSecurityHeadersWithUploadOriginKeepsOtherDirectives(t *testing.T) {
	base := servedCSP(t, SecurityHeaders)
	with := servedCSP(t, SecurityHeadersWith("http://localhost:29000", "http://minio:9000"))
	if got, want := with["connect-src"], "'self' http://localhost:29000 http://minio:9000 https: wss:"; got != want {
		t.Errorf("connect-src = %q, want %q", got, want)
	}
	for directive, value := range base {
		if directive == "connect-src" {
			continue
		}
		if with[directive] != value {
			t.Errorf("%s changed with an upload origin: %q → %q", directive, value, with[directive])
		}
	}
	if len(with) != len(base) {
		t.Errorf("directive count changed: %d → %d", len(base), len(with))
	}
}

// A deployment that samples Sentry Session Replay loads the replay bundle
// from Sentry's CDN (lazyLoadIntegration) and compresses recordings in a
// blob: worker; both are allowed only when asked for, on top of the base.
func TestSecurityHeadersWithOptionsScriptAndWorkerSrc(t *testing.T) {
	d := servedCSP(t, SecurityHeadersWithOptions(CSPOptions{
		ConnectSrc: []string{"http://localhost:29000"},
		ScriptSrc:  []string{"https://browser.sentry-cdn.com"},
		WorkerSrc:  []string{"blob:"},
	}))
	if got, want := d["script-src"], "'self' https://browser.sentry-cdn.com"; got != want {
		t.Errorf("script-src = %q, want %q", got, want)
	}
	// 'self' stays: pdf.js runs its worker from the app's own origin.
	if got, want := d["worker-src"], "'self' blob:"; got != want {
		t.Errorf("worker-src = %q, want %q", got, want)
	}
	if got, want := d["connect-src"], "'self' http://localhost:29000 https: wss:"; got != want {
		t.Errorf("connect-src = %q, want %q", got, want)
	}
	if got := d["frame-src"]; got != "'none'" {
		t.Errorf("frame-src = %q, want 'none'", got)
	}
}

func TestSecurityHeadersWithOptionsZeroValueIsBasePolicy(t *testing.T) {
	base := servedCSP(t, SecurityHeaders)
	zero := servedCSP(t, SecurityHeadersWithOptions(CSPOptions{}))
	if len(zero) != len(base) {
		t.Fatalf("zero options changed the directive set: %v vs %v", zero, base)
	}
	for k, v := range base {
		if zero[k] != v {
			t.Errorf("%s = %q, want %q", k, zero[k], v)
		}
	}
	if _, ok := base["worker-src"]; ok {
		t.Errorf("base policy unexpectedly sets worker-src: %q", base["worker-src"])
	}
}
