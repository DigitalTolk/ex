package config

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/caarlos0/env/v11"
)

// Config is read from the environment by Load. Each field's `env` tag names
// its variable and `envDefault` its default; an unset OR empty variable takes
// the default. Rules that span fields (fallbacks, fail-closed checks) run in
// Load after parsing.
type Config struct {
	Port string `env:"PORT" envDefault:"8080"`
	// Fail CLOSED: an unset ENV means production, not development. Defaulting
	// to development meant a prod deploy that forgot ENV=production would boot
	// with the hardcoded "dev-secret-change-me" JWT key (forgeable admin
	// tokens) plus wildcard CORS/WS origins. Local dev sets ENV=development
	// explicitly (docker-compose.yml), so this only tightens the default.
	Env string `env:"ENV" envDefault:"production"` // "development" or "production"

	// AccessLogEnabled controls per-request logging. When false, only 5xx
	// responses are recorded (ACCESS_LOG_ENABLED, default true).
	AccessLogEnabled bool `env:"ACCESS_LOG_ENABLED" envDefault:"true"`

	// GuestLoginAnyRole lifts the guest-only gate on password login
	// (GUEST_LOGIN_ANY_ROLE, default false). Local-dev affordance: without
	// OIDC the guest form is the only login, and guests can't create
	// channels. SSO users carry no password hash, so this can't log them in.
	// Set only in docker-compose.dev.yml.
	GuestLoginAnyRole bool `env:"GUEST_LOGIN_ANY_ROLE"`

	// DynamoDB
	AWSRegion        string `env:"AWS_REGION" envDefault:"us-east-1"`
	DynamoDBTable    string `env:"DYNAMODB_TABLE" envDefault:"ex"`
	DynamoDBEndpoint string `env:"DYNAMODB_ENDPOINT"` // for local dev

	// Redis
	RedisURL string `env:"REDIS_URL" envDefault:"redis://localhost:6379"`

	// OIDC
	OIDCIssuer       string `env:"OIDC_ISSUER"`
	OIDCClientID     string `env:"OIDC_CLIENT_ID"`
	OIDCClientSecret string `env:"OIDC_CLIENT_SECRET"`

	// Microsoft 365 integration (app-only Graph API): profile enrichment
	// (phone + manager) and the /mstmeetings slash command. Setting
	// MS_TENANT_ID enables it; the client credentials default to the OIDC
	// app registration (the workspace already signs in through it), with
	// MS_CLIENT_ID / MS_CLIENT_SECRET as explicit overrides. The secret is
	// server-only and must never be exposed through frontend config.
	MSTenantID     string `env:"MS_TENANT_ID"`
	MSClientID     string `env:"MS_CLIENT_ID"`
	MSClientSecret string `env:"MS_CLIENT_SECRET"`
	// MSProfileSyncInterval paces the periodic directory re-sync (phone +
	// manager for every OIDC user) so changes made in Entra propagate even
	// when their owner doesn't re-login (MS_PROFILE_SYNC_INTERVAL, default
	// 12h). The first sweep runs at boot and doubles as the backfill.
	MSProfileSyncInterval time.Duration `env:"MS_PROFILE_SYNC_INTERVAL" envDefault:"12h"`
	// MSStatusSyncInterval paces the account-standing check: an account
	// disabled or deleted in Entra is deactivated in Ex within one interval
	// (MS_STATUS_SYNC_INTERVAL, default 5m). One tenant-wide Graph listing
	// per interval, whatever the number of users.
	MSStatusSyncInterval time.Duration `env:"MS_STATUS_SYNC_INTERVAL" envDefault:"5m"`

	// JWT
	JWTSecret     string        `env:"JWT_SECRET"`
	JWTAccessTTL  time.Duration `env:"JWT_ACCESS_TTL" envDefault:"15m"`
	JWTRefreshTTL time.Duration `env:"JWT_REFRESH_TTL" envDefault:"720h"`
	// SessionMaxAge is a session's absolute lifetime (SESSION_MAX_AGE,
	// default 90 days): however often it refreshes, a session ends this long
	// after the user signed in.
	SessionMaxAge time.Duration `env:"SESSION_MAX_AGE" envDefault:"2160h"`

	// OIDCAllowedEmailDomains, when set (OIDC_ALLOWED_EMAIL_DOMAINS, comma
	// separated), restricts SSO sign-in to these email domains.
	OIDCAllowedEmailDomains []string `env:"OIDC_ALLOWED_EMAIL_DOMAINS"`

	// Transactional email (guest invites, password resets). Optional: with
	// no transport configured the app runs normally and the links are shown
	// in-app for manual relay.
	//
	// EmailProvider selects the transport: "smtp" (default) or "ses". SES
	// sends through the AWS API rather than an SMTP endpoint, so it
	// authenticates with the ambient IAM identity — no SMTP credentials to
	// mint or rotate.
	EmailProvider string `env:"EMAIL_PROVIDER" envDefault:"smtp"`
	// EmailFrom is the sender identity for both transports. Defaults to
	// SMTPFrom so an SMTP-era config keeps working unchanged.
	EmailFrom string `env:"EMAIL_FROM"`
	// SESConfigurationSet is optional; when set, SES publishes delivery,
	// bounce, and complaint events for these sends to it.
	SESConfigurationSet string `env:"SES_CONFIGURATION_SET"`

	// SMTP
	SMTPHost string `env:"SMTP_HOST"`
	SMTPPort string `env:"SMTP_PORT" envDefault:"587"`
	SMTPUser string `env:"SMTP_USER"`
	SMTPPass string `env:"SMTP_PASS"`
	SMTPFrom string `env:"SMTP_FROM" envDefault:"noreply@example.com"`
	// SMTPTLSPolicy is the STARTTLS policy on a plain port: "mandatory"
	// (the default outside development), "opportunistic" (the development
	// default, for Mailpit or a trusted local relay) or "none". Port 465 is
	// implicit TLS whatever this says.
	SMTPTLSPolicy string `env:"SMTP_TLS_POLICY"`

	// S3
	S3Endpoint       string `env:"S3_ENDPOINT"`        // internal endpoint (backend → S3)
	S3PublicEndpoint string `env:"S3_PUBLIC_ENDPOINT"` // public endpoint (browser → S3); used in presigned URLs
	S3Bucket         string `env:"S3_BUCKET" envDefault:"ex-avatars"`
	S3AccessKey      string `env:"S3_ACCESS_KEY"`
	S3SecretKey      string `env:"S3_SECRET_KEY"`
	S3Region         string `env:"S3_REGION" envDefault:"us-east-1"`

	// App
	BaseURL string `env:"BASE_URL" envDefault:"http://localhost:8080"`

	// ConnectorProvider is the standalone connector-provider ex pulls its
	// connector catalog (docs + admin auth) from. Empty → no provider; the
	// registry holds only directly-ingested connectors. Set per environment
	// (stg-ex → stg provider, prd-ex → prod provider) — never hardcoded.
	ConnectorProviderURL string `env:"CONNECTOR_PROVIDER_URL"`
	ConnectorProviderKey string `env:"CONNECTOR_PROVIDER_API_KEY"`
	// ConnectorPrivateDomains lists the domains whose hosts connector calls
	// may reach on a private 10.x address ("digitaltolk.net" covers the domain
	// and every subdomain): the internal services connectors
	// live on. Plain text on purpose — it can never stop the server starting;
	// an unusable entry is logged at boot and ignored (see
	// netguard.ParseDomains).
	ConnectorPrivateDomains string `env:"CONNECTOR_PRIVATE_DOMAINS"`

	// BedrockRegion enables server-side execution of bedrock-harness agents:
	// the backend runs the Converse loop against AWS Bedrock in this region
	// (task-role credentials). Empty → server mode stays off and such agents
	// fail legibly at invoke. Use a region hosting the wanted models or a
	// cross-region inference profile (eu.* profiles for EU data residency).
	BedrockRegion string `env:"BEDROCK_REGION"`
	// BedrockAccessKeyID (+Secret/SessionToken) override the default AWS
	// credential chain FOR BEDROCK ONLY. Needed in local dev, where the
	// environment's AWS_ACCESS_KEY_ID is the dummy credential for
	// dynamodb-local — real Bedrock creds ride these instead. Unset in real
	// deployments (the task role is the chain).
	BedrockAccessKeyID     string `env:"BEDROCK_AWS_ACCESS_KEY_ID"`
	BedrockSecretAccessKey string `env:"BEDROCK_AWS_SECRET_ACCESS_KEY"`
	BedrockSessionToken    string `env:"BEDROCK_AWS_SESSION_TOKEN"`

	// SentryFrontendDSN, when non-empty, enables Sentry error reporting in the
	// SPA: the server stamps it into the served index.html, so browsers and
	// the native shells all pick it up on next load. Backend observability is
	// Datadog's job (see Dockerfile / Orchestrion) — this is frontend-only.
	SentryFrontendDSN string `env:"SENTRY_FRONTEND_DSN"`
	// Optional Sentry sample rates (0..1, zero = off), served to the SPA the
	// same way: performance tracing, always-on session replay sampling, and
	// the buffered capture-replay-of-sessions-that-error rate.
	SentryFrontendTracesSampleRate        float64 `env:"SENTRY_FRONTEND_TRACES_SAMPLE_RATE"`
	SentryFrontendReplaySessionSampleRate float64 `env:"SENTRY_FRONTEND_REPLAY_SESSION_SAMPLE_RATE"`
	SentryFrontendReplayErrorSampleRate   float64 `env:"SENTRY_FRONTEND_REPLAY_ERROR_SAMPLE_RATE"`

	// TrustedProxyCount is how many reverse proxies (LB, CDN) sit in front of the
	// app and append to X-Forwarded-For. The rate-limit IP is taken just inside
	// these trusted hops so a client can't forge its identity with a leading XFF.
	// MUST match the deployment topology: 1 for a single LB (default), 0 for
	// direct exposure (ignore XFF entirely), N for N chained proxies. A wrong
	// value either trusts a spoofable hop or rate-limits the wrong IP.
	TrustedProxyCount int `env:"TRUSTED_PROXY_COUNT" envDefault:"1"`

	// OneSignal mobile push. REST API key is server-only and must never be
	// exposed through frontend config.
	OneSignalAppID      string `env:"ONESIGNAL_APP_ID"`
	OneSignalRESTAPIKey string `env:"ONESIGNAL_REST_API_KEY"`

	// PushWorkerConcurrency caps how many mobile-push deliveries the asynq
	// worker runs at once. 0 (unset) takes the service default.
	PushWorkerConcurrency int `env:"PUSH_WORKER_CONCURRENCY"`

	// OpenSearch — leave empty to disable search features. (The wire
	// protocol is ES-compatible for the operations we use, so the
	// underlying client is unchanged from when this was Elasticsearch.)
	OpenSearchURL string `env:"OPENSEARCH_URL"`
	// Set OpenSearchAWSRegion to the AWS region of a managed OpenSearch
	// domain or Serverless collection to enable SigV4 signing — the
	// client then authenticates via the SDK's default credential chain
	// (env vars, IRSA, EC2/ECS task role). Leave empty for self-hosted
	// OpenSearch / Elasticsearch reachable without AWS auth.
	OpenSearchAWSRegion  string `env:"OPENSEARCH_AWS_REGION"`
	OpenSearchAWSService string `env:"OPENSEARCH_AWS_SERVICE" envDefault:"es"` // "es" (default) or "aoss" for Serverless
}

