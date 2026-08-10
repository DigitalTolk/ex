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
		"BASE_URL", "ONESIGNAL_APP_ID", "ONESIGNAL_REST_API_KEY",
		"SENTRY_FRONTEND_DSN", "SENTRY_FRONTEND_TRACES_SAMPLE_RATE",
		"SENTRY_FRONTEND_REPLAY_SESSION_SAMPLE_RATE", "SENTRY_FRONTEND_REPLAY_ERROR_SAMPLE_RATE",
		"ACCESS_LOG_ENABLED",
		"MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_PROFILE_SYNC_INTERVAL",
		// The Cliffy bridge vars are validated as a pair, so an ambient value would
		// make every other Load test depend on the developer's shell.
		"CLIFFY_BRIDGE_SECRET", "CLIFFY_BRIDGE_MINT_URL", "CLIFFY_AGENT_URL", "CLIFFY_WEB_BASE",
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

func TestLoadFailsClosedWithoutEnv(t *testing.T) {
	clearEnv(t)
	// Fail-closed: with ENV unset, Env defaults to production, so an unset
	// JWT_SECRET must abort startup rather than silently use the dev secret.
	if _, err := Load(); err == nil {
		t.Fatal("Load() with no ENV and no JWT_SECRET should fail closed, got nil error")
	}
}

func TestLoadDefaults(t *testing.T) {
	clearEnv(t)
	t.Setenv("ENV", "development") // dev defaults are opt-in now (fail-closed)

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
	if cfg.OneSignalAppID != "" {
		t.Errorf("OneSignalAppID = %q, want empty", cfg.OneSignalAppID)
	}
	if cfg.OneSignalRESTAPIKey != "" {
		t.Errorf("OneSignalRESTAPIKey = %q, want empty", cfg.OneSignalRESTAPIKey)
	}
	if cfg.TrustedProxyCount != 1 {
		t.Errorf("TrustedProxyCount = %d, want default 1", cfg.TrustedProxyCount)
	}
}

func TestLoadSentryFrontendDSN(t *testing.T) {
	clearEnv(t)
	t.Setenv("ENV", "development")
	t.Setenv("SENTRY_FRONTEND_DSN", "https://key@o0.ingest.sentry.io/42")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.SentryFrontendDSN != "https://key@o0.ingest.sentry.io/42" {
		t.Errorf("SentryFrontendDSN = %q", cfg.SentryFrontendDSN)
	}
}

func TestLoadSentrySampleRates(t *testing.T) {
	t.Run("valid rates parse", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("SENTRY_FRONTEND_TRACES_SAMPLE_RATE", "0.2")
		t.Setenv("SENTRY_FRONTEND_REPLAY_SESSION_SAMPLE_RATE", "0.1")
		t.Setenv("SENTRY_FRONTEND_REPLAY_ERROR_SAMPLE_RATE", "1")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.SentryFrontendTracesSampleRate != 0.2 ||
			cfg.SentryFrontendReplaySessionSampleRate != 0.1 ||
			cfg.SentryFrontendReplayErrorSampleRate != 1 {
			t.Errorf("rates = %v/%v/%v", cfg.SentryFrontendTracesSampleRate, cfg.SentryFrontendReplaySessionSampleRate, cfg.SentryFrontendReplayErrorSampleRate)
		}
	})

	t.Run("unset means off", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.SentryFrontendTracesSampleRate != 0 {
			t.Errorf("TracesSampleRate = %v, want 0", cfg.SentryFrontendTracesSampleRate)
		}
	})

	// A typo must fail Load rather than silently disable (or full-throttle)
	// telemetry.
	for _, bad := range []string{"abc", "-0.1", "1.5"} {
		t.Run("rejects "+bad, func(t *testing.T) {
			clearEnv(t)
			t.Setenv("ENV", "development")
			t.Setenv("SENTRY_FRONTEND_TRACES_SAMPLE_RATE", bad)
			if _, err := Load(); err == nil {
				t.Fatalf("Load with rate %q should fail", bad)
			}
		})
	}

	// Each of the three rate vars has its own error arm in Load — exercise the
	// replay-session and replay-error arms too, not just traces.
	for _, envVar := range []string{
		"SENTRY_FRONTEND_REPLAY_SESSION_SAMPLE_RATE",
		"SENTRY_FRONTEND_REPLAY_ERROR_SAMPLE_RATE",
	} {
		for _, bad := range []string{"abc", "2.5"} {
			t.Run("rejects "+envVar+"="+bad, func(t *testing.T) {
				clearEnv(t)
				t.Setenv("ENV", "development")
				t.Setenv(envVar, bad)
				if _, err := Load(); err == nil {
					t.Fatalf("Load with %s=%q should fail", envVar, bad)
				}
			})
		}
	}
}

