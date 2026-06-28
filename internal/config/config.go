package config

import (
	"fmt"
	"os"
	"time"
	"unicode/utf8"
)

type Config struct {
	Port string
	Env  string // "development" or "production"

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

	// OneSignal mobile push. REST API key is server-only and must never be
	// exposed through frontend config.
	OneSignalAppID      string
	OneSignalRESTAPIKey string

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

	return c, nil
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
