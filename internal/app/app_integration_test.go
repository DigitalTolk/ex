//go:build integration

package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/fstest"
	"time"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/msgraph"
	"github.com/DigitalTolk/ex/internal/pubsub"
	"github.com/DigitalTolk/ex/internal/service"
)

var tableSeq atomic.Uint64

// frontendBuild stands in for the embedded build output.
var frontendBuild = fstest.MapFS{
	"dist/index.html": {Data: []byte("<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>")},
}

// baseConfig is a development boot against the test containers with every
// optional integration off.
func baseConfig(t *testing.T) *config.Config {
	t.Helper()
	if !containersUp {
		t.Skip("skipping: Docker (DynamoDB Local / Redis) not available")
	}
	return &config.Config{
		Port:                  "0",
		Env:                   "development",
		AccessLogEnabled:      true,
		AWSRegion:             "us-east-1",
		DynamoDBTable:         fmt.Sprintf("ex-app-%d", tableSeq.Add(1)),
		DynamoDBEndpoint:      dynamoEndpoint,
		RedisURL:              "redis://" + redisAddr,
		JWTSecret:             "app-test-secret-app-test-secret-0123",
		JWTAccessTTL:          15 * time.Minute,
		JWTRefreshTTL:         720 * time.Hour,
		SessionMaxAge:         2160 * time.Hour,
		EmailProvider:         "smtp",
		SMTPTLSPolicy:         "opportunistic",
		EmailFrom:             "noreply@example.com",
		BaseURL:               "http://localhost:8080",
		MSProfileSyncInterval: 12 * time.Hour,
		TrustedProxyCount:     1,
		OpenSearchAWSService:  "es",
	}
}

// stubServer answers every request with status (and JSON {} bodies).
func stubServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

// searchStub is an OpenSearch whose indices all exist (EnsureIndices passes)
// and that fails everything else.
func searchStub(t *testing.T) *httptest.Server {
	return stubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Error(w, `{"error":"stub"}`, http.StatusInternalServerError)
	})
}

// graphStub issues tokens and fails every Graph call.
func graphStub(t *testing.T) *httptest.Server {
	return stubServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"access_token":"t","token_type":"Bearer","expires_in":3600}`)
			return
		}
		http.Error(w, `{"error":"stub"}`, http.StatusInternalServerError)
	})
}

// withGraphAt points the Microsoft Graph client at srv for the test.
func withGraphAt(t *testing.T, srv *httptest.Server) {
	t.Helper()
	orig := newGraphClient
	t.Cleanup(func() { newGraphClient = orig })
	newGraphClient = func(c msgraph.Config) (*msgraph.Client, error) {
		c.TokenURL = srv.URL + "/token"
		c.BaseURL = srv.URL
		return msgraph.New(c)
	}
}

// fullConfig turns every optional integration on, each against a local stub.
func fullConfig(t *testing.T) *config.Config {
	cfg := baseConfig(t)
	idp := oidcDiscovery(t)
	cfg.OIDCIssuer, cfg.OIDCClientID, cfg.OIDCClientSecret = idp.URL, "ex", "secret"
	s3 := fakeS3(t)
	cfg.S3Endpoint, cfg.S3Bucket, cfg.S3AccessKey, cfg.S3SecretKey, cfg.S3Region = s3.URL, "ex-test", "minio", "minio123", "us-east-1"
	cfg.SMTPHost, cfg.SMTPPort = "127.0.0.1", "2525"
	cfg.OneSignalAppID, cfg.OneSignalRESTAPIKey = "app", "key"
	cfg.BedrockRegion, cfg.BedrockAccessKeyID, cfg.BedrockSecretAccessKey = "eu-north-1", "AKIDEXAMPLE", "secret"
	provider := stubServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"stub"}`, http.StatusServiceUnavailable)
	})
	cfg.ConnectorProviderURL, cfg.ConnectorProviderKey = provider.URL, "key"
	cfg.MSTenantID, cfg.MSClientID, cfg.MSClientSecret = "tenant", "ex", "secret"
	withGraphAt(t, graphStub(t))
	cfg.OpenSearchURL = searchStub(t).URL
	return cfg
}

// boot builds an app and arranges for every job it starts to be accounted
// for before the test ends.
func boot(t *testing.T, cfg *config.Config) *App {
	t.Helper()
	a, err := New(context.Background(), cfg, frontendBuild)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return a
}

// serveOn starts the app's background workers and serves it on a loopback
// listener; the returned channel yields serve's result.
func serveOn(t *testing.T, a *App, quit <-chan os.Signal) (string, <-chan error) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	a.startBackground()
	done := make(chan error, 1)
	go func() { done <- a.serve(ln, quit) }()
	return "http://" + ln.Addr().String(), done
}

