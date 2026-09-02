package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
	"unicode/utf8"
)

type Config struct {
	Port string
	Env  string // "development" or "production"

	// AccessLogEnabled controls per-request logging. When false, only 5xx
	// responses are recorded (ACCESS_LOG_ENABLED, default true).
	AccessLogEnabled bool

	// GuestLoginAnyRole lifts the guest-only gate on password login
	// (GUEST_LOGIN_ANY_ROLE, default false). Local-dev affordance: without
	// OIDC the guest form is the only login, and guests can't create
	// channels. SSO users carry no password hash, so this can't log them in.
	GuestLoginAnyRole bool

	// DynamoDB
	AWSRegion        string
	DynamoDBTable    string
	DynamoDBEndpoint string // for local dev

	// Redis
	RedisURL string

	// OIDC
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string

	// Microsoft 365 integration (app-only Graph API): profile enrichment
	// (phone + manager) and the /mstmeetings slash command. Setting
	// MS_TENANT_ID enables it; the client credentials default to the OIDC
	// app registration (the workspace already signs in through it), with
	// MS_CLIENT_ID / MS_CLIENT_SECRET as explicit overrides. The secret is
	// server-only and must never be exposed through frontend config.
	MSTenantID     string
	MSClientID     string
	MSClientSecret string
	// MSProfileSyncInterval paces the periodic directory re-sync (phone +
	// manager for every OIDC user) so changes made in Entra propagate even
	// when their owner doesn't re-login (MS_PROFILE_SYNC_INTERVAL, default
	// 12h). The first sweep runs at boot and doubles as the backfill.
	MSProfileSyncInterval time.Duration

	// JWT
	JWTSecret     string
	JWTAccessTTL  time.Duration
	JWTRefreshTTL time.Duration

	// SMTP (for invites)
	SMTPHost string
	SMTPPort string
	SMTPUser string
	SMTPPass string
	SMTPFrom string

	// S3
	S3Endpoint       string // internal endpoint (backend → S3)
	S3PublicEndpoint string // public endpoint (browser → S3); used in presigned URLs
	S3Bucket         string
	S3AccessKey      string
	S3SecretKey      string
	S3Region         string

	// App
	BaseURL string

	// ConnectorProvider is the standalone connector-provider ex pulls its
	// connector catalog (docs + admin auth) from. Empty → no provider; the
	// registry holds only directly-ingested connectors. Set per environment
	// (stg-ex → stg provider, prd-ex → prod provider) — never hardcoded.
	ConnectorProviderURL string
	ConnectorProviderKey string

	// SentryFrontendDSN, when non-empty, enables Sentry error reporting in the
	// SPA: the server stamps it into the served index.html, so browsers and
	// the native shells all pick it up on next load. Backend observability is
	// Datadog's job (see Dockerfile / Orchestrion) — this is frontend-only.
	SentryFrontendDSN string
	// Optional Sentry sample rates (0..1, zero = off), served to the SPA the
	// same way: performance tracing, always-on session replay sampling, and
	// the buffered capture-replay-of-sessions-that-error rate.
	SentryFrontendTracesSampleRate        float64
	SentryFrontendReplaySessionSampleRate float64
	SentryFrontendReplayErrorSampleRate   float64

	// TrustedProxyCount is how many reverse proxies (LB, CDN) sit in front of the
	// app and append to X-Forwarded-For. The rate-limit IP is taken just inside
	// these trusted hops so a client can't forge its identity with a leading XFF.
	// MUST match the deployment topology: 1 for a single LB (default), 0 for
	// direct exposure (ignore XFF entirely), N for N chained proxies. A wrong
	// value either trusts a spoofable hop or rate-limits the wrong IP.
	TrustedProxyCount int

	// OneSignal mobile push. REST API key is server-only and must never be
	// exposed through frontend config.
	OneSignalAppID      string
	OneSignalRESTAPIKey string

	// PushWorkerConcurrency caps how many mobile-push deliveries the asynq
	// worker runs at once. 0 (unset) takes the service default.
	PushWorkerConcurrency int

	// OpenSearch — leave empty to disable search features. (The wire
	// protocol is ES-compatible for the operations we use, so the
	// underlying client is unchanged from when this was Elasticsearch.)
	OpenSearchURL string
	// Set OpenSearchAWSRegion to the AWS region of a managed OpenSearch
	// domain or Serverless collection to enable SigV4 signing — the
	// client then authenticates via the SDK's default credential chain
	// (env vars, IRSA, EC2/ECS task role). Leave empty for self-hosted
	// OpenSearch / Elasticsearch reachable without AWS auth.
	OpenSearchAWSRegion  string
	OpenSearchAWSService string // "es" (default) or "aoss" for Serverless
}