func TestLoadTrustedProxyCount(t *testing.T) {
	t.Run("custom value", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("TRUSTED_PROXY_COUNT", "2")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.TrustedProxyCount != 2 {
			t.Errorf("TrustedProxyCount = %d, want 2", cfg.TrustedProxyCount)
		}
	})

	for _, bad := range []string{"abc", "-1"} {
		t.Run("rejects "+bad, func(t *testing.T) {
			clearEnv(t)
			t.Setenv("ENV", "development")
			t.Setenv("TRUSTED_PROXY_COUNT", bad)
			if _, err := Load(); err == nil {
				t.Fatalf("Load with TRUSTED_PROXY_COUNT=%q should fail", bad)
			}
		})
	}
}

func TestLoadCustomEnv(t *testing.T) {
	clearEnv(t)

	t.Setenv("PORT", "3000")
	t.Setenv("ENV", "production")
	t.Setenv("JWT_SECRET", "my-prod-secret-with-at-least-32-chars")
	t.Setenv("JWT_ACCESS_TTL", "30m")
	t.Setenv("JWT_REFRESH_TTL", "168h")
	t.Setenv("BASE_URL", "https://example.com")
	t.Setenv("AWS_REGION", "eu-west-1")
	t.Setenv("ONESIGNAL_APP_ID", "onesignal-app")
	t.Setenv("ONESIGNAL_REST_API_KEY", "onesignal-secret")

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
	if cfg.JWTSecret != "my-prod-secret-with-at-least-32-chars" {
		t.Errorf("JWTSecret = %q, want %q", cfg.JWTSecret, "my-prod-secret-with-at-least-32-chars")
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
	if cfg.OneSignalAppID != "onesignal-app" {
		t.Errorf("OneSignalAppID = %q, want onesignal-app", cfg.OneSignalAppID)
	}
	if cfg.OneSignalRESTAPIKey != "onesignal-secret" {
		t.Errorf("OneSignalRESTAPIKey = %q, want onesignal-secret", cfg.OneSignalRESTAPIKey)
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

func TestLoadWeakJWTSecretProduction(t *testing.T) {
	clearEnv(t)
	t.Setenv("ENV", "production")
	t.Setenv("JWT_SECRET", "short-secret")

	if _, err := Load(); err == nil {
		t.Fatal("expected error for weak JWT_SECRET in production")
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

func TestLoadAccessLogEnabled(t *testing.T) {
	t.Run("defaults to enabled", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if !cfg.AccessLogEnabled {
			t.Fatal("AccessLogEnabled should default to true")
		}
	})

	t.Run("disabled via env", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("ACCESS_LOG_ENABLED", "false")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.AccessLogEnabled {
			t.Fatal("ACCESS_LOG_ENABLED=false must disable the access log")
		}
	})

	t.Run("invalid value fails closed", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("ACCESS_LOG_ENABLED", "yes-please")
		if _, err := Load(); err == nil {
			t.Fatal("invalid ACCESS_LOG_ENABLED must fail Load")
		}
	})
}

func TestLoadPushWorkerConcurrency(t *testing.T) {
	t.Run("custom value", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("PUSH_WORKER_CONCURRENCY", "16")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.PushWorkerConcurrency != 16 {
			t.Errorf("PushWorkerConcurrency = %d, want 16", cfg.PushWorkerConcurrency)
		}
	})

	for _, bad := range []string{"abc", "-1"} {
		t.Run("rejects "+bad, func(t *testing.T) {
			clearEnv(t)
			t.Setenv("ENV", "development")
			t.Setenv("PUSH_WORKER_CONCURRENCY", bad)
			if _, err := Load(); err == nil {
				t.Fatalf("Load with PUSH_WORKER_CONCURRENCY=%q should fail", bad)
			}
		})
	}
}

func TestLoadMSGraph(t *testing.T) {
	t.Run("disabled by default", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.MSGraphEnabled() {
			t.Error("MSGraphEnabled() = true without MS_TENANT_ID")
		}
	})

	t.Run("credentials default to the OIDC app registration", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("MS_TENANT_ID", "tenant-1")
		t.Setenv("OIDC_CLIENT_ID", "oidc-client")
		t.Setenv("OIDC_CLIENT_SECRET", "oidc-secret")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if !cfg.MSGraphEnabled() {
			t.Error("MSGraphEnabled() = false with MS_TENANT_ID set")
		}
		if cfg.MSClientID != "oidc-client" || cfg.MSClientSecret != "oidc-secret" {
			t.Errorf("MS credentials = %q/%q, want OIDC fallback", cfg.MSClientID, cfg.MSClientSecret)
		}
	})

	t.Run("explicit credentials override OIDC", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("MS_TENANT_ID", "tenant-1")
		t.Setenv("OIDC_CLIENT_ID", "oidc-client")
		t.Setenv("OIDC_CLIENT_SECRET", "oidc-secret")
		t.Setenv("MS_CLIENT_ID", "ms-client")
		t.Setenv("MS_CLIENT_SECRET", "ms-secret")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.MSClientID != "ms-client" || cfg.MSClientSecret != "ms-secret" {
			t.Errorf("MS credentials = %q/%q, want explicit overrides", cfg.MSClientID, cfg.MSClientSecret)
		}
	})

	t.Run("fails closed on tenant without credentials", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("MS_TENANT_ID", "tenant-1")
		if _, err := Load(); err == nil {
			t.Fatal("Load with MS_TENANT_ID but no credentials should fail")
		}
	})
}

