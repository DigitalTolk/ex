package config

import (
	"reflect"
	"testing"
	"time"
)

func TestLoadSessionMaxAge(t *testing.T) {
	t.Run("defaults to 90 days", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("SESSION_MAX_AGE", "")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.SessionMaxAge != 90*24*time.Hour {
			t.Errorf("SessionMaxAge = %v, want 2160h", cfg.SessionMaxAge)
		}
	})
	t.Run("custom", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("SESSION_MAX_AGE", "720h")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.SessionMaxAge != 720*time.Hour {
			t.Errorf("SessionMaxAge = %v, want 720h", cfg.SessionMaxAge)
		}
	})
	for _, bad := range []string{"forever", "-1h", "0"} {
		t.Run("rejects "+bad, func(t *testing.T) {
			clearEnv(t)
			t.Setenv("ENV", "development")
			t.Setenv("SESSION_MAX_AGE", bad)
			if _, err := Load(); err == nil {
				t.Fatalf("Load with SESSION_MAX_AGE=%q should fail", bad)
			}
		})
	}
}

func TestLoadOIDCAllowedEmailDomains(t *testing.T) {
	clearEnv(t)
	t.Setenv("ENV", "development")
	t.Setenv("OIDC_ALLOWED_EMAIL_DOMAINS", "")
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.OIDCAllowedEmailDomains) != 0 {
		t.Fatalf("unset → %v, want no restriction", cfg.OIDCAllowedEmailDomains)
	}

	t.Setenv("OIDC_ALLOWED_EMAIL_DOMAINS", " Example.com, ,corp.example.org ")
	cfg, err = Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if want := []string{"example.com", "corp.example.org"}; !reflect.DeepEqual(cfg.OIDCAllowedEmailDomains, want) {
		t.Fatalf("domains = %v, want %v", cfg.OIDCAllowedEmailDomains, want)
	}
}
