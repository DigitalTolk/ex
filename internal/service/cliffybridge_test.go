package service

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const testBridgeSecret = "test-bridge-secret-at-least-32-characters"

// fakeCache is a minimal in-memory BridgeTokenCache for tests.
type fakeCache struct {
	mu   sync.Mutex
	data map[string][]byte
}

func newFakeCache() *fakeCache { return &fakeCache{data: map[string][]byte{}} }

func (c *fakeCache) Get(_ context.Context, key string, dest interface{}) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.data[key]
	if !ok {
		return errors.New("miss")
	}
	return json.Unmarshal(b, dest)
}

func (c *fakeCache) Set(_ context.Context, key string, val interface{}, _ time.Duration) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, err := json.Marshal(val)
	if err != nil {
		return err
	}
	c.data[key] = b
	return nil
}

func (c *fakeCache) Delete(_ context.Context, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.data, key)
	return nil
}

func (c *fakeCache) has(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.data[key]
	return ok
}

// mintServer stands in for CliffHub's /api/ai/bridge/mint. It verifies the
// assertion exactly as CliffHub does (HS256 + iss/aud), records the parsed
// claims, counts calls, and returns whatever status/token the test wants.
type mintServer struct {
	calls      int32
	status     int
	token      string
	expiresAt  time.Time
	lastClaims jwt.MapClaims
}

func newMintServer() *mintServer {
	return &mintServer{status: http.StatusOK, token: "cliffhub-token-abc", expiresAt: time.Now().Add(15 * time.Minute)}
}

