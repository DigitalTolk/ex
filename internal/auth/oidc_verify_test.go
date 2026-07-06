package auth_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/DigitalTolk/ex/internal/auth"
)

// These tests exercise the REAL OIDC verification path that the unit-test
// stubOIDCProvider bypasses: provider discovery, the token exchange, and
// coreos/go-oidc's verifier.Verify (signature via JWKS, issuer, audience,
// expiry) plus the app's own nonce check. A self-hosted issuer with a real RSA
// key signs the id_tokens, so we can feed it valid AND forged/expired/wrong-aud
// tokens and assert they're accepted or rejected accordingly — the rejection
// paths a real IdP (or dex) can't easily produce.

const (
	testClientID = "ex-test-client"
	testKID      = "test-key-1"
)

// oidcIssuer is a minimal but real OpenID Connect issuer backed by an RSA key.
type oidcIssuer struct {
	srv     *httptest.Server
	key     *rsa.PrivateKey
	issuer  string
	idToken string // the id_token the /token endpoint returns; set per test
}

func newOIDCIssuer(t *testing.T) *oidcIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("rsa key: %v", err)
	}
	iss := &oidcIssuer{key: key}

	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{
			"issuer":                                iss.issuer,
			"authorization_endpoint":                iss.issuer + "/auth",
			"token_endpoint":                        iss.issuer + "/token",
			"jwks_uri":                              iss.issuer + "/keys",
			"response_types_supported":              []string{"code"},
			"subject_types_supported":               []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, _ *http.Request) {
		pub := key.PublicKey
		writeJSON(w, map[string]any{"keys": []map[string]any{{
			"kty": "RSA",
			"kid": testKID,
			"alg": "RS256",
			"use": "sig",
			"n":   base64.RawURLEncoding.EncodeToString(pub.N.Bytes()),
			"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]any{
			"access_token": "test-access-token",
			"token_type":   "Bearer",
			"expires_in":   3600,
			"id_token":     iss.idToken,
		})
	})

	iss.srv = httptest.NewServer(mux)
	iss.issuer = iss.srv.URL
	t.Cleanup(iss.srv.Close)
	return iss
}

// mint signs an id_token with the issuer's RSA key (RS256), overlaying the given
// claims on a valid baseline. Pass a signing key override to forge a bad sig.
func (iss *oidcIssuer) mint(t *testing.T, override jwt.MapClaims, signWith *rsa.PrivateKey) string {
	t.Helper()
	claims := jwt.MapClaims{
		"iss":   iss.issuer,
		"aud":   testClientID,
		"sub":   "user-123",
		"exp":   time.Now().Add(time.Hour).Unix(),
		"iat":   time.Now().Unix(),
		"nonce": "the-nonce",
		"email": "alice@example.com",
		"name":  "Alice Example",
	}
	for k, v := range override {
		claims[k] = v
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = testKID
	if signWith == nil {
		signWith = iss.key
	}
	signed, err := tok.SignedString(signWith)
	if err != nil {
		t.Fatalf("sign id_token: %v", err)
	}
	return signed
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func newProvider(t *testing.T, iss *oidcIssuer) *auth.OIDCProvider {
	t.Helper()
	p, err := auth.NewOIDCProvider(context.Background(), iss.issuer, testClientID, "test-secret", "http://localhost/callback")
	if err != nil {
		t.Fatalf("NewOIDCProvider (real discovery): %v", err)
	}
	return p
}

func TestOIDCProvider_Exchange_VerifiesValidToken(t *testing.T) {
	iss := newOIDCIssuer(t)
	p := newProvider(t, iss)
	iss.idToken = iss.mint(t, nil, nil)

	info, err := p.Exchange(context.Background(), "any-code", "the-nonce")
	if err != nil {
		t.Fatalf("Exchange of a validly-signed token must succeed: %v", err)
	}
	if info.Email != "alice@example.com" || info.Name != "Alice Example" {
		t.Errorf("claims = %+v, want alice@example.com / Alice Example", info)
	}
}

func TestOIDCProvider_Exchange_RejectsNonceMismatch(t *testing.T) {
	iss := newOIDCIssuer(t)
	p := newProvider(t, iss)
	iss.idToken = iss.mint(t, jwt.MapClaims{"nonce": "attacker-nonce"}, nil)

	if _, err := p.Exchange(context.Background(), "code", "the-nonce"); err == nil {
		t.Fatal("a token whose nonce doesn't match the request must be rejected")
	}
}

func TestOIDCProvider_Exchange_RejectsExpiredToken(t *testing.T) {
	iss := newOIDCIssuer(t)
	p := newProvider(t, iss)
	iss.idToken = iss.mint(t, jwt.MapClaims{"exp": time.Now().Add(-time.Hour).Unix()}, nil)

	if _, err := p.Exchange(context.Background(), "code", "the-nonce"); err == nil {
		t.Fatal("an expired id_token must be rejected")
	}
}

func TestOIDCProvider_Exchange_RejectsWrongAudience(t *testing.T) {
	iss := newOIDCIssuer(t)
	p := newProvider(t, iss)
	iss.idToken = iss.mint(t, jwt.MapClaims{"aud": "some-other-client"}, nil)

	if _, err := p.Exchange(context.Background(), "code", "the-nonce"); err == nil {
		t.Fatal("an id_token minted for a different audience must be rejected")
	}
}

func TestOIDCProvider_Exchange_RejectsUnparsableClaims(t *testing.T) {
	iss := newOIDCIssuer(t)
	p := newProvider(t, iss)
	// The token itself verifies (signature, iss, aud, exp, nonce all good) but
	// its claims JSON can't unmarshal into the app's claims struct: "email" is
	// a concrete Go string there, and here it's a JSON object.
	iss.idToken = iss.mint(t, jwt.MapClaims{"email": map[string]any{"unexpected": "object"}}, nil)

	_, err := p.Exchange(context.Background(), "code", "the-nonce")
	if err == nil {
		t.Fatal("claims JSON that cannot unmarshal into the claims struct must be rejected")
	}
	// Pin the failure to the claims-parse arm, not an earlier verification step.
	if want := "parse id_token claims"; !strings.Contains(err.Error(), want) {
		t.Fatalf("error = %v, want it to contain %q", err, want)
	}
}

func TestOIDCProvider_Exchange_RejectsForgedSignature(t *testing.T) {
	iss := newOIDCIssuer(t)
	p := newProvider(t, iss)
	// Sign with a DIFFERENT key than the one published in JWKS.
	attacker, _ := rsa.GenerateKey(rand.Reader, 2048)
	iss.idToken = iss.mint(t, nil, attacker)

	if _, err := p.Exchange(context.Background(), "code", "the-nonce"); err == nil {
		t.Fatal("an id_token signed with an unknown key must fail signature verification")
	}
}
