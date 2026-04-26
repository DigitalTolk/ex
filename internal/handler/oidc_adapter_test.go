package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/DigitalTolk/ex/internal/auth"
)

func issuerForAdapterTest(t *testing.T) (string, func()) {
	t.Helper()
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                srv.URL,
			"authorization_endpoint":                srv.URL + "/auth",
			"token_endpoint":                        srv.URL + "/token",
			"jwks_uri":                              srv.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"keys":[]}`))
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
	})
	return srv.URL, srv.Close
}

func TestOIDCAdapter_AuthURL(t *testing.T) {
	url, cancel := issuerForAdapterTest(t)
	defer cancel()
	p, err := auth.NewOIDCProvider(context.Background(), url, "id", "secret", "http://localhost/cb")
	if err != nil {
		t.Fatalf("NewOIDCProvider: %v", err)
	}
	a := NewOIDCAdapter(p)
	got := a.AuthURL("STATE")
	if !strings.Contains(got, "state=STATE") {
		t.Errorf("AuthURL missing state: %q", got)
	}
}

func TestOIDCAdapter_Exchange_Error(t *testing.T) {
	url, cancel := issuerForAdapterTest(t)
	defer cancel()
	p, err := auth.NewOIDCProvider(context.Background(), url, "id", "secret", "http://localhost/cb")
	if err != nil {
		t.Fatalf("NewOIDCProvider: %v", err)
	}
	a := NewOIDCAdapter(p)
	if _, err := a.Exchange(context.Background(), "bad-code"); err == nil {
		t.Fatal("expected exchange error")
	}
}
