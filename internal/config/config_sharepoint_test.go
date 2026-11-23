package config

import (
	"bytes"
	"encoding/base64"
	"log/slog"
	"slices"
	"strings"
	"testing"
)

func TestLoadSharePoint(t *testing.T) {
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	sso := func(t *testing.T) {
		clearEnv(t)
		t.Setenv("ENV", "development")
		t.Setenv("MS_TENANT_ID", "tenant-1")
		t.Setenv("OIDC_ISSUER", "https://login.example.com/tenant-1/v2.0")
		t.Setenv("OIDC_CLIENT_ID", "oidc-client")
		t.Setenv("OIDC_CLIENT_SECRET", "oidc-secret")
	}

	t.Run("off without a key", func(t *testing.T) {
		sso(t)
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if cfg.SharePointEnabled() || len(cfg.SharePointTokenKey()) != 0 || cfg.SharePointScopes() != nil {
			t.Fatal("sharing must be off without MS_TOKEN_KEY")
		}
	})

	t.Run("on with a key", func(t *testing.T) {
		sso(t)
		t.Setenv("MS_TOKEN_KEY", " "+key+" ")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if !cfg.SharePointEnabled() || len(cfg.SharePointTokenKey()) != 32 {
			t.Fatal("sharing must be on")
		}
		if !slices.Equal(cfg.SharePointHosts(), []string{"*.sharepoint.com"}) {
			t.Fatalf("default hosts = %v", cfg.SharePointHosts())
		}
		if !slices.Equal(cfg.SharePointScopes(), []string{"offline_access", "https://graph.microsoft.com/Files.ReadWrite.All"}) {
			t.Fatalf("scopes = %v", cfg.SharePointScopes())
		}
	})

	t.Run("hosts are normalized", func(t *testing.T) {
		sso(t)
		t.Setenv("MS_TOKEN_KEY", key)
		t.Setenv("MS_SHAREPOINT_HOSTS", " Contoso.SharePoint.com, ,contoso-my.sharepoint.com")
		cfg, err := Load()
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		if !slices.Equal(cfg.SharePointHosts(), []string{"contoso.sharepoint.com", "contoso-my.sharepoint.com"}) {
			t.Fatalf("hosts = %v", cfg.SharePointHosts())
		}
	})

	for name, setup := range map[string]func(t *testing.T){
		"key without Microsoft 365": func(t *testing.T) {
			sso(t)
			t.Setenv("MS_TENANT_ID", "")
		},
		"key without SSO": func(t *testing.T) {
			sso(t)
			t.Setenv("OIDC_ISSUER", "")
		},
	} {
		t.Run("fails closed: "+name, func(t *testing.T) {
			setup(t)
			t.Setenv("MS_TOKEN_KEY", key)
			if _, err := Load(); err == nil || !strings.Contains(err.Error(), "MS_TOKEN_KEY") {
				t.Fatalf("err = %v", err)
			}
		})
	}
	// The secret store seeds a new secret with a placeholder ("bar") until its
	// real value is set: the app must still boot, with sharing off and an
	// error in the log saying why.
	for _, bad := range []string{"bar", "not base64!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		t.Run("boots with sharing off on key "+bad, func(t *testing.T) {
			sso(t)
			t.Setenv("MS_TOKEN_KEY", bad)
			var logs bytes.Buffer
			prev := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
			t.Cleanup(func() { slog.SetDefault(prev) })

			cfg, err := Load()
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if cfg.SharePointEnabled() || len(cfg.SharePointTokenKey()) != 0 || cfg.SharePointScopes() != nil {
				t.Fatal("sharing must be off with an invalid MS_TOKEN_KEY")
			}
			if !strings.Contains(logs.String(), "level=ERROR") || !strings.Contains(logs.String(), "MS_TOKEN_KEY") {
				t.Fatalf("want an error log naming MS_TOKEN_KEY, got %q", logs.String())
			}
		})
	}
}