func Load() (*Config, error) {
	c := &Config{}
	if err := env.Parse(c); err != nil {
		return nil, envError(err)
	}

	if c.SessionMaxAge <= 0 {
		return nil, fmt.Errorf("invalid SESSION_MAX_AGE %s: must be a positive duration", c.SessionMaxAge)
	}

	domains := c.OIDCAllowedEmailDomains
	c.OIDCAllowedEmailDomains = nil
	for _, domain := range domains {
		if domain = strings.ToLower(strings.TrimSpace(domain)); domain != "" {
			c.OIDCAllowedEmailDomains = append(c.OIDCAllowedEmailDomains, domain)
		}
	}

	if c.JWTSecret == "" && c.Env == "development" {
		c.JWTSecret = "dev-secret-change-me"
	}
	if c.JWTSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET is required")
	}
	if c.Env != "development" && utf8.RuneCountInString(c.JWTSecret) < 32 {
		return nil, fmt.Errorf("JWT_SECRET must be at least 32 characters outside development")
	}

	// Sample rates: unset means 0 (off); anything out of range fails Load so a
	// typo can't silently disable (or full-throttle) telemetry.
	for _, rate := range []struct {
		name string
		v    float64
	}{
		{"SENTRY_FRONTEND_TRACES_SAMPLE_RATE", c.SentryFrontendTracesSampleRate},
		{"SENTRY_FRONTEND_REPLAY_SESSION_SAMPLE_RATE", c.SentryFrontendReplaySessionSampleRate},
		{"SENTRY_FRONTEND_REPLAY_ERROR_SAMPLE_RATE", c.SentryFrontendReplayErrorSampleRate},
	} {
		if rate.v < 0 || rate.v > 1 {
			return nil, fmt.Errorf("invalid %s %v: must be a number between 0 and 1", rate.name, rate.v)
		}
	}

	if c.TrustedProxyCount < 0 {
		return nil, fmt.Errorf("invalid TRUSTED_PROXY_COUNT %d: must be a non-negative integer", c.TrustedProxyCount)
	}
	if c.PushWorkerConcurrency < 0 {
		return nil, fmt.Errorf("invalid PUSH_WORKER_CONCURRENCY %d: must be a non-negative integer", c.PushWorkerConcurrency)
	}

	// Microsoft 365: fail closed on a half-configured integration — a set
	// tenant with no usable credentials must abort boot, not silently run
	// with Graph features off.
	if c.MSClientID == "" {
		c.MSClientID = c.OIDCClientID
	}
	if c.MSClientSecret == "" {
		c.MSClientSecret = c.OIDCClientSecret
	}
	if c.MSTenantID != "" && (c.MSClientID == "" || c.MSClientSecret == "") {
		return nil, fmt.Errorf("MS_TENANT_ID is set but no client credentials are available (set MS_CLIENT_ID/MS_CLIENT_SECRET or OIDC_CLIENT_ID/OIDC_CLIENT_SECRET)")
	}
	if c.MSProfileSyncInterval <= 0 {
		return nil, fmt.Errorf("invalid MS_PROFILE_SYNC_INTERVAL %s: must be a positive duration", c.MSProfileSyncInterval)
	}
	if c.MSStatusSyncInterval <= 0 {
		return nil, fmt.Errorf("invalid MS_STATUS_SYNC_INTERVAL %s: must be a positive duration", c.MSStatusSyncInterval)
	}

	// EMAIL_FROM is the transport-neutral sender; it falls back to SMTP_FROM
	// so a config written before SES support keeps working unchanged.
	if c.EmailFrom == "" {
		c.EmailFrom = c.SMTPFrom
	}
	// Fail closed on an unknown transport rather than silently sending no
	// mail: a typo'd EMAIL_PROVIDER would otherwise look like "email is just
	// broken" in production.
	if c.EmailProvider != "smtp" && c.EmailProvider != "ses" {
		return nil, fmt.Errorf("invalid EMAIL_PROVIDER %q: must be \"smtp\" or \"ses\"", c.EmailProvider)
	}
	// STARTTLS is mandatory unless the deployment opts out: a relay that
	// stops offering it (or an on-path attacker stripping it) must fail the
	// send, not downgrade credentials and reset links to plaintext. Only
	// development defaults to opportunistic so Mailpit works out of the box.
	if c.SMTPTLSPolicy == "" {
		c.SMTPTLSPolicy = "mandatory"
		if c.IsDev() {
			c.SMTPTLSPolicy = "opportunistic"
		}
	}
	switch c.SMTPTLSPolicy {
	case "mandatory", "opportunistic", "none":
	default:
		return nil, fmt.Errorf("invalid SMTP_TLS_POLICY %q: must be \"mandatory\", \"opportunistic\" or \"none\"", c.SMTPTLSPolicy)
	}

	return c, nil
}

// envError renames the library's parse errors from the Go field to the
// variable an operator actually set ("invalid TRUSTED_PROXY_COUNT: ..."), so
// a boot failure points at the line of the deployment config to fix.
func envError(err error) error {
	var agg env.AggregateError
	if !errors.As(err, &agg) {
		return err
	}
	errs := make([]error, 0, len(agg.Errors))
	for _, e := range agg.Errors {
		if pe, ok := e.(env.ParseError); ok {
			field, _ := reflect.TypeFor[Config]().FieldByName(pe.Name)
			name, _, _ := strings.Cut(field.Tag.Get("env"), ",")
			e = fmt.Errorf("invalid %s: %w", name, pe.Err)
		}
		errs = append(errs, e)
	}
	return errors.Join(errs...)
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