func Load() (*Config, error) {
	c := &Config{
		Port: envOr("PORT", "8080"),
		// Fail CLOSED: an unset ENV means production, not development. Defaulting
		// to development meant a prod deploy that forgot ENV=production would boot
		// with the hardcoded "dev-secret-change-me" JWT key (forgeable admin
		// tokens) plus wildcard CORS/WS origins. Local dev sets ENV=development
		// explicitly (docker-compose.yml), so this only tightens the default.
		Env:                  envOr("ENV", "production"),
		AWSRegion:            envOr("AWS_REGION", "us-east-1"),
		DynamoDBTable:        envOr("DYNAMODB_TABLE", "ex"),
		DynamoDBEndpoint:     os.Getenv("DYNAMODB_ENDPOINT"),
		RedisURL:             envOr("REDIS_URL", "redis://localhost:6379"),
		OIDCIssuer:           os.Getenv("OIDC_ISSUER"),
		OIDCClientID:         os.Getenv("OIDC_CLIENT_ID"),
		OIDCClientSecret:     os.Getenv("OIDC_CLIENT_SECRET"),
		JWTSecret:            os.Getenv("JWT_SECRET"),
		SMTPHost:             os.Getenv("SMTP_HOST"),
		SMTPPort:             envOr("SMTP_PORT", "587"),
		SMTPUser:             os.Getenv("SMTP_USER"),
		SMTPPass:             os.Getenv("SMTP_PASS"),
		SMTPFrom:             envOr("SMTP_FROM", "noreply@example.com"),
		S3Endpoint:           os.Getenv("S3_ENDPOINT"),
		S3PublicEndpoint:     os.Getenv("S3_PUBLIC_ENDPOINT"),
		S3Bucket:             envOr("S3_BUCKET", "ex-avatars"),
		S3AccessKey:          os.Getenv("S3_ACCESS_KEY"),
		S3SecretKey:          os.Getenv("S3_SECRET_KEY"),
		S3Region:             envOr("S3_REGION", "us-east-1"),
		BaseURL:              envOr("BASE_URL", "http://localhost:8080"),
		ConnectorProviderURL: os.Getenv("CONNECTOR_PROVIDER_URL"),
		ConnectorProviderKey: os.Getenv("CONNECTOR_PROVIDER_API_KEY"),
		OneSignalAppID:       os.Getenv("ONESIGNAL_APP_ID"),
		OneSignalRESTAPIKey:  os.Getenv("ONESIGNAL_REST_API_KEY"),
		OpenSearchURL:        os.Getenv("OPENSEARCH_URL"),
		OpenSearchAWSRegion:  os.Getenv("OPENSEARCH_AWS_REGION"),
		OpenSearchAWSService: envOr("OPENSEARCH_AWS_SERVICE", "es"),
	}

	accessTTL := envOr("JWT_ACCESS_TTL", "15m")
	d, err := time.ParseDuration(accessTTL)
	if err != nil {
		return nil, fmt.Errorf("invalid JWT_ACCESS_TTL: %w", err)
	}
	c.JWTAccessTTL = d

	refreshTTL := envOr("JWT_REFRESH_TTL", "720h")
	d, err = time.ParseDuration(refreshTTL)
	if err != nil {
		return nil, fmt.Errorf("invalid JWT_REFRESH_TTL: %w", err)
	}
	c.JWTRefreshTTL = d

	if c.JWTSecret == "" && c.Env == "development" {
		c.JWTSecret = "dev-secret-change-me"
	}
	if c.JWTSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET is required")
	}
	if c.Env != "development" && utf8.RuneCountInString(c.JWTSecret) < 32 {
		return nil, fmt.Errorf("JWT_SECRET must be at least 32 characters outside development")
	}

	c.SentryFrontendDSN = os.Getenv("SENTRY_FRONTEND_DSN")
	if c.SentryFrontendTracesSampleRate, err = sampleRateEnv("SENTRY_FRONTEND_TRACES_SAMPLE_RATE"); err != nil {
		return nil, err
	}
	if c.SentryFrontendReplaySessionSampleRate, err = sampleRateEnv("SENTRY_FRONTEND_REPLAY_SESSION_SAMPLE_RATE"); err != nil {
		return nil, err
	}
	if c.SentryFrontendReplayErrorSampleRate, err = sampleRateEnv("SENTRY_FRONTEND_REPLAY_ERROR_SAMPLE_RATE"); err != nil {
		return nil, err
	}

	// Access-log switch. Default ON; ACCESS_LOG_ENABLED=false keeps the access
	// log quiet except for 5xx responses (server faults must never go dark).
	c.AccessLogEnabled = true
	if v := os.Getenv("ACCESS_LOG_ENABLED"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf("invalid ACCESS_LOG_ENABLED %q: must be a boolean", v)
		}
		c.AccessLogEnabled = b
	}

	// Dev-only: GUEST_LOGIN_ANY_ROLE=true lets the password login form accept
	// non-guest roles (local stacks have no OIDC, and channel creation is
	// blocked for guests). Default off; set only in docker-compose.dev.yml.
	if v := os.Getenv("GUEST_LOGIN_ANY_ROLE"); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return nil, fmt.Errorf("invalid GUEST_LOGIN_ANY_ROLE %q: must be a boolean", v)
		}
		c.GuestLoginAnyRole = b
	}

	proxyCount := envOr("TRUSTED_PROXY_COUNT", "1")
	n, err := strconv.Atoi(proxyCount)
	if err != nil || n < 0 {
		return nil, fmt.Errorf("invalid TRUSTED_PROXY_COUNT %q: must be a non-negative integer", proxyCount)
	}
	c.TrustedProxyCount = n

	pushConc := envOr("PUSH_WORKER_CONCURRENCY", "0")
	pc, err := strconv.Atoi(pushConc)
	if err != nil || pc < 0 {
		return nil, fmt.Errorf("invalid PUSH_WORKER_CONCURRENCY %q: must be a non-negative integer", pushConc)
	}
	c.PushWorkerConcurrency = pc

	// Microsoft 365: fail closed on a half-configured integration — a set
	// tenant with no usable credentials must abort boot, not silently run
	// with Graph features off.
	c.MSTenantID = os.Getenv("MS_TENANT_ID")
	c.MSClientID = envOr("MS_CLIENT_ID", c.OIDCClientID)
	c.MSClientSecret = envOr("MS_CLIENT_SECRET", c.OIDCClientSecret)
	if c.MSTenantID != "" && (c.MSClientID == "" || c.MSClientSecret == "") {
		return nil, fmt.Errorf("MS_TENANT_ID is set but no client credentials are available (set MS_CLIENT_ID/MS_CLIENT_SECRET or OIDC_CLIENT_ID/OIDC_CLIENT_SECRET)")
	}
	syncInterval := envOr("MS_PROFILE_SYNC_INTERVAL", "12h")
	d, err = time.ParseDuration(syncInterval)
	if err != nil || d <= 0 {
		return nil, fmt.Errorf("invalid MS_PROFILE_SYNC_INTERVAL %q: must be a positive duration", syncInterval)
	}
	c.MSProfileSyncInterval = d

	return c, nil
}

// MSGraphEnabled reports whether the Microsoft 365 (Graph) integration is
// configured.
func (c *Config) MSGraphEnabled() bool {
	return c.MSTenantID != ""
}

func (c *Config) IsDev() bool {
	return c.Env == "development"
}

// OIDCRedirectURL returns the OIDC callback URL derived from BaseURL.
func (c *Config) OIDCRedirectURL() string {
	return c.BaseURL + "/auth/oidc/callback"
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// sampleRateEnv parses an optional 0..1 sampling rate from the environment.
// Unset/empty means 0 (off); anything unparsable or out of range fails Load
// so a typo can't silently disable (or full-throttle) telemetry.
func sampleRateEnv(name string) (float64, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return 0, nil
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil || v < 0 || v > 1 {
		return 0, fmt.Errorf("invalid %s %q: must be a number between 0 and 1", name, raw)
	}
	return v, nil
}
