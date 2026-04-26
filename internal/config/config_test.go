package config

import (
	"os"
	"testing"
	"time"
)

// clearEnv unsets all config-relevant env vars and restores them after the test.
func clearEnv(t *testing.T) {
	t.Helper()

	envVars := []string{
		"PORT", "ENV", "AWS_REGION", "DYNAMODB_TABLE", "DYNAMODB_ENDPOINT",
		"REDIS_URL", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET",
		"JWT_SECRET", "JWT_ACCESS_TTL", "JWT_REFRESH_TTL",
		"SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM",
		"BASE_URL",
	}

	saved := make(map[string]string)
	for _, k := range envVars {
		if v, ok := os.LookupEnv(k); ok {
			saved[k] = v
		}
		_ = os.Unsetenv(k)
	}

	t.Cleanup(func() {
		for _, k := range envVars {
			if v, ok := saved[k]; ok {
				_ = os.Setenv(k, v)
			} else {
				_ = os.Unsetenv(k)
			}
		}
	})
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Port != "8080" {
		t.Errorf("Port = %q, want %q", cfg.Port, "8080")
	}
	if cfg.Env != "development" {
		t.Errorf("Env = %q, want %q", cfg.Env, "development")
	}
	if cfg.AWSRegion != "us-east-1" {
		t.Errorf("AWSRegion = %q, want %q", cfg.AWSRegion, "us-east-1")
	}
	if cfg.DynamoDBTable != "ex" {
		t.Errorf("DynamoDBTable = %q, want %q", cfg.DynamoDBTable, "ex")
	}
	if cfg.RedisURL != "redis://localhost:6379" {
		t.Errorf("RedisURL = %q, want %q", cfg.RedisURL, "redis://localhost:6379")
	}
	if cfg.JWTAccessTTL != 15*time.Minute {
		t.Errorf("JWTAccessTTL = %v, want %v", cfg.JWTAccessTTL, 15*time.Minute)
	}
	if cfg.JWTRefreshTTL != 720*time.Hour {
		t.Errorf("JWTRefreshTTL = %v, want %v", cfg.JWTRefreshTTL, 720*time.Hour)
	}
	// In development mode without JWT_SECRET, it gets the dev default.
	if cfg.JWTSecret != "dev-secret-change-me" {
		t.Errorf("JWTSecret = %q, want %q", cfg.JWTSecret, "dev-secret-change-me")
	}
	if cfg.SMTPFrom != "noreply@example.com" {
		t.Errorf("SMTPFrom = %q, want %q", cfg.SMTPFrom, "noreply@example.com")
	}
	if cfg.BaseURL != "http://localhost:8080" {
		t.Errorf("BaseURL = %q, want %q", cfg.BaseURL, "http://localhost:8080")
	}
}

func TestLoadCustomEnv(t *testing.T) {
	clearEnv(t)

	t.Setenv("PORT", "3000")
	t.Setenv("ENV", "production")
	t.Setenv("JWT_SECRET", "my-prod-secret")
	t.Setenv("JWT_ACCESS_TTL", "30m")
	t.Setenv("JWT_REFRESH_TTL", "168h")
	t.Setenv("BASE_URL", "https://example.com")
	t.Setenv("AWS_REGION", "eu-west-1")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.Port != "3000" {
		t.Errorf("Port = %q, want %q", cfg.Port, "3000")
	}
	if cfg.Env != "production" {
		t.Errorf("Env = %q, want %q", cfg.Env, "production")
	}
	if cfg.JWTSecret != "my-prod-secret" {
		t.Errorf("JWTSecret = %q, want %q", cfg.JWTSecret, "my-prod-secret")
	}
	if cfg.JWTAccessTTL != 30*time.Minute {
		t.Errorf("JWTAccessTTL = %v, want %v", cfg.JWTAccessTTL, 30*time.Minute)
	}
	if cfg.JWTRefreshTTL != 168*time.Hour {
		t.Errorf("JWTRefreshTTL = %v, want %v", cfg.JWTRefreshTTL, 168*time.Hour)
	}
	if cfg.BaseURL != "https://example.com" {
		t.Errorf("BaseURL = %q, want %q", cfg.BaseURL, "https://example.com")
	}
	if cfg.AWSRegion != "eu-west-1" {
		t.Errorf("AWSRegion = %q, want %q", cfg.AWSRegion, "eu-west-1")
	}
}

func TestLoadInvalidAccessDuration(t *testing.T) {
	clearEnv(t)
	t.Setenv("JWT_ACCESS_TTL", "invalid")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for invalid JWT_ACCESS_TTL")
	}
}

func TestLoadInvalidRefreshDuration(t *testing.T) {
	clearEnv(t)
	t.Setenv("JWT_REFRESH_TTL", "bad-duration")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for invalid JWT_REFRESH_TTL")
	}
}

func TestLoadMissingJWTSecretProduction(t *testing.T) {
	clearEnv(t)
	t.Setenv("ENV", "production")

	_, err := Load()
	if err == nil {
		t.Fatal("expected error for missing JWT_SECRET in production")
	}
}

func TestIsDev(t *testing.T) {
	tests := []struct {
		env  string
		want bool
	}{
		{"development", true},
		{"production", false},
		{"staging", false},
	}

	for _, tt := range tests {
		t.Run(tt.env, func(t *testing.T) {
			cfg := &Config{Env: tt.env}
			if got := cfg.IsDev(); got != tt.want {
				t.Errorf("IsDev() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestOIDCRedirectURL(t *testing.T) {
	tests := []struct {
		baseURL string
		want    string
	}{
		{"http://localhost:8080", "http://localhost:8080/auth/oidc/callback"},
		{"https://example.com", "https://example.com/auth/oidc/callback"},
	}

	for _, tt := range tests {
		t.Run(tt.baseURL, func(t *testing.T) {
			cfg := &Config{BaseURL: tt.baseURL}
			if got := cfg.OIDCRedirectURL(); got != tt.want {
				t.Errorf("OIDCRedirectURL() = %q, want %q", got, tt.want)
			}
		})
	}
}