func get(t *testing.T, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// The production shape: every optional integration on. The process boots
// with nothing left unwired, serves, and shuts down draining WebSockets,
// then notification fan-outs, then durable-inbox appends — in that order.
func TestBootWithEveryIntegrationServesAndShutsDownInOrder(t *testing.T) {
	a := boot(t, fullConfig(t))
	if a.chat.directorySync == nil || a.agents.engine == nil || a.search.mappingRebuilder == nil || a.infra.s3 == nil || a.chat.mailer == nil {
		t.Fatal("full config: an optional integration did not come up")
	}

	var mu sync.Mutex
	var order []string
	record := func(stage string) {
		mu.Lock()
		defer mu.Unlock()
		order = append(order, stage)
	}
	drainWS, waitNotify, waitInbox := a.drainWS, a.waitNotifyFanOut, a.waitInboxFanOut
	a.drainWS = func(d time.Duration) bool { record("websockets"); return drainWS(d) }
	a.waitNotifyFanOut = func() { record("notification fan-outs"); waitNotify() }
	a.waitInboxFanOut = func() { record("inbox fan-outs"); waitInbox() }
	closers := len(a.closers)

	quit := make(chan os.Signal, 1)
	base, done := serveOn(t, a, quit)
	if resp := get(t, base+"/healthz"); resp.StatusCode != http.StatusOK {
		t.Fatalf("/healthz = %d, want 200", resp.StatusCode)
	}
	// The SPA from the embedded build is served.
	resp := get(t, base+"/")
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(body), `id="root"`) {
		t.Fatalf("/ = %d %q, want the SPA", resp.StatusCode, body)
	}

	quit <- syscall.SIGTERM
	if err := <-done; err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	a.jobs.Wait()
	want := []string{"websockets", "notification fan-outs", "inbox fan-outs"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("shutdown order = %v, want %v", order, want)
	}
	// broker, task Redis, task queue and the started worker were released.
	if closers != 4 || a.closers != nil {
		t.Fatalf("closers = %d (left %v), want 4 run", closers, a.closers)
	}
}

