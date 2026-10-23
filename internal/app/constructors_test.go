package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"

	"github.com/DigitalTolk/ex/internal/config"
	"github.com/DigitalTolk/ex/internal/middleware"
	"github.com/DigitalTolk/ex/internal/storage"
)

func TestNewPushSender(t *testing.T) {
	if p := newPushSender(&config.Config{}); p != nil {
		t.Fatalf("unconfigured push = %v, want nil", p)
	}
	if p := newPushSender(&config.Config{OneSignalAppID: "app", OneSignalRESTAPIKey: "key", BaseURL: "https://ex.example.com"}); p == nil {
		t.Fatal("configured push = nil, want a sender")
	}
	// A broken public URL disables push (loudly) instead of failing the boot.
	if p := newPushSender(&config.Config{OneSignalAppID: "app", OneSignalRESTAPIKey: "key", BaseURL: "not a url"}); p != nil {
		t.Fatalf("misconfigured push = %v, want nil", p)
	}
}

func TestNewServerEngine(t *testing.T) {
	if e := newServerEngine(&config.Config{}, nil, nil); e != nil {
		t.Fatalf("no BEDROCK_REGION: engine = %v, want nil", e)
	}
	cfg := &config.Config{
		Port:                   "8080",
		BedrockRegion:          "eu-north-1",
		BedrockAccessKeyID:     "AKIDEXAMPLE",
		BedrockSecretAccessKey: "secret",
	}
	e := newServerEngine(cfg, nil, nil)
	if e == nil {
		t.Fatal("bedrock configured: engine = nil")
	}
	// The bridged workspace tools call this process over loopback.
	if err := e.Wired(); err != nil {
		t.Fatalf("engine wiring: %v", err)
	}

	// The task role's chain is used when no static keys are given; a config
	// that cannot load leaves server-side agents off.
	orig := loadBedrockConfig
	t.Cleanup(func() { loadBedrockConfig = orig })
	var sawStatic bool
	loadBedrockConfig = func(ctx context.Context, opts ...func(*awsconfig.LoadOptions) error) (aws.Config, error) {
		var lo awsconfig.LoadOptions
		for _, o := range opts {
			_ = o(&lo)
		}
		sawStatic = lo.Credentials != nil
		return aws.Config{}, errors.New("no credentials")
	}
	if e := newServerEngine(&config.Config{BedrockRegion: "eu-north-1"}, nil, nil); e != nil {
		t.Fatalf("config load failure: engine = %v, want nil", e)
	}
	if sawStatic {
		t.Fatal("no BEDROCK_AWS_ACCESS_KEY_ID: want the default credential chain")
	}
}

// oidcDiscovery serves a minimal OpenID discovery document.
func oidcDiscovery(t *testing.T) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                srv.URL,
			"authorization_endpoint":                srv.URL + "/auth",
			"token_endpoint":                        srv.URL + "/token",
			"jwks_uri":                              srv.URL + "/keys",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestNewOIDC(t *testing.T) {
	ctx := context.Background()
	if p, err := newOIDC(ctx, &config.Config{}); p != nil || err != nil {
		t.Fatalf("no issuer = %v, %v; want guest login only", p, err)
	}
	idp := oidcDiscovery(t)
	p, err := newOIDC(ctx, &config.Config{OIDCIssuer: idp.URL, OIDCClientID: "ex", BaseURL: "http://localhost:8080"})
	if err != nil || p == nil {
		t.Fatalf("discoverable issuer = %v, %v", p, err)
	}
	if _, err := newOIDC(ctx, &config.Config{OIDCIssuer: idp.URL + "/missing"}); err == nil || !strings.Contains(err.Error(), "failed to init OIDC provider") {
		t.Fatalf("undiscoverable issuer: err = %v", err)
	}
}

