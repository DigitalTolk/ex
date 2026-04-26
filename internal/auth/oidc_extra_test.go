package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// fakeIssuer spins up a minimal OIDC discovery + token endpoint so we can
// exercise NewOIDCProvider, AuthURL, and Exchange's error paths without
// hitting a real provider.
func fakeIssuer(t *testing.T, tokenHandler http.HandlerFunc) (string, func()) {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                 srv.URL,
			"authorization_endpoint": srv.URL + "/authorize",
			"token_endpoint":         srv.URL + "/token",
			"jwks_uri":               srv.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"keys":[]}`))
	})
	mux.HandleFunc("/token", tokenHandler)
	return srv.URL, srv.Close
}

func TestNewOIDCProvider_DiscoveryFails(t *testing.T) {
	_, err := NewOIDCProvider(context.Background(), "http://127.0.0.1:1/bad", "id", "secret", "http://localhost/cb")
	if err == nil {
		t.Fatal("expected discovery error")
	}
}

func TestOIDCProvider_AuthURL(t *testing.T) {
	url, cancel := fakeIssuer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no", http.StatusBadRequest)
	})
	defer cancel()
	p, err := NewOIDCProvider(context.Background(), url, "client-id", "secret", "http://localhost/cb")
	if err != nil {
		t.Fatalf("NewOIDCProvider: %v", err)
	}
	got := p.AuthURL("state-xyz")
	if !strings.Contains(got, "state=state-xyz") {
		t.Errorf("AuthURL missing state param: %q", got)
	}
	if !strings.Contains(got, "client_id=client-id") {
		t.Errorf("AuthURL missing client_id: %q", got)
	}
}

func TestOIDCProvider_Exchange_BadCode(t *testing.T) {
	url, cancel := fakeIssuer(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
	})
	defer cancel()
	p, err := NewOIDCProvider(context.Background(), url, "client-id", "secret", "http://localhost/cb")
	if err != nil {
		t.Fatalf("NewOIDCProvider: %v", err)
	}
	if _, err := p.Exchange(context.Background(), "bad-code"); err == nil {
		t.Fatal("expected exchange error")
	}
}

func TestOIDCProvider_Exchange_NoIDToken(t *testing.T) {
	url, cancel := fakeIssuer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"abc","token_type":"Bearer"}`))
	})
	defer cancel()
	p, err := NewOIDCProvider(context.Background(), url, "client-id", "secret", "http://localhost/cb")
	if err != nil {
		t.Fatalf("NewOIDCProvider: %v", err)
	}
	_, err = p.Exchange(context.Background(), "code")
	if err == nil || !strings.Contains(err.Error(), "id_token") {
		t.Fatalf("expected no id_token error, got %v", err)
	}
}

// TestOIDCProvider_Exchange_BadIDToken: token endpoint returns an id_token
// that fails verification (jwks empty). Covers the verify error branch.
func TestOIDCProvider_Exchange_BadIDToken(t *testing.T) {
	url, cancel := fakeIssuer(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"abc","token_type":"Bearer","id_token":"not-a-real-jwt"}`))
	})
	defer cancel()
	p, err := NewOIDCProvider(context.Background(), url, "client-id", "secret", "http://localhost/cb")
	if err != nil {
		t.Fatalf("NewOIDCProvider: %v", err)
	}
	_, err = p.Exchange(context.Background(), "code")
	if err == nil {
		t.Fatal("expected verification error")
	}
}

// TestOIDCProvider_AuthURL_Direct constructs an OIDCProvider with stub fields
// to ensure AuthURL works in isolation (no network).
func TestOIDCProvider_AuthURL_Direct(t *testing.T) {
	p := &OIDCProvider{
		oauth2Config: oauth2.Config{
			ClientID:    "x",
			RedirectURL: "http://localhost/cb",
			Endpoint:    oauth2.Endpoint{AuthURL: "http://issuer/auth", TokenURL: "http://issuer/token"},
			Scopes:      []string{oidc.ScopeOpenID},
		},
	}
	got := p.AuthURL("S")
	if !strings.Contains(got, "state=S") {
		t.Errorf("AuthURL: %q", got)
	}
}