// Run listens on the configured port and returns once a signal has shut the
// process down. With search configured but unreachable the boot still
// succeeds (indices are ensured best-effort).
func TestRunServesUntilSignalled(t *testing.T) {
	cfg := baseConfig(t)
	cfg.OpenSearchURL = stubServer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"down"}`, http.StatusInternalServerError)
	}).URL
	a := boot(t, cfg)
	quit := make(chan os.Signal, 1)
	quit <- syscall.SIGINT
	if err := a.Run(quit); err != nil {
		t.Fatalf("Run: %v", err)
	}
	a.jobs.Wait()
}

func TestRunFailsWhenThePortIsTaken(t *testing.T) {
	taken, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = taken.Close() }()
	cfg := baseConfig(t)
	_, cfg.Port, _ = net.SplitHostPort(taken.Addr().String())
	a := boot(t, cfg)
	err = a.Run(make(chan os.Signal))
	if err == nil || !strings.Contains(err.Error(), "server error") {
		t.Fatalf("Run on a taken port = %v, want a server error", err)
	}
	a.stopBackground()
	a.close()
	a.jobs.Wait()
}

func TestServeReportsAFailedListener(t *testing.T) {
	a := boot(t, baseConfig(t))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	a.startBackground()
	done := make(chan error, 1)
	go func() { done <- a.serve(ln, make(chan os.Signal)) }()
	get(t, "http://"+ln.Addr().String()+"/healthz") // serving
	_ = ln.Close()
	if err := <-done; err == nil || !strings.Contains(err.Error(), "server error") {
		t.Fatalf("serve after the listener failed = %v, want a server error", err)
	}
	a.stopBackground()
	a.close()
	a.jobs.Wait()
}

// A connection HTTP shutdown cannot drain in time fails the shutdown (the
// process then exits non-zero) before anything else is torn down.
func TestShutdownFailsWhenHTTPDoesNotDrain(t *testing.T) {
	a := boot(t, baseConfig(t))
	accepted := make(chan struct{}, 1)
	a.http.server.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateNew {
			accepted <- struct{}{}
		}
	}
	a.httpShutdownTimeout = time.Millisecond
	drained := false
	a.drainWS = func(time.Duration) bool { drained = true; return true }
	quit := make(chan os.Signal, 1)
	base, done := serveOn(t, a, quit)
	conn, err := net.Dial("tcp", strings.TrimPrefix(base, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	<-accepted // a fresh connection that never sends its request

	quit <- syscall.SIGTERM
	if err := <-done; err == nil || !strings.Contains(err.Error(), "server forced to shutdown") {
		t.Fatalf("shutdown = %v, want the forced-shutdown error", err)
	}
	if drained {
		t.Fatal("a failed HTTP shutdown must stop before the WebSocket drain")
	}
	_ = a.http.server.Close()
	a.close()
	a.jobs.Wait()
}

// Each drain is bounded: a wedged stage is logged and shutdown moves on.
func TestShutdownBoundsEachDrain(t *testing.T) {
	a := boot(t, baseConfig(t))
	release := make(chan struct{})
	defer close(release)
	a.drainTimeout = time.Millisecond
	var stages []string
	a.drainWS = func(d time.Duration) bool {
		stages = append(stages, "websockets")
		return false
	}
	a.waitNotifyFanOut = func() { <-release }
	a.waitInboxFanOut = func() { <-release }
	quit := make(chan os.Signal, 1)
	_, done := serveOn(t, a, quit)
	quit <- syscall.SIGTERM
	if err := <-done; err != nil {
		t.Fatalf("shutdown = %v, want nil after the bounded waits", err)
	}
	if len(stages) != 1 || a.closers != nil {
		t.Fatalf("stages = %v closers = %v, want the drain attempted and everything released", stages, a.closers)
	}
	a.jobs.Wait()
}

// A worker that refuses to start is logged; the boot still serves (another
// instance's worker runs the tasks) and nothing tries to stop it.
func TestBootSurvivesATaskWorkerThatWontStart(t *testing.T) {
	orig := startTaskWorker
	t.Cleanup(func() { startTaskWorker = orig })
	startTaskWorker = func(*service.AsynqPushWorker) error { return errors.New("already running") }
	a := boot(t, baseConfig(t))
	if len(a.closers) != 3 {
		t.Fatalf("closers = %d, want broker, task Redis and queue only", len(a.closers))
	}
	a.close()
	a.jobs.Wait()
}

// Every boot step that can fail aborts New with an error naming it.
func TestBootFailuresNameTheirStep(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, cfg *config.Config)
		want  string
	}{
		{"aws config", func(t *testing.T, _ *config.Config) {
			t.Setenv("AWS_PROFILE", "ex-app-test-missing-profile")
		}, "failed to init DynamoDB"},
		{"dynamodb table", func(t *testing.T, cfg *config.Config) {
			cfg.DynamoDBEndpoint = stubServer(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/x-amz-json-1.0")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"__type":"com.amazon.coral.validate#ValidationException","message":"stub"}`)
			}).URL
		}, "failed to ensure DynamoDB table"},
		{"redis cache", func(_ *testing.T, cfg *config.Config) {
			cfg.RedisURL = "nope://redis"
		}, "failed to init Redis cache"},
		{"redis pub/sub", func(t *testing.T, _ *config.Config) {
			orig := newRedisPubSub
			t.Cleanup(func() { newRedisPubSub = orig })
			newRedisPubSub = func(string) (*pubsub.RedisPubSub, error) { return nil, errors.New("redis went away") }
		}, "failed to init Redis pub/sub"},
		{"oidc", func(t *testing.T, cfg *config.Config) {
			cfg.OIDCIssuer = oidcDiscovery(t).URL + "/missing"
		}, "failed to init OIDC provider"},
		{"mail transport", func(_ *testing.T, cfg *config.Config) {
			cfg.SMTPHost, cfg.SMTPPort = "127.0.0.1", "smtp"
		}, "failed to init mail transport"},
		{"microsoft graph", func(t *testing.T, cfg *config.Config) {
			orig := newGraphClient
			t.Cleanup(func() { newGraphClient = orig })
			newGraphClient = func(msgraph.Config) (*msgraph.Client, error) { return nil, errors.New("bad token URL") }
		}, "failed to init Microsoft Graph client"},
		{"search", func(_ *testing.T, cfg *config.Config) {
			cfg.OpenSearchURL = "http://bad host"
		}, "failed to init OpenSearch client"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := baseConfig(t)
			tc.setup(t, cfg)
			a, err := New(context.Background(), cfg, frontendBuild)
			if a != nil || err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("New = %v, %v; want an error containing %q", a, err, tc.want)
			}
		})
	}
}

// The boot refuses a process with a dependency left unwired, naming it.
func TestCheckWiringNamesAMissingDependency(t *testing.T) {
	a := boot(t, baseConfig(t))
	defer func() {
		a.close()
		a.jobs.Wait()
	}()
	if err := a.checkWiring(context.Background()); err != nil {
		t.Fatalf("production wiring: %v", err)
	}
	a.chat.messages.SetNotifier(nil)
	err := a.checkWiring(context.Background())
	if err == nil || !strings.Contains(err.Error(), "boot wiring incomplete") || !strings.Contains(err.Error(), "no notifier wired") {
		t.Fatalf("checkWiring = %v, want the missing notifier named", err)
	}
}
