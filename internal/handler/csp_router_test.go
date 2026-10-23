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
	var frontendFS fs.FS = fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html><head></head>app</html>")},
	}
	router := NewRouter(&Deps{
		Auth: &AuthHandler{}, User: &UserHandler{}, Channel: &ChannelHandler{},
		Conversation: &ConversationHandler{}, WS: &WSHandler{},
		JWT: setupJWTManager(), FrontendFS: frontendFS, AppVersion: "test", AllowOrigins: []string{"*"},
		SentryFrontend: sentry, UploadConnectSrc: uploadConnectSrc,
	})
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