func TestLoadMSProfileSyncInterval(t *testing.T) {
	t.Run("default 12h", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.MSProfileSyncInterval != 12*time.Hour {
			t.Errorf("MSProfileSyncInterval = %v, want 12h", cfg.MSProfileSyncInterval)
		}
	})
	t.Run("custom", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("MS_PROFILE_SYNC_INTERVAL", "30m")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.MSProfileSyncInterval != 30*time.Minute {
			t.Errorf("MSProfileSyncInterval = %v, want 30m", cfg.MSProfileSyncInterval)
		}
	})
	for _, bad := range []string{"abc", "-1h", "0"} {
		t.Run("rejects "+bad, func(t *testing.T) {
			clearEnv(t)
			t.Setenv("ENV", "development")
			t.Setenv("MS_PROFILE_SYNC_INTERVAL", bad)
			if _, err := Load(); err == nil {
				t.Fatalf("Load with MS_PROFILE_SYNC_INTERVAL=%q should fail", bad)
			}
		})
	}
}

// The bridge secret is the feature's on/off switch. The three URLs default to
// CliffHub production, so only an explicitly blanked mint URL is a
// half-configuration — and that fails at boot rather than at call time.
func TestLoadCliffyBridgePairing(t *testing.T) {
	t.Run("secret with an explicitly blanked mint URL is rejected", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("CLIFFY_BRIDGE_SECRET", "a-secret-that-is-long-enough-here")
		t.Setenv("CLIFFY_BRIDGE_MINT_URL", "")
		if _, err := Load(); err == nil {
			t.Fatal("want a boot failure for a half-configured bridge")
		}
	})

	t.Run("no secret leaves Cliffy disabled, defaults notwithstanding", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("CLIFFY_BRIDGE_SECRET", "")
		c, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		// The URLs are populated from the defaults, but with no secret the bridge
		// is never constructed (NewCliffyBridge returns nil), so Cliffy is off.
		if c.CliffyBridgeSecret != "" {
			t.Fatalf("CliffyBridgeSecret = %q, want empty", c.CliffyBridgeSecret)
		}
		if c.CliffyBridgeMintURL != defaultCliffyMintURL {
			t.Fatalf("CliffyBridgeMintURL = %q, want the default", c.CliffyBridgeMintURL)
		}
	})

	t.Run("the URLs default to CliffHub production when unset", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("CLIFFY_BRIDGE_SECRET", "a-secret-that-is-long-enough-here")
		c, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if c.CliffyBridgeMintURL != defaultCliffyMintURL {
			t.Fatalf("CliffyBridgeMintURL = %q, want %q", c.CliffyBridgeMintURL, defaultCliffyMintURL)
		}
		if c.CliffyAgentURL != defaultCliffyAgentURL {
			t.Fatalf("CliffyAgentURL = %q, want %q", c.CliffyAgentURL, defaultCliffyAgentURL)
		}
		if c.CliffyWebBase != defaultCliffyWebBase {
			t.Fatalf("CliffyWebBase = %q, want %q", c.CliffyWebBase, defaultCliffyWebBase)
		}
	})

	t.Run("an explicit URL overrides the default", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("CLIFFY_BRIDGE_SECRET", "a-secret-that-is-long-enough-here")
		t.Setenv("CLIFFY_BRIDGE_MINT_URL", "http://localhost:8199/api/ai/bridge/mint")
		c, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if c.CliffyBridgeMintURL != "http://localhost:8199/api/ai/bridge/mint" {
			t.Fatalf("CliffyBridgeMintURL = %q, want the override", c.CliffyBridgeMintURL)
		}
	})

	t.Run("targeting the default CliffHub is detectable for the boot warning", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("CLIFFY_BRIDGE_SECRET", "a-secret-that-is-long-enough-here")
		c, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if !c.CliffyTargetsDefaultCliffHub() {
			t.Fatal("want the defaults to be reported as production CliffHub")
		}

		// Overriding the agent (a local dev port) is enough to clear it.
		t.Setenv("CLIFFY_AGENT_URL", "http://localhost:3000/api/ai/chat")
		c, err = Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if c.CliffyTargetsDefaultCliffHub() {
			t.Fatal("an overridden agent URL must not report as production CliffHub")
		}
	})

	t.Run("Cliffy disabled never reports as targeting production", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		c, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if c.CliffyTargetsDefaultCliffHub() {
			t.Fatal("no secret means Cliffy is off — nothing to warn about")
		}
	})

	t.Run("both set together is accepted", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("CLIFFY_BRIDGE_SECRET", "a-secret-that-is-long-enough-here")
		t.Setenv("CLIFFY_BRIDGE_MINT_URL", "https://cliffhub.example/api/ai/bridge/mint")
		if _, err := Load(); err != nil {
			t.Fatalf("Load: %v", err)
		}
	})
}

// Outside development the bridge secret must be long enough to be a real HMAC
// key — a short one would boot fine and then sign assertions weakly.
func TestLoadRejectsShortCliffyBridgeSecretOutsideDevelopment(t *testing.T) {
	clearEnv(t)
	t.Setenv("ENV", "production")
	t.Setenv("JWT_SECRET", "a-production-jwt-secret-of-sufficient-length")
	t.Setenv("CLIFFY_BRIDGE_SECRET", "too-short")
	t.Setenv("CLIFFY_BRIDGE_MINT_URL", "https://cliffhub.example/api/ai/bridge/mint")
	if _, err := Load(); err == nil {
		t.Fatal("want a boot failure for a short bridge secret outside development")
	}
}