func (m *mintServer) handler(t *testing.T) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&m.calls, 1)

		var body struct {
			Assertion string `json:"assertion"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Assertion == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		claims := jwt.MapClaims{}
		_, err := jwt.ParseWithClaims(body.Assertion, claims, func(*jwt.Token) (interface{}, error) {
			return []byte(testBridgeSecret), nil
		}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithExpirationRequired())
		if err != nil {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		m.lastClaims = claims

		if m.status != http.StatusOK {
			w.WriteHeader(m.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token":      m.token,
			"token_type": "Bearer",
			"expires_at": m.expiresAt.UTC().Format(time.RFC3339Nano),
		})
	}
}

func newTestBridge(t *testing.T, url string, cache BridgeTokenCache, now func() time.Time) *CliffyBridge {
	t.Helper()
	b, err := NewCliffyBridge(CliffyBridgeConfig{
		Secret:        testBridgeSecret,
		MintURL:       url,
		AssertionTTL:  45 * time.Second,
		RefreshMargin: 60 * time.Second,
		Cache:         cache,
		now:           now,
	})
	if err != nil {
		t.Fatalf("NewCliffyBridge: %v", err)
	}
	if b == nil {
		t.Fatal("NewCliffyBridge returned nil for a configured bridge")
	}
	return b
}

func TestNewCliffyBridge_DisabledWhenUnset(t *testing.T) {
	for _, tc := range []CliffyBridgeConfig{
		{Secret: "", MintURL: "https://x/api"},
		{Secret: "s", MintURL: ""},
		{},
	} {
		b, err := NewCliffyBridge(tc)
		if err != nil || b != nil {
			t.Errorf("NewCliffyBridge(%+v) = (%v,%v), want (nil,nil)", tc, b, err)
		}
	}
}

func TestNewCliffyBridge_InvalidMintURL(t *testing.T) {
	b, err := NewCliffyBridge(CliffyBridgeConfig{Secret: "s", MintURL: "not-a-url"})
	if err == nil || b != nil {
		t.Fatalf("expected error for invalid mint URL, got (%v,%v)", b, err)
	}
}

func TestTokenFor_MintsAndSignsVerifiableAssertion(t *testing.T) {
	ms := newMintServer()
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()

	b := newTestBridge(t, srv.URL, nil, time.Now)

	token, expiresAt, err := b.TokenFor(context.Background(), "ex-user-1", "user@example.com")
	if err != nil {
		t.Fatalf("TokenFor: %v", err)
	}
	if token != ms.token {
		t.Errorf("token = %q, want %q", token, ms.token)
	}
	if expiresAt.IsZero() {
		t.Error("expiresAt is zero")
	}
	// The server verified the signature; assert the claims it parsed.
	if got := ms.lastClaims["iss"]; got != bridgeAssertionIssuer {
		t.Errorf("iss = %v, want %v", got, bridgeAssertionIssuer)
	}
	if got := ms.lastClaims["aud"]; got != bridgeAssertionAudience {
		t.Errorf("aud = %v, want %v (must be a plain string)", got, bridgeAssertionAudience)
	}
	if got := ms.lastClaims["email"]; got != "user@example.com" {
		t.Errorf("email = %v, want user@example.com", got)
	}
	if got := ms.lastClaims["sub"]; got != "ex-user-1" {
		t.Errorf("sub = %v, want ex-user-1", got)
	}
}

func TestTokenFor_EmptyEmailIsNoAccount(t *testing.T) {
	ms := newMintServer()
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, nil, time.Now)

	_, _, err := b.TokenFor(context.Background(), "ex-user-1", "")
	if !errors.Is(err, ErrCliffyNoAccount) {
		t.Fatalf("err = %v, want ErrCliffyNoAccount", err)
	}
	if atomic.LoadInt32(&ms.calls) != 0 {
		t.Error("expected no server call for an empty email")
	}
}

func TestTokenFor_ForbiddenIsNoAccount(t *testing.T) {
	ms := newMintServer()
	ms.status = http.StatusForbidden
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, nil, time.Now)

	_, _, err := b.TokenFor(context.Background(), "ex-user-1", "guest@example.com")
	if !errors.Is(err, ErrCliffyNoAccount) {
		t.Fatalf("err = %v, want ErrCliffyNoAccount", err)
	}
}

func TestTokenFor_ServerErrorIsTransient(t *testing.T) {
	ms := newMintServer()
	ms.status = http.StatusInternalServerError
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, nil, time.Now)

	_, _, err := b.TokenFor(context.Background(), "ex-user-1", "user@example.com")
	if err == nil || errors.Is(err, ErrCliffyNoAccount) {
		t.Fatalf("err = %v, want a transient (non-no-account) error", err)
	}
}

func TestTokenFor_CachesToken(t *testing.T) {
	ms := newMintServer()
	ms.expiresAt = time.Now().Add(15 * time.Minute)
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, newFakeCache(), time.Now)

	for i := 0; i < 3; i++ {
		if _, _, err := b.TokenFor(context.Background(), "ex-user-1", "user@example.com"); err != nil {
			t.Fatalf("TokenFor #%d: %v", i, err)
		}
	}
	if n := atomic.LoadInt32(&ms.calls); n != 1 {
		t.Errorf("mint calls = %d, want 1 (cached thereafter)", n)
	}
}

func TestTokenFor_RemintsWithinRefreshMargin(t *testing.T) {
	ms := newMintServer()
	// Token expires in 30s; refresh margin is 60s → always considered stale.
	ms.expiresAt = time.Now().Add(30 * time.Second)
	srv := httptest.NewServer(ms.handler(t))
	defer srv.Close()
	b := newTestBridge(t, srv.URL, newFakeCache(), time.Now)

	for i := 0; i < 2; i++ {
		if _, _, err := b.TokenFor(context.Background(), "ex-user-1", "user@example.com"); err != nil {
			t.Fatalf("TokenFor #%d: %v", i, err)
		}
	}
	if n := atomic.LoadInt32(&ms.calls); n != 2 {
		t.Errorf("mint calls = %d, want 2 (token too close to expiry to cache)", n)
	}
}

func TestRevoke_ClearsCacheAndCallsCliffHub(t *testing.T) {
	var revokeCalls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/api/ai/bridge/mint", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": "tok", "token_type": "Bearer",
			"expires_at": time.Now().Add(15 * time.Minute).UTC().Format(time.RFC3339Nano),
		})
	})
	mux.HandleFunc("/api/ai/bridge/revoke", func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&revokeCalls, 1)
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "revoked": 1})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cache := newFakeCache()
	b := newTestBridge(t, srv.URL+"/api/ai/bridge/mint", cache, time.Now)

	// Seed a cached token, then revoke.
	if _, _, err := b.TokenFor(context.Background(), "u1", "user@example.com"); err != nil {
		t.Fatalf("TokenFor: %v", err)
	}
	if !cache.has("cliffy:bridge:tok:u1") {
		t.Fatal("expected a cached token before revoke")
	}

	if err := b.Revoke(context.Background(), "u1", "user@example.com"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if cache.has("cliffy:bridge:tok:u1") {
		t.Error("cached token should be cleared after revoke")
	}
	if atomic.LoadInt32(&revokeCalls) != 1 {
		t.Errorf("CliffHub revoke calls = %d, want 1", revokeCalls)
	}
}

func TestSignAssertion_RespectsTTL(t *testing.T) {
	base := time.Unix(1_800_000_000, 0)
	b := newTestBridge(t, "https://cliffhub.example/api/ai/bridge/mint", nil, func() time.Time { return base })

	assertion, err := b.signAssertion("ex-user-1", "user@example.com")
	if err != nil {
		t.Fatalf("signAssertion: %v", err)
	}
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(assertion, claims, func(*jwt.Token) (interface{}, error) {
		return []byte(testBridgeSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"})); err != nil {
		t.Fatalf("parse: %v", err)
	}
	iat, _ := claims["iat"].(float64)
	exp, _ := claims["exp"].(float64)
	if int64(exp-iat) != 45 {
		t.Errorf("exp-iat = %d, want 45", int64(exp-iat))
	}
}