// fakeS3 accepts every request (bucket creation included).
func fakeS3(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestNewObjectStorage(t *testing.T) {
	ctx := context.Background()
	if c := newObjectStorage(ctx, &config.Config{}); c != nil {
		t.Fatalf("nothing configured = %v, want nil", c)
	}
	s3 := fakeS3(t)
	cfg := &config.Config{S3Endpoint: s3.URL, S3Bucket: "ex-test", S3AccessKey: "minio", S3SecretKey: "minio123", S3Region: "us-east-1"}
	if c := newObjectStorage(ctx, cfg); c == nil {
		t.Fatal("configured S3 = nil")
	}

	orig := newS3Client
	t.Cleanup(func() { newS3Client = orig })
	newS3Client = func(context.Context, storage.S3Config) (*storage.S3Client, error) {
		return nil, errors.New("load config")
	}
	if c := newObjectStorage(ctx, &config.Config{S3Bucket: "ex-test"}); c != nil {
		t.Fatalf("unavailable S3 = %v, want nil (uploads disabled)", c)
	}
}

func TestBuildMailer(t *testing.T) {
	ctx := context.Background()
	if m, err := buildMailer(ctx, &config.Config{EmailProvider: "smtp"}); m != nil || err != nil {
		t.Fatalf("no SMTP host = %v, %v; want no mail", m, err)
	}
	smtp := &config.Config{EmailProvider: "smtp", SMTPHost: "127.0.0.1", SMTPPort: "2525", EmailFrom: "ex@example.com", SMTPTLSPolicy: "opportunistic"}
	if m, err := buildMailer(ctx, smtp); m == nil || err != nil {
		t.Fatalf("SMTP = %v, %v", m, err)
	}
	ses := &config.Config{EmailProvider: "ses", AWSRegion: "eu-north-1", EmailFrom: "ex@example.com"}
	if m, err := buildMailer(ctx, ses); m == nil || err != nil {
		t.Fatalf("SES = %v, %v", m, err)
	}
	if m, err := buildMailer(ctx, &config.Config{EmailProvider: "ses"}); m != nil || err != nil {
		t.Fatalf("SES without a region = %v, %v; want no mail", m, err)
	}
	// A bad transport setting is a misconfiguration, not an opt-out.
	bad := &config.Config{EmailProvider: "smtp", SMTPHost: "127.0.0.1", SMTPPort: "smtp", EmailFrom: "ex@example.com"}
	if _, err := buildMailer(ctx, bad); err == nil || !strings.Contains(err.Error(), "failed to init mail transport") {
		t.Fatalf("bad SMTP port: err = %v", err)
	}
}

func TestProductionLoggerEmitsParseableJSON(t *testing.T) {
	var buf bytes.Buffer
	logger := productionLogger(&buf)

	logger.Warn("author last-read mark failed", "parentID", "ch-1", "error", "store: item not found")

	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("production log line is not JSON: %v\nline: %s", err, buf.String())
	}
	if line["level"] != "WARN" {
		t.Errorf("level = %v, want WARN", line["level"])
	}
	if line["msg"] != "author last-read mark failed" {
		t.Errorf("msg = %v", line["msg"])
	}
	if line["parentID"] != "ch-1" {
		t.Errorf("parentID field = %v, want ch-1 (attributes must be structured, not embedded in msg)", line["parentID"])
	}
}

// A line logged inside a request with its context names the request, so a
// failure can be matched to its access-log line and the client's
// X-Request-ID.
func TestProductionLoggerTagsRequestLines(t *testing.T) {
	var buf bytes.Buffer
	logger := productionLogger(&buf)
	h := middleware.RequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		logger.ErrorContext(r.Context(), "send failed", "error", "boom")
	}))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/messages", nil)
	req.Header.Set("X-Request-ID", "req-42")
	h.ServeHTTP(httptest.NewRecorder(), req)

	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("production log line is not JSON: %v\nline: %s", err, buf.String())
	}
	if line["requestID"] != "req-42" {
		t.Errorf("requestID = %v, want req-42", line["requestID"])
	}
}

func TestSetupLogging(t *testing.T) {
	orig := slog.Default()
	t.Cleanup(func() { slog.SetDefault(orig) })

	var dev bytes.Buffer
	SetupLogging(&config.Config{Env: "development"}, &dev)
	if slog.Default() != orig {
		t.Fatal("development must keep the default human-readable logger")
	}

	var prod bytes.Buffer
	SetupLogging(&config.Config{Env: "production"}, &prod)
	slog.Info("booted", "port", "8080")
	var line map[string]any
	if err := json.Unmarshal(prod.Bytes(), &line); err != nil || line["msg"] != "booted" {
		t.Fatalf("production default logger line = %q (%v), want JSON", prod.String(), err)
	}
}

func TestHealthCheckPort(t *testing.T) {
	if got := healthCheckPort(func(string) string { return "" }); got != "8080" {
		t.Fatalf("default port = %q, want 8080", got)
	}
	getenv := func(k string) string {
		if k == "PORT" {
			return "3000"
		}
		return ""
	}
	if got := healthCheckPort(getenv); got != "3000" {
		t.Fatalf("env port = %q, want 3000", got)
	}
}

func TestRunHealthCheck(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer healthy.Close()
	var stderr bytes.Buffer
	if code := runHealthCheck(healthy.Client(), healthy.URL+"/healthz", &stderr); code != 0 {
		t.Fatalf("healthy probe exit = %d, want 0", code)
	}

	unhealthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer unhealthy.Close()
	if code := runHealthCheck(unhealthy.Client(), unhealthy.URL+"/healthz", &stderr); code != 1 {
		t.Fatalf("unhealthy probe exit = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "unhealthy status 503") {
		t.Fatalf("stderr = %q, want the status", stderr.String())
	}

	// A connection error (nothing listening) is also unhealthy.
	if code := runHealthCheck(http.DefaultClient, "http://127.0.0.1:1/healthz", &stderr); code != 1 {
		t.Fatalf("connection-error probe exit = %d, want 1", code)
	}
}

// The subcommand probes the local server on $PORT.
func TestHealthCheckProbesTheLocalPort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			http.NotFound(w, r)
		}
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	t.Setenv("PORT", port)
	if code := HealthCheck(); code != 0 {
		t.Fatalf("HealthCheck exit = %d, want 0", code)
	}
}
