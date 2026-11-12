package handler

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func routerCSP(t *testing.T, sentry SentryFrontendConfig, uploadConnectSrc ...string) string {
	t.Helper()
	return routerCSPWith(t, &Deps{SentryFrontend: sentry, UploadConnectSrc: uploadConnectSrc})
}

func routerCSPWith(t *testing.T, d *Deps) string {
	t.Helper()
	var frontendFS fs.FS = fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html><head></head>app</html>")},
	}
	d.Auth, d.User, d.Channel = &AuthHandler{}, &UserHandler{}, &ChannelHandler{}
	d.Conversation, d.WS = &ConversationHandler{}, &WSHandler{}
	d.JWT, d.FrontendFS, d.AppVersion, d.AllowOrigins = setupJWTManager(), frontendFS, "test", []string{"*"}
	router := NewRouter(d)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	return rec.Header().Get("Content-Security-Policy")
}

const testDSN = "https://k@o0.ingest.sentry.io/1"

// Session Replay is lazy-loaded from Sentry's CDN and records through a
// blob: worker, so a deployment that samples replay must allow both — and
// only such a deployment.
func TestRouterCSPAllowsSentryReplayOnlyWhenSampled(t *testing.T) {
	for name, cfg := range map[string]SentryFrontendConfig{
		"session replay":  {DSN: testDSN, ReplaySessionSampleRate: 0.1},
		"on-error replay": {DSN: testDSN, ReplayErrorSampleRate: 1},
	} {
		t.Run(name, func(t *testing.T) {
			csp := routerCSP(t, cfg, "http://localhost:29000")
			if !strings.Contains(csp, "script-src 'self' "+sentryReplayCDN+";") {
				t.Errorf("script-src lacks the Sentry CDN: %q", csp)
			}
			if !strings.Contains(csp, "worker-src 'self' blob:") {
				t.Errorf("worker-src lacks blob:: %q", csp)
			}
			if !strings.Contains(csp, "connect-src 'self' http://localhost:29000 https: wss:") {
				t.Errorf("upload connect-src lost: %q", csp)
			}
		})
	}
	for name, cfg := range map[string]SentryFrontendConfig{
		"no DSN":                  {},
		"DSN, no replay":          {DSN: testDSN, TracesSampleRate: 0.5},
		"replay rate without DSN": {ReplaySessionSampleRate: 1, ReplayErrorSampleRate: 1},
	} {
		t.Run(name, func(t *testing.T) {
			csp := routerCSP(t, cfg)
			if strings.Contains(csp, "sentry-cdn") || strings.Contains(csp, "worker-src") {
				t.Errorf("CSP widened without sampled replay: %q", csp)
			}
			if !strings.Contains(csp, "script-src 'self';") {
				t.Errorf("script-src changed: %q", csp)
			}
		})
	}
}

// With SharePoint sharing on, the page may frame its hosts: a shared file's
// preview loads from there.
func TestRouterCSPFramesSharePointHosts(t *testing.T) {
	csp := routerCSPWith(t, &Deps{FrameSrc: []string{"https://*.sharepoint.com"}})
	if !strings.Contains(csp, "frame-src https://*.sharepoint.com;") {
		t.Errorf("frame-src lacks SharePoint: %q", csp)
	}
	if csp := routerCSP(t, SentryFrontendConfig{}); !strings.Contains(csp, "frame-src 'none';") {
		t.Errorf("frame-src widened without SharePoint: %q", csp)
	}
}
