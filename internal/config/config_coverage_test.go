package config

import (
	"strings"
	"testing"
)

// GUEST_LOGIN_ANY_ROLE parsing: dev-only boolean with a hard reject on junk.
func TestConfigCov_GuestLoginAnyRole(t *testing.T) {
	t.Run("invalid value rejected", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("JWT_SECRET", "test-secret")
		t.Setenv("ENV", "development")
		t.Setenv("GUEST_LOGIN_ANY_ROLE", "definitely-not-a-bool")
		if _, err := Load(); err == nil || !strings.Contains(err.Error(), "GUEST_LOGIN_ANY_ROLE") {
			t.Fatalf("want GUEST_LOGIN_ANY_ROLE parse error, got %v", err)
		}
	})
	t.Run("true lifts the gate", func(t *testing.T) {
		clearEnv(t)
		t.Setenv("JWT_SECRET", "test-secret")
		t.Setenv("ENV", "development")
		t.Setenv("GUEST_LOGIN_ANY_ROLE", "true")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("load: %v", err)
		}
		if !cfg.GuestLoginAnyRole {
			t.Fatal("GuestLoginAnyRole not set")
		}
	})
}
